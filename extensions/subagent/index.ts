import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	renderStaticSubagentCall,
	renderStaticSubagentResult,
	renderSubagentNotificationCard,
	SubagentDashboard,
} from "./render.ts";
import {
	SubagentCreateParams,
	SubagentListParams,
	SubagentSendParams,
	SubagentStopParams,
	SubagentWaitParams,
} from "./schemas.ts";
import { DEFAULT_SUBAGENT_MAX_CONCURRENCY, DEFAULT_SUBAGENT_MAX_DEPTH, SubagentSupervisor } from "./supervisor.ts";
import {
	type ListSubagentsDetails,
	NOTIFICATION_MESSAGE_TYPE,
	ROOT_CALLER_ID,
	type StopSubagentDetails,
	type SubagentToolDetails,
	type WaitSubagentsDetails,
} from "./types.ts";

const MAX_CREATE_DESCRIPTION_LENGTH = 2_000;
const CREATE_DESCRIPTION_PREFIX =
	"Create a persistent in-process SDK subagent and start it in the background. Returns immediately with its immutable id and initial state.";

type ModelDiscoveryContext = ExtensionContext & {
	readonly scopedModels?: ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
};

function canonicalModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function buildSubagentCreateDescription(
	model: Model<Api> | undefined,
	scopedModels: ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> = [],
): string {
	const inheritance = model
		? ` Omitting model inherits the current parent model (${canonicalModel(model)}).`
		: " Omitting model inherits the current parent model.";
	const base = `${CREATE_DESCRIPTION_PREFIX}${inheritance}`;
	if (scopedModels.length === 0) {
		return base.length <= MAX_CREATE_DESCRIPTION_LENGTH
			? base
			: `${base.slice(0, MAX_CREATE_DESCRIPTION_LENGTH - 1)}…`;
	}

	const lead = `${base} Preferred available choices: `;
	const choices = scopedModels.map(
		(scoped) => `${canonicalModel(scoped.model)}${scoped.thinkingLevel ? `:${scoped.thinkingLevel}` : ""}`,
	);
	let description = lead;
	for (const [index, choice] of choices.entries()) {
		const separator = index === 0 ? "" : ", ";
		const suffix = index === choices.length - 1 ? "." : ", …";
		if (`${description}${separator}${choice}${suffix}`.length > MAX_CREATE_DESCRIPTION_LENGTH) break;
		description += `${separator}${choice}`;
	}
	if (description === lead) return `${lead.slice(0, MAX_CREATE_DESCRIPTION_LENGTH - 1)}…`;
	return `${description}${description.endsWith(choices.at(-1) ?? "") ? "." : ", …"}`;
}

export default function SubagentExtension(pi: ExtensionAPI): void {
	pi.registerFlag("subagent-max-depth", {
		description: "Maximum subagent recursion depth (nonnegative integer)",
		type: "string",
		default: String(DEFAULT_SUBAGENT_MAX_DEPTH),
	});
	pi.registerFlag("subagent-max-concurrency", {
		description: "Maximum concurrent subagent runs (positive integer)",
		type: "string",
		default: String(DEFAULT_SUBAGENT_MAX_CONCURRENCY),
	});

	let supervisor: SubagentSupervisor | undefined;
	const dashboardWidgetKey = "subagent-dashboard";

	const clearDashboard = (context: ExtensionContext) => {
		if (context.mode === "tui") context.ui.setWidget(dashboardWidgetKey, undefined);
	};

	const installDashboard = (context: ExtensionContext, current: SubagentSupervisor) => {
		if (context.mode !== "tui") return;
		context.ui.setWidget(dashboardWidgetKey, (tui, theme) => {
			const dashboard = new SubagentDashboard(
				() => current.getDashboardChildren(),
				() => context.ui.getToolsExpanded(),
				() => Math.max(4, Math.min(24, Math.floor(tui.terminal.rows * 0.4))),
				theme,
				() => current.registerDashboardInvalidator(undefined),
			);
			current.registerDashboardInvalidator(() => {
				dashboard.invalidate();
				tui.requestRender();
			});
			return dashboard;
		});
	};

	const requireSupervisor = (): SubagentSupervisor => {
		if (!supervisor) throw new Error("Subagent supervisor is not initialized for this session");
		return supervisor;
	};

	const registerCreateTool = (context: ModelDiscoveryContext, model = context.model) => {
		pi.registerTool({
			name: "subagent_create",
			label: "Subagent Create",
			description: buildSubagentCreateDescription(model, context.scopedModels),
			promptSnippet: "Create a persistent background subagent with isolated context",
			promptGuidelines: [
				"Use subagent_create for bounded parallel work that benefits from an isolated conversation context.",
				"Use subagent_wait or subagent_list instead of polling subagents repeatedly.",
			],
			parameters: SubagentCreateParams,
			executionMode: "sequential",
			execute: async (_toolCallId, params, signal) =>
				requireSupervisor().createSubagent(ROOT_CALLER_ID, params, signal),
			renderCall(args, theme, renderContext) {
				const prompt = args.context ? `${args.context}\n\n${args.task}` : args.task;
				return renderStaticSubagentCall(
					"create",
					args.name?.trim() || "new subagent",
					prompt,
					theme,
					renderContext.expanded,
					renderContext.lastComponent,
				);
			},
			renderResult(result, _options, theme) {
				return renderStaticSubagentResult(result.details as SubagentToolDetails | undefined, theme);
			},
		});
	};

	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description: "List event-derived status snapshots for matching subagents without invoking another model.",
		promptSnippet: "Inspect current subagent states and activity",
		parameters: SubagentListParams,
		execute: async (_toolCallId, params) => requireSupervisor().listSubagents(ROOT_CALLER_ID, params),
		renderResult(result, _options, theme) {
			const details = result.details as ListSubagentsDetails | undefined;
			if (!details) return new Text(theme.fg("muted", "No subagent details"), 0, 0);
			const lines = details.snapshots.map(
				(snapshot) =>
					`${theme.fg("accent", snapshot.name)} ${theme.fg("muted", snapshot.state)} ${theme.fg("dim", `turn ${snapshot.turns}`)}`,
			);
			return new Text(lines.join("\n") || theme.fg("dim", "No matching subagents"), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Subagent Send",
		description:
			"Answer, steer, queue a follow-up, or continue a retained subagent. Auto steers running children and starts a new run for idle children.",
		promptSnippet: "Send context or continue a persistent subagent",
		parameters: SubagentSendParams,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => requireSupervisor().sendSubagent(ROOT_CALLER_ID, params, signal),
		renderCall(args, theme, renderContext) {
			return renderStaticSubagentCall(
				"send",
				args.name,
				args.message,
				theme,
				renderContext.expanded,
				renderContext.lastComponent,
			);
		},
		renderResult(result, _options, theme) {
			return renderStaticSubagentResult(result.details as SubagentToolDetails | undefined, theme);
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description:
			"Wait by subscription for selected subagents to reach requested states; streams compact updates while waiting.",
		promptSnippet: "Wait for subagent state changes without polling",
		parameters: SubagentWaitParams,
		execute: async (_toolCallId, params, signal, onUpdate) =>
			requireSupervisor().waitSubagents(ROOT_CALLER_ID, params, signal, onUpdate),
		renderResult(result, options, theme) {
			const details = result.details as WaitSubagentsDetails | undefined;
			const status = details?.matched
				? `${details.matched.name}: ${details.matched.state}`
				: `wait ${details?.reason ?? "pending"}`;
			const color =
				options.isPartial || details?.reason === "pending"
					? "muted"
					: details?.reason === "event"
						? "success"
						: "muted";
			return new Text(theme.fg(color, status), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: "Reversibly stop a subagent and retain its context for later resumption.",
		promptSnippet: "Reversibly stop a subagent",
		parameters: SubagentStopParams,
		execute: async (_toolCallId, params, signal) => requireSupervisor().stopSubagent(ROOT_CALLER_ID, params, signal),
		renderResult(result, _options, theme) {
			const details = result.details as StopSubagentDetails | undefined;
			return new Text(
				details
					? `${theme.fg("accent", details.snapshot.name)} ${theme.fg("muted", details.snapshot.state)}`
					: theme.fg("muted", "Subagent stopped"),
				0,
				0,
			);
		},
	});

	pi.registerMessageRenderer(NOTIFICATION_MESSAGE_TYPE, (message, options, theme) =>
		renderSubagentNotificationCard(String(message.content), theme, options.expanded),
	);

	pi.on("session_start", (_event, context) => {
		registerCreateTool(context as ModelDiscoveryContext);
	});

	pi.on("model_select", (event, context) => {
		registerCreateTool(context as ModelDiscoveryContext, event.model);
	});

	pi.on("agent_settled", () => {
		supervisor?.remindWaitingDescendants();
	});

	pi.on("session_start", async (_event, context) => {
		supervisor = await SubagentSupervisor.create(pi, context);
		installDashboard(context, supervisor);
	});

	pi.on("session_tree", async (_event, context) => {
		clearDashboard(context);
		await supervisor?.shutdown(false);
		supervisor = await SubagentSupervisor.create(pi, context);
		installDashboard(context, supervisor);
	});

	pi.on("session_shutdown", async (_event, context) => {
		clearDashboard(context);
		await supervisor?.shutdown();
		supervisor = undefined;
	});
}
