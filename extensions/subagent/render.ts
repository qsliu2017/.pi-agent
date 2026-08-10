import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { DashboardChildView, SubagentSnapshot, SubagentToolDetails, TurnView } from "./types.ts";

const LIVING_STATES = new Set(["creating", "running", "stopping", "waiting_parent"]);
const EXPANDED_TURN_LIMIT = 5;

function singleLine(text: string | undefined, fallback = ""): string {
	return text?.replace(/\s+/g, " ").trim() || fallback;
}

function formatDuration(milliseconds: number): string {
	if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
	const totalSeconds = Math.round(milliseconds / 1_000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
}

function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}m`;
}

function activityText(activity: TurnView["activities"][number]): string {
	const prefix = activity.name === "bash" ? "$" : activity.name;
	return `${prefix}${activity.preview ? ` ${singleLine(activity.preview)}` : ""}${activity.isError ? " [error]" : ""}`;
}

function primaryTurnText(turn: TurnView): string {
	const active = [...turn.activities].reverse().find((activity) => activity.endedAt === undefined);
	const latest = active ?? turn.activities.at(-1);
	return latest ? activityText(latest) : singleLine(turn.textPreview ?? turn.thinkingPreview, "thinking");
}

function expandedTurnTexts(turn: TurnView): string[] {
	const texts: string[] = [];
	if (turn.thinkingPreview) texts.push(`thinking: ${singleLine(turn.thinkingPreview)}`);
	if (turn.textPreview) texts.push(`text: ${singleLine(turn.textPreview)}`);
	for (const activity of turn.activities) {
		texts.push(`tool: ${activityText(activity)}`);
		if (activity.resultPreview) texts.push(`result: ${singleLine(activity.resultPreview)}`);
	}
	return texts.length > 0 ? texts : ["thinking"];
}

function modelText(snapshot: SubagentSnapshot): string {
	const model = snapshot.model.split("/").at(-1) ?? snapshot.model;
	return snapshot.thinking_level === "off" ? model : `${model}:${snapshot.thinking_level}`;
}

function collapsedActivity(snapshot: SubagentSnapshot, turns: TurnView[]): string {
	if (snapshot.state === "waiting_parent") return "waiting for parent";
	if (snapshot.state === "stopping") return "stopping";
	if (snapshot.state === "creating") return "creating";
	if (snapshot.current_activity) {
		if (snapshot.current_activity.type === "tool" && snapshot.current_activity.name) {
			const prefix = snapshot.current_activity.name === "bash" ? "$" : snapshot.current_activity.name;
			return `${prefix}${snapshot.current_activity.preview ? ` ${singleLine(snapshot.current_activity.preview)}` : ""}`;
		}
		return singleLine(snapshot.current_activity.preview, "thinking");
	}
	const turn = turns.at(-1);
	return turn ? primaryTurnText(turn) : singleLine(snapshot.last_text_preview, "starting");
}

function stateAppearance(snapshot: SubagentSnapshot): { color: "warning" | "muted"; symbol: string } {
	if (snapshot.state === "waiting_parent") return { color: "warning", symbol: "?" };
	if (snapshot.state === "stopping") return { color: "muted", symbol: "■" };
	return { color: "warning", symbol: "●" };
}

function childHeader(view: DashboardChildView, theme: Theme): string {
	const { snapshot, turns } = view;
	const appearance = stateAppearance(snapshot);
	return `${theme.fg(appearance.color, appearance.symbol)} ${theme.fg("toolTitle", theme.bold(snapshot.name))}  ${theme.fg("muted", modelText(snapshot))}  ${theme.fg("dim", `turn ${snapshot.turns}`)}  ${theme.fg("toolOutput", collapsedActivity(snapshot, turns))}`;
}

function expandedChildLines(view: DashboardChildView, theme: Theme): string[] {
	const lines = [childHeader(view, theme)];
	const turns = view.turns.slice(-EXPANDED_TURN_LIMIT);
	for (const turn of turns) {
		for (const [index, detail] of expandedTurnTexts(turn).entries()) {
			const prefix = index === 0 ? `${String(turn.index).padStart(3)}  ` : "     ";
			lines.push(theme.fg("toolOutput", `${prefix}${detail}`));
		}
	}
	if (turns.length === 0) lines.push(theme.fg("dim", `     ${collapsedActivity(view.snapshot, view.turns)}`));
	if (view.snapshot.pending_question) {
		lines.push(theme.fg("warning", `     question: ${singleLine(view.snapshot.pending_question)}`));
	}
	if (view.snapshot.error) lines.push(theme.fg("error", `     error: ${singleLine(view.snapshot.error)}`));
	const usage = view.snapshot.usage;
	const totalTokens = usage.input + usage.output + usage.cache_read + usage.cache_write;
	lines.push(
		theme.fg(
			"dim",
			`     ${formatTokens(totalTokens)} tokens | ${formatDuration(view.snapshot.elapsed_ms)} | idle ${formatDuration(view.snapshot.idle_ms)}`,
		),
	);
	return lines;
}

export function selectDashboardChildren(children: DashboardChildView[]): DashboardChildView[] {
	return children
		.filter((child) => LIVING_STATES.has(child.snapshot.state))
		.sort((left, right) => left.dashboardOrder - right.dashboardOrder);
}

export class SubagentDashboard implements Component {
	private readonly getChildren: () => DashboardChildView[];
	private readonly getExpanded: () => boolean;
	private readonly getMaxLines: () => number;
	private readonly theme: Theme;
	private readonly onDispose?: () => void;
	private cachedWidth: number | undefined;
	private cachedExpanded: boolean | undefined;
	private cachedMaxLines: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		getChildren: () => DashboardChildView[],
		getExpanded: () => boolean,
		getMaxLines: () => number,
		theme: Theme,
		onDispose?: () => void,
	) {
		this.getChildren = getChildren;
		this.getExpanded = getExpanded;
		this.getMaxLines = getMaxLines;
		this.theme = theme;
		this.onDispose = onDispose;
	}

	render(width: number): string[] {
		const expanded = this.getExpanded();
		const maxLines = Math.max(1, Math.floor(this.getMaxLines()));
		if (
			this.cachedLines &&
			this.cachedWidth === width &&
			this.cachedExpanded === expanded &&
			this.cachedMaxLines === maxLines
		) {
			return this.cachedLines;
		}

		const availableWidth = Math.max(1, width);
		const children = selectDashboardChildren(this.getChildren());
		if (children.length === 0) {
			this.cachedWidth = width;
			this.cachedExpanded = expanded;
			this.cachedMaxLines = maxLines;
			this.cachedLines = [];
			return this.cachedLines;
		}

		const sections = children.map((child) =>
			expanded ? expandedChildLines(child, this.theme) : [childHeader(child, this.theme)],
		);
		const body = sections.flat();
		let lines = [this.theme.fg("accent", this.theme.bold("Subagents")), ...body];
		if (lines.length > maxLines) {
			if (maxLines === 1) {
				lines = [lines[0] ?? ""];
			} else {
				const shownBodyLines = Math.max(0, maxLines - 2);
				const omittedLines = body.length - shownBodyLines;
				let bodyOffset = 0;
				let omittedChildren = 0;
				for (const section of sections) {
					if (bodyOffset >= shownBodyLines) omittedChildren++;
					bodyOffset += section.length;
				}
				const childSuffix =
					omittedChildren > 0 ? ` (${omittedChildren} subagent${omittedChildren === 1 ? "" : "s"} omitted)` : "";
				lines = [
					lines[0] ?? "",
					...body.slice(0, shownBodyLines),
					this.theme.fg("dim", `… ${omittedLines} more line${omittedLines === 1 ? "" : "s"}${childSuffix}`),
				];
			}
		}

		this.cachedWidth = width;
		this.cachedExpanded = expanded;
		this.cachedMaxLines = maxLines;
		this.cachedLines = lines.map((line) => truncateToWidth(line, availableWidth));
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedExpanded = undefined;
		this.cachedMaxLines = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {
		this.onDispose?.();
	}
}

export class SubagentNotificationCard implements Component {
	private content: string;
	private theme: Theme;
	private expanded: boolean;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(content: string, theme: Theme, expanded: boolean) {
		this.content = content;
		this.theme = theme;
		this.expanded = expanded;
	}

	update(content: string, theme: Theme, expanded: boolean): void {
		this.content = content;
		this.theme = theme;
		this.expanded = expanded;
		this.invalidate();
	}

	render(width: number): string[] {
		if (!this.expanded) return [];
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const availableWidth = Math.max(1, Math.floor(width));
		const header = truncateToWidth(this.theme.fg("accent", this.theme.bold("╭─ Subagent update")), availableWidth);
		const footer = truncateToWidth(this.theme.fg("accent", "╰─"), availableWidth);
		const prefixText = availableWidth >= 3 ? "│ " : availableWidth === 2 ? "│" : "";
		const prefix = prefixText ? this.theme.fg("accent", prefixText) : "";
		const bodyWidth = Math.max(1, availableWidth - prefixText.length);
		const body = wrapTextWithAnsi(this.theme.fg("customMessageText", this.content), bodyWidth).map(
			(line) => `${prefix}${line}`,
		);
		this.cachedWidth = width;
		this.cachedLines = [header, ...body, footer];
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export function renderSubagentNotificationCard(
	content: string,
	theme: Theme,
	expanded: boolean,
	lastComponent?: Component,
): Component {
	const component =
		lastComponent instanceof SubagentNotificationCard
			? lastComponent
			: new SubagentNotificationCard(content, theme, expanded);
	component.update(content, theme, expanded);
	return component;
}

class StaticToolLine implements Component {
	private readonly text: string;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = [truncateToWidth(this.text, Math.max(1, width))];
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

const COLLAPSED_PROMPT_LINES = 3;

class StaticSubagentCall implements Component {
	private action: "create" | "send";
	private name: string;
	private content: string;
	private theme: Theme;
	private expanded: boolean;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(action: "create" | "send", name: string, content: string, theme: Theme, expanded: boolean) {
		this.action = action;
		this.name = name;
		this.content = content;
		this.theme = theme;
		this.expanded = expanded;
	}

	update(action: "create" | "send", name: string, content: string, theme: Theme, expanded: boolean): void {
		this.action = action;
		this.name = name;
		this.content = content;
		this.theme = theme;
		this.expanded = expanded;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const availableWidth = Math.max(1, width);
		const toolName = this.action === "create" ? "subagent_create" : "subagent_send";
		const header = truncateToWidth(
			`${this.theme.fg("toolTitle", this.theme.bold(toolName))} ${this.theme.fg("accent", singleLine(this.name))}`,
			availableWidth,
		);
		const completeBody = wrapTextWithAnsi(this.theme.fg("dim", this.content), availableWidth);
		const body = this.expanded ? completeBody : completeBody.slice(0, COLLAPSED_PROMPT_LINES);
		if (!this.expanded && completeBody.length > COLLAPSED_PROMPT_LINES) {
			const lastIndex = body.length - 1;
			body[lastIndex] =
				`${truncateToWidth(body[lastIndex] ?? "", availableWidth - 1, "")}${this.theme.fg("dim", "…")}`;
		}

		this.cachedWidth = width;
		this.cachedLines = [header, ...body];
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export function renderStaticSubagentCall(
	action: "create" | "send",
	name: string,
	content: string,
	theme: Theme,
	expanded = false,
	lastComponent?: Component,
): Component {
	const component =
		lastComponent instanceof StaticSubagentCall
			? lastComponent
			: new StaticSubagentCall(action, name, content, theme, expanded);
	component.update(action, name, content, theme, expanded);
	return component;
}

export function renderStaticSubagentResult(details: SubagentToolDetails | undefined, theme: Theme): Component {
	if (!details) return new StaticToolLine(theme.fg("muted", "Subagent acknowledgement unavailable"));
	const verb = details.action === "create" ? "Created" : "Sent to";
	return new StaticToolLine(
		`${theme.fg("success", verb)} ${theme.fg("accent", details.snapshot.name)} ${theme.fg("muted", `(${details.childId}) · ${details.snapshot.state}`)}`,
	);
}
