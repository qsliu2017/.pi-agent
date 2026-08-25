import type { AgentSession, ExtensionAPI, ExtensionContext, ModelRuntime, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import {
	DEFAULT_SUBAGENT_MAX_CONCURRENCY,
	DEFAULT_SUBAGENT_MAX_DEPTH,
	parseSubagentHarnessLimits,
	type SubagentHarnessLimits,
	SubagentSupervisor,
} from "./supervisor.ts";
import { ROOT_CALLER_ID, type PersistedChild, type SubagentSnapshot, type TurnView } from "./types.ts";

interface TestMutex {
	run<T>(operation: () => Promise<T> | T): Promise<T>;
}

interface TestRecord {
	metadata: PersistedChild;
	manager?: SessionManager;
	session?: AgentSession;
	lock: TestMutex;
	runPromise?: Promise<void>;
	claimed: boolean;
	turns: TurnView[];
	activeActivities: Map<string, unknown>;
}

interface Internals {
	children: Map<string, TestRecord>;
	waiters: Map<string, unknown>;
	newRecord(metadata: PersistedChild, manager?: SessionManager): TestRecord;
	privateTools(callerId: string, remainingDepth: number): ToolDefinition[];
	generateSystemPrompt(input: any): string;
	evaluateWaiters(record: TestRecord): boolean;
	resolveCwd(input: string | undefined, base: string, contained: boolean): Promise<string>;
	resolveModel(requested: string | undefined, fallback: unknown): Promise<unknown>;
	openRuntime(record: TestRecord, model?: unknown): Promise<void>;
	cloneSourceManager(record: TestRecord, cwd: string): SessionManager;
	persistRegistry(): void;
}

function metadata(overrides: Partial<PersistedChild> = {}): PersistedChild {
	const now = Date.now();
	return {
		id: "child-1",
		name: "worker",
		parentId: null,
		depth: 1,
		remainingDepth: 2,
		childSessionId: "session-1",
		childLeafId: "leaf-1",
		sessionPath: "/tmp/subagent-session.jsonl",
		cwd: process.cwd(),
		task: "work",
		modelProvider: "test",
		modelId: "model",
		thinkingLevel: "off",
		generatedSystemPrompt: "prompt",
		enabledTools: ["read", "subagent_list", "subagent_wait", "subagent_stop", "subagent_create"],
		limits: {},
		state: "stopped",
		turns: 0,
		createdAt: now,
		updatedAt: now,
		lastActivityAt: now,
		dashboardOrder: 1,
		activeMs: 0,
		usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 },
		latestTurns: [],
		notifyOnStop: false,
		...overrides,
	};
}

function createSupervisor(limits?: SubagentHarnessLimits): {
	supervisor: SubagentSupervisor;
	internals: Internals;
	sent: Array<{ message: any; options: any }>;
	appended: Array<{ type: string; data: unknown }>;
} {
	const sent: Array<{ message: any; options: any }> = [];
	const appended: Array<{ type: string; data: unknown }> = [];
	const pi = {
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	const context = {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "root", getBranch: () => [] },
		model: { provider: "test", id: "model" },
		modelRegistry: {
			getProvider: () => undefined,
			getProviderAuthStatus: () => ({ source: "none" }),
			getAll: () => [{ provider: "test", id: "model" }],
		},
	} as unknown as ExtensionContext;
	const runtime = {
		getModel: () => ({ provider: "test", id: "model" }),
		getProviderAuthStatus: () => ({ source: "none" }),
	} as unknown as ModelRuntime;
	const supervisor = Reflect.construct(SubagentSupervisor, [
		pi,
		context,
		runtime,
		limits ?? { maxDepth: 3, maxConcurrency: 4 },
	]) as SubagentSupervisor;
	return { supervisor, internals: supervisor as unknown as Internals, sent, appended };
}

function addRecord(internals: Internals, child: PersistedChild): TestRecord {
	const record = internals.newRecord(child);
	internals.children.set(child.id, record);
	return record;
}

function fakeManager(id = "session-new"): SessionManager {
	return {
		getSessionFile: () => `/tmp/${id}.jsonl`,
		getSessionId: () => id,
		getLeafId: () => "leaf",
		getEntry: () => ({}),
		branch: () => {},
		resetLeaf: () => {},
	} as unknown as SessionManager;
}

function assistant(text: string): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function installCreateHarness(internals: Internals, finalText = "final handoff") {
	let resolvePrompt = () => {};
	const promptGate = new Promise<void>((resolve) => {
		resolvePrompt = resolve;
	});
	const messages: any[] = [];
	const prompt = vi.fn(async () => {
		await promptGate;
		messages.push(assistant(finalText));
	});
	const session = {
		messages,
		prompt,
		dispose: vi.fn(),
		getSessionStats: () => undefined,
		clearQueue: vi.fn(),
		abortRetry: vi.fn(),
		abortCompaction: vi.fn(),
		agent: { abort: vi.fn(() => resolvePrompt()) },
	} as unknown as AgentSession;
	vi.spyOn(internals, "resolveCwd").mockResolvedValue(process.cwd());
	vi.spyOn(internals, "resolveModel").mockResolvedValue({ provider: "test", id: "model" });
	vi.spyOn(internals, "openRuntime").mockImplementation(async (record) => {
		record.session = session;
	});
	vi.spyOn(internals, "persistRegistry").mockImplementation(() => {});
	return { session, prompt, resolvePrompt };
}

describe("harness policy", () => {
	function flags(values: Record<string, string | undefined>): ExtensionAPI {
		return { getFlag: (name: string) => values[name] } as unknown as ExtensionAPI;
	}

	test("parses defaults and boundaries", () => {
		expect(parseSubagentHarnessLimits(flags({}))).toEqual({
			maxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
			maxConcurrency: DEFAULT_SUBAGENT_MAX_CONCURRENCY,
		});
		expect(parseSubagentHarnessLimits(flags({ "subagent-max-depth": "0", "subagent-max-concurrency": "1" }))).toEqual({
			maxDepth: 0,
			maxConcurrency: 1,
		});
	});

	test.each([
		["subagent-max-depth", "-1"],
		["subagent-max-concurrency", "0"],
		["subagent-max-concurrency", "many"],
	])("rejects invalid %s", (name, value) => {
		expect(() => parseSubagentHarnessLimits(flags({ [name]: value }))).toThrow();
	});
});

describe("scoped tool protocol", () => {
	test("contains only create, wait, list, and stop", () => {
		const { internals } = createSupervisor();
		expect(internals.privateTools("owner", 1).map((tool) => tool.name).sort()).toEqual([
			"subagent_create",
			"subagent_list",
			"subagent_stop",
			"subagent_wait",
		]);
		expect(internals.privateTools("owner", 0).map((tool) => tool.name).sort()).toEqual([
			"subagent_list",
			"subagent_stop",
			"subagent_wait",
		]);
	});

	test("marks recursive create parallel and prompts natural final responses", () => {
		const { internals } = createSupervisor();
		const create = internals.privateTools("owner", 1).find((tool) => tool.name === "subagent_create");
		expect(create?.executionMode).toBe("parallel");
		const prompt = internals.generateSystemPrompt({
			id: "id",
			name: "worker",
			parentName: "parent",
			cwd: process.cwd(),
			remainingDepth: 1,
			enabledTools: [],
			limits: {},
		});
		expect(prompt).toContain("one concise final response");
		expect(prompt).toContain("end with a direct question");
	});
});

describe("public states and waits", () => {
	test("lists only running and stopped states", () => {
		const { supervisor, internals } = createSupervisor();
		addRecord(internals, metadata({ id: "a", name: "a", state: "running" }));
		addRecord(internals, metadata({ id: "b", name: "b", state: "stopped" }));
		expect(supervisor.listSubagents(ROOT_CALLER_ID, {}).details.snapshots.map((item) => item.state)).toEqual([
			"running",
			"stopped",
		]);
	});

	test("for any returns the first stopped selection", async () => {
		const { supervisor, internals } = createSupervisor();
		addRecord(internals, metadata({ id: "a", name: "a", state: "running" }));
		addRecord(internals, metadata({ id: "b", name: "b", state: "stopped", finalResponse: "done" }));
		const result = await supervisor.waitSubagents(ROOT_CALLER_ID, { names: ["a", "b"], for: "any" });
		expect(result.details.reason).toBe("settled");
		expect(result.details.matched?.id).toBe("b");
		expect(result.content[0]?.text).toContain("done");
	});

	test("for all waits until the entire fixed selection stops", async () => {
		const { supervisor, internals } = createSupervisor();
		const a = addRecord(internals, metadata({ id: "a", name: "a", state: "running" }));
		addRecord(internals, metadata({ id: "b", name: "b", state: "stopped" }));
		const pending = supervisor.waitSubagents(ROOT_CALLER_ID, { names: ["a", "b"], for: "all" });
		await vi.waitFor(() => expect(internals.waiters.size).toBe(1));
		a.metadata.state = "stopped";
		internals.evaluateWaiters(a);
		const result = await pending;
		expect(result.details.reason).toBe("settled");
		expect(result.details.settled).toBe(2);
		expect(result.content[0]?.text).toContain("state=stopped");
	});

	test("timeout releases the parent and leaves children running", async () => {
		const { supervisor, internals } = createSupervisor();
		const child = addRecord(internals, metadata({ state: "running" }));
		const result = await supervisor.waitSubagents(ROOT_CALLER_ID, { timeout_seconds: 0.01 });
		expect(result.details.reason).toBe("timeout");
		expect(result.details.started_at).toEqual(expect.any(Number));
		expect(result.details.elapsed_ms).toBeGreaterThanOrEqual(0);
		expect(child.metadata.state).toBe("running");
	});
});

describe("create lifecycle", () => {
	test("background returns after acceptance and later stops with a natural handoff", async () => {
		const { supervisor, internals } = createSupervisor();
		const harness = installCreateHarness(internals);
		vi.spyOn(internals, "cloneSourceManager").mockReturnValue(fakeManager());
		const createStatic = vi.spyOn((await import("@earendil-works/pi-coding-agent")).SessionManager, "create").mockReturnValue(fakeManager());
		const result = await supervisor.createSubagent(ROOT_CALLER_ID, { task: "research", mode: "background" });
		expect(result.details.snapshot.state).toBe("running");
		const record = internals.children.get(result.details.childId)!;
		const run = record.runPromise!;
		harness.resolvePrompt();
		await run;
		expect(record.metadata.state).toBe("stopped");
		expect(record.metadata.finalResponse).toBe("final handoff");
		createStatic.mockRestore();
	});

	test("wait mode remains pending and returns the complete handoff", async () => {
		const { supervisor, internals } = createSupervisor();
		const harness = installCreateHarness(internals, "complete multiline\nhandoff");
		const createStatic = vi.spyOn((await import("@earendil-works/pi-coding-agent")).SessionManager, "create").mockReturnValue(fakeManager());
		const pending = supervisor.createSubagent(ROOT_CALLER_ID, { task: "research" });
		await vi.waitFor(() => expect(harness.prompt).toHaveBeenCalledTimes(1));
		harness.resolvePrompt();
		const result = await pending;
		expect(result.details.snapshot.state).toBe("stopped");
		expect(result.content[0]?.text).toContain("complete multiline\nhandoff");
		createStatic.mockRestore();
	});

	test("cancelling wait mode detaches the child and preserves its later notification", async () => {
		const { supervisor, internals, sent } = createSupervisor();
		const harness = installCreateHarness(internals, "late handoff");
		const createStatic = vi.spyOn((await import("@earendil-works/pi-coding-agent")).SessionManager, "create").mockReturnValue(fakeManager());
		const controller = new AbortController();
		const pending = supervisor.createSubagent(ROOT_CALLER_ID, { task: "research" }, controller.signal);
		await vi.waitFor(() => expect(harness.prompt).toHaveBeenCalledTimes(1));
		controller.abort(new Error("parent cancelled"));
		await expect(pending).rejects.toThrow("parent cancelled");
		const record = [...internals.children.values()][0]!;
		expect(record.metadata.state).toBe("running");
		expect(record.metadata.notifyOnStop).toBe(true);
		const run = record.runPromise!;
		harness.resolvePrompt();
		await run;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sent[0]?.message.content).toContain("late handoff");
		createStatic.mockRestore();
	});

	test("enforces a per-run timeout and returns a stopped error", async () => {
		const { supervisor, internals } = createSupervisor();
		installCreateHarness(internals);
		const createStatic = vi.spyOn((await import("@earendil-works/pi-coding-agent")).SessionManager, "create").mockReturnValue(fakeManager());
		const result = await supervisor.createSubagent(ROOT_CALLER_ID, {
			task: "possibly stuck",
			limits: { timeout_seconds: 0.01 },
		});
		expect(result.details.snapshot.state).toBe("stopped");
		expect(result.details.snapshot.stop_reason).toBe("timeout");
		expect(result.details.snapshot.error).toContain("Execution limit exceeded");
		expect(result.content[0]?.text).toContain("Execution limit exceeded");
		createStatic.mockRestore();
	});

	test("creates an immutable continuation with source lineage", async () => {
		const { supervisor, internals } = createSupervisor();
		const source = addRecord(
			internals,
			metadata({ id: "source", name: "source", state: "stopped", rolePrompt: "reviewer", finalResponse: "question?" }),
		);
		installCreateHarness(internals);
		const clone = vi.spyOn(internals, "cloneSourceManager").mockReturnValue(fakeManager("continued"));
		const result = await supervisor.createSubagent(ROOT_CALLER_ID, {
			task: "answer",
			from: "source",
			mode: "background",
		});
		const child = internals.children.get(result.details.childId)!;
		expect(clone).toHaveBeenCalledWith(source, process.cwd());
		expect(child.metadata.fromId).toBe("source");
		expect(child.metadata.rolePrompt).toBe("reviewer");
		expect(source.metadata.state).toBe("stopped");
	});

	test("rejects creation when recursive depth is disabled", async () => {
		const { supervisor, internals } = createSupervisor({ maxDepth: 0, maxConcurrency: 4 });
		installCreateHarness(internals);
		await expect(supervisor.createSubagent(ROOT_CALLER_ID, { task: "work" })).rejects.toThrow("depth limit");
	});

	test("rejects a running source", async () => {
		const { supervisor, internals } = createSupervisor();
		addRecord(internals, metadata({ id: "source", name: "source", state: "running" }));
		installCreateHarness(internals);
		await expect(supervisor.createSubagent(ROOT_CALLER_ID, { task: "answer", from: "source" })).rejects.toThrow(
			"still running",
		);
	});
});

describe("stop", () => {
	function installAbortableRun(record: TestRecord): ReturnType<typeof vi.fn> {
		let resolveRun = () => {};
		record.runPromise = new Promise<void>((resolve) => {
			resolveRun = resolve;
		});
		const abort = vi.fn(() => {
			record.metadata.state = "stopped";
			resolveRun();
		});
		record.session = {
			clearQueue: vi.fn(),
			abortRetry: vi.fn(),
			abortCompaction: vi.fn(),
			agent: { abort },
		} as unknown as AgentSession;
		return abort;
	}

	test("aborts running work and reports stopped", async () => {
		const { supervisor, internals } = createSupervisor();
		const record = addRecord(internals, metadata({ state: "running" }));
		installAbortableRun(record);
		const result = await supervisor.stopSubagent(ROOT_CALLER_ID, { name: record.metadata.id });
		expect(result.details.snapshot.state).toBe("stopped");
	});

	test("recursively aborts active descendants without forwarding their results", async () => {
		const { supervisor, internals, sent } = createSupervisor();
		const parent = addRecord(internals, metadata({ id: "parent", name: "parent", state: "running" }));
		const child = addRecord(
			internals,
			metadata({ id: "child", name: "child", parentId: "parent", depth: 2, state: "running", notifyOnStop: true }),
		);
		const grandchild = addRecord(
			internals,
			metadata({ id: "grandchild", name: "grandchild", parentId: "child", depth: 3, state: "running", notifyOnStop: true }),
		);
		const aborts = [parent, child, grandchild].map(installAbortableRun);

		const result = await supervisor.stopSubagent(ROOT_CALLER_ID, { name: "parent", reason: "no longer needed" });

		expect(aborts.every((abort) => abort.mock.calls.length === 1)).toBe(true);
		expect([parent, child, grandchild].map((record) => record.metadata.state)).toEqual([
			"stopped",
			"stopped",
			"stopped",
		]);
		expect(child.metadata.stopMessage).toContain("Stopped with ancestor parent");
		expect(grandchild.metadata.notifyOnStop).toBe(false);
		expect(result.content[0]?.text).toContain("2 active descendants");
		expect(sent).toEqual([]);
	});
});
