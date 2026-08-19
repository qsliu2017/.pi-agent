import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
	CreateSubagentDetails,
	ListSubagentsDetails,
	StopSubagentDetails,
	SubagentMode,
	WaitFor,
	WaitSubagentsDetails,
} from "./types.ts";

const CREATE_SYSTEM_LINES = 3;
const CREATE_TASK_LINES = 5;
const STOP_REASON_LINES = 3;
const COLLAPSED_LIST_ROWS = 5;

function oneLine(value: string | undefined): string {
	return value?.replace(/\s+/g, " ").trim() ?? "";
}

function limitedText(text: string | undefined, width: number, maxLines: number | undefined, theme: Theme): string[] {
	if (!text?.trim()) return [];
	const wrapped = wrapTextWithAnsi(theme.fg("dim", text.trim()), Math.max(1, width));
	if (maxLines === undefined || wrapped.length <= maxLines) return wrapped;
	const lines = wrapped.slice(0, maxLines);
	const last = lines.length - 1;
	lines[last] = `${truncateToWidth(lines[last] ?? "", Math.max(1, width - 1), "")}${theme.fg("dim", "…")}`;
	return lines;
}

function statusColor(status: string): "success" | "warning" | "error" | "muted" {
	if (status === "stopped" || status === "settled") return "success";
	if (status === "error" || status === "timeout" || status === "cancelled") return "error";
	if (status === "running" || status === "waiting" || status === "pending") return "warning";
	return "muted";
}

function statusLine(id: string | undefined, status: string, theme: Theme, width: number): string {
	const prefix = id ? `${id} ` : "";
	return truncateToWidth(`${theme.fg("muted", prefix)}${theme.fg(statusColor(status), status)}`, Math.max(1, width));
}

abstract class CachedCard implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	protected abstract build(width: number): string[];

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const availableWidth = Math.max(1, width);
		this.cachedWidth = width;
		this.cachedLines = this.build(availableWidth).map((line) => truncateToWidth(line, availableWidth));
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export class CreateCardRegistry {
	private readonly snapshots = new Map<string, CreateSubagentDetails["snapshot"]>();
	private readonly invalidators = new Map<string, () => void>();

	bind(details: CreateSubagentDetails, invalidate: () => void): CreateSubagentDetails {
		this.invalidators.set(details.childId, invalidate);
		const known = this.snapshots.get(details.childId);
		const snapshot = known?.state === "stopped" && details.snapshot.state === "running" ? known : details.snapshot;
		this.snapshots.set(details.childId, snapshot);
		return snapshot === details.snapshot ? details : { ...details, snapshot };
	}

	update(snapshots: readonly CreateSubagentDetails["snapshot"][]): void {
		for (const snapshot of snapshots) {
			const previous = this.snapshots.get(snapshot.id);
			this.snapshots.set(snapshot.id, snapshot);
			if (
				previous &&
				(previous.state !== snapshot.state ||
					previous.final_response !== snapshot.final_response ||
					previous.error !== snapshot.error ||
					previous.stop_reason !== snapshot.stop_reason ||
					previous.stop_message !== snapshot.stop_message)
			) {
				this.invalidators.get(snapshot.id)?.();
			}
		}
	}

	clear(): void {
		this.snapshots.clear();
		this.invalidators.clear();
	}
}

export interface CreateCardInput {
	name?: string;
	from?: string;
	mode: SubagentMode;
	systemPrompt?: string;
	context?: string;
	task: string;
	cwd?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	timeoutSeconds?: number;
}

class CreateCallCard extends CachedCard {
	constructor(
		private input: CreateCardInput,
		private theme: Theme,
		private expanded: boolean,
	) {
		super();
	}

	update(input: CreateCardInput, theme: Theme, expanded: boolean): void {
		this.input = input;
		this.theme = theme;
		this.expanded = expanded;
		this.invalidate();
	}

	protected build(width: number): string[] {
		const name = oneLine(this.input.name);
		const lineage = this.input.from ? ` ← ${oneLine(this.input.from)}` : "";
		const timeout = this.input.timeoutSeconds === undefined ? "" : ` timeout ${this.input.timeoutSeconds}s`;
		const header = `${this.theme.fg("toolTitle", this.theme.bold("subagent_create"))}${name ? ` ${this.theme.fg("accent", name)}` : ""}${this.theme.fg("dim", `${lineage} - ${this.input.mode}${timeout}`)}`;
		const lines = [header];
		lines.push(
			...limitedText(
				this.input.systemPrompt,
				width,
				this.expanded ? undefined : CREATE_SYSTEM_LINES,
				this.theme,
			),
		);
		if (this.expanded && this.input.context?.trim()) {
			lines.push(this.theme.fg("muted", "context"));
			lines.push(...limitedText(this.input.context, width, undefined, this.theme));
		}
		lines.push(...limitedText(this.input.task, width, this.expanded ? undefined : CREATE_TASK_LINES, this.theme));
		const differences = [this.input.cwd, this.input.model, this.input.thinkingLevel].filter(Boolean).join(" ");
		if (differences) lines.push(this.theme.fg("muted", differences));
		return lines;
	}
}

export function renderSubagentCreateCall(
	input: CreateCardInput,
	theme: Theme,
	expanded: boolean,
	lastComponent?: Component,
): Component {
	const card = lastComponent instanceof CreateCallCard ? lastComponent : new CreateCallCard(input, theme, expanded);
	card.update(input, theme, expanded);
	return card;
}

class CreateResultCard extends CachedCard {
	constructor(
		private details: CreateSubagentDetails | undefined,
		private theme: Theme,
		private expanded: boolean,
		private partial: boolean,
		private isError: boolean,
	) {
		super();
	}

	update(details: CreateSubagentDetails | undefined, theme: Theme, expanded: boolean, partial: boolean, isError: boolean): void {
		this.details = details;
		this.theme = theme;
		this.expanded = expanded;
		this.partial = partial;
		this.isError = isError;
		this.invalidate();
	}

	protected build(width: number): string[] {
		const snapshot = this.details?.snapshot;
		const status = snapshot?.state ?? (this.isError ? "error" : this.partial ? "running" : "stopped");
		const lines = [statusLine(this.details?.childId, status, this.theme, width)];
		if (!this.expanded || !snapshot || snapshot.state === "running") return lines;
		const handoff =
			snapshot.stop_reason === "finished"
				? snapshot.final_response
				: snapshot.error ?? snapshot.final_response ?? snapshot.stop_message;
		lines.push(...limitedText(handoff, width, undefined, this.theme));
		return lines;
	}
}

export function renderSubagentCreateResult(
	details: CreateSubagentDetails | undefined,
	theme: Theme,
	expanded: boolean,
	partial: boolean,
	isError = false,
	lastComponent?: Component,
): Component {
	const card =
		lastComponent instanceof CreateResultCard
			? lastComponent
			: new CreateResultCard(details, theme, expanded, partial, isError);
	card.update(details, theme, expanded, partial, isError);
	return card;
}

export interface WaitCardInput {
	names?: readonly string[];
	waitFor: WaitFor;
	timeoutSeconds?: number;
	details?: WaitSubagentsDetails;
}

function seconds(milliseconds: number): string {
	return `${Math.max(0, Math.round(milliseconds / 1_000))}s`;
}

function waitCompletionMs(snapshot: WaitSubagentsDetails["snapshots"][number], startedAt: number): number {
	return snapshot.stopped_at === undefined ? snapshot.elapsed_ms : Math.max(0, snapshot.stopped_at - startedAt);
}

class WaitCallCard extends CachedCard {
	constructor(
		private input: WaitCardInput,
		private theme: Theme,
	) {
		super();
	}

	update(input: WaitCardInput, theme: Theme): void {
		this.input = input;
		this.theme = theme;
		this.invalidate();
	}

	protected build(_width: number): string[] {
		const count = this.input.details?.total ?? this.input.names?.length;
		const strategy = count === 1 ? "" : ` ${this.input.waitFor}`;
		const reason = this.input.details?.reason;
		const outcome =
			reason === "settled"
				? ` done after ${seconds(this.input.details?.elapsed_ms ?? 0)}`
				: reason === "timeout"
					? ` timeout after ${seconds(this.input.details?.elapsed_ms ?? 0)}`
					: reason === "cancelled"
						? ` cancelled after ${seconds(this.input.details?.elapsed_ms ?? 0)}`
						: "";
		return [
			`${this.theme.fg("toolTitle", this.theme.bold("subagent_wait"))}${this.theme.fg("dim", `${strategy}${outcome}`)}`,
		];
	}
}

export function renderSubagentWaitCall(input: WaitCardInput, theme: Theme, lastComponent?: Component): Component {
	const card = lastComponent instanceof WaitCallCard ? lastComponent : new WaitCallCard(input, theme);
	card.update(input, theme);
	return card;
}

class WaitResultCard extends CachedCard {
	constructor(
		private details: WaitSubagentsDetails | undefined,
		private timeoutSeconds: number | undefined,
		private theme: Theme,
		private expanded: boolean,
		private isError: boolean,
	) {
		super();
	}

	update(
		details: WaitSubagentsDetails | undefined,
		timeoutSeconds: number | undefined,
		theme: Theme,
		expanded: boolean,
		isError: boolean,
	): void {
		this.details = details;
		this.timeoutSeconds = timeoutSeconds;
		this.theme = theme;
		this.expanded = expanded;
		this.isError = isError;
		this.invalidate();
	}

	protected build(width: number): string[] {
		if (this.isError) return [this.theme.fg("error", "error")];
		if (!this.details) return [];
		const terminal = this.details.reason !== "pending";
		const lines = this.details.snapshots.map((snapshot) => {
			if (snapshot.state === "stopped") {
				return `${snapshot.name} ${this.theme.fg("success", `done after ${seconds(waitCompletionMs(snapshot, this.details?.started_at ?? 0))}`)}`;
			}
			return terminal ? snapshot.name : `${snapshot.name} ${this.theme.fg("warning", "running")}`;
		});
		if (!terminal && this.timeoutSeconds !== undefined) lines.push(this.theme.fg("muted", `timeout ${this.timeoutSeconds}s`));
		if (this.expanded) {
			for (const snapshot of this.details.snapshots) {
				const handoff =
					snapshot.stop_reason === "finished"
						? snapshot.final_response
						: snapshot.error ?? snapshot.final_response ?? snapshot.stop_message;
				if (handoff) lines.push(...limitedText(`${snapshot.name}: ${handoff}`, width, undefined, this.theme));
			}
		}
		return lines;
	}
}

export function renderSubagentWaitResult(
	details: WaitSubagentsDetails | undefined,
	timeoutSeconds: number | undefined,
	theme: Theme,
	expanded: boolean,
	isError = false,
	lastComponent?: Component,
): Component {
	const card =
		lastComponent instanceof WaitResultCard
			? lastComponent
			: new WaitResultCard(details, timeoutSeconds, theme, expanded, isError);
	card.update(details, timeoutSeconds, theme, expanded, isError);
	return card;
}

export interface ListCardInput {
	states?: readonly string[];
	detail: "compact" | "standard";
}

class ListCallCard extends CachedCard {
	constructor(
		private input: ListCardInput,
		private theme: Theme,
	) {
		super();
	}

	update(input: ListCardInput, theme: Theme): void {
		this.input = input;
		this.theme = theme;
		this.invalidate();
	}

	protected build(_width: number): string[] {
		const states = this.input.states?.length ? this.input.states.join(", ") : "all";
		return [
			`${this.theme.fg("toolTitle", this.theme.bold("subagent_list"))} ${this.theme.fg("accent", states)}${this.theme.fg("dim", ` - ${this.input.detail}`)}`,
		];
	}
}

export function renderSubagentListCall(input: ListCardInput, theme: Theme, lastComponent?: Component): Component {
	const card = lastComponent instanceof ListCallCard ? lastComponent : new ListCallCard(input, theme);
	card.update(input, theme);
	return card;
}

class ListResultCard extends CachedCard {
	constructor(
		private details: ListSubagentsDetails | undefined,
		private detail: "compact" | "standard",
		private theme: Theme,
		private expanded: boolean,
	) {
		super();
	}

	update(details: ListSubagentsDetails | undefined, detail: "compact" | "standard", theme: Theme, expanded: boolean): void {
		this.details = details;
		this.detail = detail;
		this.theme = theme;
		this.expanded = expanded;
		this.invalidate();
	}

	protected build(width: number): string[] {
		const snapshots = this.details?.snapshots ?? [];
		if (snapshots.length === 0) return [this.theme.fg("dim", "No matching subagents")];
		const visible = this.expanded ? snapshots : snapshots.slice(0, COLLAPSED_LIST_ROWS);
		const lines: string[] = [];
		for (const snapshot of visible) {
			lines.push(`${snapshot.name} ${snapshot.id} ${snapshot.state} turn ${snapshot.turns}`);
			if (this.expanded && this.detail === "standard") {
				const timeout = snapshot.timeout_seconds === undefined ? "" : ` timeout ${snapshot.timeout_seconds}s`;
				lines.push(
					this.theme.fg(
						"dim",
						`${snapshot.from ? `from ${snapshot.from} ` : ""}${snapshot.cwd} ${snapshot.model} ${snapshot.thinking_level}${timeout}`,
					),
				);
				lines.push(
					this.theme.fg(
						"dim",
						`elapsed ${Math.round(snapshot.elapsed_ms / 1000)}s idle ${Math.round(snapshot.idle_ms / 1000)}s | ${snapshot.usage.input + snapshot.usage.output + snapshot.usage.cache_read + snapshot.usage.cache_write} tokens | $${snapshot.usage.cost.toFixed(4)}`,
					),
				);
				if (snapshot.current_activity) {
					const activity = snapshot.current_activity.name
						? `${snapshot.current_activity.name}${snapshot.current_activity.preview ? ` ${snapshot.current_activity.preview}` : ""}`
						: snapshot.current_activity.preview ?? snapshot.current_activity.type;
					lines.push(this.theme.fg("muted", `activity: ${activity}`));
				}
				const handoff =
					snapshot.stop_reason === "finished"
						? snapshot.final_response
						: snapshot.error ?? snapshot.final_response ?? snapshot.stop_message;
				lines.push(...limitedText(handoff, width, undefined, this.theme));
			}
		}
		if (!this.expanded && snapshots.length > visible.length) {
			const omitted = snapshots.length - visible.length;
			lines.push(this.theme.fg("dim", `… ${omitted} more subagent${omitted === 1 ? "" : "s"}`));
		}
		return lines;
	}
}

export function renderSubagentListResult(
	details: ListSubagentsDetails | undefined,
	detail: "compact" | "standard",
	theme: Theme,
	expanded: boolean,
	lastComponent?: Component,
): Component {
	const card =
		lastComponent instanceof ListResultCard
			? lastComponent
			: new ListResultCard(details, detail, theme, expanded);
	card.update(details, detail, theme, expanded);
	return card;
}

export interface StopCardInput {
	name: string;
	reason?: string;
}

class StopCallCard extends CachedCard {
	constructor(
		private input: StopCardInput,
		private theme: Theme,
		private expanded: boolean,
	) {
		super();
	}

	update(input: StopCardInput, theme: Theme, expanded: boolean): void {
		this.input = input;
		this.theme = theme;
		this.expanded = expanded;
		this.invalidate();
	}

	protected build(width: number): string[] {
		return [
			`${this.theme.fg("toolTitle", this.theme.bold("subagent_stop"))} ${this.theme.fg("accent", this.input.name)}`,
			...limitedText(this.input.reason, width, this.expanded ? undefined : STOP_REASON_LINES, this.theme),
		];
	}
}

export function renderSubagentStopCall(
	input: StopCardInput,
	theme: Theme,
	expanded: boolean,
	lastComponent?: Component,
): Component {
	const card = lastComponent instanceof StopCallCard ? lastComponent : new StopCallCard(input, theme, expanded);
	card.update(input, theme, expanded);
	return card;
}

class StopResultCard extends CachedCard {
	constructor(
		private details: StopSubagentDetails | undefined,
		private theme: Theme,
		private expanded: boolean,
		private isError: boolean,
	) {
		super();
	}

	update(details: StopSubagentDetails | undefined, theme: Theme, expanded: boolean, isError: boolean): void {
		this.details = details;
		this.theme = theme;
		this.expanded = expanded;
		this.isError = isError;
		this.invalidate();
	}

	protected build(width: number): string[] {
		const snapshot = this.details?.snapshot;
		const lines = [statusLine(this.details?.childId, snapshot?.state ?? (this.isError ? "error" : "running"), this.theme, width)];
		if (this.expanded && snapshot) {
			const details = [snapshot.stop_message, snapshot.error ?? snapshot.final_response].filter(
				(value, index, values): value is string => Boolean(value) && values.indexOf(value) === index,
			);
			for (const detail of details) lines.push(...limitedText(detail, width, undefined, this.theme));
		}
		return lines;
	}
}

export function renderSubagentStopResult(
	details: StopSubagentDetails | undefined,
	theme: Theme,
	expanded: boolean,
	isError = false,
	lastComponent?: Component,
): Component {
	const card = lastComponent instanceof StopResultCard ? lastComponent : new StopResultCard(details, theme, expanded, isError);
	card.update(details, theme, expanded, isError);
	return card;
}
