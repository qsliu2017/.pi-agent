import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	contentText,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SubagentSupervisor } from "./supervisor.ts";
import { ROOT_CALLER_ID, type PersistedChild } from "./types.ts";

interface RuntimeRecord {
	metadata: PersistedChild;
	session?: AgentSession;
	manager?: SessionManager;
	runPromise?: Promise<void>;
}

interface RuntimeInternals {
	children: Map<string, RuntimeRecord>;
	waiters: Map<string, unknown>;
	cancelRun(record: RuntimeRecord, cause: "requested"): Promise<void>;
	handleChildEvent(record: RuntimeRecord, event: AgentSessionEvent): void;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-sdk-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider();
	runtime.registerNativeProvider(faux.provider);
	const manager = SessionManager.inMemory(cwd);
	const pi = {
		appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
		sendMessage: vi.fn(),
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	const context = {
		cwd,
		sessionManager: manager,
		model: faux.getModel(),
		modelRegistry: new ModelRegistry(runtime),
	} as unknown as ExtensionContext;
	const supervisor = Reflect.construct(SubagentSupervisor, [pi, context, runtime]) as SubagentSupervisor;
	Object.assign(supervisor, { agentDir: cwd, childSessionDir: join(cwd, "sessions") });
	cleanups.push(() => supervisor.shutdown());
	return { supervisor, internals: supervisor as unknown as RuntimeInternals, faux, cwd };
}

describe("Pi SDK lifecycle", () => {
	test("joins background descendants before the owning child settles", async () => {
		const { supervisor, internals, faux } = await setup();
		let finishDescendant = () => {};
		const descendantGate = new Promise<void>((resolve) => { finishDescendant = resolve; });
		cleanups.push(async () => finishDescendant());
		const respond: FauxResponseFactory = async (context) => {
			if (getCurrentSystemPrompt(context.messages).includes("subagent nested (")) {
				await descendantGate;
				return fauxAssistantMessage("nested handoff");
			}
			const last = context.messages.at(-1)!;
			if (last.role === "toolResult" && last.toolName === "subagent_create") {
				return fauxAssistantMessage("background work accepted");
			}
			if (last.role === "toolResult" && last.toolName === "subagent_wait") {
				expect(contentText(last.content)).toContain("nested handoff");
				return fauxAssistantMessage("joined handoff");
			}
			if (contentText(last.content).includes("Background subagents still running:")) {
				return fauxAssistantMessage(fauxToolCall("subagent_wait", { names: ["nested"] }));
			}
			return fauxAssistantMessage(fauxToolCall("subagent_create", {
				task: "research", name: "nested", mode: "background",
			}));
		};
		faux.setResponses(Array.from({ length: 5 }, () => respond));
		const accepted = await supervisor.createSubagent(ROOT_CALLER_ID, {
			task: "delegate research", name: "owner", mode: "background",
		});
		const owner = internals.children.get(accepted.details.childId)!;
		const run = owner.runPromise;
		await vi.waitFor(() => expect(internals.waiters.size).toBe(1));
		expect(owner.metadata.state).toBe("running");
		finishDescendant();
		await run;
		expect(owner.metadata.state).toBe("stopped");
		expect(owner.metadata.finalResponse).toBe("joined handoff");
		expect([...internals.children.values()].every((record) => record.metadata.state === "stopped")).toBe(true);
		expect(faux.state.callCount).toBe(5);
	});

	test("session cancellation prevents automatic recovery after agent_end", async () => {
		const { supervisor, internals, faux } = await setup();
		let finishResponse = () => {};
		const responseGate = new Promise<void>((resolve) => { finishResponse = resolve; });
		cleanups.push(async () => finishResponse());
		faux.setResponses([
			async () => {
				await responseGate;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" });
			},
			fauxAssistantMessage("unexpected retry"),
		]);
		const accepted = await supervisor.createSubagent(ROOT_CALLER_ID, { task: "work", mode: "background" });
		const record = internals.children.get(accepted.details.childId)!;
		const run = record.runPromise;
		const session = record.session!;
		vi.spyOn(session.settingsManager, "getRetrySettings").mockReturnValue({
			enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1,
		});
		session.subscribe((event) => {
			if (event.type === "agent_end") void internals.cancelRun(record, "requested");
		});
		finishResponse();
		await run;
		expect(record.metadata.state).toBe("stopped");
		expect(record.metadata.stopReason).toBe("requested");
		expect(faux.state.callCount).toBe(1);
	});

	test("enforces run timeouts in an isolated SDK session", async () => {
		const { supervisor, internals, faux, cwd } = await setup();
		await mkdir(join(cwd, "extensions"));
		await writeFile(join(cwd, "extensions", "unrelated.ts"), 'throw new Error("unrelated extension loaded");');
		await writeFile(join(cwd, "AGENTS.md"), "Unrelated project context");
		await writeFile(join(cwd, "APPEND_SYSTEM.md"), "Unrelated appended prompt");
		faux.setResponses([async (_context, options) => {
			const record = [...internals.children.values()][0]!;
			const resources = record.session!.resourceLoader;
			expect(resources.getExtensions().extensions).toHaveLength(1);
			expect(resources.getExtensions().errors).toEqual([]);
			expect(resources.getSkills().skills).toEqual([]);
			expect(resources.getPrompts().prompts).toEqual([]);
			expect(resources.getAgentsFiles().agentsFiles).toEqual([]);
			expect(resources.getAppendSystemPrompt()).toEqual([]);
			expect(record.session!.getActiveToolNames()).not.toContain("bash");
			expect(record.session!.getActiveToolNames()).not.toContain("powershell");
			const signal = options!.signal!;
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted" });
		}]);
		const result = await supervisor.createSubagent(ROOT_CALLER_ID, {
			task: "bounded work", limits: { timeout_seconds: 0.1 },
		});
		expect(result.details.snapshot.state).toBe("stopped");
		expect(result.details.snapshot.stop_reason).toBe("timeout");
		expect(result.details.snapshot.error).toContain("Execution limit exceeded");
		expect(faux.state.callCount).toBe(1);
	});

	test("retains the final handoff when compaction shrinks a continuation's context", async () => {
		const { supervisor, internals, faux } = await setup();
		faux.setResponses([fauxAssistantMessage("retained history")]);
		const source = await supervisor.createSubagent(ROOT_CALLER_ID, { task: "review" });
		const sourceRecord = internals.children.get(source.details.childId)!;
		const history = SessionManager.open(sourceRecord.metadata.sessionPath);
		for (let index = 0; index < 5; index++) {
			history.appendMessage({ role: "user", content: `question ${index}`, timestamp: Date.now() });
			history.appendMessage(fauxAssistantMessage(`answer ${index}`));
		}
		sourceRecord.metadata.childLeafId = history.getLeafId();
		faux.setResponses([() => {
			const record = [...internals.children.values()].find((child) => child.metadata.state === "running")!;
			record.manager!.appendCompaction("compacted history", null, 1_000);
			record.session!.refreshContext();
			return fauxAssistantMessage("actual final handoff");
		}]);
		const continued = await supervisor.createSubagent(ROOT_CALLER_ID, { from: source.details.childId, task: "continue" });
		expect(continued.details.snapshot.final_response).toBe("actual final handoff");
		expect(continued.content[0]?.text).toContain("actual final handoff");
		const record = internals.children.get(continued.details.childId)!;
		const branch = SessionManager.open(record.metadata.sessionPath).getBranch();
		expect(branch.at(-1)).toMatchObject({
			type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "actual final handoff" }] },
		});
	});

	test.each(["context_edit", "usage", "compaction"] as const)("checkpoints %s entries for recovery", async (kind) => {
		const { supervisor, internals, faux } = await setup();
		let finishResponse = () => {};
		const responseGate = new Promise<void>((resolve) => { finishResponse = resolve; });
		cleanups.push(async () => finishResponse());
		faux.setResponses([async () => {
			await responseGate;
			return fauxAssistantMessage("done");
		}]);
		const accepted = await supervisor.createSubagent(ROOT_CALLER_ID, { task: "work", mode: "background" });
		const record = internals.children.get(accepted.details.childId)!;
		const run = record.runPromise;
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		const manager = record.manager!;
		let event: AgentSessionEvent;
		if (kind === "compaction") {
			const id = manager.appendCompaction("summary", null, 1_000);
			event = { type: "compaction_end", reason: "manual", result: { summary: "summary", firstKeptEntryId: id, tokensBefore: 1_000 }, aborted: false, willRetry: false };
		} else {
			const id = kind === "usage"
				? manager.appendUsage("cache_warm", "faux", "faux", fauxAssistantMessage("").usage).id
				: manager.appendContextEdit(manager.appendMessage(fauxAssistantMessage("omitted attempt")), null);
			event = { type: "entry_appended", entry: manager.getEntry(id)! };
		}
		const leaf = manager.getLeafId();
		internals.handleChildEvent(record, event);
		await Promise.resolve();
		expect(record.metadata.childLeafId).toBe(leaf);
		finishResponse();
		await run;
	});

	test("continuations replay durable history with their own prompt and narrowed tools", async () => {
		const { supervisor, internals, faux } = await setup();
		faux.setResponses([fauxAssistantMessage("retained question")]);
		const source = await supervisor.createSubagent(ROOT_CALLER_ID, {
			task: "review", name: "source", tools: ["read", "grep"],
		});
		const sourceRecord = internals.children.get(source.details.childId)!;
		const sourceHistory = await readFile(sourceRecord.metadata.sessionPath, "utf8");
		faux.setResponses([(context) => {
			expect(getCurrentSystemPrompt(context.messages)).toContain("subagent continued (");
			expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual([
				"read", "subagent_list", "subagent_wait", "subagent_stop", "subagent_create",
			]);
			expect(context.messages.some((message) => contentText(message.content) === "retained question")).toBe(true);
			return fauxAssistantMessage("continued answer");
		}]);
		const continued = await supervisor.createSubagent(ROOT_CALLER_ID, {
			from: source.details.childId, task: "answer", name: "continued", tools: ["read"],
		});
		expect(continued.details.snapshot.final_response).toBe("continued answer");
		expect(continued.details.childId).not.toBe(source.details.childId);
		expect(await readFile(sourceRecord.metadata.sessionPath, "utf8")).toBe(sourceHistory);
	});
});
