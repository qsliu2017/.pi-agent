import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentMessage, AgentToolUpdateCallback, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type Api, type AssistantMessage, type Model, type Provider } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
	type SubagentCreateInput,
	SubagentCreateParams,
	type SubagentListInput,
	SubagentListParams,
	type SubagentStopInput,
	SubagentStopParams,
	type SubagentWaitInput,
	SubagentWaitParams,
} from "./schemas.ts";
import {
	type CreateSubagentDetails,
	type CurrentActivity,
	type DashboardChildView,
	type ListSubagentsDetails,
	NOTIFICATION_MESSAGE_TYPE,
	type PersistedChild,
	type PersistedRegistry,
	REGISTRY_ENTRY_TYPE,
	ROOT_CALLER_ID,
	type StopReason,
	type StopSubagentDetails,
	type SubagentLimits,
	type SubagentMode,
	type SubagentSnapshot,
	type SubagentState,
	type ToolActivityView,
	type TurnView,
	type UsageSnapshot,
	type WaitFor,
	type WaitSubagentsDetails,
} from "./types.ts";

export const DEFAULT_SUBAGENT_MAX_DEPTH = 3;
export const DEFAULT_SUBAGENT_MAX_CONCURRENCY = 4;
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const MANAGEMENT_TOOL_NAMES = ["subagent_list", "subagent_wait", "subagent_stop"];
const MAX_PREVIEW_CHARS = 4_000;
const MAX_RETAINED_TURNS = 5;
const RENDER_THROTTLE_MS = 40;
const NOTIFICATION_BATCH_MS = 75;
const LEGACY_REGISTRY_ENTRY_TYPE = "subagent.registry.v1";

class Mutex {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(operation: () => Promise<T> | T): Promise<T> {
		let release = () => {};
		const previous = this.tail;
		this.tail = new Promise<void>((resolveTail) => {
			release = resolveTail;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

type AbortCause = "requested" | "timeout" | "shutdown";

interface ChildRecord {
	metadata: PersistedChild;
	session?: AgentSession;
	manager?: SessionManager;
	unsubscribe?: () => void;
	lock: Mutex;
	runPromise?: Promise<void>;
	runMessageStart?: number;
	abortCause?: AbortCause;
	claimed: boolean;
	activeStartedAt?: number;
	timeout?: ReturnType<typeof setTimeout>;
	currentActivity?: CurrentActivity;
	activeActivities: Map<string, ToolActivityView>;
	turns: TurnView[];
}

interface Waiter {
	id: string;
	startedAt: number;
	selectedIds: Set<string>;
	waitFor: WaitFor;
	resolve: (reason: "settled" | "timeout" | "cancelled", matchedId?: string) => void;
	timeout?: ReturnType<typeof setTimeout>;
	updateInterval?: ReturnType<typeof setInterval>;
	signal?: AbortSignal;
	abortListener?: () => void;
	onUpdate?: AgentToolUpdateCallback<WaitSubagentsDetails>;
}

export interface SubagentHarnessLimits {
	maxDepth: number;
	maxConcurrency: number;
}

function parseIntegerFlag(pi: ExtensionAPI, name: string, fallback: number, minimum: number): number {
	const value = pi.getFlag(name);
	const text = value === undefined ? String(fallback) : value;
	if (typeof text !== "string" || text.trim() === "") {
		throw new Error(`--${name} must be ${minimum === 0 ? "a nonnegative" : "a positive"} integer`);
	}
	const parsed = Number(text);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) {
		throw new Error(`--${name} must be ${minimum === 0 ? "a nonnegative" : "a positive"} integer`);
	}
	return parsed;
}

export function parseSubagentHarnessLimits(pi: ExtensionAPI): SubagentHarnessLimits {
	return {
		maxDepth: parseIntegerFlag(pi, "subagent-max-depth", DEFAULT_SUBAGENT_MAX_DEPTH, 0),
		maxConcurrency: parseIntegerFlag(pi, "subagent-max-concurrency", DEFAULT_SUBAGENT_MAX_CONCURRENCY, 1),
	};
}

function emptyUsage(): UsageSnapshot {
	return { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 };
}

function truncatePreview(text: string | undefined): string | undefined {
	const normalized = text?.trim();
	if (!normalized) return undefined;
	return normalized.length > MAX_PREVIEW_CHARS ? `${normalized.slice(0, MAX_PREVIEW_CHARS)}...` : normalized;
}

function assistantText(message: AgentMessage | undefined): string | undefined {
	if (!message || message.role !== "assistant") return undefined;
	return (
		message.content
			.flatMap((content) => (content.type === "text" ? [content.text] : []))
			.join("\n")
			.trim() || undefined
	);
}

function assistantPreviews(message: AgentMessage): { text?: string; thinking?: string } {
	if (message.role !== "assistant") return {};
	const text: string[] = [];
	const thinking: string[] = [];
	for (const content of message.content) {
		if (content.type === "text") text.push(content.text);
		if (content.type === "thinking") thinking.push(content.thinking);
	}
	return { text: truncatePreview(text.join("\n")), thinking: truncatePreview(thinking.join("\n")) };
}

function textFromUnknown(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.text === "string") return truncatePreview(record.text);
	if (Array.isArray(record.content)) {
		return truncatePreview(
			record.content
				.flatMap((item) => {
					if (!item || typeof item !== "object") return [];
					const content = item as Record<string, unknown>;
					return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
				})
				.join("\n"),
		);
	}
	try {
		return truncatePreview(JSON.stringify(value));
	} catch {
		return undefined;
	}
}

function toolPreview(name: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const values = args as Record<string, unknown>;
	if (name === "bash" && typeof values.command === "string") return truncatePreview(values.command);
	if (typeof values.path === "string") return values.path;
	return textFromUnknown(args);
}

function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

function rebuildTurns(messages: AgentMessage[]): TurnView[] {
	const turns: TurnView[] = [];
	const tools = new Map<string, ToolActivityView>();
	for (const message of messages) {
		if (message.role === "assistant") {
			const previews = assistantPreviews(message);
			const turn: TurnView = {
				index: turns.length + 1,
				textPreview: previews.text,
				thinkingPreview: previews.thinking,
				activities: [],
				startedAt: message.timestamp,
				endedAt: message.timestamp,
			};
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const activity: ToolActivityView = {
					toolCallId: content.id,
					name: content.name,
					preview: toolPreview(content.name, content.arguments),
					startedAt: message.timestamp,
				};
				turn.activities.push(activity);
				tools.set(content.id, activity);
			}
			turns.push(turn);
		} else if (message.role === "toolResult") {
			const activity = tools.get(message.toolCallId);
			if (activity) {
				activity.endedAt = message.timestamp;
				activity.isError = message.isError;
				activity.resultPreview = textFromUnknown(message);
			}
		}
	}
	return turns;
}

function exactResourceLoader(systemPrompt: string): ResourceLoader {
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function isPersistedRegistry(value: unknown): value is PersistedRegistry {
	if (!value || typeof value !== "object") return false;
	const registry = value as Partial<PersistedRegistry>;
	return (
		registry.version === 2 &&
		typeof registry.ownerSessionId === "string" &&
		typeof registry.sequence === "number" &&
		typeof registry.dashboardOrderSequence === "number" &&
		Array.isArray(registry.children)
	);
}

function migrateLegacyRegistry(value: unknown): PersistedRegistry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const legacy = value as Record<string, unknown>;
	if (
		legacy.version !== 1 ||
		typeof legacy.ownerSessionId !== "string" ||
		typeof legacy.sequence !== "number" ||
		!Array.isArray(legacy.children)
	) {
		return undefined;
	}
	const children = legacy.children.flatMap((item): PersistedChild[] => {
		if (!item || typeof item !== "object") return [];
		const child = item as Record<string, any>;
		if (
			typeof child.id !== "string" ||
			typeof child.name !== "string" ||
			typeof child.sessionPath !== "string" ||
			typeof child.cwd !== "string"
		) {
			return [];
		}
		const legacyState = String(child.state ?? "paused");
		const finalResponse =
			(typeof child.lastYield?.content === "string" ? child.lastYield.content : undefined) ??
			[...(Array.isArray(child.latestTurns) ? child.latestTurns : [])]
				.reverse()
				.find((turn) => typeof turn?.textPreview === "string")?.textPreview;
		const generatedSystemPrompt = String(child.generatedSystemPrompt ?? "");
		const rolePrompt = generatedSystemPrompt.match(/<parent_role_prompt>\s*([\s\S]*?)\s*<\/parent_role_prompt>/)?.[1];
		const stopReason: StopReason =
			legacyState === "failed"
				? "error"
				: legacyState === "running" || legacyState === "creating" || legacyState === "stopping"
					? "recovered"
					: legacyState === "paused"
						? "requested"
						: "finished";
		return [
			{
				id: child.id,
				name: child.name,
				parentId: typeof child.parentId === "string" ? child.parentId : null,
				depth: typeof child.depth === "number" ? child.depth : 1,
				remainingDepth: typeof child.remainingDepth === "number" ? child.remainingDepth : 0,
				childSessionId: String(child.childSessionId ?? child.id),
				childLeafId: typeof child.childLeafId === "string" ? child.childLeafId : null,
				sessionPath: child.sessionPath,
				cwd: child.cwd,
				task: String(child.task ?? "Recovered task"),
				context: typeof child.context === "string" ? child.context : undefined,
				modelProvider: String(child.modelProvider ?? "unknown"),
				modelId: String(child.modelId ?? "unknown"),
				thinkingLevel: child.thinkingLevel ?? "off",
				rolePrompt,
				generatedSystemPrompt,
				enabledTools: Array.isArray(child.enabledTools) ? child.enabledTools.filter((name: unknown) => typeof name === "string") : [],
				limits: {
					timeoutSeconds:
						typeof child.limits?.timeoutSeconds === "number" ? child.limits.timeoutSeconds : undefined,
				},
				state: "stopped",
				stopReason,
				finalResponse,
				error:
					typeof child.error === "string"
						? child.error
						: stopReason === "recovered"
							? "Interrupted before redesign recovery"
							: undefined,
				turns: typeof child.turns === "number" ? child.turns : 0,
				createdAt: typeof child.createdAt === "number" ? child.createdAt : Date.now(),
				updatedAt: Date.now(),
				lastActivityAt: typeof child.lastActivityAt === "number" ? child.lastActivityAt : Date.now(),
				dashboardOrder: typeof child.dashboardOrder === "number" ? child.dashboardOrder : 0,
				activeMs: typeof child.cumulativeActiveMs === "number" ? child.cumulativeActiveMs : 0,
				usage: child.usage ?? emptyUsage(),
				latestTurns: Array.isArray(child.latestTurns) ? child.latestTurns.slice(-MAX_RETAINED_TURNS) : [],
				notifyOnStop: false,
			},
		];
	});
	return {
		version: 2,
		ownerSessionId: legacy.ownerSessionId,
		sequence: legacy.sequence,
		dashboardOrderSequence:
			typeof legacy.dashboardOrderSequence === "number" ? legacy.dashboardOrderSequence : children.length,
		children,
	};
}

export class SubagentSupervisor {
	private readonly pi: ExtensionAPI;
	private readonly rootContext: ExtensionContext;
	private readonly modelRuntime: ModelRuntime;
	private readonly agentDir: string;
	private readonly childSessionDir: string;
	private readonly ownerSessionId: string;
	private readonly maxDepth: number;
	private readonly maxConcurrency: number;
	private readonly children = new Map<string, ChildRecord>();
	private readonly operationLock = new Mutex();
	private readonly waiters = new Map<string, Waiter>();
	private dashboardInvalidator?: () => void;
	private dashboardTimer?: ReturnType<typeof setTimeout>;
	private rootNotificationTimer?: ReturnType<typeof setTimeout>;
	private readonly rootNotifications = new Map<string, string>();
	private readonly reminderKeys = new Map<string, string>();
	private sequence = 0;
	private dashboardOrderSequence = 0;
	private accepting = true;
	private persistenceEnabled = true;
	private disposed = false;
	private shutdownPromise?: Promise<void>;

	private constructor(
		pi: ExtensionAPI,
		context: ExtensionContext,
		modelRuntime: ModelRuntime,
		harnessLimits: SubagentHarnessLimits = {
			maxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
			maxConcurrency: DEFAULT_SUBAGENT_MAX_CONCURRENCY,
		},
	) {
		this.pi = pi;
		this.rootContext = context;
		this.modelRuntime = modelRuntime;
		this.maxDepth = harnessLimits.maxDepth;
		this.maxConcurrency = harnessLimits.maxConcurrency;
		this.agentDir = getAgentDir();
		this.ownerSessionId = context.sessionManager.getSessionId();
		this.childSessionDir = join(this.agentDir, "subagents", this.ownerSessionId, "sessions");
	}

	static async create(pi: ExtensionAPI, context: ExtensionContext): Promise<SubagentSupervisor> {
		const agentDir = getAgentDir();
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		const supervisor = new SubagentSupervisor(pi, context, runtime, parseSubagentHarnessLimits(pi));
		await supervisor.recover();
		return supervisor;
	}

	registerDashboardInvalidator(invalidate: (() => void) | undefined): void {
		if (!this.disposed) this.dashboardInvalidator = invalidate;
	}

	getDashboardChildren(): DashboardChildView[] {
		return [...this.children.values()].map((record) => ({
			snapshot: this.snapshot(record),
			turns: this.cloneTurns(record.turns),
			dashboardOrder: record.metadata.dashboardOrder,
			parentId: record.metadata.parentId,
		}));
	}

	remindRunningDescendants(): void {
		if (!this.accepting || this.disposed) return;
		const content = this.runningReminder(ROOT_CALLER_ID);
		if (!content) return;
		this.pi.sendMessage(
			{ customType: NOTIFICATION_MESSAGE_TYPE, content, display: true, details: { source: "subagent-reminder" } },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	async createSubagent(
		callerId: string,
		params: SubagentCreateInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<CreateSubagentDetails>,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: CreateSubagentDetails }> {
		const mode: SubagentMode = params.mode ?? "wait";
		const { record, acceptedAt } = await this.operationLock.run(async () => {
			this.assertAccepting();
			this.throwIfAborted(signal);
			if (!params.task.trim()) throw new Error("Subagent task must not be empty");
			if (this.activeRunCount() >= this.maxConcurrency) {
				throw new Error(`Subagent concurrency limit reached (${this.maxConcurrency})`);
			}

			const owner = callerId === ROOT_CALLER_ID ? undefined : this.requireChild(callerId);
			if (owner && owner.metadata.remainingDepth <= 0) throw new Error("Subagent recursion depth exhausted");
			const depth = owner ? owner.metadata.depth + 1 : 1;
			if (depth > this.maxDepth) throw new Error(`Subagent depth limit reached (${this.maxDepth})`);
			const remainingDepth = this.maxDepth - depth;
			const source = params.from ? this.resolveOne(callerId, params.from) : undefined;
			if (source?.metadata.state === "running") {
				throw new Error(`Source subagent ${source.metadata.name} is still running; wait for or stop it first`);
			}

			const baseCwd = owner?.metadata.cwd ?? this.rootContext.cwd;
			const requestedCwd = params.cwd ?? source?.metadata.cwd;
			const cwd = await this.resolveCwd(requestedCwd, baseCwd, owner !== undefined);
			const inheritedTools = owner?.metadata.enabledTools.filter((name) => BUILTIN_TOOLS.has(name));
			const sourceTools = source?.metadata.enabledTools.filter((name) => BUILTIN_TOOLS.has(name));
			const requestedTools = params.tools ?? sourceTools ?? inheritedTools ?? [...DEFAULT_TOOLS];
			const builtins = this.validateTools(requestedTools, inheritedTools);
			const configuredFallback = source
				? { provider: source.metadata.modelProvider, id: source.metadata.modelId }
				: owner
					? { provider: owner.metadata.modelProvider, id: owner.metadata.modelId }
					: undefined;
			const fallbackModel = configuredFallback
				? this.modelRuntime.getModel(configuredFallback.provider, configuredFallback.id) ??
					this.rootContext.modelRegistry
						.getAll()
						.find((candidate) => candidate.provider === configuredFallback.provider && candidate.id === configuredFallback.id)
				: this.rootContext.model;
			const model = await this.resolveModel(params.model, fallbackModel);
			this.throwIfAborted(signal);
			const thinkingLevel =
				params.thinking_level ?? source?.metadata.thinkingLevel ?? owner?.metadata.thinkingLevel ?? this.pi.getThinkingLevel();
			const rolePrompt = params.system_prompt ?? source?.metadata.rolePrompt;
			const id = randomUUID();
			const name = params.name?.trim() || `${source?.metadata.name ?? "subagent"}-${id.slice(0, 8)}`;
			const limits: SubagentLimits = { timeoutSeconds: params.limits?.timeout_seconds };
			const privateNames = [...MANAGEMENT_TOOL_NAMES, ...(remainingDepth > 0 ? ["subagent_create"] : [])];
			const enabledTools = [...new Set([...builtins, ...privateNames])];
			const generatedSystemPrompt = this.generateSystemPrompt({
				id,
				name,
				cwd,
				parentName: owner?.metadata.name ?? "parent Pi session",
				remainingDepth,
				enabledTools,
				limits,
				rolePrompt,
			});
			const manager = source ? this.cloneSourceManager(source, cwd) : SessionManager.create(cwd, this.childSessionDir);
			const sessionPath = manager.getSessionFile();
			if (!sessionPath) throw new Error("Failed to allocate a persistent child session path");
			const now = Date.now();
			const metadata: PersistedChild = {
				id,
				name,
				parentId: owner?.metadata.id ?? null,
				fromId: source?.metadata.id,
				depth,
				remainingDepth,
				childSessionId: manager.getSessionId(),
				childLeafId: manager.getLeafId(),
				sessionPath,
				cwd,
				task: params.task,
				context: params.context,
				modelProvider: model.provider,
				modelId: model.id,
				thinkingLevel,
				rolePrompt,
				generatedSystemPrompt,
				enabledTools,
				limits,
				state: "running",
				turns: 0,
				createdAt: now,
				updatedAt: now,
				lastActivityAt: now,
				dashboardOrder: ++this.dashboardOrderSequence,
				activeMs: 0,
				usage: emptyUsage(),
				latestTurns: [],
				notifyOnStop: mode === "background",
			};
			const record = this.newRecord(metadata, manager);
			record.claimed = mode === "wait";
			try {
				await this.openRuntime(record, model);
				this.throwIfAborted(signal);
				this.children.set(id, record);
				this.persistRegistry();
				this.invalidateDashboard(false);
				this.startRun(record, this.initialMessage(params.task, params.context));
				return { record, acceptedAt: Date.now() };
			} catch (error) {
				this.children.delete(id);
				this.releaseRuntime(record);
				this.persistRegistry();
				this.invalidateDashboard(false);
				throw error;
			}
		});

		if (mode === "background") return this.createResult(record, mode, acceptedAt, false);

		const releaseClaim = () => {
			if (record.metadata.state === "running") {
				record.claimed = false;
				record.metadata.notifyOnStop = true;
				this.persistRegistry();
			}
		};
		if (signal?.aborted) releaseClaim();
		else signal?.addEventListener("abort", releaseClaim, { once: true });
		const updateInterval = onUpdate
			? setInterval(() => onUpdate(this.createResult(record, mode, acceptedAt, true)), 1_000)
			: undefined;
		try {
			await this.waitForRun(record, signal);
			return this.createResult(record, mode, acceptedAt, false);
		} finally {
			if (updateInterval) clearInterval(updateInterval);
			signal?.removeEventListener("abort", releaseClaim);
			record.claimed = false;
		}
	}

	listSubagents(
		callerId: string,
		params: SubagentListInput,
	): { content: Array<{ type: "text"; text: string }>; details: ListSubagentsDetails } {
		this.assertAccepting();
		const selected = params.names ? this.resolveMany(callerId, params.names) : this.allowedChildren(callerId);
		const states = params.states ? new Set<SubagentState>(params.states) : undefined;
		const snapshots = selected.filter((record) => !states || states.has(record.metadata.state)).map((record) => this.snapshot(record));
		const text =
			params.detail === "compact"
				? snapshots.map((snapshot) => `${snapshot.name} (${snapshot.id}): ${snapshot.state}`).join("\n") ||
					"No matching subagents."
				: JSON.stringify(snapshots, null, 2);
		return {
			content: [{ type: "text", text: truncateHead(text, { maxBytes: 40_000, maxLines: 1_000 }).content }],
			details: { snapshots },
		};
	}

	async waitSubagents(
		callerId: string,
		params: SubagentWaitInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<WaitSubagentsDetails>,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: WaitSubagentsDetails }> {
		this.assertAccepting();
		const startedAt = Date.now();
		const selected = params.names
			? this.resolveMany(callerId, params.names)
			: this.allowedChildren(callerId).filter((record) => record.metadata.state === "running");
		if (selected.length === 0) throw new Error("No selected subagents to wait for");
		const waitFor: WaitFor = params.for ?? "all";
		const immediate = this.waitCondition(selected, waitFor);
		if (immediate.done) {
			for (const record of selected) if (record.metadata.state === "stopped") this.claimNotification(record);
			return this.waitResult("settled", waitFor, selected, immediate.matched, startedAt);
		}
		if (signal?.aborted) return this.waitResult("cancelled", waitFor, selected, undefined, startedAt);

		const waiterId = randomUUID();
		const outcome = await new Promise<{ reason: "settled" | "timeout" | "cancelled"; matchedId?: string }>((resolveWait) => {
			const waiter: Waiter = {
				id: waiterId,
				startedAt,
				selectedIds: new Set(selected.map((record) => record.metadata.id)),
				waitFor,
				resolve: (reason, matchedId) => resolveWait({ reason, matchedId }),
				signal,
				onUpdate,
			};
			if (params.timeout_seconds !== undefined) {
				waiter.timeout = setTimeout(() => this.settleWaiter(waiter, "timeout"), params.timeout_seconds * 1_000);
			}
			if (signal) {
				waiter.abortListener = () => this.settleWaiter(waiter, "cancelled");
				signal.addEventListener("abort", waiter.abortListener, { once: true });
			}
			waiter.updateInterval = setInterval(() => this.updateWaiter(waiter), 1_000);
			this.waiters.set(waiter.id, waiter);
			if (signal?.aborted) this.settleWaiter(waiter, "cancelled");
			else this.updateWaiter(waiter);
		});
		const matched = outcome.matchedId ? this.children.get(outcome.matchedId) : undefined;
		return this.waitResult(outcome.reason, waitFor, selected, matched, startedAt);
	}

	async stopSubagent(
		callerId: string,
		params: SubagentStopInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<StopSubagentDetails>,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: StopSubagentDetails }> {
		const { record, active } = await this.operationLock.run(() => {
			this.assertAccepting();
			this.throwIfAborted(signal);
			const target = this.resolveOne(callerId, params.name);
			const subtree = [target, ...this.descendantsOf(target.metadata.id)];
			const running = subtree.filter((child) => child.metadata.state === "running");
			for (const child of running) {
				child.claimed = true;
				child.metadata.notifyOnStop = false;
				this.claimNotification(child);
				child.metadata.stopMessage =
					child === target
						? params.reason
						: `Stopped with ancestor ${target.metadata.name} (${target.metadata.id})${params.reason ? `: ${params.reason}` : ""}`;
				this.cancelRun(child, "requested");
			}
			this.persistRegistry();
			return { record: target, active: running };
		});
		const descendantCount = active.filter((child) => child !== record).length;
		if (active.length > 0) {
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Stopping ${record.metadata.name} (${record.metadata.id})${descendantCount > 0 ? ` and ${descendantCount} active descendant${descendantCount === 1 ? "" : "s"}` : ""}…`,
					},
				],
				details: { childId: record.metadata.id, snapshot: this.snapshot(record) },
			});
			try {
				await Promise.all(active.map((child) => this.waitForRun(child, signal)));
			} finally {
				for (const child of active) child.claimed = false;
			}
		}
		const snapshot = this.snapshot(record);
		return {
			content: [
				{
					type: "text",
					text: `Stopped ${record.metadata.name} (${record.metadata.id})${descendantCount > 0 ? ` and ${descendantCount} active descendant${descendantCount === 1 ? "" : "s"}` : ""}.`,
				},
			],
			details: { childId: record.metadata.id, snapshot },
		};
	}

	shutdown(persist = true): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.accepting = false;
		this.persistenceEnabled = persist;
		this.shutdownPromise = this.performShutdown(persist);
		return this.shutdownPromise;
	}

	private async performShutdown(persist: boolean): Promise<void> {
		if (this.rootNotificationTimer) clearTimeout(this.rootNotificationTimer);
		if (this.dashboardTimer) clearTimeout(this.dashboardTimer);
		for (const waiter of [...this.waiters.values()]) this.settleWaiter(waiter, "cancelled");
		const runs: Promise<void>[] = [];
		for (const record of this.children.values()) {
			if (record.metadata.state === "running") {
				record.claimed = false;
				record.metadata.notifyOnStop = true;
				this.cancelRun(record, "shutdown");
				if (record.runPromise) runs.push(record.runPromise);
			}
		}
		await Promise.allSettled(runs);
		for (const record of this.children.values()) {
			if (record.metadata.state === "running") {
				record.metadata.state = "stopped";
				record.metadata.stopReason = "recovered";
				record.metadata.error ??= "Interrupted by session shutdown";
			}
			this.captureRuntimeMetadata(record);
			this.releaseRuntime(record);
		}
		if (persist) this.persistRegistry();
		this.dashboardInvalidator = undefined;
		this.disposed = true;
	}

	private newRecord(metadata: PersistedChild, manager?: SessionManager): ChildRecord {
		return {
			metadata,
			manager,
			lock: new Mutex(),
			claimed: false,
			activeActivities: new Map(),
			turns: this.cloneTurns(metadata.latestTurns).slice(-MAX_RETAINED_TURNS),
		};
	}

	private initialMessage(task: string, context?: string): string {
		return context
			? `<parent_context>\n${context}\n</parent_context>\n\n<task>\n${task}\n</task>`
			: `<task>\n${task}\n</task>`;
	}

	private recreateMissingHistory(metadata: PersistedChild): void {
		const manager = SessionManager.create(metadata.cwd, this.childSessionDir, { id: metadata.childSessionId });
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: this.initialMessage(metadata.task, metadata.context) }],
			timestamp: Date.now(),
		});
		manager.appendMessage(
			fauxAssistantMessage(
				metadata.finalResponse ?? metadata.error ?? "Run stopped before its session history was fully persisted.",
				{ stopReason: metadata.error ? "error" : "aborted", errorMessage: metadata.error },
			),
		);
		metadata.sessionPath = manager.getSessionFile() ?? metadata.sessionPath;
		metadata.childSessionId = manager.getSessionId();
		metadata.childLeafId = manager.getLeafId();
	}

	private cloneSourceManager(source: ChildRecord, cwd: string): SessionManager {
		if (!existsSync(source.metadata.sessionPath)) {
			throw new Error(`Source subagent history is missing: ${source.metadata.id}`);
		}
		const manager = SessionManager.open(source.metadata.sessionPath, this.childSessionDir, source.metadata.cwd);
		const leaf = source.metadata.childLeafId ?? manager.getLeafId();
		if (!leaf || !manager.getEntry(leaf)) throw new Error(`Source subagent has no durable history: ${source.metadata.id}`);
		const path = manager.createBranchedSession(leaf);
		if (!path) throw new Error(`Failed to clone source subagent history: ${source.metadata.id}`);
		return SessionManager.open(path, this.childSessionDir, cwd);
	}

	private async openRuntime(record: ChildRecord, model?: Model<Api>): Promise<void> {
		const resolvedModel =
			model ?? (await this.resolveModel(`${record.metadata.modelProvider}/${record.metadata.modelId}`, undefined));
		const manager =
			record.manager ?? SessionManager.open(record.metadata.sessionPath, this.childSessionDir, record.metadata.cwd);
		if (record.metadata.childLeafId === null) manager.resetLeaf();
		else if (manager.getEntry(record.metadata.childLeafId)) manager.branch(record.metadata.childLeafId);
		const { session } = await createAgentSession({
			cwd: record.metadata.cwd,
			agentDir: this.agentDir,
			modelRuntime: this.modelRuntime,
			model: resolvedModel,
			thinkingLevel: record.metadata.thinkingLevel,
			resourceLoader: exactResourceLoader(record.metadata.generatedSystemPrompt),
			customTools: this.privateTools(record.metadata.id, record.metadata.remainingDepth),
			tools: record.metadata.enabledTools,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory(),
		});
		record.manager = manager;
		record.session = session;
		record.metadata.thinkingLevel = session.thinkingLevel;
		record.metadata.childLeafId = manager.getLeafId();
		record.turns = rebuildTurns(session.messages).slice(-MAX_RETAINED_TURNS);
		record.unsubscribe = session.subscribe((event) => this.handleChildEvent(record, event));
	}

	private privateTools(callerId: string, remainingDepth: number): ToolDefinition[] {
		const tools: ToolDefinition[] = [
			defineTool({
				name: "subagent_list",
				label: "Subagent List",
				description: "List descendant subagents visible to this caller.",
				parameters: SubagentListParams,
				execute: async (_id, params: SubagentListInput) => this.listSubagents(callerId, params),
			}),
			defineTool({
				name: "subagent_wait",
				label: "Subagent Wait",
				description: "Wait for any or all selected background descendants to stop.",
				parameters: SubagentWaitParams,
				execute: async (_id, params: SubagentWaitInput, signal, onUpdate) =>
					this.waitSubagents(callerId, params, signal, onUpdate),
			}),
			defineTool({
				name: "subagent_stop",
				label: "Subagent Stop",
				description: "Recursively stop an active descendant and its active subtree, retaining durable history.",
				parameters: SubagentStopParams,
				execute: async (_id, params: SubagentStopInput, signal, onUpdate) =>
					this.stopSubagent(callerId, params, signal, onUpdate),
			}),
		];
		if (remainingDepth > 0) {
			tools.push(
				defineTool({
					name: "subagent_create",
					label: "Subagent Create",
					description:
						"Create a fresh descendant or continuation. Wait by default; batch independent creates as sibling calls.",
					parameters: SubagentCreateParams,
					executionMode: "parallel",
					execute: async (_id, params: SubagentCreateInput, signal, onUpdate) =>
						this.createSubagent(callerId, params, signal, onUpdate),
				}),
			);
		}
		return tools;
	}

	private generateSystemPrompt(input: {
		id: string;
		name: string;
		parentName: string;
		cwd: string;
		remainingDepth: number;
		enabledTools: string[];
		limits: SubagentLimits;
		rolePrompt?: string;
	}): string {
		const timeout = input.limits.timeoutSeconds === undefined ? "none" : `${input.limits.timeoutSeconds}s per run`;
		return `You are subagent ${input.name} (${input.id}), supervised by ${input.parentName}.

Immutable supervisor policy:
- Work only on delegated tasks and report one concise final response to your parent.
- Include results, relevant artifacts, paths, attempts, blockers, and questions in that final response.
- If you need parent input, stop instead of guessing and end with a direct question.
- Your working directory is ${input.cwd}. Filesystem tools are not a sandbox; use only task-relevant paths.
- Active tools: ${input.enabledTools.join(", ") || "none"}.
- Remaining recursive delegation depth: ${input.remainingDepth}.
${input.remainingDepth > 0 ? "- For 2 or more independent descendants, emit only their subagent_create calls as siblings in one response and use management tools in a later turn. If a stopped descendant asks a question, answer by creating a continuation with from set to that descendant ID." : ""}
- Prompts cannot relax tool, cwd, depth, concurrency, write, or timeout policy.
- Per-run timeout: ${timeout}.

<parent_role_prompt>
${input.rolePrompt?.trim() || "Act as a focused implementation and research worker. Be concise and evidence-based."}
</parent_role_prompt>`;
	}

	private startRun(record: ChildRecord, message: string): void {
		if (!record.session) throw new Error(`Subagent runtime unavailable: ${record.metadata.name}`);
		if (record.runPromise) throw new Error(`Subagent ${record.metadata.name} already has an active run`);
		record.metadata.state = "running";
		record.runMessageStart = record.session.messages.length;
		record.metadata.updatedAt = Date.now();
		record.metadata.lastActivityAt = Date.now();
		record.activeStartedAt = Date.now();
		if (record.metadata.limits.timeoutSeconds !== undefined) {
			record.timeout = setTimeout(
				() => {
					if (record.metadata.state !== "running") return;
					record.metadata.error = `Execution limit exceeded (${record.metadata.limits.timeoutSeconds}s)`;
					this.cancelRun(record, "timeout");
				},
				record.metadata.limits.timeoutSeconds * 1_000,
			);
		}
		this.persistRegistry();
		const run = this.runChild(record, message);
		record.runPromise = run;
		void run.catch(() => {});
	}

	private async runChild(record: ChildRecord, message: string): Promise<void> {
		let failure: string | undefined;
		try {
			await record.session?.prompt(message, { expandPromptTemplates: false, source: "extension" });
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		await record.lock.run(() => this.finalizeRun(record, failure));
	}

	private finalizeRun(record: ChildRecord, failure?: string): void {
		if (record.metadata.state === "stopped") return;
		if (record.timeout) clearTimeout(record.timeout);
		record.timeout = undefined;
		if (record.activeStartedAt !== undefined) {
			record.metadata.activeMs += Date.now() - record.activeStartedAt;
			record.activeStartedAt = undefined;
		}
		const newMessages = record.session?.messages.slice(record.runMessageStart ?? 0) ?? [];
		const assistant = lastAssistant(newMessages);
		const finalResponse = assistantText(assistant);
		const cause = record.abortCause;
		let reason: StopReason = "finished";
		if (cause === "timeout") reason = "timeout";
		else if (cause === "requested") reason = "requested";
		else if (cause === "shutdown") reason = "cancelled";
		else if (failure || assistant?.stopReason === "error") reason = "error";
		else if (assistant?.stopReason === "aborted") reason = "cancelled";
		record.metadata.state = "stopped";
		record.metadata.stopReason = reason;
		record.metadata.finalResponse = finalResponse;
		record.metadata.error ??=
			failure || (assistant?.stopReason === "error" ? assistant.errorMessage ?? "Model run failed" : undefined);
		if (!assistant && record.manager) {
			const durableText = `Run stopped before producing a final response: ${
				record.metadata.error ?? record.metadata.stopMessage ?? reason
			}`;
			record.manager.appendMessage(fauxAssistantMessage(durableText, { stopReason: "aborted" }));
		}
		record.metadata.updatedAt = Date.now();
		record.metadata.lastActivityAt = Date.now();
		record.currentActivity = undefined;
		record.activeActivities.clear();
		record.abortCause = undefined;
		record.runMessageStart = undefined;
		record.runPromise = undefined;
		this.captureRuntimeMetadata(record);
		const claimedByWaiter = this.evaluateWaiters(record);
		if (record.claimed || claimedByWaiter) record.metadata.notifyOnStop = false;
		this.persistRegistry();
		this.invalidateDashboard(false);
		this.releaseRuntime(record);
		if (record.metadata.notifyOnStop && this.accepting) this.notifyOwner(record);
	}

	private cancelRun(record: ChildRecord, cause: AbortCause): void {
		record.abortCause = cause;
		if (record.timeout) clearTimeout(record.timeout);
		record.timeout = undefined;
		try {
			record.session?.clearQueue();
			record.session?.abortRetry();
			record.session?.abortCompaction();
			record.session?.agent.abort();
		} catch (error) {
			record.metadata.error = `${record.metadata.error ? `${record.metadata.error}; ` : ""}Abort failed: ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
	}

	private waitForRun(record: ChildRecord, signal?: AbortSignal): Promise<void> {
		if (record.metadata.state === "stopped" || !record.runPromise) return Promise.resolve();
		if (!signal) return record.runPromise;
		if (signal.aborted) {
			return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
		}
		return new Promise<void>((resolveWait, rejectWait) => {
			const run = record.runPromise;
			const cleanup = () => signal.removeEventListener("abort", onAbort);
			const onAbort = () => {
				cleanup();
				if (record.metadata.state === "stopped") resolveWait();
				else rejectWait(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			run?.then(
				() => {
					cleanup();
					resolveWait();
				},
				(error) => {
					cleanup();
					rejectWait(error);
				},
			);
		});
	}

	private createResult(
		record: ChildRecord,
		mode: SubagentMode,
		acceptedAt: number,
		partial: boolean,
	): { content: Array<{ type: "text"; text: string }>; details: CreateSubagentDetails } {
		const snapshot = this.snapshot(record);
		const text =
			record.metadata.state === "stopped"
				? this.notificationText(record)
				: `${partial ? "Waiting for" : "Started"} ${record.metadata.name} (${record.metadata.id}); state=running.`;
		return {
			content: [{ type: "text", text }],
			details: { action: "create", mode, childId: record.metadata.id, acceptedAt, snapshot },
		};
	}

	private waitCondition(records: ChildRecord[], waitFor: WaitFor): { done: boolean; matched?: ChildRecord } {
		const stopped = records.filter((record) => record.metadata.state === "stopped");
		return waitFor === "any"
			? { done: stopped.length > 0, matched: stopped[0] }
			: { done: stopped.length === records.length };
	}

	private waitResult(
		reason: "pending" | "settled" | "timeout" | "cancelled",
		waitFor: WaitFor,
		records: ChildRecord[],
		matched?: ChildRecord,
		startedAt = Date.now(),
	): { content: Array<{ type: "text"; text: string }>; details: WaitSubagentsDetails } {
		const snapshots = records.map((record) => this.snapshot(record));
		const settled = snapshots.filter((snapshot) => snapshot.state === "stopped").length;
		const matchedSnapshot = matched ? this.snapshot(matched) : undefined;
		const header = `${reason}: ${settled}/${snapshots.length} subagents stopped.`;
		const handoffRecords =
			waitFor === "any" && matched ? [matched] : records.filter((record) => record.metadata.state === "stopped");
		const handoffs = handoffRecords.map((record) => this.notificationText(record));
		const running = records
			.filter((record) => record.metadata.state === "running")
			.map((record) => `${record.metadata.name} (${record.metadata.id}): running`);
		const text = [header, ...handoffs, ...(reason === "settled" ? [] : running)].join("\n\n");
		return {
			content: [{ type: "text", text }],
			details: {
				reason,
				started_at: startedAt,
				elapsed_ms: Math.max(0, Date.now() - startedAt),
				waitFor,
				snapshots,
				settled,
				total: snapshots.length,
				matched: matchedSnapshot,
			},
		};
	}

	private updateWaiter(waiter: Waiter): void {
		if (!this.waiters.has(waiter.id) || !waiter.onUpdate) return;
		const records = [...waiter.selectedIds].flatMap((id) => {
			const record = this.children.get(id);
			return record ? [record] : [];
		});
		waiter.onUpdate(this.waitResult("pending", waiter.waitFor, records, undefined, waiter.startedAt));
	}

	private settleWaiter(waiter: Waiter, reason: "settled" | "timeout" | "cancelled", matchedId?: string): void {
		if (!this.waiters.delete(waiter.id)) return;
		if (waiter.timeout) clearTimeout(waiter.timeout);
		if (waiter.updateInterval) clearInterval(waiter.updateInterval);
		if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener("abort", waiter.abortListener);
		if (reason === "cancelled") {
			for (const id of waiter.selectedIds) {
				const record = this.children.get(id);
				if (!record || record.metadata.state !== "stopped" || record.claimed) continue;
				const claimedElsewhere = [...this.waiters.values()].some((other) => other.selectedIds.has(id));
				if (claimedElsewhere) continue;
				record.metadata.notifyOnStop = true;
				if (this.accepting) this.notifyOwner(record);
			}
			this.persistRegistry();
		}
		waiter.resolve(reason, matchedId);
	}

	private evaluateWaiters(record: ChildRecord): boolean {
		let claimed = false;
		for (const waiter of [...this.waiters.values()]) {
			if (!waiter.selectedIds.has(record.metadata.id)) continue;
			claimed = true;
			const records = [...waiter.selectedIds].flatMap((id) => {
				const child = this.children.get(id);
				return child ? [child] : [];
			});
			const condition = this.waitCondition(records, waiter.waitFor);
			if (condition.done) this.settleWaiter(waiter, "settled", condition.matched?.metadata.id);
		}
		return claimed;
	}

	private runningReminder(callerId: string): string | undefined {
		const parentId = callerId === ROOT_CALLER_ID ? null : callerId;
		const running = [...this.children.values()].filter(
			(record) => record.metadata.parentId === parentId && record.metadata.state === "running" && !record.claimed,
		);
		if (running.length === 0) {
			this.reminderKeys.delete(callerId);
			return undefined;
		}
		const key = running.map((record) => record.metadata.id).sort().join(",");
		if (this.reminderKeys.get(callerId) === key) return undefined;
		this.reminderKeys.set(callerId, key);
		return `Background subagents still running:\n${running
			.map((record) => `- ${record.metadata.name} (${record.metadata.id})`)
			.join("\n")}\nUse subagent_wait to join them or subagent_stop to abort them.`;
	}

	private claimNotification(record: ChildRecord): void {
		record.metadata.notifyOnStop = false;
		this.rootNotifications.delete(record.metadata.id);
		if (this.rootNotifications.size === 0 && this.rootNotificationTimer) {
			clearTimeout(this.rootNotificationTimer);
			this.rootNotificationTimer = undefined;
		}
		this.persistRegistry();
	}

	private notificationText(record: ChildRecord): string {
		const handoff =
			record.metadata.stopReason === "finished"
				? record.metadata.finalResponse
				: record.metadata.error ?? record.metadata.finalResponse ?? record.metadata.stopMessage;
		return `[subagent ${record.metadata.name} (${record.metadata.id})] state=stopped${handoff ? `\n${handoff}` : ""}`;
	}

	private notifyOwner(record: ChildRecord): void {
		const text = this.notificationText(record);
		if (record.metadata.parentId !== null) {
			const owner = this.children.get(record.metadata.parentId);
			if (owner?.metadata.state === "running" && owner.session) {
				void owner.session.followUp(text).then(
					() => {
						record.metadata.notifyOnStop = false;
						this.persistRegistry();
					},
					() => this.queueRootNotification(record, text),
				);
				return;
			}
		}
		this.queueRootNotification(record, text);
	}

	private queueRootNotification(record: ChildRecord, text: string): void {
		this.rootNotifications.set(record.metadata.id, text);
		if (this.rootNotificationTimer) return;
		this.rootNotificationTimer = setTimeout(() => {
			this.rootNotificationTimer = undefined;
			if (!this.accepting || this.rootNotifications.size === 0) return;
			const ids = [...this.rootNotifications.keys()];
			const content = [...this.rootNotifications.values()].join("\n\n");
			this.rootNotifications.clear();
			this.pi.sendMessage(
				{ customType: NOTIFICATION_MESSAGE_TYPE, content, display: true, details: { source: "subagent" } },
				{ deliverAs: "followUp", triggerTurn: true },
			);
			for (const id of ids) {
				const child = this.children.get(id);
				if (child) child.metadata.notifyOnStop = false;
			}
			this.persistRegistry();
		}, NOTIFICATION_BATCH_MS);
	}

	private handleChildEvent(record: ChildRecord, event: AgentSessionEvent): void {
		if (this.disposed) return;
		if (event.type === "message_end") this.checkpointChildLeaf(record);
		const now = Date.now();
		record.metadata.lastActivityAt = now;
		switch (event.type) {
			case "agent_start":
				record.currentActivity = { type: "thinking", preview: "starting", started_at: now };
				break;
			case "turn_start":
				record.activeActivities.clear();
				record.turns.push({ index: record.metadata.turns + 1, activities: [], startedAt: now });
				record.currentActivity = { type: "thinking", preview: "thinking", started_at: now };
				break;
			case "message_update": {
				const previews = assistantPreviews(event.message);
				const turn = record.turns.at(-1);
				if (turn) {
					turn.textPreview = previews.text ?? turn.textPreview;
					turn.thinkingPreview = previews.thinking ?? turn.thinkingPreview;
				}
				record.currentActivity = this.currentToolActivity(record) ??
					(previews.text ? undefined : { type: "thinking", preview: previews.thinking ?? "thinking", started_at: now });
				this.invalidateDashboard(true);
				return;
			}
			case "tool_execution_start": {
				const activity: ToolActivityView = {
					toolCallId: event.toolCallId,
					name: event.toolName,
					preview: toolPreview(event.toolName, event.args),
					startedAt: now,
				};
				record.turns.at(-1)?.activities.push(activity);
				record.activeActivities.set(event.toolCallId, activity);
				record.currentActivity = this.currentToolActivity(record);
				break;
			}
			case "tool_execution_update": {
				const activity = record.activeActivities.get(event.toolCallId);
				if (activity) activity.resultPreview = textFromUnknown(event.partialResult) ?? activity.resultPreview;
				record.currentActivity = this.currentToolActivity(record);
				this.invalidateDashboard(true);
				return;
			}
			case "tool_execution_end": {
				const activity = record.activeActivities.get(event.toolCallId);
				if (activity) {
					activity.endedAt = now;
					activity.isError = event.isError;
					activity.resultPreview = textFromUnknown(event.result) ?? activity.resultPreview;
				}
				record.activeActivities.delete(event.toolCallId);
				record.currentActivity = this.currentToolActivity(record);
				break;
			}
			case "turn_end":
				record.metadata.turns++;
				if (record.turns.at(-1)) record.turns.at(-1)!.endedAt = now;
				this.retainLatestTurns(record);
				this.persistRegistry();
				break;
			case "auto_retry_start":
				record.currentActivity = { type: "thinking", preview: `retry ${event.attempt}/${event.maxAttempts}`, started_at: now };
				break;
			case "compaction_start":
				record.currentActivity = { type: "thinking", preview: `compacting (${event.reason})`, started_at: now };
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					const previews = assistantPreviews(event.message);
					const turn = record.turns.at(-1);
					if (turn) turn.textPreview = previews.text ?? turn.textPreview;
				}
				break;
			case "agent_settled": {
				const content = this.runningReminder(record.metadata.id);
				if (content && record.session) queueMicrotask(() => void record.session?.followUp(content).catch(() => {}));
				break;
			}
			default:
				break;
		}
		this.invalidateDashboard(false);
	}

	private checkpointChildLeaf(record: ChildRecord): void {
		const manager = record.manager;
		if (!manager) return;
		queueMicrotask(() => {
			if (record.manager !== manager) return;
			record.metadata.childLeafId = manager.getLeafId();
			record.metadata.updatedAt = Date.now();
			this.persistRegistry();
		});
	}

	private currentToolActivity(record: ChildRecord): CurrentActivity | undefined {
		let latest: ToolActivityView | undefined;
		for (const activity of record.activeActivities.values()) {
			if (!latest || activity.startedAt >= latest.startedAt) latest = activity;
		}
		return latest
			? {
					type: "tool",
					name: latest.name,
					preview: latest.resultPreview ?? latest.preview,
					started_at: latest.startedAt,
				}
			: undefined;
	}

	private usageSnapshot(record: ChildRecord): UsageSnapshot {
		try {
			const stats = record.session?.getSessionStats();
			return stats
				? {
						input: stats.tokens.input,
						output: stats.tokens.output,
						cache_read: stats.tokens.cacheRead,
						cache_write: stats.tokens.cacheWrite,
						cost: stats.cost,
					}
				: { ...record.metadata.usage };
		} catch {
			return { ...record.metadata.usage };
		}
	}

	private snapshot(record: ChildRecord): SubagentSnapshot {
		const now = Date.now();
		const active = record.activeStartedAt === undefined ? 0 : now - record.activeStartedAt;
		return {
			id: record.metadata.id,
			name: record.metadata.name,
			from: record.metadata.fromId,
			state: record.metadata.state,
			model: `${record.metadata.modelProvider}/${record.metadata.modelId}`,
			thinking_level: record.metadata.thinkingLevel,
			cwd: record.metadata.cwd,
			timeout_seconds: record.metadata.limits.timeoutSeconds,
			elapsed_ms: record.metadata.activeMs + active,
			idle_ms: Math.max(0, now - record.metadata.lastActivityAt),
			turns: record.metadata.turns,
			current_activity: record.currentActivity,
			last_text_preview: [...record.turns].reverse().find((turn) => turn.textPreview)?.textPreview,
			final_response: record.metadata.finalResponse,
			error: record.metadata.error,
			stop_reason: record.metadata.stopReason,
			stop_message: record.metadata.stopMessage,
			stopped_at: record.metadata.state === "stopped" ? record.metadata.updatedAt : undefined,
			usage: this.usageSnapshot(record),
		};
	}

	private captureRuntimeMetadata(record: ChildRecord): void {
		try {
			record.metadata.childLeafId = record.manager?.getLeafId() ?? record.metadata.childLeafId;
		} catch {
			// Keep the last durable leaf.
		}
		record.metadata.usage = this.usageSnapshot(record);
		this.retainLatestTurns(record);
	}

	private retainLatestTurns(record: ChildRecord): void {
		if (record.turns.length > MAX_RETAINED_TURNS) record.turns = record.turns.slice(-MAX_RETAINED_TURNS);
		record.metadata.latestTurns = this.cloneTurns(record.turns);
	}

	private releaseRuntime(record: ChildRecord): void {
		const unsubscribe = record.unsubscribe;
		const session = record.session;
		record.unsubscribe = undefined;
		record.session = undefined;
		record.manager = undefined;
		record.currentActivity = undefined;
		record.activeActivities.clear();
		try {
			unsubscribe?.();
		} catch {}
		try {
			session?.dispose();
		} catch {}
	}

	private activeRunCount(): number {
		return [...this.children.values()].filter((record) => record.metadata.state === "running").length;
	}

	private requireChild(id: string): ChildRecord {
		const record = this.children.get(id);
		if (!record) throw new Error(`Unknown subagent id: ${id}`);
		return record;
	}

	private allowedChildren(callerId: string): ChildRecord[] {
		return [...this.children.values()].filter((record) => {
			if (callerId === ROOT_CALLER_ID) return true;
			let parentId = record.metadata.parentId;
			while (parentId) {
				if (parentId === callerId) return true;
				parentId = this.children.get(parentId)?.metadata.parentId ?? null;
			}
			return false;
		});
	}

	private descendantsOf(parentId: string): ChildRecord[] {
		const descendants: ChildRecord[] = [];
		const pending = [parentId];
		while (pending.length > 0) {
			const current = pending.shift();
			for (const record of this.children.values()) {
				if (record.metadata.parentId !== current) continue;
				descendants.push(record);
				pending.push(record.metadata.id);
			}
		}
		return descendants;
	}

	private resolveOne(callerId: string, selector: string): ChildRecord {
		const allowed = this.allowedChildren(callerId);
		const byId = allowed.find((record) => record.metadata.id === selector);
		if (byId) return byId;
		const byName = allowed.filter((record) => record.metadata.name === selector);
		if (byName.length === 0) throw new Error(`No subagent in scope matches: ${selector}`);
		if (byName.length > 1) throw new Error(`Ambiguous subagent name ${selector}; use an immutable id`);
		return byName[0]!;
	}

	private resolveMany(callerId: string, selectors: string[]): ChildRecord[] {
		return [
			...new Map(
				selectors.map((selector) => {
					const record = this.resolveOne(callerId, selector);
					return [record.metadata.id, record] as const;
				}),
			).values(),
		];
	}

	private validateTools(requested: string[], inherited?: string[]): string[] {
		const unique = [...new Set(requested)];
		const unknown = unique.filter((name) => !BUILTIN_TOOLS.has(name));
		if (unknown.length > 0) throw new Error(`Unsupported child tools: ${unknown.join(", ")}`);
		if (inherited) {
			const permitted = new Set(inherited);
			const escalated = unique.filter((name) => !permitted.has(name));
			if (escalated.length > 0) throw new Error(`Descendant tools exceed parent privileges: ${escalated.join(", ")}`);
		}
		return unique;
	}

	private async resolveCwd(input: string | undefined, base: string, requireContainment: boolean): Promise<string> {
		const canonicalBase = await realpath(base);
		const candidate = resolve(canonicalBase, input ?? ".");
		const info = await stat(candidate).catch(() => undefined);
		if (!info?.isDirectory()) throw new Error(`Subagent cwd is not an existing directory: ${candidate}`);
		const canonical = await realpath(candidate);
		const fromBase = relative(canonicalBase, canonical);
		if (requireContainment && (fromBase === ".." || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase))) {
			throw new Error(`Descendant cwd must remain within parent cwd: ${canonicalBase}`);
		}
		return canonical;
	}

	private async seedProvider(providerId: string): Promise<void> {
		const provider: Provider | undefined = this.rootContext.modelRegistry.getProvider(providerId);
		if (provider) this.modelRuntime.registerNativeProvider(provider);
		const status = this.rootContext.modelRegistry.getProviderAuthStatus(providerId);
		if (status.source !== "runtime") {
			if (this.modelRuntime.getProviderAuthStatus(providerId).source === "runtime") {
				await this.modelRuntime.removeRuntimeApiKey(providerId);
			}
			return;
		}
		const auth = await this.rootContext.modelRegistry.getProviderAuth(providerId);
		if (!auth?.auth.apiKey) throw new Error(`Parent runtime override for ${providerId} has no API key`);
		await this.modelRuntime.setRuntimeApiKey(providerId, auth.auth.apiKey);
	}

	private async resolveModel(requested: string | undefined, fallback: Model<Api> | undefined): Promise<Model<Api>> {
		if (!requested) {
			if (!fallback) throw new Error("No model is available for the subagent");
			await this.seedProvider(fallback.provider);
			return this.modelRuntime.getModel(fallback.provider, fallback.id) ?? fallback;
		}
		const slash = requested.indexOf("/");
		if (slash > 0) {
			const provider = requested.slice(0, slash);
			const modelId = requested.slice(slash + 1);
			await this.seedProvider(provider);
			const model = this.modelRuntime.getModel(provider, modelId);
			if (!model) throw new Error(`Unknown model: ${requested}`);
			return model;
		}
		const matches = this.rootContext.modelRegistry.getAll().filter((model) => model.id === requested);
		if (matches.length === 0) throw new Error(`Unknown model id: ${requested}`);
		if (matches.length > 1) throw new Error(`Ambiguous model id ${requested}; use provider/model-id`);
		const model = matches[0]!;
		await this.seedProvider(model.provider);
		return this.modelRuntime.getModel(model.provider, model.id) ?? model;
	}

	private persistRegistry(): void {
		if (this.disposed || !this.persistenceEnabled) return;
		const registry: PersistedRegistry = {
			version: 2,
			ownerSessionId: this.ownerSessionId,
			sequence: ++this.sequence,
			dashboardOrderSequence: this.dashboardOrderSequence,
			children: [...this.children.values()].map((record) => ({
				...record.metadata,
				childLeafId: record.manager?.getLeafId() ?? record.metadata.childLeafId,
				enabledTools: [...record.metadata.enabledTools],
				limits: { ...record.metadata.limits },
				usage: this.usageSnapshot(record),
				latestTurns: this.cloneTurns(record.turns),
			})),
		};
		this.pi.appendEntry(REGISTRY_ENTRY_TYPE, registry);
	}

	private async recover(): Promise<void> {
		let latest: PersistedRegistry | undefined;
		for (const entry of this.rootContext.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			const parsed =
				entry.customType === REGISTRY_ENTRY_TYPE && isPersistedRegistry(entry.data)
					? entry.data
					: entry.customType === LEGACY_REGISTRY_ENTRY_TYPE
						? migrateLegacyRegistry(entry.data)
						: undefined;
			if (parsed?.ownerSessionId === this.ownerSessionId && (!latest || parsed.sequence > latest.sequence)) latest = parsed;
		}
		if (!latest) return;
		this.sequence = latest.sequence;
		this.dashboardOrderSequence = latest.dashboardOrderSequence;
		const notifications: ChildRecord[] = [];
		for (const saved of latest.children) {
			if (!saved || typeof saved.id !== "string") continue;
			const wasRunning = saved.state === "running";
			const metadata: PersistedChild = {
				...saved,
				state: "stopped",
				stopReason: wasRunning ? "recovered" : saved.stopReason,
				error: wasRunning ? saved.error ?? "Interrupted before recovery" : saved.error,
				notifyOnStop: wasRunning || saved.notifyOnStop,
				enabledTools: [...saved.enabledTools],
				limits: { ...saved.limits },
				usage: { ...saved.usage },
				latestTurns: this.cloneTurns(saved.latestTurns),
			};
			if (!existsSync(metadata.sessionPath)) this.recreateMissingHistory(metadata);
			const record = this.newRecord(metadata);
			this.children.set(metadata.id, record);
			if (metadata.notifyOnStop) notifications.push(record);
		}
		this.persistRegistry();
		for (const record of notifications) this.notifyOwner(record);
	}

	private cloneTurns(turns: TurnView[]): TurnView[] {
		return turns.map((turn) => ({ ...turn, activities: turn.activities.map((activity) => ({ ...activity })) }));
	}

	private invalidateDashboard(throttled: boolean): void {
		if (!this.dashboardInvalidator) return;
		if (!throttled) {
			if (this.dashboardTimer) clearTimeout(this.dashboardTimer);
			this.dashboardTimer = undefined;
			try {
				this.dashboardInvalidator();
			} catch {}
			return;
		}
		if (this.dashboardTimer) return;
		this.dashboardTimer = setTimeout(() => {
			this.dashboardTimer = undefined;
			try {
				this.dashboardInvalidator?.();
			} catch {}
		}, RENDER_THROTTLE_MS);
	}

	private assertAccepting(): void {
		if (!this.accepting || this.disposed) throw new Error("Subagent supervisor is shutting down");
	}

	private throwIfAborted(signal?: AbortSignal): void {
		if (!signal?.aborted) return;
		throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
	}
}
