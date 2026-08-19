import { relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CreateCardRegistry,
	renderSubagentCreateCall,
	renderSubagentCreateResult,
	renderSubagentListCall,
	renderSubagentListResult,
	renderSubagentStopCall,
	renderSubagentStopResult,
	renderSubagentWaitCall,
	renderSubagentWaitResult,
} from "./cards.ts";
import { renderSubagentNotificationCard, SubagentDashboard } from "./render.ts";
import { SubagentCreateParams, SubagentListParams, SubagentStopParams, SubagentWaitParams } from "./schemas.ts";
import { DEFAULT_SUBAGENT_MAX_CONCURRENCY, DEFAULT_SUBAGENT_MAX_DEPTH, SubagentSupervisor } from "./supervisor.ts";
import {
	type CreateSubagentDetails,
	type ListSubagentsDetails,
	NOTIFICATION_MESSAGE_TYPE,
	ROOT_CALLER_ID,
	type StopSubagentDetails,
	type SubagentSnapshot,
	type WaitSubagentsDetails,
} from "./types.ts";

const MAX_CREATE_DESCRIPTION_LENGTH = 2_000;
const CREATE_DESCRIPTION_PREFIX =
	"Create a fresh subagent or a continuation from stopped history. Waits by default; use mode background only for explicit detached work. For 2+ independent tasks, emit sibling subagent_create calls in one response.";

type ModelDiscoveryContext = ExtensionContext & {
	readonly scopedModels?: ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
};

type CreateCardState = { snapshot?: SubagentSnapshot };
type WaitCardState = { details?: WaitSubagentsDetails };

function canonicalModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function relativeCwd(baseCwd: string, childCwd: string): string {
	return relative(resolve(baseCwd), resolve(baseCwd, childCwd)) || ".";
}

export function buildSubagentCreateDescription(
	model: Model<Api> | undefined,
	scopedModels: ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> = [],
): string {
	const inheritance = model
		? ` Omitting model inherits the current parent or source model (${canonicalModel(model)}).`
		: " Omitting model inherits the current parent or source model.";
	const base = `${CREATE_DESCRIPTION_PREFIX}${inheritance}`;
	if (scopedModels.length === 0) return base.slice(0, MAX_CREATE_DESCRIPTION_LENGTH);
	const choices = scopedModels.map(
		(scoped) => `${canonicalModel(scoped.model)}${scoped.thinkingLevel ? `:${scoped.thinkingLevel}` : ""}`,
	);
	let description = `${base} Preferred available choices: `;
	for (const [index, choice] of choices.entries()) {
		const separator = index === 0 ? "" : ", ";
		if (`${description}${separator}${choice}, …`.length > MAX_CREATE_DESCRIPTION_LENGTH) break;
		description += `${separator}${choice}`;
	}
	return `${description}${description.endsWith(choices.at(-1) ?? "") ? "." : ", …"}`.slice(0, MAX_CREATE_DESCRIPTION_LENGTH);
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
	const createCards = new CreateCardRegistry();
	const dashboardWidgetKey = "subagent-dashboard";
	const requireSupervisor = () => {
		if (!supervisor) throw new Error("Subagent supervisor is not initialized for this session");
		return supervisor;
	};
	const clearDashboard = (context: ExtensionContext) => {
		createCards.clear();
		if (context.mode === "tui") context.ui.setWidget(dashboardWidgetKey, undefined);
	};
	const installDashboard = (context: ExtensionContext, current: SubagentSupervisor) => {
		if (context.mode !== "tui") return;
		createCards.update(current.getDashboardChildren().map((child) => child.snapshot));
		context.ui.setWidget(dashboardWidgetKey, (tui, theme) => {
			const dashboard = new SubagentDashboard(
				() => current.getDashboardChildren(),
				() => context.ui.getToolsExpanded(),
				() => Math.max(4, Math.min(24, Math.floor(tui.terminal.rows * 0.4))),
				theme,
				() => current.registerDashboardInvalidator(undefined),
			);
			current.registerDashboardInvalidator(() => {
				createCards.update(current.getDashboardChildren().map((child) => child.snapshot));
				dashboard.invalidate();
				tui.requestRender();
			});
			return dashboard;
		});
	};

	const registerCreateTool = (context: ModelDiscoveryContext, model = context.model) => {
		pi.registerTool({
			name: "subagent_create",
			label: "Subagent Create",
			description: buildSubagentCreateDescription(model, context.scopedModels),
			promptSnippet: "Create an isolated child or continuation; wait by default",
			promptGuidelines: [
				"Use subagent_create for bounded work that benefits from isolated context or a different model/effort.",
				"For 2 or more independent tasks, emit only their subagent_create calls as siblings in one response so wait-mode children run concurrently; use management tools in a later turn.",
				"Use from with a stopped child ID to answer a question or continue retained history.",
				"Use background mode only when the parent must continue before that child stops; then join it with subagent_wait.",
			],
			parameters: SubagentCreateParams,
			executionMode: "parallel",
			execute: async (_id, params, signal, onUpdate) =>
				requireSupervisor().createSubagent(ROOT_CALLER_ID, params, signal, onUpdate),
			renderCall(args, theme, renderContext) {
				const live = ((renderContext.state ?? {}) as CreateCardState).snapshot;
				const parentCwd = context.cwd ?? ".";
				const parentModel = model ? canonicalModel(model) : "default";
				const parentThinking = context.thinkingLevel ?? pi.getThinkingLevel?.() ?? "off";
				const childCwd = live?.cwd ?? args.cwd ?? parentCwd;
				const childModel = live?.model ?? args.model ?? parentModel;
				const childThinking = live?.thinking_level ?? args.thinking_level ?? parentThinking;
				return renderSubagentCreateCall(
					{
						name: live?.name ?? args.name,
						from: live?.from ?? args.from,
						mode: args.mode ?? "wait",
						systemPrompt: args.system_prompt,
						context: args.context,
						task: args.task,
						cwd: resolve(parentCwd, childCwd) === resolve(parentCwd) ? undefined : relativeCwd(parentCwd, childCwd),
						model: childModel === parentModel ? undefined : childModel,
						thinkingLevel: childThinking === parentThinking ? undefined : childThinking,
						timeoutSeconds: live?.timeout_seconds ?? args.limits?.timeout_seconds,
					},
					theme,
					renderContext.expanded,
					renderContext.lastComponent,
				);
			},
			renderResult(result, options, theme, renderContext) {
				const rawDetails = result.details as CreateSubagentDetails | undefined;
				const details = rawDetails ? createCards.bind(rawDetails, renderContext.invalidate) : undefined;
				const state = (renderContext.state ?? {}) as CreateCardState;
				if (details?.snapshot && state.snapshot !== details.snapshot) {
					state.snapshot = details.snapshot;
					queueMicrotask(() => renderContext.invalidate?.());
				}
				return renderSubagentCreateResult(
					details,
					theme,
					options.expanded,
					options.isPartial,
					renderContext.isError,
					renderContext.lastComponent,
				);
			},
		});
	};

	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description: "List event-derived snapshots of running or stopped subagents without invoking another model.",
		promptSnippet: "Inspect subagent state, lineage, activity, handoff, and errors",
		parameters: SubagentListParams,
		execute: async (_id, params) => requireSupervisor().listSubagents(ROOT_CALLER_ID, params),
		renderCall(args, theme, renderContext) {
			return renderSubagentListCall(
				{ states: args.states, detail: args.detail ?? "standard" },
				theme,
				renderContext.lastComponent,
			);
		},
		renderResult(result, options, theme, renderContext) {
			return renderSubagentListResult(
				result.details as ListSubagentsDetails | undefined,
				renderContext.args.detail ?? "standard",
				theme,
				options.expanded,
				renderContext.lastComponent,
			);
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description: "Wait for any or all selected background subagents to stop. A timeout releases only the parent wait.",
		promptSnippet: "Join any or all background subagents",
		parameters: SubagentWaitParams,
		execute: async (_id, params, signal, onUpdate) =>
			requireSupervisor().waitSubagents(ROOT_CALLER_ID, params, signal, onUpdate),
		renderCall(args, theme, renderContext) {
			const details = ((renderContext.state ?? {}) as WaitCardState).details;
			return renderSubagentWaitCall(
				{ names: args.names, waitFor: args.for ?? "all", timeoutSeconds: args.timeout_seconds, details },
				theme,
				renderContext.lastComponent,
			);
		},
		renderResult(result, options, theme, renderContext) {
			const details = result.details as WaitSubagentsDetails | undefined;
			const state = (renderContext.state ?? {}) as WaitCardState;
			if (details && state.details !== details) {
				state.details = details;
				queueMicrotask(() => renderContext.invalidate?.());
			}
			return renderSubagentWaitResult(
				details,
				renderContext.args.timeout_seconds,
				theme,
				options.expanded,
				renderContext.isError,
				renderContext.lastComponent,
			);
		},
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: "Abort an active subagent and retain its durable history for a new continuation.",
		promptSnippet: "Stop active work while retaining history",
		parameters: SubagentStopParams,
		execute: async (_id, params, signal, onUpdate) =>
			requireSupervisor().stopSubagent(ROOT_CALLER_ID, params, signal, onUpdate),
		renderCall(args, theme, renderContext) {
			return renderSubagentStopCall(
				{ name: args.name, reason: args.reason },
				theme,
				renderContext.expanded,
				renderContext.lastComponent,
			);
		},
		renderResult(result, options, theme, renderContext) {
			return renderSubagentStopResult(
				result.details as StopSubagentDetails | undefined,
				theme,
				options.expanded,
				renderContext.isError,
				renderContext.lastComponent,
			);
		},
	});

	pi.registerMessageRenderer(NOTIFICATION_MESSAGE_TYPE, (message, options, theme) =>
		renderSubagentNotificationCard(String(message.content), theme, options.expanded),
	);

	pi.on("session_start", (_event, context) => registerCreateTool(context as ModelDiscoveryContext));
	pi.on("model_select", (event, context) => registerCreateTool(context as ModelDiscoveryContext, event.model));
	pi.on("agent_settled", () => supervisor?.remindRunningDescendants());
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
