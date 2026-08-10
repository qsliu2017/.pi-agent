import { resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionContext,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import subagentSdkExtension from "./index.ts";
import { SubagentCreateParams } from "./schemas.ts";
import {
	DEFAULT_SUBAGENT_MAX_CONCURRENCY,
	DEFAULT_SUBAGENT_MAX_DEPTH,
	parseSubagentHarnessLimits,
	type SubagentHarnessLimits,
	SubagentSupervisor,
} from "./supervisor.ts";
import {
	type PersistedChild,
	type PersistedRegistry,
	REGISTRY_ENTRY_TYPE,
	ROOT_CALLER_ID,
	type TurnView,
} from "./types.ts";

interface TestMutex {
	run<T>(operation: () => Promise<T> | T): Promise<T>;
}

interface TestChildRecord {
	metadata: PersistedChild;
	session?: AgentSession;
	manager?: SessionManager;
	lock: TestMutex;
	runPromise?: Promise<void>;
	runGeneration: number;
	activeActivities: Map<string, unknown>;
	turns: TurnView[];
	historyMissing: boolean;
	unsubscribe?: () => void;
	settlingGeneration?: number;
	stopFlight?: unknown;
	abortCause?: "pause" | "shutdown" | "timeout" | "yield";
	yieldLatch?: { status: "completed" | "needs_input" | "blocked"; content: string; at: number };
	activeStartedAt?: number;
}

interface SupervisorInternals {
	pi: ExtensionAPI;
	operationLock: TestMutex;
	children: Map<string, TestChildRecord>;
	rootNotificationTimer?: ReturnType<typeof setTimeout>;
	dashboardOrderSequence: number;
	allocateDashboardOrder(): number;
	newRecord(metadata: PersistedChild, manager: SessionManager | undefined, historyMissing: boolean): TestChildRecord;
	handleChildEvent(record: TestChildRecord, event: AgentSessionEvent): void;
	finalizeRun(record: TestChildRecord, generation: number, failure: string | undefined): void | Promise<void>;
	deliverNestedNotification(ownerId: string, text: string): Promise<void>;
	schedulePendingNotificationDrain(record: TestChildRecord): Promise<void>;
	ensureRuntime(record: TestChildRecord): Promise<void>;
	startRun(record: TestChildRecord, message: string, resumedBySend?: boolean): void;
	recover(): Promise<void>;
}

function metadata(overrides: Partial<PersistedChild> = {}): PersistedChild {
	const now = Date.now();
	return {
		id: "child-1",
		name: "worker",
		parentId: null,
		depth: 1,
		remainingDepth: 2,
		childSessionId: "child-session",
		childLeafId: null,
		sessionPath: resolve("child-session.jsonl"),
		cwd: process.cwd(),
		task: "Inspect the implementation",
		context: "The race occurs during restart",
		modelProvider: "faux",
		modelId: "faux-model",
		thinkingLevel: "off",
		generatedSystemPrompt: "test prompt",
		enabledTools: [],
		limits: {},
		state: "paused",
		turns: 0,
		createdAt: now,
		updatedAt: now,
		lastActivityAt: now,
		dashboardOrder: 1,
		cumulativeActiveMs: 0,
		usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 },
		...overrides,
		latestTurns: overrides.latestTurns ?? [],
		pendingNotifications: overrides.pendingNotifications ?? [],
	};
}

function createSupervisor(harnessLimits?: SubagentHarnessLimits): {
	supervisor: SubagentSupervisor;
	internals: SupervisorInternals;
	appended: Array<{ customType: string; data: unknown }>;
	sent: Array<{ message: unknown; options: unknown }>;
	rootManager: SessionManager;
} {
	const appended: Array<{ customType: string; data: unknown }> = [];
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const rootManager = SessionManager.inMemory(process.cwd());
	const pi = {
		appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
		sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
	} as unknown as ExtensionAPI;
	const context = {
		cwd: process.cwd(),
		sessionManager: rootManager,
		modelRegistry: {
			getProvider: () => undefined,
			getProviderAuthStatus: () => ({ source: "none" }),
		},
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;
	const modelRuntime = {
		getProviderAuthStatus: () => ({ source: "none" }),
	} as unknown as ModelRuntime;
	const supervisor = Reflect.construct(SubagentSupervisor, [
		pi,
		context,
		modelRuntime,
		harnessLimits,
	]) as SubagentSupervisor;
	return { supervisor, internals: supervisor as unknown as SupervisorInternals, appended, sent, rootManager };
}

function addRecord(
	internals: SupervisorInternals,
	childMetadata: PersistedChild,
	manager?: SessionManager,
	historyMissing = false,
): TestChildRecord {
	const record = internals.newRecord(childMetadata, manager, historyMissing);
	internals.children.set(childMetadata.id, record);
	return record;
}

async function within<T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("operation timed out")), milliseconds);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function persistedTurn(index: number): TurnView {
	return {
		index,
		textPreview: `summary-${index}`,
		activities: [],
		startedAt: index,
		endedAt: index + 1,
	};
}

function sessionThatSettlesThroughOperationLock(
	internals: SupervisorInternals,
	record: TestChildRecord,
	settleRun: () => void,
	onQueued: () => void,
): AgentSession {
	return {
		clearQueue: () => {},
		getSessionStats: () => undefined,
		abortRetry: () => {},
		abortCompaction: () => {},
		dispose: () => {},
		agent: {
			abort: () => {
				void internals.operationLock.run(() => {
					onQueued();
					record.metadata.state = "paused";
					record.runPromise = undefined;
					settleRun();
				});
			},
		},
	} as unknown as AgentSession;
}

interface ControlledSession {
	session: AgentSession;
	prompt: ReturnType<typeof vi.fn>;
	steer: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	settle(): void;
}

function controlledSession(onPromptAccepted?: (message: string) => void): ControlledSession {
	let settle = () => {};
	const run = new Promise<void>((resolveRun) => {
		settle = resolveRun;
	});
	const prompt = vi.fn((message: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
		options?.preflightResult?.(true);
		if (onPromptAccepted) queueMicrotask(() => onPromptAccepted(message));
		return run;
	});
	const steer = vi.fn(async () => {});
	const dispose = vi.fn();
	const abort = vi.fn(settle);
	return {
		session: {
			messages: [],
			prompt,
			steer,
			followUp: async () => {},
			clearQueue: () => {},
			getSessionStats: () => undefined,
			abortRetry: () => {},
			abortCompaction: () => {},
			dispose,
			agent: { abort },
		} as unknown as AgentSession,
		prompt,
		steer,
		dispose,
		abort,
		settle,
	};
}

function installRuntimeOnDemand(internals: SupervisorInternals, runtime: ControlledSession): void {
	internals.ensureRuntime = async (record) => {
		if (!record.session) record.session = runtime.session;
	};
}

function acceptUserMessage(internals: SupervisorInternals, record: TestChildRecord, text: string): void {
	internals.handleChildEvent(record, {
		type: "message_end",
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	});
}

describe("subagent harness limits", () => {
	test("registers string flags with their defaults", () => {
		const flags = new Map<string, { type: "boolean" | "string"; default?: boolean | string }>();
		const pi = {
			registerFlag: (name: string, options: { type: "boolean" | "string"; default?: boolean | string }) =>
				flags.set(name, options),
			registerTool: () => {},
			registerMessageRenderer: () => {},
			on: () => {},
		} as unknown as ExtensionAPI;

		subagentSdkExtension(pi);

		expect(flags.get("subagent-max-depth")).toMatchObject({ type: "string", default: "3" });
		expect(flags.get("subagent-max-concurrency")).toMatchObject({ type: "string", default: "4" });
	});

	function flagApi(values: Record<string, string | undefined>): ExtensionAPI {
		return { getFlag: (name: string) => values[name] } as unknown as ExtensionAPI;
	}

	test("uses defaults and accepts configured integer boundaries", () => {
		expect(parseSubagentHarnessLimits(flagApi({}))).toEqual({
			maxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
			maxConcurrency: DEFAULT_SUBAGENT_MAX_CONCURRENCY,
		});
		expect(
			parseSubagentHarnessLimits(flagApi({ "subagent-max-depth": "0", "subagent-max-concurrency": "1" })),
		).toEqual({ maxDepth: 0, maxConcurrency: 1 });
	});

	test("enforces configured depth and concurrency instead of defaults", async () => {
		const depthLimited = createSupervisor({ maxDepth: 0, maxConcurrency: 4 }).supervisor;
		await expect(depthLimited.createSubagent(ROOT_CALLER_ID, { task: "cannot start" })).rejects.toThrow(
			"Subagent depth limit reached (0)",
		);

		const { supervisor, internals } = createSupervisor({ maxDepth: 3, maxConcurrency: 1 });
		const running = addRecord(internals, metadata({ state: "running" }));
		running.runPromise = Promise.resolve();
		await expect(supervisor.createSubagent(ROOT_CALLER_ID, { task: "cannot start" })).rejects.toThrow(
			"Subagent concurrency limit reached (1)",
		);
	});

	test.each([
		["subagent-max-depth", "-1", "a nonnegative integer"],
		["subagent-max-depth", "1.5", "a nonnegative integer"],
		["subagent-max-concurrency", "0", "a positive integer"],
		["subagent-max-concurrency", "many", "a positive integer"],
	] as const)("rejects invalid --%s values", (name, value, message) => {
		expect(() => parseSubagentHarnessLimits(flagApi({ [name]: value }))).toThrow(`--${name} must be ${message}`);
	});

	test("keeps harness policy out of the model-facing create schema", () => {
		const schema = JSON.stringify(SubagentCreateParams);
		expect(schema).not.toContain('"depth"');
		expect(schema).not.toContain("max_depth");
		const parsed = JSON.parse(schema) as {
			properties: { limits: { properties: Record<string, unknown> } };
		};
		expect(Object.keys(parsed.properties.limits.properties)).toEqual(["timeout_seconds"]);
	});
});

describe("SubagentSupervisor lifecycle locking", () => {
	test("stop releases the operation lock before awaiting a run with queued recursive management", async () => {
		const { supervisor, internals } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "running" }));
		let settleRun = () => {};
		let queuedManagementRan = false;
		record.runPromise = new Promise<void>((resolveRun) => {
			settleRun = resolveRun;
		});
		record.session = sessionThatSettlesThroughOperationLock(internals, record, settleRun, () => {
			queuedManagementRan = true;
		});

		const result = await within(supervisor.stopSubagent(ROOT_CALLER_ID, { name: record.metadata.id }));

		expect(queuedManagementRan).toBe(true);
		expect(result.details.snapshot.state).toBe("paused");
	});

	test("shutdown releases the operation lock before awaiting runs with queued recursive management", async () => {
		const { supervisor, internals } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "running" }));
		let settleRun = () => {};
		let queuedManagementRan = false;
		record.runPromise = new Promise<void>((resolveRun) => {
			settleRun = resolveRun;
		});
		record.session = sessionThatSettlesThroughOperationLock(internals, record, settleRun, () => {
			queuedManagementRan = true;
		});

		await within(supervisor.shutdown(false));

		expect(queuedManagementRan).toBe(true);
		expect(record.metadata.state).toBe("paused");
	});

	test("retains notifications when prompt rejects immediately or reports a negative preflight", async () => {
		for (const mode of ["reject", "negative-preflight"] as const) {
			const { supervisor, internals } = createSupervisor();
			const record = addRecord(internals, metadata({ state: "paused" }));
			const dispose = vi.fn();
			const prompt = vi.fn((_message: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
				if (mode === "negative-preflight") options?.preflightResult?.(false);
				return Promise.reject(new Error(`${mode} prompt failure`));
			});
			record.session = {
				messages: [],
				prompt,
				getSessionStats: () => undefined,
				dispose,
			} as unknown as AgentSession;

			await internals.deliverNestedNotification(record.metadata.id, `${mode} handoff`);
			const run = record.runPromise;
			if (run) await run;

			expect(prompt).toHaveBeenCalledTimes(1);
			expect(record.runPromise).toBeUndefined();
			expect(record.metadata.state).toBe("failed");
			expect(record.metadata.pendingNotifications.map(({ content }) => content)).toEqual([`${mode} handoff`]);
			expect(dispose).toHaveBeenCalledTimes(1);
			await supervisor.shutdown(false);
		}
	});

	test("retains a nested notification while its owner is stopping and drains it afterward", async () => {
		const { supervisor, internals } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "stopping" }));
		const runtime = controlledSession((message) => acceptUserMessage(internals, record, message));
		record.session = runtime.session;

		await internals.deliverNestedNotification(record.metadata.id, "nested child completed");

		expect(runtime.prompt).not.toHaveBeenCalled();
		expect(record.metadata.state).toBe("stopping");
		expect(record.metadata.pendingNotifications).toHaveLength(1);
		expect(record.metadata.pendingNotifications[0]?.content).toBe("nested child completed");

		record.metadata.state = "paused";
		await internals.schedulePendingNotificationDrain(record);

		expect(runtime.prompt).toHaveBeenCalledWith("nested child completed", expect.anything());
		expect(record.metadata.pendingNotifications).toEqual([]);
		expect(record.metadata.state).toBe("running");

		runtime.settle();
		if (record.runPromise) await record.runPromise;
		await supervisor.shutdown(false);
	});

	test("batches concurrent nested notifications and removes each inbox item exactly once", async () => {
		const { supervisor, internals } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "paused" }));
		const runtime = controlledSession((message) => acceptUserMessage(internals, record, message));
		record.session = runtime.session;

		await Promise.all([
			internals.deliverNestedNotification(record.metadata.id, "first completion"),
			internals.deliverNestedNotification(record.metadata.id, "second completion"),
		]);

		expect(runtime.prompt).toHaveBeenCalledTimes(1);
		expect(runtime.prompt).toHaveBeenCalledWith("first completion\n\nsecond completion", expect.anything());
		expect(record.metadata.pendingNotifications).toEqual([]);

		await internals.schedulePendingNotificationDrain(record);
		expect(runtime.prompt).toHaveBeenCalledTimes(1);

		runtime.settle();
		if (record.runPromise) await record.runPromise;
		await supervisor.shutdown(false);
	});

	test("retains nested notifications under concurrency pressure and drains them when a slot opens", async () => {
		const { supervisor, internals } = createSupervisor({ maxDepth: 3, maxConcurrency: 1 });
		const busy = addRecord(internals, metadata({ id: "busy", name: "busy", state: "running" }));
		busy.runPromise = new Promise<void>(() => {});
		const owner = addRecord(internals, metadata({ state: "paused" }));
		const runtime = controlledSession((message) => acceptUserMessage(internals, owner, message));
		owner.session = runtime.session;

		await internals.deliverNestedNotification(owner.metadata.id, "queued under pressure");

		expect(owner.metadata.pendingNotifications).toHaveLength(1);
		expect(runtime.prompt).not.toHaveBeenCalled();

		busy.runPromise = undefined;
		busy.metadata.state = "completed";
		await internals.schedulePendingNotificationDrain(owner);

		expect(runtime.prompt).toHaveBeenCalledWith("queued under pressure", expect.anything());
		expect(owner.metadata.pendingNotifications).toEqual([]);
		runtime.settle();
		if (owner.runPromise) await owner.runPromise;
		await supervisor.shutdown(false);
	});

	test("queues a notification for a running owner until its run safely settles", async () => {
		const { supervisor, internals } = createSupervisor();
		const owner = addRecord(internals, metadata({ state: "completed" }));
		const active = controlledSession();
		const delivery = controlledSession((message) => acceptUserMessage(internals, owner, message));
		owner.session = active.session;
		internals.startRun(owner, "active work");
		installRuntimeOnDemand(internals, delivery);

		await internals.deliverNestedNotification(owner.metadata.id, "wait for safe delivery");

		expect(active.steer).not.toHaveBeenCalled();
		expect(owner.metadata.pendingNotifications).toHaveLength(1);
		const activeRun = owner.runPromise;
		active.settle();
		if (activeRun) await activeRun;
		await internals.schedulePendingNotificationDrain(owner);

		expect(delivery.prompt).toHaveBeenCalledWith("wait for safe delivery", expect.anything());
		expect(owner.metadata.pendingNotifications).toEqual([]);
		delivery.settle();
		if (owner.runPromise) await owner.runPromise;
		await supervisor.shutdown(false);
	});

	test("retains a notification through owner settlement and delivers it afterward", async () => {
		const { supervisor, internals } = createSupervisor();
		const owner = addRecord(internals, metadata({ state: "running" }));
		const runtime = controlledSession((message) => acceptUserMessage(internals, owner, message));
		owner.session = runtime.session;
		owner.runGeneration = 1;
		owner.runPromise = Promise.resolve();
		owner.settlingGeneration = 1;

		await internals.deliverNestedNotification(owner.metadata.id, "arrived while settling");

		expect(runtime.steer).not.toHaveBeenCalled();
		expect(owner.metadata.pendingNotifications).toHaveLength(1);

		owner.runPromise = undefined;
		owner.settlingGeneration = undefined;
		owner.metadata.state = "paused";
		await internals.schedulePendingNotificationDrain(owner);

		expect(runtime.prompt).toHaveBeenCalledWith("arrived while settling", expect.anything());
		expect(owner.metadata.pendingNotifications).toEqual([]);
		runtime.settle();
		if (owner.runPromise) await owner.runPromise;
		await supervisor.shutdown(false);
	});

	test.each(["stop", "shutdown"] as const)(
		"retains an accepted notification when %s wins before its user-message checkpoint",
		async (operation) => {
			const { supervisor, internals, appended } = createSupervisor();
			const owner = addRecord(internals, metadata({ state: "paused" }));
			let settle = () => {};
			const run = new Promise<void>((resolveRun) => {
				settle = resolveRun;
			});
			const abort = vi.fn(settle);
			const prompt = vi.fn((_message: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
				options?.preflightResult?.(true);
				return run;
			});
			owner.session = {
				messages: [],
				prompt,
				clearQueue: () => {},
				abortRetry: () => {},
				abortCompaction: () => {},
				getSessionStats: () => undefined,
				dispose: () => {},
				agent: { abort },
			} as unknown as AgentSession;

			const delivery = internals.deliverNestedNotification(owner.metadata.id, "handoff without checkpoint");
			await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

			if (operation === "stop") {
				await supervisor.stopSubagent(ROOT_CALLER_ID, { name: owner.metadata.id });
			} else {
				await supervisor.shutdown(true);
			}
			await delivery;

			expect(abort).toHaveBeenCalledTimes(1);
			expect(owner.metadata.pendingNotifications.map(({ content }) => content)).toEqual([
				"handoff without checkpoint",
			]);
			const registry = appended.at(-1)?.data as PersistedRegistry;
			expect(registry.children[0]?.pendingNotifications.map(({ content }) => content)).toEqual([
				"handoff without checkpoint",
			]);
			if (operation === "stop") await supervisor.shutdown(false);
		},
	);

	test("recovers a running owner and retries its notification before any user-message checkpoint", async () => {
		const { supervisor, internals, rootManager } = createSupervisor();
		const saved = metadata({
			state: "running",
			sessionPath: resolve("package.json"),
			pendingNotifications: [{ id: "notification-before-checkpoint", content: "retry after crash", createdAt: 1 }],
		});
		const runtime = controlledSession((message) => {
			const record = internals.children.get(saved.id);
			if (record) acceptUserMessage(internals, record, message);
		});
		rootManager.appendCustomEntry(REGISTRY_ENTRY_TYPE, {
			version: 1,
			ownerSessionId: rootManager.getSessionId(),
			sequence: 1,
			dashboardOrderSequence: 1,
			children: [saved],
		} satisfies PersistedRegistry);
		internals.ensureRuntime = async (record) => {
			record.session = runtime.session;
		};

		await internals.recover();
		const recovered = internals.children.get(saved.id);
		if (!recovered) throw new Error("Expected recovered owner");
		await internals.schedulePendingNotificationDrain(recovered);

		expect(runtime.prompt).toHaveBeenCalledWith("retry after crash", expect.anything());
		runtime.settle();
		if (recovered.runPromise) await recovered.runPromise;
		await supervisor.shutdown(false);
	});

	test("handles nested-notification enqueue persistence rejection without losing the inbox item", async () => {
		const { supervisor, internals } = createSupervisor();
		const owner = addRecord(internals, metadata({ id: "owner", name: "owner", state: "paused" }));
		const child = addRecord(
			internals,
			metadata({
				id: "nested-child",
				name: "nested-child",
				parentId: owner.metadata.id,
				depth: 2,
				state: "running",
			}),
		);
		child.runGeneration = 1;
		child.runPromise = Promise.resolve();
		child.activeStartedAt = Date.now();
		const originalAppendEntry = internals.pi.appendEntry.bind(internals.pi);
		let appendCalls = 0;
		const appendEntry = vi.fn((...args: Parameters<ExtensionAPI["appendEntry"]>) => {
			appendCalls++;
			if (appendCalls >= 2) throw new Error("registry append rejected");
			return originalAppendEntry(...args);
		});
		internals.pi.appendEntry = appendEntry;

		await internals.finalizeRun(child, 1, undefined);
		await vi.waitFor(() => expect(owner.metadata.error).toContain("Nested notification enqueue failed"));

		expect(appendEntry).toHaveBeenCalled();
		expect(owner.metadata.pendingNotifications).toHaveLength(1);
		expect(owner.metadata.pendingNotifications[0]?.content).toContain("subagent nested-child (nested-child)");
		internals.pi.appendEntry = originalAppendEntry;
		await supervisor.shutdown(false);
	});

	test("keeps a notification durable when prompt enqueue fails after positive preflight", async () => {
		const { supervisor, internals, appended } = createSupervisor();
		const owner = addRecord(internals, metadata({ state: "paused" }));
		const dispose = vi.fn();
		const prompt = vi.fn((_message: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			options?.preflightResult?.(true);
			return Promise.reject(new Error("user message persistence failed"));
		});
		owner.session = {
			messages: [],
			prompt,
			getSessionStats: () => undefined,
			dispose,
		} as unknown as AgentSession;

		await internals.deliverNestedNotification(owner.metadata.id, "must retry after enqueue failure");
		const run = owner.runPromise;
		if (run) await run;

		expect(owner.metadata.state).toBe("failed");
		expect(owner.metadata.error).toContain("user message persistence failed");
		expect(owner.metadata.pendingNotifications.map(({ content }) => content)).toEqual([
			"must retry after enqueue failure",
		]);
		const registry = appended.at(-1)?.data as PersistedRegistry;
		expect(registry.children[0]?.pendingNotifications.map(({ content }) => content)).toEqual([
			"must retry after enqueue failure",
		]);
		expect(dispose).toHaveBeenCalledTimes(1);
		await supervisor.shutdown(false);
	});

	test("recovers and eventually delivers a persisted nested notification", async () => {
		const { supervisor, internals, rootManager } = createSupervisor();
		const saved = metadata({
			state: "paused",
			sessionPath: resolve("package.json"),
			pendingNotifications: [{ id: "notification-1", content: "persisted handoff", createdAt: 1 }],
		});
		const runtime = controlledSession((message) => {
			const record = internals.children.get(saved.id);
			if (record) acceptUserMessage(internals, record, message);
		});
		rootManager.appendCustomEntry(REGISTRY_ENTRY_TYPE, {
			version: 1,
			ownerSessionId: rootManager.getSessionId(),
			sequence: 1,
			dashboardOrderSequence: 1,
			children: [saved],
		} satisfies PersistedRegistry);
		(internals as unknown as { ensureRuntime: (record: TestChildRecord) => Promise<void> }).ensureRuntime = async (
			record,
		) => {
			record.session = runtime.session;
		};

		await internals.recover();
		const recovered = internals.children.get(saved.id);
		if (!recovered) throw new Error("Expected recovered owner");
		await internals.schedulePendingNotificationDrain(recovered);

		expect(runtime.prompt).toHaveBeenCalledWith("persisted handoff", expect.anything());
		expect(recovered.metadata.pendingNotifications).toEqual([]);
		runtime.settle();
		if (recovered.runPromise) await recovered.runPromise;
		await supervisor.shutdown(false);
	});

	test("eventually propagates a recursive completion through its owner to the root", async () => {
		const { supervisor, internals, sent } = createSupervisor();
		const owner = addRecord(internals, metadata({ id: "owner", name: "owner", state: "paused" }));
		const ownerRuntime = controlledSession((message) => acceptUserMessage(internals, owner, message));
		owner.session = ownerRuntime.session;
		const child = addRecord(
			internals,
			metadata({
				id: "nested-child",
				name: "nested-child",
				parentId: owner.metadata.id,
				depth: 2,
				state: "running",
			}),
		);
		const childRuntime = controlledSession();
		child.session = childRuntime.session;
		child.runGeneration = 1;
		child.runPromise = Promise.resolve();
		child.activeStartedAt = Date.now();

		await internals.finalizeRun(child, 1, undefined);
		await internals.schedulePendingNotificationDrain(owner);

		expect(ownerRuntime.prompt).toHaveBeenCalledWith(
			expect.stringContaining("[subagent nested-child (nested-child)] state=completed"),
			expect.anything(),
		);
		ownerRuntime.settle();
		if (owner.runPromise) await owner.runPromise;
		await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));

		expect(sent.some(({ message }) => JSON.stringify(message).includes("subagent owner (owner)"))).toBe(true);
		await supervisor.shutdown(false);
	});

	test("serializes an idle stop before a later send without disposing the resumed runtime", async () => {
		const { supervisor, internals } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "completed" }));
		const retired = controlledSession();
		const resumed = controlledSession();
		record.session = retired.session;
		installRuntimeOnDemand(internals, resumed);

		const stop = supervisor.stopSubagent(ROOT_CALLER_ID, { name: record.metadata.id });
		const send = supervisor.sendSubagent(ROOT_CALLER_ID, { name: record.metadata.id, message: "continue" });
		const [stopResult, sendResult] = await within(Promise.all([stop, send]));

		expect(stopResult.details.snapshot.state).toBe("paused");
		expect(sendResult.details.snapshot.state).toBe("running");
		expect(retired.prompt).not.toHaveBeenCalled();
		expect(retired.dispose).toHaveBeenCalledTimes(1);
		expect(resumed.prompt).toHaveBeenCalledWith("continue", expect.anything());
		expect(resumed.dispose).not.toHaveBeenCalled();
		expect(record.session).toBe(resumed.session);
		expect(record.metadata.state).toBe("running");

		resumed.settle();
		if (record.runPromise) await record.runPromise;
		await supervisor.shutdown(false);
	});

	test("settles an active stop before accepting a later send", async () => {
		const { supervisor, internals } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "completed" }));
		const retired = controlledSession();
		const resumed = controlledSession();
		record.session = retired.session;
		internals.startRun(record, "initial");
		installRuntimeOnDemand(internals, resumed);

		const stop = supervisor.stopSubagent(ROOT_CALLER_ID, { name: record.metadata.id });
		const send = supervisor.sendSubagent(ROOT_CALLER_ID, { name: record.metadata.id, message: "after stop" });
		const [stopResult, sendResult] = await within(Promise.all([stop, send]));

		expect(stopResult.details.snapshot.state).toBe("paused");
		expect(sendResult.details.snapshot.state).toBe("running");
		expect(retired.abort).toHaveBeenCalledTimes(1);
		expect(retired.dispose).toHaveBeenCalledTimes(1);
		expect(resumed.prompt).toHaveBeenCalledWith("after stop", expect.anything());
		expect(resumed.dispose).not.toHaveBeenCalled();
		expect(record.session).toBe(resumed.session);

		resumed.settle();
		if (record.runPromise) await record.runPromise;
		await supervisor.shutdown(false);
	});

	test("aborts a send waiting on stop without cancelling the stop flight", async () => {
		const { supervisor, internals } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "completed" }));
		let settle = () => {};
		const run = new Promise<void>((resolveRun) => {
			settle = resolveRun;
		});
		const abort = vi.fn();
		record.session = {
			messages: [],
			prompt: () => run,
			clearQueue: () => {},
			abortRetry: () => {},
			abortCompaction: () => {},
			getSessionStats: () => undefined,
			dispose: () => {},
			agent: { abort },
		} as unknown as AgentSession;
		internals.startRun(record, "initial");

		const stop = supervisor.stopSubagent(ROOT_CALLER_ID, { name: record.metadata.id });
		await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
		const controller = new AbortController();
		const send = supervisor.sendSubagent(
			ROOT_CALLER_ID,
			{ name: record.metadata.id, message: "do not deliver" },
			controller.signal,
		);
		controller.abort(new Error("send caller cancelled"));

		await expect(within(send, 250)).rejects.toThrow("send caller cancelled");
		expect(abort).toHaveBeenCalledTimes(1);
		expect(record.metadata.state).toBe("stopping");

		settle();
		const stopResult = await within(stop);
		expect(stopResult.details.snapshot.state).toBe("paused");
		expect(abort).toHaveBeenCalledTimes(1);
		await supervisor.shutdown(false);
	});

	test("settles two concurrent stops before accepting a later send", async () => {
		const { supervisor, internals } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "completed" }));
		const retired = controlledSession();
		const resumed = controlledSession();
		record.session = retired.session;
		internals.startRun(record, "initial");
		installRuntimeOnDemand(internals, resumed);

		const firstStop = supervisor.stopSubagent(ROOT_CALLER_ID, { name: record.metadata.id });
		const secondStop = supervisor.stopSubagent(ROOT_CALLER_ID, { name: record.metadata.id });
		const send = supervisor.sendSubagent(ROOT_CALLER_ID, { name: record.metadata.id, message: "after both" });
		const [firstResult, secondResult, sendResult] = await within(Promise.all([firstStop, secondStop, send]));

		expect(firstResult.details.snapshot.state).toBe("paused");
		expect(secondResult.details.snapshot.state).toBe("paused");
		expect(sendResult.details.snapshot.state).toBe("running");
		expect(retired.dispose).toHaveBeenCalledTimes(1);
		expect(resumed.prompt).toHaveBeenCalledWith("after both", expect.anything());
		expect(resumed.dispose).not.toHaveBeenCalled();
		expect(record.session).toBe(resumed.session);

		resumed.settle();
		if (record.runPromise) await record.runPromise;
		await supervisor.shutdown(false);
	});

	test.each([
		"clearQueue",
		"abortRetry",
		"abortCompaction",
		"agent.abort",
		"getSessionStats",
		"appendEntry",
		"dashboard invalidator",
	] as const)("settles stop and a concurrent send when %s throws during stop setup", async (failurePoint) => {
		const { supervisor, internals } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "completed" }));
		const retired = controlledSession();
		const resumed = controlledSession();
		let failureArmed = false;
		let statsFailureInjected = false;
		const fail = (point: typeof failurePoint): void => {
			if (failureArmed && failurePoint === point) throw new Error(`${point} injected failure`);
		};
		const clearQueue = vi.fn(() => fail("clearQueue"));
		const abortRetry = vi.fn(() => fail("abortRetry"));
		const abortCompaction = vi.fn(() => fail("abortCompaction"));
		const abort = vi.fn(() => {
			fail("agent.abort");
			retired.settle();
		});
		const getSessionStats = vi.fn(() => {
			if (failureArmed && failurePoint === "getSessionStats" && !statsFailureInjected) {
				statsFailureInjected = true;
				throw new Error("getSessionStats injected failure");
			}
			return undefined;
		});
		Object.assign(retired.session, {
			clearQueue,
			abortRetry,
			abortCompaction,
			getSessionStats,
			agent: { abort },
		});
		record.session = retired.session;
		internals.startRun(record, "initial");
		const retiredRun = record.runPromise;
		if (!retiredRun) throw new Error("Expected an active retired run");
		installRuntimeOnDemand(internals, resumed);

		if (failurePoint === "appendEntry") {
			const originalAppendEntry = internals.pi.appendEntry.bind(internals.pi);
			let injected = false;
			internals.pi.appendEntry = vi.fn((...args: Parameters<ExtensionAPI["appendEntry"]>) => {
				if (!injected) {
					injected = true;
					throw new Error("appendEntry injected failure");
				}
				return originalAppendEntry(...args);
			});
		}
		if (failurePoint === "dashboard invalidator") {
			let injected = false;
			supervisor.registerDashboardInvalidator(() => {
				if (!injected) {
					injected = true;
					throw new Error("dashboard invalidator injected failure");
				}
			});
		}
		failureArmed = true;

		const stop = supervisor.stopSubagent(ROOT_CALLER_ID, { name: record.metadata.id });
		const send = supervisor.sendSubagent(ROOT_CALLER_ID, {
			name: record.metadata.id,
			message: "after injected stop failure",
		});
		const [stopResult, sendResult] = await within(Promise.all([stop, send]));

		expect(stopResult.details.snapshot.state).toBe("paused");
		if (failurePoint !== "dashboard invalidator") {
			expect(stopResult.details.snapshot.error).toContain("injected failure");
		}
		expect(sendResult.details.snapshot.state).toBe("running");
		expect(clearQueue).toHaveBeenCalledTimes(1);
		expect(abortRetry).toHaveBeenCalledTimes(1);
		expect(abortCompaction).toHaveBeenCalledTimes(1);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(record.stopFlight).toBeUndefined();
		expect(retired.dispose).toHaveBeenCalledTimes(1);
		expect(resumed.dispose).not.toHaveBeenCalled();
		expect(record.session).toBe(resumed.session);
		expect(record.metadata.state).toBe("running");

		const resumedGeneration = record.runGeneration;
		retired.settle();
		await within(retiredRun);
		expect(record.runGeneration).toBe(resumedGeneration);
		expect(record.settlingGeneration).toBeUndefined();
		expect(record.metadata.state).toBe("running");
		expect(record.session).toBe(resumed.session);
		expect(retired.dispose).toHaveBeenCalledTimes(1);
		expect(resumed.dispose).not.toHaveBeenCalled();

		resumed.settle();
		if (record.runPromise) await record.runPromise;
		await supervisor.shutdown(false);
	});

	test("captures final leaf, usage, and summaries before stop disposal", async () => {
		const { supervisor, internals, appended } = createSupervisor();
		const manager = SessionManager.inMemory(process.cwd());
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "durable child message" }],
			timestamp: Date.now(),
		});
		const record = addRecord(
			internals,
			metadata({ state: "running", turns: 7, latestTurns: [persistedTurn(7)] }),
			manager,
		);
		let settle = () => {};
		record.runPromise = new Promise<void>((resolveRun) => {
			settle = resolveRun;
		});
		const dispose = vi.fn();
		record.session = {
			messages: [],
			clearQueue: () => {},
			abortRetry: () => {},
			abortCompaction: () => {},
			getSessionStats: () => ({
				tokens: { input: 21, output: 8, cacheRead: 3, cacheWrite: 2, total: 34 },
				cost: 0.75,
			}),
			dispose,
			agent: { abort: settle },
		} as unknown as AgentSession;

		await supervisor.stopSubagent(ROOT_CALLER_ID, { name: record.metadata.id });

		const registry = appended.at(-1)?.data as PersistedRegistry;
		const saved = registry.children.find((child) => child.id === record.metadata.id);
		expect(saved).toMatchObject({
			state: "paused",
			childLeafId: manager.getLeafId(),
			turns: 7,
			usage: { input: 21, output: 8, cache_read: 3, cache_write: 2, cost: 0.75 },
		});
		expect(saved?.latestTurns.map((turn) => turn.index)).toEqual([7]);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	test("disposes a retired runtime exactly once and ignores its stale settlement", async () => {
		const { supervisor, internals } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "running" }));
		const retired = controlledSession();
		const resumed = controlledSession();
		record.session = retired.session;
		record.runGeneration = 1;
		record.runPromise = Promise.resolve();
		record.activeStartedAt = Date.now();

		await internals.finalizeRun(record, 1, undefined);
		await internals.finalizeRun(record, 1, undefined);
		expect(retired.dispose).toHaveBeenCalledTimes(1);

		record.session = resumed.session;
		internals.startRun(record, "new generation");
		await internals.finalizeRun(record, 1, "stale failure");

		expect(record.runGeneration).toBe(2);
		expect(record.metadata.state).toBe("running");
		expect(record.metadata.error).toBeUndefined();
		expect(record.session).toBe(resumed.session);
		expect(resumed.dispose).not.toHaveBeenCalled();

		resumed.settle();
		if (record.runPromise) await record.runPromise;
		await supervisor.shutdown(false);
	});
});

describe("SubagentSupervisor waiting-parent reminders", () => {
	test("repeats reminders after settlement until no child is waiting", () => {
		const { supervisor, internals, sent } = createSupervisor();
		const waiting = addRecord(internals, metadata({ state: "waiting_parent" }));
		const nested = addRecord(
			internals,
			metadata({ id: "nested", name: "nested", parentId: waiting.metadata.id, depth: 2, state: "waiting_parent" }),
		);
		addRecord(internals, metadata({ id: "done", name: "done", state: "completed" }));

		supervisor.remindWaitingDescendants();
		supervisor.remindWaitingDescendants();

		expect(sent).toHaveLength(2);
		expect(sent[0]?.message).toMatchObject({
			content: expect.stringContaining(`${waiting.metadata.name} (${waiting.metadata.id})`),
		});
		expect(sent[0]?.message).toMatchObject({
			content: expect.stringContaining(`${nested.metadata.name} (${nested.metadata.id})`),
		});
		expect(sent[0]?.message).not.toMatchObject({ content: expect.stringContaining("done") });
		expect(sent[0]?.options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });

		waiting.metadata.state = "paused";
		nested.metadata.state = "paused";
		supervisor.remindWaitingDescendants();
		expect(sent).toHaveLength(2);
	});
});

describe("SubagentSupervisor pause-only disposal", () => {
	test("stop is idempotent, always pauses, and releases an idle retained runtime", async () => {
		const { supervisor, internals } = createSupervisor();
		const manager = SessionManager.inMemory(process.cwd());
		const record = addRecord(internals, metadata({ state: "completed" }), manager);
		const dispose = vi.fn();
		record.session = {
			messages: [],
			getSessionStats: () => ({
				tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
				cost: 0.25,
			}),
			dispose,
		} as unknown as AgentSession;

		const first = await supervisor.stopSubagent(ROOT_CALLER_ID, { name: record.metadata.id });
		const second = await supervisor.stopSubagent(ROOT_CALLER_ID, { name: record.metadata.id });

		expect(first.details.snapshot.state).toBe("paused");
		expect(second.details.snapshot.state).toBe("paused");
		expect(second.details.snapshot.usage).toMatchObject({ input: 10, output: 5, cost: 0.25 });
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(record.session).toBeUndefined();
		expect(record.manager).toBeUndefined();
	});

	test.each([
		["completed", undefined, undefined, undefined],
		["waiting_parent", undefined, "needs_input", undefined],
		["failed", "model failed", undefined, undefined],
		["paused", undefined, undefined, "pause"],
	] as const)(
		"disposes the SDK runtime whenever a run settles as %s",
		async (state, failure, yieldStatus, abortCause) => {
			const { supervisor, internals } = createSupervisor();
			const manager = SessionManager.inMemory(process.cwd());
			const record = addRecord(internals, metadata({ state: "running" }), manager);
			const dispose = vi.fn();
			record.session = {
				messages: [],
				getSessionStats: () => undefined,
				dispose,
			} as unknown as AgentSession;
			record.runGeneration = 1;
			record.runPromise = Promise.resolve();
			record.activeStartedAt = Date.now();
			record.abortCause = abortCause;
			if (yieldStatus) record.yieldLatch = { status: yieldStatus, content: "Need an answer", at: Date.now() };

			await internals.finalizeRun(record, 1, failure);

			expect(record.metadata.state).toBe(state);
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(record.session).toBeUndefined();
			expect(record.manager).toBeUndefined();
			await supervisor.shutdown(false);
		},
	);
});

describe("SubagentSupervisor dashboard ordering", () => {
	test("assigns monotonically increasing creation activation order", () => {
		const { internals } = createSupervisor();

		expect([internals.allocateDashboardOrder(), internals.allocateDashboardOrder()]).toEqual([1, 2]);
	});

	test("activity and running delivery do not change activation order", async () => {
		const { supervisor, internals } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "running", dashboardOrder: 4 }));
		record.runPromise = new Promise<void>(() => {});
		record.session = {
			steer: async () => {},
			followUp: async () => {},
			getSessionStats: () => undefined,
		} as unknown as AgentSession;

		internals.handleChildEvent(record, { type: "turn_start" });
		internals.handleChildEvent(record, { type: "agent_start" });
		await supervisor.sendSubagent(ROOT_CALLER_ID, { name: record.metadata.id, message: "steer" });
		await supervisor.sendSubagent(ROOT_CALLER_ID, {
			name: record.metadata.id,
			message: "follow up",
			delivery: "follow_up",
		});

		expect(record.metadata.dashboardOrder).toBe(4);
	});

	test("resuming an idle child moves it after existing activations and persists the order", async () => {
		const { supervisor, internals, appended } = createSupervisor();
		internals.dashboardOrderSequence = 2;
		addRecord(internals, metadata({ id: "active", name: "active", state: "running", dashboardOrder: 2 }));
		const resumed = addRecord(internals, metadata({ state: "paused", dashboardOrder: 1 }));
		resumed.session = {
			prompt: () => new Promise<void>(() => {}),
			getSessionStats: () => undefined,
		} as unknown as AgentSession;

		await supervisor.sendSubagent(ROOT_CALLER_ID, { name: resumed.metadata.id, message: "resume" });

		expect(resumed.metadata.dashboardOrder).toBe(3);
		const registry = appended.at(-1)?.data as PersistedRegistry;
		expect(registry.dashboardOrderSequence).toBe(3);
		expect(registry.children.find((child) => child.id === resumed.metadata.id)?.dashboardOrder).toBe(3);
	});
});

describe("SubagentSupervisor persistence", () => {
	test("normalizes a literal legacy v1 child with no pendingNotifications inbox", async () => {
		const { internals, rootManager, appended } = createSupervisor();
		const { pendingNotifications: _pendingNotifications, ...legacyChild } = metadata({
			state: "completed",
			sessionPath: resolve("package.json"),
		});
		rootManager.appendCustomEntry(REGISTRY_ENTRY_TYPE, {
			version: 1,
			ownerSessionId: rootManager.getSessionId(),
			sequence: 1,
			dashboardOrderSequence: 1,
			children: [legacyChild],
		});

		await internals.recover();

		const recovered = internals.children.get(legacyChild.id);
		expect(recovered?.metadata).toMatchObject({
			id: legacyChild.id,
			name: legacyChild.name,
			task: legacyChild.task,
			state: legacyChild.state,
			dashboardOrder: legacyChild.dashboardOrder,
			pendingNotifications: [],
		});
		const normalized = appended.at(-1)?.data as PersistedRegistry;
		expect(normalized.children[0]).toMatchObject({
			id: legacyChild.id,
			task: legacyChild.task,
			state: legacyChild.state,
			pendingNotifications: [],
		});
	});

	test("restores the monotonic dashboard sequence", async () => {
		const { internals, rootManager } = createSupervisor();
		rootManager.appendCustomEntry(REGISTRY_ENTRY_TYPE, {
			version: 1,
			ownerSessionId: rootManager.getSessionId(),
			sequence: 9,
			dashboardOrderSequence: 7,
			children: [metadata({ state: "completed", dashboardOrder: 7 })],
		} satisfies PersistedRegistry);

		await internals.recover();

		expect(internals.allocateDashboardOrder()).toBe(8);
	});

	test("checkpoints each child leaf after AgentSession persists the message", async () => {
		const { internals, appended } = createSupervisor();
		const manager = SessionManager.inMemory(process.cwd());
		const record = addRecord(internals, metadata(), manager);
		const messages = [
			{ role: "user", content: [{ type: "text", text: "accepted prompt" }], timestamp: Date.now() },
			fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], { stopReason: "toolUse" }),
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: "persisted result" }],
				isError: false,
				timestamp: Date.now(),
			},
		] satisfies Array<Parameters<SessionManager["appendMessage"]>[0]>;

		for (const message of messages) {
			internals.handleChildEvent(record, { type: "message_end", message });
			manager.appendMessage(message);
			await Promise.resolve();
			const registryEntry = appended.at(-1);
			expect(registryEntry?.customType).toBe(REGISTRY_ENTRY_TYPE);
			const registry = registryEntry?.data as PersistedRegistry;
			expect(registry.children[0]?.childLeafId).toBe(manager.getLeafId());
			expect(registry.children[0]).not.toHaveProperty("latestAnchorToolCallId");
			expect(registry.children[0]).not.toHaveProperty("frozenAnchors");
			expect(record.metadata.childLeafId).toBe(manager.getLeafId());
		}
	});

	test("history-missing recovery includes the original task and parent context", async () => {
		const { supervisor, internals } = createSupervisor();
		const record = addRecord(internals, metadata(), SessionManager.inMemory(process.cwd()), true);
		let delivered = "";
		record.session = {
			prompt: async (message: string) => {
				delivered = message;
			},
			messages: [],
			getSessionStats: () => undefined,
			clearQueue: () => {},
			abortRetry: () => {},
			abortCompaction: () => {},
			dispose: () => {},
			agent: { abort: () => {} },
		} as unknown as AgentSession;

		await supervisor.sendSubagent(ROOT_CALLER_ID, {
			name: record.metadata.id,
			message: "Continue from recovery",
		});
		if (record.runPromise) await record.runPromise;

		expect(delivered).toContain("Original parent context:\nThe race occurs during restart");
		expect(delivered).toContain("Original task:\nInspect the implementation");
		expect(delivered).toContain("Continue from recovery");
		await supervisor.shutdown(false);
	});
});

describe("SubagentSupervisor compact summary persistence", () => {
	test("retains and persists only the latest five compact turn summaries", () => {
		const { internals, appended } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "running" }));

		for (let index = 1; index <= 7; index++) {
			const message = fauxAssistantMessage(`summary-${index}`);
			internals.handleChildEvent(record, { type: "turn_start" });
			internals.handleChildEvent(record, { type: "message_end", message });
			internals.handleChildEvent(record, { type: "turn_end", message, toolResults: [] });
		}

		expect(record.turns.map((turn) => turn.index)).toEqual([3, 4, 5, 6, 7]);
		const registry = appended.at(-1)?.data as PersistedRegistry;
		const saved = registry.children[0];
		expect(saved.latestTurns.map((turn) => turn.index)).toEqual([3, 4, 5, 6, 7]);
		expect(saved.latestTurns.map((turn) => turn.textPreview)).toEqual([
			"summary-3",
			"summary-4",
			"summary-5",
			"summary-6",
			"summary-7",
		]);
	});

	test("recovers settled metadata and summaries without eagerly opening an SDK runtime", async () => {
		const { internals, rootManager } = createSupervisor();
		const saved = metadata({
			state: "waiting_parent",
			sessionPath: resolve("package.json"),
			latestTurns: [persistedTurn(4), persistedTurn(5)],
		});
		rootManager.appendCustomEntry(REGISTRY_ENTRY_TYPE, {
			version: 1,
			ownerSessionId: rootManager.getSessionId(),
			sequence: 1,
			dashboardOrderSequence: 1,
			children: [saved],
		} satisfies PersistedRegistry);
		let runtimeOpens = 0;
		(internals as unknown as { openRuntime: () => Promise<void> }).openRuntime = async () => {
			runtimeOpens++;
		};

		await internals.recover();

		const recovered = internals.children.get(saved.id);
		expect(runtimeOpens).toBe(0);
		expect(recovered?.session).toBeUndefined();
		expect(recovered?.manager).toBeUndefined();
		expect(recovered?.turns.map((turn) => turn.index)).toEqual([4, 5]);
	});
});

describe("SubagentSupervisor turn counting", () => {
	test("counts and renders every child turn for status display", () => {
		const { internals } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "running" }));
		const first = fauxAssistantMessage(
			[{ type: "text", text: "first" }, fauxToolCall("read", { path: "README.md" })],
			{ stopReason: "toolUse" },
		);
		const second = fauxAssistantMessage("second");

		internals.handleChildEvent(record, { type: "turn_start" });
		internals.handleChildEvent(record, { type: "message_end", message: first });
		internals.handleChildEvent(record, { type: "turn_end", message: first, toolResults: [] });
		internals.handleChildEvent(record, { type: "turn_start" });
		internals.handleChildEvent(record, { type: "message_end", message: second });
		internals.handleChildEvent(record, { type: "turn_end", message: second, toolResults: [] });

		expect(record.metadata.turns).toBe(2);
		expect(record.turns).toHaveLength(2);
		expect(record.turns.map((turn) => turn.textPreview)).toEqual(["first", "second"]);
	});
});
