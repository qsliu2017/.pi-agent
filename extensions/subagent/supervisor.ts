import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentMessage, AgentToolUpdateCallback, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
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
	type SubagentSendInput,
	SubagentSendParams,
	type SubagentStopInput,
	SubagentStopParams,
	type SubagentWaitInput,
	SubagentWaitParams,
	type SubagentYieldInput,
	SubagentYieldParams,
} from "./schemas.ts";
import {
	type CurrentActivity,
	type DashboardChildView,
	type DeliveryMode,
	type ListSubagentsDetails,
	NOTIFICATION_MESSAGE_TYPE,
	type PendingNotification,
	type PersistedChild,
	type PersistedRegistry,
	REGISTRY_ENTRY_TYPE,
	ROOT_CALLER_ID,
	type StopSubagentDetails,
	type SubagentLimits,
	type SubagentSnapshot,
	type SubagentState,
	type SubagentToolDetails,
	type ToolActivityView,
	type TurnView,
	type UsageSnapshot,
	type WaitEvent,
	type WaitSubagentsDetails,
	type YieldRecord,
} from "./types.ts";

export const DEFAULT_SUBAGENT_MAX_DEPTH = 3;
export const DEFAULT_SUBAGENT_MAX_CONCURRENCY = 4;
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const MANAGEMENT_TOOL_NAMES = ["subagent_yield", "subagent_list", "subagent_send", "subagent_wait", "subagent_stop"];
const RENDER_THROTTLE_MS = 40;
const NOTIFICATION_BATCH_MS = 75;
const MAX_PREVIEW_CHARS = 4_000;
const MAX_RETAINED_TURNS = 5;

class Mutex {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(operation: () => Promise<T> | T): Promise<T> {
		let release: () => void = () => {};
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

type AbortCause = "pause" | "shutdown" | "timeout" | "yield";

interface NotificationDelivery {
	generation: number;
	notificationIds: string[];
	preflightAccepted: boolean;
	promise: Promise<boolean>;
	resolve: (accepted: boolean) => void;
}

interface StopFlight {
	token: number;
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
	activeRun?: Promise<void>;
	snapshot?: SubagentSnapshot;
}

interface ChildRecord {
	metadata: PersistedChild;
	session?: AgentSession;
	manager?: SessionManager;
	unsubscribe?: () => void;
	lock: Mutex;
	runPromise?: Promise<void>;
	runGeneration: number;
	settlingGeneration?: number;
	abortCause?: AbortCause;
	yieldLatch?: YieldRecord;
	activeStartedAt?: number;
	timeout?: ReturnType<typeof setTimeout>;
	stopSequence: number;
	stopFlight?: StopFlight;
	notificationDelivery?: NotificationDelivery;
	notificationRetryDeferred: boolean;
	notificationDrainPromise?: Promise<void>;
	currentActivity?: CurrentActivity;
	activeActivities: Map<string, ToolActivityView>;
	turns: TurnView[];
	historyMissing: boolean;
}

interface WaiterOutcome {
	reason: "event" | "timeout" | "cancelled";
	matchedId?: string;
}

interface Waiter {
	id: string;
	callerId: string;
	selectedIds: Set<string>;
	acceptedStates: Set<WaitEvent>;
	resolve: (outcome: WaiterOutcome) => void;
	timeout?: ReturnType<typeof setTimeout>;
	updateInterval?: ReturnType<typeof setInterval>;
	signal?: AbortSignal;
	abortListener?: () => void;
	onUpdate?: AgentToolUpdateCallback<WaitSubagentsDetails>;
}

type StopSubagentResult = {
	content: Array<{ type: "text"; text: string }>;
	details: StopSubagentDetails;
};

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
	if (!text) return undefined;
	const normalized = text.trim();
	if (!normalized) return undefined;
	return normalized.length > MAX_PREVIEW_CHARS ? `${normalized.slice(0, MAX_PREVIEW_CHARS)}...` : normalized;
}

function textFromUnknown(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.text === "string") return truncatePreview(record.text);
	if (Array.isArray(record.content)) {
		const text = record.content
			.flatMap((item) => {
				if (!item || typeof item !== "object") return [];
				const content = item as Record<string, unknown>;
				return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
			})
			.join("\n");
		return truncatePreview(text);
	}
	try {
		return truncatePreview(JSON.stringify(value));
	} catch {
		return undefined;
	}
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

function toolPreview(name: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const values = args as Record<string, unknown>;
	if (name === "bash" && typeof values.command === "string") return truncatePreview(values.command);
	if (typeof values.path === "string") {
		const range =
			typeof values.offset === "number" || typeof values.limit === "number"
				? `:${String(values.offset ?? 1)}${typeof values.limit === "number" ? `+${values.limit}` : ""}`
				: "";
		return `${values.path}${range}`;
	}
	return textFromUnknown(args);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function isSubagentState(value: unknown): value is SubagentState {
	return (
		value === "creating" ||
		value === "running" ||
		value === "stopping" ||
		value === "waiting_parent" ||
		value === "completed" ||
		value === "failed" ||
		value === "paused"
	);
}

function isWaitEvent(value: SubagentState): value is WaitEvent {
	return value === "waiting_parent" || value === "completed" || value === "failed" || value === "paused";
}

function isSubagentLimits(value: unknown): value is SubagentLimits {
	if (!value || typeof value !== "object") return false;
	const limits = value as Record<string, unknown>;
	return (
		Object.keys(limits).every((key) => key === "timeoutSeconds") &&
		(limits.timeoutSeconds === undefined || typeof limits.timeoutSeconds === "number")
	);
}

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
	if (!value || typeof value !== "object") return false;
	const usage = value as Partial<UsageSnapshot>;
	return (
		typeof usage.input === "number" &&
		typeof usage.output === "number" &&
		typeof usage.cache_read === "number" &&
		typeof usage.cache_write === "number" &&
		typeof usage.cost === "number"
	);
}

function isToolActivityView(value: unknown): value is ToolActivityView {
	if (!value || typeof value !== "object") return false;
	const activity = value as Partial<ToolActivityView>;
	return (
		typeof activity.toolCallId === "string" &&
		typeof activity.name === "string" &&
		typeof activity.startedAt === "number" &&
		(activity.preview === undefined || typeof activity.preview === "string") &&
		(activity.resultPreview === undefined || typeof activity.resultPreview === "string") &&
		(activity.endedAt === undefined || typeof activity.endedAt === "number") &&
		(activity.isError === undefined || typeof activity.isError === "boolean")
	);
}

function isPendingNotification(value: unknown): value is PendingNotification {
	if (!value || typeof value !== "object") return false;
	const notification = value as Partial<PendingNotification>;
	return (
		typeof notification.id === "string" &&
		typeof notification.content === "string" &&
		typeof notification.createdAt === "number"
	);
}

function isTurnView(value: unknown): value is TurnView {
	if (!value || typeof value !== "object") return false;
	const turn = value as Partial<TurnView>;
	return (
		typeof turn.index === "number" &&
		typeof turn.startedAt === "number" &&
		(turn.textPreview === undefined || typeof turn.textPreview === "string") &&
		(turn.thinkingPreview === undefined || typeof turn.thinkingPreview === "string") &&
		(turn.endedAt === undefined || typeof turn.endedAt === "number") &&
		Array.isArray(turn.activities) &&
		turn.activities.every(isToolActivityView)
	);
}

function isPersistedChild(value: unknown): value is PersistedChild {
	if (!value || typeof value !== "object") return false;
	const child = value as Partial<PersistedChild>;
	return (
		typeof child.id === "string" &&
		typeof child.name === "string" &&
		(child.parentId === null || typeof child.parentId === "string") &&
		typeof child.depth === "number" &&
		typeof child.remainingDepth === "number" &&
		typeof child.childSessionId === "string" &&
		(child.childLeafId === null || typeof child.childLeafId === "string") &&
		typeof child.sessionPath === "string" &&
		typeof child.cwd === "string" &&
		typeof child.task === "string" &&
		typeof child.modelProvider === "string" &&
		typeof child.modelId === "string" &&
		isThinkingLevel(child.thinkingLevel) &&
		typeof child.generatedSystemPrompt === "string" &&
		Array.isArray(child.enabledTools) &&
		child.enabledTools.every((tool) => typeof tool === "string") &&
		isSubagentLimits(child.limits) &&
		isSubagentState(child.state) &&
		typeof child.turns === "number" &&
		typeof child.createdAt === "number" &&
		typeof child.updatedAt === "number" &&
		typeof child.lastActivityAt === "number" &&
		typeof child.dashboardOrder === "number" &&
		typeof child.cumulativeActiveMs === "number" &&
		isUsageSnapshot(child.usage) &&
		Array.isArray(child.latestTurns) &&
		child.latestTurns.length <= MAX_RETAINED_TURNS &&
		child.latestTurns.every(isTurnView) &&
		Array.isArray(child.pendingNotifications) &&
		child.pendingNotifications.every(isPendingNotification)
	);
}

function normalizePersistedChild(value: unknown): PersistedChild | undefined {
	if (!value || typeof value !== "object") return undefined;
	const child = value as Record<string, unknown>;
	const normalized = child.pendingNotifications === undefined ? { ...child, pendingNotifications: [] } : child;
	return isPersistedChild(normalized) ? normalized : undefined;
}

function parseRegistry(value: unknown): PersistedRegistry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const registry = value as Partial<PersistedRegistry>;
	if (
		registry.version !== 1 ||
		typeof registry.ownerSessionId !== "string" ||
		typeof registry.sequence !== "number" ||
		typeof registry.dashboardOrderSequence !== "number" ||
		!Array.isArray(registry.children)
	) {
		return undefined;
	}
	return {
		version: 1,
		ownerSessionId: registry.ownerSessionId,
		sequence: registry.sequence,
		dashboardOrderSequence: registry.dashboardOrderSequence,
		children: registry.children.flatMap((child) => {
			const normalized = normalizePersistedChild(child);
			return normalized ? [normalized] : [];
		}),
	};
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
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
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
				activity.resultPreview = textFromUnknown(message) ?? activity.resultPreview;
			}
		}
	}
	return turns;
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
	private readonly pendingStopOperations = new Set<Promise<StopSubagentResult>>();
	private rootNotificationTimer?: ReturnType<typeof setTimeout>;
	private shutdownPromise?: Promise<void>;
	private readonly rootNotifications = new Map<string, string>();
	private sequence = 0;
	private dashboardOrderSequence = 0;
	private accepting = true;
	private persistenceEnabled = true;
	private disposed = false;

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
		const harnessLimits = parseSubagentHarnessLimits(pi);
		const agentDir = getAgentDir();
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		const supervisor = new SubagentSupervisor(pi, context, runtime, harnessLimits);
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
		}));
	}

	remindWaitingDescendants(): void {
		if (!this.accepting || this.disposed) return;
		const waiting = this.allowedChildren(ROOT_CALLER_ID).filter(
			(record) => record.metadata.state === "waiting_parent",
		);
		if (waiting.length === 0) return;
		const list = waiting.map((record) => `- ${record.metadata.name} (${record.metadata.id})`).join("\n");
		const content = `Subagents still waiting for parent input:\n${list}\nAnswer or continue each with subagent_send, or reversibly pause it with subagent_stop.`;
		this.pi.sendMessage(
			{ customType: NOTIFICATION_MESSAGE_TYPE, content, display: true, details: { source: "subagent-reminder" } },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	async createSubagent(
		callerId: string,
		params: SubagentCreateInput,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails }> {
		return this.operationLock.run(async () => {
			this.assertAccepting();
			this.throwIfAborted(signal);
			if (!params.task.trim()) throw new Error("Subagent task must not be empty");
			if (this.activeRunCount() >= this.maxConcurrency) {
				throw new Error(`Subagent concurrency limit reached (${this.maxConcurrency})`);
			}
			const parent = callerId === ROOT_CALLER_ID ? undefined : this.requireChild(callerId);
			if (parent && parent.metadata.remainingDepth <= 0) throw new Error("Subagent recursion depth exhausted");
			const depth = parent ? parent.metadata.depth + 1 : 1;
			if (depth > this.maxDepth) throw new Error(`Subagent depth limit reached (${this.maxDepth})`);
			const remainingDepth = this.maxDepth - depth;
			const cwd = await this.resolveCwd(
				params.cwd,
				parent?.metadata.cwd ?? this.rootContext.cwd,
				parent !== undefined,
			);
			this.throwIfAborted(signal);
			const inheritedTools = parent?.metadata.enabledTools.filter((name) => BUILTIN_TOOLS.has(name));
			const requestedTools = params.tools ?? (inheritedTools ? [...inheritedTools] : [...DEFAULT_TOOLS]);
			const builtins = this.validateTools(requestedTools, inheritedTools);
			const baseModel = parent
				? this.modelRuntime.getModel(parent.metadata.modelProvider, parent.metadata.modelId)
				: this.rootContext.model;
			const model = await this.resolveModel(params.model, baseModel);
			this.throwIfAborted(signal);
			const thinkingLevel = params.thinking_level ?? parent?.metadata.thinkingLevel ?? this.pi.getThinkingLevel();
			const id = randomUUID();
			const name = params.name?.trim() || `subagent-${id.slice(0, 8)}`;
			const limits: SubagentLimits = {
				timeoutSeconds: params.limits?.timeout_seconds,
			};
			const privateNames = [...MANAGEMENT_TOOL_NAMES, ...(remainingDepth > 0 ? ["subagent_create"] : [])];
			const enabledTools = [...new Set([...builtins, ...privateNames])];
			const generatedSystemPrompt = this.generateSystemPrompt({
				id,
				name,
				cwd,
				parentName: parent?.metadata.name ?? "parent Pi session",
				remainingDepth,
				enabledTools,
				limits,
				rolePrompt: params.system_prompt,
			});
			const manager = SessionManager.create(cwd, this.childSessionDir);
			const sessionPath = manager.getSessionFile();
			if (!sessionPath) throw new Error("Failed to allocate a persistent child session path");
			const now = Date.now();
			const metadata: PersistedChild = {
				id,
				name,
				parentId: parent?.metadata.id ?? null,
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
				generatedSystemPrompt,
				enabledTools,
				limits,
				state: "creating",
				turns: 0,
				createdAt: now,
				updatedAt: now,
				lastActivityAt: now,
				dashboardOrder: this.allocateDashboardOrder(),
				cumulativeActiveMs: 0,
				usage: emptyUsage(),
				latestTurns: [],
				pendingNotifications: [],
			};
			const record = this.newRecord(metadata, manager, false);
			this.children.set(id, record);
			this.invalidateDashboard(false);
			try {
				await this.openRuntime(record, model);
				this.throwIfAborted(signal);
				const initialMessage = params.context
					? `<parent_context>\n${params.context}\n</parent_context>\n\n<task>\n${params.task}\n</task>`
					: `<task>\n${params.task}\n</task>`;
				this.startRun(record, initialMessage);
				const snapshot = this.snapshot(record);
				return {
					content: [{ type: "text", text: `Created ${name} (${id}) in state ${snapshot.state}.` }],
					details: { action: "create", childId: id, acceptedAt: Date.now(), snapshot },
				};
			} catch (error) {
				this.children.delete(id);
				if (record.timeout) clearTimeout(record.timeout);
				record.unsubscribe?.();
				record.unsubscribe = undefined;
				record.session?.dispose();
				record.session = undefined;
				this.persistRegistry();
				this.invalidateDashboard(false);
				throw error;
			}
		});
	}

	listSubagents(
		callerId: string,
		params: SubagentListInput,
	): { content: Array<{ type: "text"; text: string }>; details: ListSubagentsDetails } {
		this.assertAccepting();
		const selected = params.names ? this.resolveMany(callerId, params.names) : this.allowedChildren(callerId);
		const states = params.states ? new Set<SubagentState>(params.states) : undefined;
		const snapshots = selected
			.filter((record) => !states || states.has(record.metadata.state))
			.map((record) => this.snapshot(record));
		const text =
			params.detail === "compact"
				? snapshots
						.map((snapshot) => `${snapshot.name} (${snapshot.id}): ${snapshot.state}, turn ${snapshot.turns}`)
						.join("\n") || "No matching subagents."
				: JSON.stringify(snapshots, null, 2);
		return {
			content: [{ type: "text", text: truncateHead(text, { maxBytes: 40_000, maxLines: 1_000 }).content }],
			details: { snapshots },
		};
	}

	async sendSubagent(
		callerId: string,
		params: SubagentSendInput,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails }> {
		const record = await this.operationLock.run(() => {
			this.assertAccepting();
			this.throwIfAborted(signal);
			return this.resolveOne(callerId, params.name);
		});
		await this.seedProvider(record.metadata.modelProvider);
		this.throwIfAborted(signal);
		while (true) {
			let settlingRun: Promise<void> | undefined;
			let stopFlight: StopFlight | undefined;
			const result = await this.operationLock.run(() =>
				record.lock.run(async () => {
					this.assertAccepting();
					this.throwIfAborted(signal);
					if (record.metadata.state === "stopping") {
						stopFlight = record.stopFlight;
						if (!stopFlight) throw new Error(`Subagent ${record.metadata.name} is stopping`);
						return undefined;
					}
					const delivery: DeliveryMode = params.delivery ?? "auto";
					if (record.metadata.state === "running") {
						const session = this.requireSession(record);
						if (record.settlingGeneration === record.runGeneration && record.runPromise) {
							settlingRun = record.runPromise;
							return undefined;
						}
						this.throwIfAborted(signal);
						if (delivery === "follow_up") await session.followUp(params.message);
						else await session.steer(params.message);
						record.metadata.lastActivityAt = Date.now();
						this.persistRegistry();
						this.invalidateDashboard(false);
					} else {
						if (delivery !== "auto") {
							throw new Error(
								`${delivery} requires a running subagent; use delivery "auto" to continue an idle one`,
							);
						}
						if (this.activeRunCount() >= this.maxConcurrency) {
							throw new Error(`Subagent concurrency limit reached (${this.maxConcurrency})`);
						}
						try {
							await this.ensureRuntime(record);
							this.throwIfAborted(signal);
							const message = record.historyMissing
								? `<recovery_context>\nThe previous child session file was not durably created.${record.metadata.context ? `\n\nOriginal parent context:\n${record.metadata.context}` : ""}\n\nOriginal task:\n${record.metadata.task}\n</recovery_context>\n\n${params.message}`
								: params.message;
							record.historyMissing = false;
							this.startRun(record, message, true);
						} catch (error) {
							if (!record.runPromise) this.disposeRuntime(record);
							throw error;
						}
					}
					const snapshot = this.snapshot(record);
					return {
						content: [
							{
								type: "text" as const,
								text: `Delivered message to ${record.metadata.name}; state is ${snapshot.state}.`,
							},
						],
						details: { action: "send" as const, childId: record.metadata.id, acceptedAt: Date.now(), snapshot },
					};
				}),
			);
			if (result) return result;
			const pending = stopFlight?.promise ?? settlingRun;
			if (!pending) throw new Error(`Subagent ${record.metadata.name} could not accept the message`);
			await this.waitWithAbort(pending, signal);
			this.throwIfAborted(signal);
		}
	}

	async waitSubagents(
		callerId: string,
		params: SubagentWaitInput,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<WaitSubagentsDetails> | undefined,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: WaitSubagentsDetails }> {
		this.assertAccepting();
		const selected = params.names ? this.resolveMany(callerId, params.names) : this.allowedChildren(callerId);
		if (selected.length === 0) throw new Error("No retained subagents can reach a requested wait event");
		const acceptedStates = new Set<WaitEvent>(params.events ?? ["waiting_parent", "completed", "failed", "paused"]);
		if (acceptedStates.size === 0) throw new Error("subagent_wait events must not be empty");
		const immediate = selected.find(
			(record) => isWaitEvent(record.metadata.state) && acceptedStates.has(record.metadata.state),
		);
		if (immediate) {
			this.claimNotification(immediate);
			return this.waitResult("event", selected, immediate);
		}
		if (signal?.aborted) return this.waitResult("cancelled", selected);

		const outcome = await new Promise<WaiterOutcome>((resolveWaiter) => {
			const id = randomUUID();
			const waiter: Waiter = {
				id,
				callerId,
				selectedIds: new Set(selected.map((record) => record.metadata.id)),
				acceptedStates,
				resolve: resolveWaiter,
				signal,
				onUpdate,
			};
			if (params.timeout_seconds !== undefined) {
				waiter.timeout = setTimeout(
					() => this.settleWaiter(waiter, { reason: "timeout" }),
					params.timeout_seconds * 1_000,
				);
			}
			if (signal) {
				waiter.abortListener = () => this.settleWaiter(waiter, { reason: "cancelled" });
				signal.addEventListener("abort", waiter.abortListener, { once: true });
			}
			waiter.updateInterval = setInterval(() => this.updateWaiter(waiter), 1_000);
			this.waiters.set(id, waiter);
			this.updateWaiter(waiter);
		});
		const current = [...(outcome.matchedId ? [this.requireChild(outcome.matchedId)] : [])];
		return this.waitResult(outcome.reason, selected, current[0]);
	}

	stopSubagent(callerId: string, params: SubagentStopInput, signal?: AbortSignal): Promise<StopSubagentResult> {
		const operation = this.stopSubagentOperation(callerId, params, signal);
		this.pendingStopOperations.add(operation);
		void operation.finally(() => this.pendingStopOperations.delete(operation)).catch(() => {});
		return operation;
	}

	shutdown(persist = true): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.shutdownPromise) return this.shutdownPromise;
		this.accepting = false;
		this.persistenceEnabled = persist;
		this.shutdownPromise = this.performShutdown(persist);
		return this.shutdownPromise;
	}

	private async stopSubagentOperation(
		callerId: string,
		params: SubagentStopInput,
		signal?: AbortSignal,
	): Promise<StopSubagentResult> {
		const { record, flight } = await this.operationLock.run(async () => {
			this.assertAccepting();
			this.throwIfAborted(signal);
			const record = this.resolveOne(callerId, params.name);
			return { record, flight: await this.beginStopRecord(record, params.reason) };
		});

		await flight.promise;
		const snapshot = flight.snapshot ?? this.snapshot(record);
		return {
			content: [{ type: "text", text: `Paused ${record.metadata.name}.` }],
			details: { childId: record.metadata.id, snapshot },
		};
	}

	private async performShutdown(persist: boolean): Promise<void> {
		const active = await this.operationLock.run(() => {
			if (this.rootNotificationTimer) clearTimeout(this.rootNotificationTimer);
			this.rootNotificationTimer = undefined;
			this.rootNotifications.clear();
			for (const waiter of [...this.waiters.values()]) this.settleWaiter(waiter, { reason: "cancelled" });
			const runs: Promise<void>[] = [];
			if (this.dashboardTimer) clearTimeout(this.dashboardTimer);
			this.dashboardTimer = undefined;
			for (const record of this.children.values()) {
				this.deferNotificationDelivery(record, "Nested notification delivery interrupted by shutdown", false);
				if (record.runPromise) {
					this.cancelRun(record, "shutdown");
					runs.push(record.runPromise);
				}
			}
			return runs;
		});

		await Promise.allSettled(active);
		await Promise.allSettled([...this.pendingStopOperations]);

		await this.operationLock.run(() => {
			for (const record of this.children.values()) {
				if (
					record.metadata.state === "running" ||
					record.metadata.state === "stopping" ||
					record.metadata.state === "creating"
				)
					record.metadata.state = "paused";
				record.metadata.updatedAt = Date.now();
				this.captureRuntimeMetadata(record);
			}
			if (persist) this.persistRegistry();
			for (const record of this.children.values()) this.releaseRuntime(record);
			this.dashboardInvalidator = undefined;
			this.disposed = true;
		});
	}

	private allocateDashboardOrder(): number {
		return ++this.dashboardOrderSequence;
	}

	private assertAccepting(): void {
		if (!this.accepting || this.disposed) throw new Error("Subagent supervisor is shutting down");
	}

	private throwIfAborted(signal: AbortSignal | undefined): void {
		if (!signal?.aborted) return;
		throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
	}

	private waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
		if (!signal) return promise;
		this.throwIfAborted(signal);
		return new Promise<T>((resolveWait, rejectWait) => {
			const onAbort = () => {
				cleanup();
				rejectWait(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
			};
			const cleanup = () => signal.removeEventListener("abort", onAbort);
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(
				(value) => {
					cleanup();
					resolveWait(value);
				},
				(error) => {
					cleanup();
					rejectWait(error);
				},
			);
		});
	}

	private cloneTurns(turns: TurnView[]): TurnView[] {
		return turns.map((turn) => ({
			...turn,
			activities: turn.activities.map((activity) => ({ ...activity })),
		}));
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

	private appendRecordError(record: ChildRecord, message: string): void {
		record.metadata.error = record.metadata.error ? `${record.metadata.error}; ${message}` : message;
		record.metadata.updatedAt = Date.now();
	}

	private setAbortCause(record: ChildRecord, cause: AbortCause): void {
		const priority: Record<AbortCause, number> = {
			yield: 0,
			timeout: 1,
			pause: 2,
			shutdown: 2,
		};
		if (record.abortCause === undefined || priority[cause] > priority[record.abortCause]) record.abortCause = cause;
	}

	private cancelRun(record: ChildRecord, cause: AbortCause, error?: string): { abortFailed: boolean } {
		this.setAbortCause(record, cause);
		if (error) record.metadata.error = error;
		if (record.timeout) clearTimeout(record.timeout);
		record.timeout = undefined;
		const failures: string[] = [];
		const attempt = (name: string, operation: (() => void) | undefined): boolean => {
			if (!operation) return false;
			try {
				operation();
				return true;
			} catch (operationError) {
				failures.push(
					`${name}: ${operationError instanceof Error ? operationError.message : String(operationError)}`,
				);
				return false;
			}
		};
		attempt("clearQueue", record.session ? () => record.session?.clearQueue() : undefined);
		attempt("abortRetry", record.session ? () => record.session?.abortRetry() : undefined);
		attempt("abortCompaction", record.session ? () => record.session?.abortCompaction() : undefined);
		const abortSucceeded = attempt("agent.abort", record.session ? () => record.session?.agent.abort() : undefined);
		if (failures.length > 0) this.appendRecordError(record, `Run cancellation issue(s): ${failures.join(", ")}`);
		return { abortFailed: record.runPromise !== undefined && !abortSucceeded };
	}

	private detachUnabortableRun(record: ChildRecord): void {
		if (record.activeStartedAt !== undefined) {
			record.metadata.cumulativeActiveMs += Date.now() - record.activeStartedAt;
			record.activeStartedAt = undefined;
		}
		record.runGeneration++;
		record.runPromise = undefined;
		record.settlingGeneration = undefined;
		record.abortCause = undefined;
		this.appendRecordError(record, "Detached active run after agent.abort failed");
	}

	private persistStopState(record: ChildRecord, phase: string): void {
		try {
			this.persistRegistry();
		} catch (error) {
			this.appendRecordError(
				record,
				`${phase} persistence failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async beginStopRecord(record: ChildRecord, reason?: string): Promise<StopFlight> {
		let created = false;
		const flight = await record.lock.run(() => {
			if (record.stopFlight) return record.stopFlight;
			let resolveFlight = () => {};
			let rejectFlight = (_error: unknown) => {};
			const promise = new Promise<void>((resolve, reject) => {
				resolveFlight = resolve;
				rejectFlight = reject;
			});
			const next: StopFlight = {
				token: ++record.stopSequence,
				promise,
				resolve: resolveFlight,
				reject: rejectFlight,
				activeRun: record.runPromise,
			};
			record.stopFlight = next;
			created = true;
			record.metadata.error = reason;
			record.metadata.state = "stopping";
			record.metadata.updatedAt = Date.now();
			record.metadata.lastActivityAt = record.metadata.updatedAt;
			this.deferNotificationDelivery(record, "Nested notification delivery interrupted by stop", false);
			if (record.runPromise) {
				const cancellation = this.cancelRun(record, "pause", reason);
				if (cancellation.abortFailed) {
					next.activeRun = undefined;
					this.detachUnabortableRun(record);
				}
			}
			this.captureRuntimeMetadata(record);
			this.persistStopState(record, "Stop setup");
			this.invalidateDashboard(false);
			return next;
		});
		if (created) {
			void this.executeStopFlight(record, flight).then(flight.resolve, flight.reject);
		}
		return flight;
	}

	private async executeStopFlight(record: ChildRecord, flight: StopFlight): Promise<void> {
		if (flight.activeRun) await Promise.allSettled([flight.activeRun]);
		let deferOwnNotificationRetry = false;
		try {
			await record.lock.run(() => {
				if (record.stopFlight !== flight || record.stopSequence !== flight.token) return;
				this.claimNotification(record);
				record.metadata.state = "paused";
				record.metadata.updatedAt = Date.now();
				record.metadata.lastActivityAt = record.metadata.updatedAt;
				deferOwnNotificationRetry = record.notificationRetryDeferred;
				record.notificationRetryDeferred = false;
				this.captureRuntimeMetadata(record);
				this.persistStopState(record, "Stop commit");
				this.evaluateWaiters(record);
				this.invalidateDashboard(false);
				this.releaseRuntime(record);
				flight.snapshot = this.snapshot(record);
				record.stopFlight = undefined;
			});
		} finally {
			if (record.stopFlight === flight) record.stopFlight = undefined;
		}
		this.schedulePendingNotificationDrains(deferOwnNotificationRetry ? record.metadata.id : undefined);
	}

	private newRecord(
		metadata: PersistedChild,
		manager: SessionManager | undefined,
		historyMissing: boolean,
	): ChildRecord {
		return {
			metadata,
			manager,
			lock: new Mutex(),
			runGeneration: 0,
			stopSequence: 0,
			notificationRetryDeferred: false,
			activeActivities: new Map(),
			turns: this.cloneTurns(metadata.latestTurns).slice(-MAX_RETAINED_TURNS),
			historyMissing,
		};
	}

	private retainLatestTurns(record: ChildRecord): void {
		if (record.turns.length > MAX_RETAINED_TURNS) record.turns = record.turns.slice(-MAX_RETAINED_TURNS);
		record.metadata.latestTurns = this.cloneTurns(record.turns);
	}

	private captureRuntimeMetadata(record: ChildRecord): void {
		try {
			record.metadata.childLeafId = record.manager?.getLeafId() ?? record.metadata.childLeafId;
		} catch (error) {
			this.appendRecordError(
				record,
				`Child leaf capture failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		record.metadata.usage = this.usageSnapshot(record);
		try {
			this.retainLatestTurns(record);
		} catch (error) {
			this.appendRecordError(
				record,
				`Turn summary capture failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
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
		} catch (error) {
			this.appendRecordError(
				record,
				`Child event unsubscribe failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		try {
			session?.dispose();
		} catch (error) {
			this.appendRecordError(
				record,
				`AgentSession disposal failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private disposeRuntime(record: ChildRecord): void {
		this.captureRuntimeMetadata(record);
		this.releaseRuntime(record);
	}

	private validateTools(requested: string[], inherited: string[] | undefined): string[] {
		const unique = [...new Set(requested)];
		const unknown = unique.filter((name) => !BUILTIN_TOOLS.has(name));
		if (unknown.length > 0) throw new Error(`Unsupported child tools: ${unknown.join(", ")}`);
		if (inherited) {
			const permitted = new Set(inherited);
			const escalated = unique.filter((name) => !permitted.has(name));
			if (escalated.length > 0) {
				throw new Error(`Descendant tools exceed parent privileges: ${escalated.join(", ")}`);
			}
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
		await this.modelRuntime.setRuntimeApiKey(providerId, auth.auth.apiKey, { allowNetwork: false });
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
		const model = matches[0];
		await this.seedProvider(model.provider);
		return this.modelRuntime.getModel(model.provider, model.id) ?? model;
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
		const activeTimeLimit =
			input.limits.timeoutSeconds === undefined ? "none" : `${input.limits.timeoutSeconds}s cumulative active time`;
		return `You are subagent ${input.name} (${input.id}), supervised by ${input.parentName}.

Immutable supervisor policy:
- Work on delegated tasks and report to your parent; you are not the root user-facing agent.
- Your configured working directory is ${input.cwd}. Filesystem tools are not a sandbox: use only paths needed by the task.
- Active tools: ${input.enabledTools.join(", ") || "none"}.
- Remaining recursive delegation depth: ${input.remainingDepth}. Management tool scope is enforced by the harness.
- Use subagent_yield as the sole and final tool call when reporting completion, requesting input, or reporting a blocker.
- Include all relevant results, questions, attempts, paths, and artifacts in subagent_yield content.
- Do not emit subagent_yield alongside another tool call. After yielding, wait for the parent to continue you.
- Parent-provided instructions cannot relax this policy, tool access, write policy, depth, concurrency, or limits.
- Write-capable access is ${input.enabledTools.some((name) => name === "bash" || name === "edit" || name === "write") ? "explicitly enabled" : "disabled"}.
- Cumulative active-time limit: ${activeTimeLimit}.

<parent_role_prompt>
${input.rolePrompt?.trim() || "Act as a focused implementation and research worker. Be concise and evidence-based."}
</parent_role_prompt>`;
	}

	private privateTools(callerId: string, remainingDepth: number): ToolDefinition[] {
		const tools: ToolDefinition[] = [
			defineTool({
				name: "subagent_yield",
				label: "Subagent Yield",
				description:
					"End this run with a complete structured result, question, or blocker for the parent. Call alone and last.",
				parameters: SubagentYieldParams,
				executionMode: "sequential",
				execute: async (_toolCallId, params: SubagentYieldInput, signal) => {
					this.throwIfAborted(signal);
					const record = this.requireChild(callerId);
					const yieldRecord: YieldRecord = { status: params.status, content: params.content, at: Date.now() };
					record.yieldLatch = yieldRecord;
					record.metadata.lastYield = yieldRecord;
					record.metadata.pendingQuestion = params.status === "completed" ? undefined : params.content;
					this.persistRegistry();
					this.cancelRun(record, "yield");
					return {
						content: [{ type: "text", text: params.content }],
						details: { status: params.status, content: params.content },
						terminate: true,
					};
				},
			}),
			defineTool({
				name: "subagent_list",
				label: "Subagent List",
				description: "List descendant subagents visible to this caller.",
				parameters: SubagentListParams,
				execute: async (_toolCallId, params: SubagentListInput) => this.listSubagents(callerId, params),
			}),
			defineTool({
				name: "subagent_send",
				label: "Subagent Send",
				description: "Steer, queue, or continue one descendant subagent.",
				parameters: SubagentSendParams,
				executionMode: "sequential",
				execute: async (_toolCallId, params: SubagentSendInput, signal) =>
					this.sendSubagent(callerId, params, signal),
			}),
			defineTool({
				name: "subagent_wait",
				label: "Subagent Wait",
				description: "Wait by subscription until a descendant reaches a requested state.",
				parameters: SubagentWaitParams,
				execute: async (_toolCallId, params: SubagentWaitInput, signal, onUpdate) =>
					this.waitSubagents(callerId, params, signal, onUpdate),
			}),
			defineTool({
				name: "subagent_stop",
				label: "Subagent Stop",
				description: "Reversibly stop one descendant subagent in the paused state.",
				parameters: SubagentStopParams,
				execute: async (_toolCallId, params: SubagentStopInput, signal) =>
					this.stopSubagent(callerId, params, signal),
			}),
		];
		if (remainingDepth > 0) {
			tools.push(
				defineTool({
					name: "subagent_create",
					label: "Subagent Create",
					description: "Create a scoped descendant subagent and start it in the background.",
					parameters: SubagentCreateParams,
					executionMode: "sequential",
					execute: async (_toolCallId, params: SubagentCreateInput, signal) =>
						this.createSubagent(callerId, params, signal),
				}),
			);
		}
		return tools;
	}

	private async openRuntime(record: ChildRecord, model?: Model<Api>): Promise<void> {
		const resolvedModel =
			model ?? (await this.resolveModel(`${record.metadata.modelProvider}/${record.metadata.modelId}`, undefined));
		const manager =
			record.manager ?? SessionManager.open(record.metadata.sessionPath, this.childSessionDir, record.metadata.cwd);
		if (record.metadata.childLeafId === null) manager.resetLeaf();
		else {
			if (!manager.getEntry(record.metadata.childLeafId)) {
				throw new Error(`Persisted child leaf not found: ${record.metadata.childLeafId}`);
			}
			manager.branch(record.metadata.childLeafId);
		}
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
		record.activeActivities.clear();
		const rebuiltTurns = rebuildTurns(session.messages);
		const offset = Math.max(0, record.metadata.turns - rebuiltTurns.length);
		record.turns = rebuiltTurns
			.map((turn, index) => ({ ...turn, index: offset + index + 1 }))
			.slice(-MAX_RETAINED_TURNS);
		record.metadata.turns = Math.max(record.metadata.turns, rebuiltTurns.length);
		this.retainLatestTurns(record);
		record.unsubscribe = session.subscribe((event) => {
			try {
				this.handleChildEvent(record, event);
			} catch (error) {
				record.metadata.error = error instanceof Error ? error.message : String(error);
				record.metadata.lastActivityAt = Date.now();
				this.invalidateDashboard(false);
			}
		});
	}

	private async ensureRuntime(record: ChildRecord): Promise<void> {
		if (record.session) return;
		if (existsSync(record.metadata.sessionPath)) {
			record.manager = undefined;
		} else {
			record.manager = SessionManager.create(record.metadata.cwd, this.childSessionDir, {
				id: record.metadata.childSessionId,
			});
			const path = record.manager.getSessionFile();
			if (!path) throw new Error("Failed to recreate child session path");
			record.metadata.sessionPath = path;
			record.metadata.childLeafId = null;
			record.historyMissing = true;
		}
		await this.openRuntime(record);
	}

	private requireSession(record: ChildRecord): AgentSession {
		if (!record.session)
			throw new Error(`Subagent runtime unavailable: ${record.metadata.error ?? record.metadata.name}`);
		return record.session;
	}

	private createNotificationDelivery(
		record: ChildRecord,
		generation: number,
		notificationIds: string[],
	): NotificationDelivery {
		let resolveDelivery = (_accepted: boolean) => {};
		const promise = new Promise<boolean>((resolve) => {
			resolveDelivery = resolve;
		});
		const delivery: NotificationDelivery = {
			generation,
			notificationIds: [...notificationIds],
			preflightAccepted: false,
			promise,
			resolve: resolveDelivery,
		};
		record.notificationDelivery = delivery;
		return delivery;
	}

	private deferNotificationDelivery(record: ChildRecord, reason: string, persist = true): void {
		const delivery = record.notificationDelivery;
		if (!delivery) return;
		record.notificationDelivery = undefined;
		record.notificationRetryDeferred = true;
		record.metadata.error = reason;
		delivery.resolve(false);
		if (!persist) return;
		this.captureRuntimeMetadata(record);
		try {
			this.persistRegistry();
		} catch (error) {
			record.metadata.error = `${reason}; notification deferral persistence failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private handleNotificationPreflight(record: ChildRecord, generation: number, accepted: boolean): void {
		const delivery = record.notificationDelivery;
		if (!delivery || delivery.generation !== generation) return;
		if (!accepted) {
			this.deferNotificationDelivery(record, "Nested notification prompt was rejected before acceptance");
			return;
		}
		delivery.preflightAccepted = true;
	}

	private checkpointNotificationDeliveryAfterUserMessage(record: ChildRecord): void {
		const delivery = record.notificationDelivery;
		if (!delivery) return;
		queueMicrotask(() => {
			if (
				record.notificationDelivery !== delivery ||
				record.runGeneration !== delivery.generation ||
				!delivery.preflightAccepted ||
				record.metadata.state !== "running"
			) {
				return;
			}
			const deliveredIds = new Set(delivery.notificationIds);
			const previous = record.metadata.pendingNotifications;
			record.metadata.pendingNotifications = previous.filter((notification) => !deliveredIds.has(notification.id));
			this.captureRuntimeMetadata(record);
			try {
				this.persistRegistry();
			} catch (error) {
				record.metadata.pendingNotifications = previous;
				this.deferNotificationDelivery(
					record,
					`Nested notification checkpoint persistence failed: ${error instanceof Error ? error.message : String(error)}`,
					false,
				);
				return;
			}
			record.notificationDelivery = undefined;
			delivery.resolve(true);
		});
	}

	private startRun(
		record: ChildRecord,
		message: string,
		resumedBySend = false,
		notificationIds?: string[],
	): Promise<boolean> | undefined {
		this.requireSession(record);
		if (record.runPromise) throw new Error(`Subagent ${record.metadata.name} already has an active run`);
		const elapsed = record.metadata.cumulativeActiveMs;
		const timeoutMs =
			record.metadata.limits.timeoutSeconds === undefined
				? undefined
				: record.metadata.limits.timeoutSeconds * 1_000;
		if (timeoutMs !== undefined && elapsed >= timeoutMs) {
			throw new Error(`Subagent ${record.metadata.name} exhausted its timeout_seconds limit`);
		}
		record.runGeneration++;
		const generation = record.runGeneration;
		const notificationDelivery =
			notificationIds && notificationIds.length > 0
				? this.createNotificationDelivery(record, generation, notificationIds)
				: undefined;
		record.abortCause = undefined;
		record.settlingGeneration = undefined;
		record.yieldLatch = undefined;
		record.metadata.lastYield = undefined;
		record.metadata.pendingQuestion = undefined;
		record.metadata.error = undefined;
		if (resumedBySend) record.metadata.dashboardOrder = this.allocateDashboardOrder();
		record.metadata.state = "running";
		record.metadata.updatedAt = Date.now();
		record.metadata.lastActivityAt = Date.now();
		record.activeStartedAt = Date.now();
		if (timeoutMs !== undefined) {
			record.timeout = setTimeout(
				() => {
					if (record.runGeneration !== generation || record.metadata.state !== "running") return;
					this.cancelRun(
						record,
						"timeout",
						`Active-time limit exceeded (${record.metadata.limits.timeoutSeconds}s)`,
					);
				},
				Math.max(1, timeoutMs - elapsed),
			);
		}
		this.persistRegistry();
		this.invalidateDashboard(false);
		const run = this.runChild(record, generation, message);
		record.runPromise = run;
		void run.catch(() => {});
		return notificationDelivery?.promise;
	}

	private async runChild(record: ChildRecord, generation: number, message: string): Promise<void> {
		let failure: string | undefined;
		try {
			await this.requireSession(record).prompt(message, {
				expandPromptTemplates: false,
				source: "extension",
				preflightResult: (accepted) => this.handleNotificationPreflight(record, generation, accepted),
			});
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		if (record.runGeneration !== generation) return;
		record.settlingGeneration = generation;
		await record.lock.run(() => this.finalizeRun(record, generation, failure));
	}

	private finalizeRun(record: ChildRecord, generation: number, failure: string | undefined): void {
		if (record.runGeneration !== generation) return;
		if (record.timeout) clearTimeout(record.timeout);
		record.timeout = undefined;
		if (record.activeStartedAt !== undefined) {
			record.metadata.cumulativeActiveMs += Date.now() - record.activeStartedAt;
			record.activeStartedAt = undefined;
		}
		record.runPromise = undefined;
		record.settlingGeneration = undefined;
		const abortCause = record.abortCause;
		const stopInProgress = abortCause === "pause" && record.stopFlight !== undefined;
		const assistant = record.session ? lastAssistant(record.session.messages) : undefined;
		if (stopInProgress) {
			record.metadata.state = "stopping";
		} else if (abortCause === "pause" || abortCause === "shutdown") {
			record.metadata.state = "paused";
		} else if (abortCause === "timeout") {
			record.metadata.state = "failed";
		} else if (record.yieldLatch) {
			record.metadata.state = record.yieldLatch.status === "completed" ? "completed" : "waiting_parent";
			record.metadata.lastYield = record.yieldLatch;
			record.metadata.pendingQuestion =
				record.yieldLatch.status === "completed" ? undefined : record.yieldLatch.content;
		} else if (failure) {
			record.metadata.state = "failed";
			record.metadata.error = failure;
		} else if (assistant?.stopReason === "error") {
			record.metadata.state = "failed";
			record.metadata.error = assistant.errorMessage ?? "Model run failed";
		} else if (assistant?.stopReason === "aborted") {
			record.metadata.state = "paused";
			record.metadata.error ??= "Run aborted unexpectedly";
		} else {
			record.metadata.state = "completed";
		}
		record.metadata.updatedAt = Date.now();
		record.metadata.lastActivityAt = Date.now();
		record.currentActivity = undefined;
		record.activeActivities.clear();
		record.abortCause = undefined;
		if (record.notificationDelivery?.generation === generation) {
			this.deferNotificationDelivery(
				record,
				failure
					? `Nested notification prompt failed before durable acceptance: ${failure}`
					: "Nested notification run settled before its user message was durably accepted",
				false,
			);
		}
		const deferOwnNotificationRetry = record.notificationRetryDeferred;
		record.notificationRetryDeferred = false;
		this.captureRuntimeMetadata(record);
		this.persistRegistry();
		const claimed = this.evaluateWaiters(record);
		const managementStop = abortCause === "pause" || abortCause === "shutdown";
		if (!claimed && !managementStop && this.accepting) this.notifyOwner(record);
		this.invalidateDashboard(false);
		if (!stopInProgress) this.releaseRuntime(record);
		this.schedulePendingNotificationDrains(deferOwnNotificationRetry ? record.metadata.id : undefined);
	}

	private handleChildEvent(record: ChildRecord, event: AgentSessionEvent): void {
		if (this.disposed) return;
		if (event.type === "message_end") {
			this.checkpointChildLeafAfterMessage(record);
			if (event.message.role === "user") this.checkpointNotificationDeliveryAfterUserMessage(record);
		}
		const now = Date.now();
		record.metadata.lastActivityAt = now;
		switch (event.type) {
			case "agent_start":
				record.currentActivity = { type: "thinking", preview: "starting", started_at: now };
				break;
			case "turn_start":
				record.activeActivities.clear();
				record.turns.push({ index: record.metadata.turns + 1, activities: [], startedAt: now });
				this.retainLatestTurns(record);
				record.currentActivity = { type: "thinking", preview: "thinking", started_at: now };
				break;
			case "message_update": {
				const previews = assistantPreviews(event.message);
				const turn = record.turns.at(-1);
				if (turn) {
					turn.textPreview = previews.text ?? turn.textPreview;
					turn.thinkingPreview = previews.thinking ?? turn.thinkingPreview;
				}
				record.currentActivity =
					this.currentToolActivity(record) ??
					(previews.text
						? undefined
						: { type: "thinking", preview: previews.thinking ?? "thinking", started_at: now });
				this.invalidateDashboard(true);
				return;
			}
			case "message_end":
				if (event.message.role === "assistant") {
					const previews = assistantPreviews(event.message);
					const turn = record.turns.at(-1);
					if (turn) {
						turn.textPreview = previews.text ?? turn.textPreview;
						turn.thinkingPreview = previews.thinking ?? turn.thinkingPreview;
					}
					record.metadata.error =
						event.message.stopReason === "error" ? event.message.errorMessage : record.metadata.error;
				}
				break;
			case "tool_execution_start": {
				const turn = record.turns.at(-1);
				const activity: ToolActivityView = {
					toolCallId: event.toolCallId,
					name: event.toolName,
					preview: toolPreview(event.toolName, event.args),
					startedAt: now,
				};
				turn?.activities.push(activity);
				record.activeActivities.set(event.toolCallId, activity);
				record.currentActivity = this.currentToolActivity(record);
				break;
			}
			case "tool_execution_update": {
				const activity = record.activeActivities.get(event.toolCallId);
				const preview = textFromUnknown(event.partialResult);
				if (activity) activity.resultPreview = preview ?? activity.resultPreview;
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
				record.currentActivity = this.currentToolActivity(record) ?? {
					type: "thinking",
					preview: "processing tool result",
					started_at: now,
				};
				break;
			}
			case "turn_end": {
				const turn = record.turns.at(-1);
				if (turn) turn.endedAt = now;
				record.metadata.turns++;
				this.retainLatestTurns(record);
				this.persistRegistry();
				break;
			}
			case "auto_retry_start":
				record.currentActivity = {
					type: "thinking",
					preview: `retry ${event.attempt}/${event.maxAttempts}`,
					started_at: now,
				};
				break;
			case "auto_retry_end":
				record.currentActivity = event.success
					? { type: "thinking", preview: "retry succeeded", started_at: now }
					: undefined;
				if (event.finalError) record.metadata.error = event.finalError;
				break;
			case "compaction_start":
				record.currentActivity = { type: "thinking", preview: `compacting (${event.reason})`, started_at: now };
				break;
			case "compaction_end":
				record.currentActivity = event.errorMessage
					? { type: "thinking", preview: event.errorMessage, started_at: now }
					: { type: "thinking", preview: "compaction complete", started_at: now };
				break;
			case "queue_update":
				if (event.steering.length + event.followUp.length > 0) {
					record.currentActivity = {
						type: "thinking",
						preview: `${event.steering.length} steering, ${event.followUp.length} follow-up queued`,
						started_at: now,
					};
				}
				break;
			case "agent_end":
			case "agent_settled":
			case "message_start":
			case "entry_appended":
			case "session_info_changed":
			case "thinking_level_changed":
				break;
		}
		this.invalidateDashboard(false);
	}

	private checkpointChildLeafAfterMessage(record: ChildRecord): void {
		const manager = record.manager;
		if (!manager) return;
		queueMicrotask(() => {
			if (record.manager !== manager) return;
			record.metadata.childLeafId = manager.getLeafId();
			record.metadata.updatedAt = Date.now();
			this.persistRegistry();
		});
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
		} catch (error) {
			this.appendRecordError(
				record,
				`Usage capture failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return { ...record.metadata.usage };
		}
	}

	private snapshot(record: ChildRecord): SubagentSnapshot {
		const now = Date.now();
		const active = record.activeStartedAt === undefined ? 0 : now - record.activeStartedAt;
		return {
			id: record.metadata.id,
			name: record.metadata.name,
			state: record.metadata.state,
			model: `${record.metadata.modelProvider}/${record.metadata.modelId}`,
			thinking_level: record.metadata.thinkingLevel,
			elapsed_ms: record.metadata.cumulativeActiveMs + active,
			idle_ms: Math.max(0, now - record.metadata.lastActivityAt),
			turns: record.metadata.turns,
			current_activity: record.currentActivity,
			last_text_preview: [...record.turns].reverse().find((turn) => turn.textPreview)?.textPreview,
			pending_question: record.metadata.pendingQuestion,
			error: record.metadata.error,
			usage: this.usageSnapshot(record),
		};
	}

	private invalidateDashboard(throttled: boolean): void {
		if (!this.dashboardInvalidator) return;
		if (!throttled) {
			if (this.dashboardTimer) clearTimeout(this.dashboardTimer);
			this.dashboardTimer = undefined;
			try {
				this.dashboardInvalidator();
			} catch {
				// UI invalidation must never strand lifecycle transitions.
			}
			return;
		}
		if (this.dashboardTimer) return;
		this.dashboardTimer = setTimeout(() => {
			this.dashboardTimer = undefined;
			try {
				this.dashboardInvalidator?.();
			} catch {
				// UI invalidation must never strand lifecycle transitions.
			}
		}, RENDER_THROTTLE_MS);
	}

	private activeRunCount(): number {
		let count = 0;
		for (const record of this.children.values()) if (record.runPromise) count++;
		return count;
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

	private resolveOne(callerId: string, selector: string): ChildRecord {
		const allowed = this.allowedChildren(callerId);
		const byId = allowed.find((record) => record.metadata.id === selector);
		if (byId) return byId;
		const byName = allowed.filter((record) => record.metadata.name === selector);
		if (byName.length === 0) throw new Error(`No subagent in scope matches: ${selector}`);
		if (byName.length > 1) throw new Error(`Ambiguous subagent name ${selector}; use an immutable id`);
		return byName[0];
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

	private waitResult(
		reason: "pending" | "event" | "timeout" | "cancelled",
		records: ChildRecord[],
		matched?: ChildRecord,
	): { content: Array<{ type: "text"; text: string }>; details: WaitSubagentsDetails } {
		const snapshots = records.map((record) => this.snapshot(record));
		const matchedSnapshot = matched ? this.snapshot(matched) : undefined;
		const text = matchedSnapshot
			? `${matchedSnapshot.name} reached ${matchedSnapshot.state}.`
			: `subagent_wait ${reason}. ${snapshots.map((snapshot) => `${snapshot.name}:${snapshot.state}`).join(", ")}`;
		return { content: [{ type: "text", text }], details: { reason, snapshots, matched: matchedSnapshot } };
	}

	private updateWaiter(waiter: Waiter): void {
		if (!this.waiters.has(waiter.id) || !waiter.onUpdate) return;
		const records = [...waiter.selectedIds].flatMap((id) => {
			const record = this.children.get(id);
			return record ? [record] : [];
		});
		const result = this.waitResult("pending", records);
		waiter.onUpdate({
			content: [{ type: "text", text: result.content[0].text }],
			details: result.details,
		});
	}

	private settleWaiter(waiter: Waiter, outcome: WaiterOutcome): void {
		if (!this.waiters.delete(waiter.id)) return;
		if (waiter.timeout) clearTimeout(waiter.timeout);
		if (waiter.updateInterval) clearInterval(waiter.updateInterval);
		if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener("abort", waiter.abortListener);
		waiter.resolve(outcome);
	}

	private evaluateWaiters(record: ChildRecord): boolean {
		let claimed = false;
		for (const waiter of [...this.waiters.values()]) {
			if (
				waiter.selectedIds.has(record.metadata.id) &&
				isWaitEvent(record.metadata.state) &&
				waiter.acceptedStates.has(record.metadata.state)
			) {
				claimed = true;
				this.settleWaiter(waiter, { reason: "event", matchedId: record.metadata.id });
			}
		}
		return claimed;
	}

	private claimNotification(record: ChildRecord): void {
		if (record.metadata.parentId !== null || !this.rootNotifications.delete(record.metadata.id)) return;
		if (this.rootNotifications.size === 0 && this.rootNotificationTimer) {
			clearTimeout(this.rootNotificationTimer);
			this.rootNotificationTimer = undefined;
		}
	}

	private notificationText(record: ChildRecord): string {
		const handoff = record.metadata.lastYield?.content ?? record.metadata.error ?? record.turns.at(-1)?.textPreview;
		return `[subagent ${record.metadata.name} (${record.metadata.id})] state=${record.metadata.state}${handoff ? `\n${handoff}` : ""}`;
	}

	private notifyOwner(record: ChildRecord): void {
		const text = this.notificationText(record);
		if (record.metadata.parentId === null) {
			this.rootNotifications.set(record.metadata.id, text);
			if (!this.rootNotificationTimer) {
				this.rootNotificationTimer = setTimeout(() => {
					this.rootNotificationTimer = undefined;
					if (!this.accepting || this.rootNotifications.size === 0) return;
					const content = [...this.rootNotifications.values()].join("\n\n");
					this.rootNotifications.clear();
					this.pi.sendMessage(
						{ customType: NOTIFICATION_MESSAGE_TYPE, content, display: true, details: { source: "subagent" } },
						{ deliverAs: "followUp", triggerTurn: true },
					);
				}, NOTIFICATION_BATCH_MS);
			}
			return;
		}
		const ownerId = record.metadata.parentId;
		void this.deliverNestedNotification(ownerId, text).catch((error) => {
			const owner = this.children.get(ownerId);
			if (!owner) return;
			owner.metadata.error = `Nested notification enqueue failed: ${error instanceof Error ? error.message : String(error)}`;
			owner.metadata.updatedAt = Date.now();
			owner.metadata.lastActivityAt = owner.metadata.updatedAt;
			try {
				this.persistRegistry();
			} catch {
				// The inbox item remains in memory and a later registry write can persist it.
			}
			this.invalidateDashboard(false);
		});
	}

	private async deliverNestedNotification(ownerId: string, text: string): Promise<void> {
		if (!this.accepting) return;
		const owner = this.children.get(ownerId);
		if (!owner) return;
		owner.metadata.pendingNotifications.push({ id: randomUUID(), content: text, createdAt: Date.now() });
		owner.metadata.updatedAt = Date.now();
		this.persistRegistry();
		this.invalidateDashboard(false);
		await this.schedulePendingNotificationDrain(owner);
	}

	private notificationInboxText(notifications: PendingNotification[]): string {
		return notifications.map((notification) => notification.content).join("\n\n");
	}

	private schedulePendingNotificationDrain(record: ChildRecord): Promise<void> {
		if (!this.accepting || record.metadata.pendingNotifications.length === 0) return Promise.resolve();
		if (record.notificationDrainPromise) return record.notificationDrainPromise;
		const drain = this.drainPendingNotifications(record);
		const tracked = drain
			.then((progressed) => {
				if (record.notificationDrainPromise === tracked) record.notificationDrainPromise = undefined;
				if (progressed && record.metadata.pendingNotifications.length > 0) {
					queueMicrotask(() => void this.schedulePendingNotificationDrain(record));
				}
			})
			.catch((error) => {
				if (record.notificationDrainPromise === tracked) record.notificationDrainPromise = undefined;
				record.metadata.error = `Nested notification delivery deferred: ${error instanceof Error ? error.message : String(error)}`;
				record.metadata.updatedAt = Date.now();
				record.metadata.lastActivityAt = record.metadata.updatedAt;
				try {
					this.persistRegistry();
				} catch {
					// Keep the in-memory inbox intact; a later registry write can retry persistence.
				}
				this.invalidateDashboard(false);
			});
		record.notificationDrainPromise = tracked;
		return tracked;
	}

	private async drainPendingNotifications(record: ChildRecord): Promise<boolean> {
		let acceptance: Promise<boolean> | undefined;
		const started = await this.operationLock.run(async () => {
			if (!this.accepting) return false;
			return record.lock.run(async () => {
				if (record.metadata.pendingNotifications.length === 0 || record.metadata.state === "stopping") {
					return false;
				}
				if (record.metadata.state === "running") return false;
				const notifications = [...record.metadata.pendingNotifications];
				const text = this.notificationInboxText(notifications);
				if (this.activeRunCount() >= this.maxConcurrency) return false;
				try {
					await this.ensureRuntime(record);
					acceptance = this.startRun(
						record,
						text,
						false,
						notifications.map((notification) => notification.id),
					);
					if (!acceptance) throw new Error("Failed to create nested notification acceptance checkpoint");
					return true;
				} catch (error) {
					if (!record.runPromise) this.disposeRuntime(record);
					throw error;
				}
			});
		});
		if (!started || !acceptance) return false;
		return acceptance;
	}

	private schedulePendingNotificationDrains(excludedRecordId?: string): void {
		if (!this.accepting) return;
		for (const record of this.children.values()) {
			if (record.metadata.id === excludedRecordId) continue;
			if (record.metadata.pendingNotifications.length > 0) void this.schedulePendingNotificationDrain(record);
		}
	}

	private persistRegistry(): void {
		if (this.disposed || !this.persistenceEnabled) return;
		this.sequence++;
		const registry: PersistedRegistry = {
			version: 1,
			ownerSessionId: this.ownerSessionId,
			sequence: this.sequence,
			dashboardOrderSequence: this.dashboardOrderSequence,
			children: [...this.children.values()].map((record) => ({
				...record.metadata,
				childLeafId: record.manager?.getLeafId() ?? record.metadata.childLeafId,
				limits: { timeoutSeconds: record.metadata.limits.timeoutSeconds },
				enabledTools: [...record.metadata.enabledTools],
				usage: this.usageSnapshot(record),
				latestTurns: this.cloneTurns(record.turns).slice(-MAX_RETAINED_TURNS),
				pendingNotifications: record.metadata.pendingNotifications.map((notification) => ({ ...notification })),
			})),
		};
		this.pi.appendEntry(REGISTRY_ENTRY_TYPE, registry);
	}

	private async recover(): Promise<void> {
		let latest: PersistedRegistry | undefined;
		for (const entry of this.rootContext.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== REGISTRY_ENTRY_TYPE) continue;
			const parsed = parseRegistry(entry.data);
			if (parsed?.ownerSessionId === this.ownerSessionId && (!latest || parsed.sequence > latest.sequence)) {
				latest = parsed;
			}
		}
		if (!latest) return;
		this.sequence = latest.sequence;
		this.dashboardOrderSequence = latest.dashboardOrderSequence;
		const candidates = new Map(latest.children.map((child) => [child.id, child]));
		const retained = [...candidates.values()].filter((child) => {
			const seen = new Set<string>();
			let current: PersistedChild | undefined = child;
			while (current?.parentId !== null) {
				if (!current || seen.has(current.id)) return false;
				seen.add(current.id);
				current = candidates.get(current.parentId);
				if (!current) return false;
			}
			return current !== undefined;
		});
		for (const saved of retained) {
			const metadata: PersistedChild = {
				...saved,
				state:
					saved.state === "running" || saved.state === "stopping" || saved.state === "creating"
						? "paused"
						: saved.state,
				enabledTools: [...saved.enabledTools],
				limits: { timeoutSeconds: saved.limits.timeoutSeconds },
				usage: { ...saved.usage },
				latestTurns: this.cloneTurns(saved.latestTurns).slice(-MAX_RETAINED_TURNS),
				pendingNotifications: saved.pendingNotifications.map((notification) => ({ ...notification })),
			};
			const historyMissing = !existsSync(metadata.sessionPath);
			this.children.set(metadata.id, this.newRecord(metadata, undefined, historyMissing));
		}
		this.persistRegistry();
		this.schedulePendingNotificationDrains();
	}
}
