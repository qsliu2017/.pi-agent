import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, MessageRenderer, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, test, vi } from "vitest";
import subagentExtension, { buildSubagentCreateDescription } from "./index.ts";
import { SubagentCreateParams, SubagentListParams, SubagentWaitParams } from "./schemas.ts";
import { NOTIFICATION_MESSAGE_TYPE } from "./types.ts";

vi.mock("@earendil-works/pi-ai", () => ({
	StringEnum: (values: readonly string[], options?: object) => Type.String({ enum: [...values], ...options }),
}));

vi.mock("./supervisor.ts", () => ({
	DEFAULT_SUBAGENT_MAX_CONCURRENCY: 4,
	DEFAULT_SUBAGENT_MAX_DEPTH: 3,
	SubagentSupervisor: { create: vi.fn() },
}));

type Handler = (event: any, context: ExtensionContext) => unknown;

function model(provider = "openai", id = "gpt-test"): Model<Api> {
	return { provider, id } as Model<Api>;
}

function capture(): {
	tools: ToolDefinition[];
	handlers: Map<string, Handler[]>;
	renderers: Map<string, MessageRenderer>;
	flags: Map<string, unknown>;
} {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, Handler[]>();
	const renderers = new Map<string, MessageRenderer>();
	const flags = new Map<string, unknown>();
	const pi = {
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerFlag: (name: string, value: unknown) => flags.set(name, value),
		registerMessageRenderer: (name: string, renderer: MessageRenderer) => renderers.set(name, renderer),
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	} as unknown as ExtensionAPI;
	subagentExtension(pi);
	return { tools, handlers, renderers, flags };
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function registerCreate(result: ReturnType<typeof capture>): ToolDefinition {
	const handler = result.handlers.get("session_start")?.[0];
	if (!handler) throw new Error("Missing session_start create registration");
	handler({ reason: "startup" }, { cwd: "/repo", model: model(), scopedModels: [] } as unknown as ExtensionContext);
	const tool = result.tools.find((candidate) => candidate.name === "subagent_create");
	if (!tool) throw new Error("Missing create tool");
	return tool;
}

describe("tool surface", () => {
	test("exposes only create, wait, list, and stop", () => {
		const result = capture();
		expect(result.tools.map((tool) => tool.name)).toEqual(["subagent_list", "subagent_wait", "subagent_stop"]);
		registerCreate(result);
		expect(result.tools.map((tool) => tool.name).sort()).toEqual([
			"subagent_create",
			"subagent_list",
			"subagent_stop",
			"subagent_wait",
		]);
	});

	test("defines the redesigned schemas", () => {
		const create = JSON.parse(JSON.stringify(SubagentCreateParams));
		expect(Object.keys(create.properties)).toEqual([
			"task",
			"from",
			"mode",
			"name",
			"model",
			"thinking_level",
			"system_prompt",
			"tools",
			"cwd",
			"context",
			"limits",
		]);
		expect(create.properties.mode.enum).toEqual(["wait", "background"]);
		const wait = JSON.parse(JSON.stringify(SubagentWaitParams));
		expect(Object.keys(wait.properties)).toEqual(["names", "for", "timeout_seconds"]);
		expect(wait.properties.for.enum).toEqual(["any", "all"]);
		expect(JSON.stringify(SubagentListParams)).toContain('"running"');
		expect(JSON.stringify(SubagentListParams)).toContain('"stopped"');
	});

	test("marks create explicitly parallel and strongly prompts sibling batching", () => {
		const create = registerCreate(capture());
		expect(create.executionMode).toBe("parallel");
		expect(create.promptGuidelines?.join(" ")).toContain("as siblings in one response");
		expect(create.description).toContain("Waits by default");
	});

	test("registers flags and the outstanding-work reminder hook", () => {
		const result = capture();
		expect(result.flags.get("subagent-max-depth")).toMatchObject({ default: "3" });
		expect(result.flags.get("subagent-max-concurrency")).toMatchObject({ default: "4" });
		expect(result.handlers.get("agent_settled")).toHaveLength(1);
	});
});

describe("descriptions and rendering", () => {
	test("includes inherited and scoped model choices", () => {
		const description = buildSubagentCreateDescription(model("openai", "gpt-parent"), [
			{ model: model("anthropic", "claude"), thinkingLevel: "high" },
		]);
		expect(description).toContain("openai/gpt-parent");
		expect(description).toContain("anthropic/claude:high");
	});

	test("renders continuation and background mode on create calls", async () => {
		const create = registerCreate(capture());
		if (!create.renderCall) throw new Error("Missing create renderer");
		const component = create.renderCall(
			{ task: "continue review", from: "old-worker", name: "new-worker", mode: "background" } as never,
			theme,
			{ expanded: false } as never,
		);
		expect(component.render(100)).toEqual([
			"subagent_create new-worker ← old-worker - background",
			"continue review",
		]);

		if (!create.renderResult) throw new Error("Missing create result renderer");
		const state: Record<string, unknown> = {};
		const invalidate = vi.fn();
		create.renderResult(
			{
				content: [{ type: "text", text: "running" }],
				details: {
					action: "create",
					mode: "background",
					childId: "id",
					acceptedAt: 1,
					snapshot: {
						id: "id",
						name: "resolved-worker",
						from: "old-worker",
						state: "running",
						model: "anthropic/claude",
						thinking_level: "high",
						cwd: "/repo/resolved",
						timeout_seconds: 60,
						elapsed_ms: 1,
						idle_ms: 0,
						turns: 0,
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 },
					},
				},
			} as never,
			{ expanded: false, isPartial: true },
			theme,
			{ state, invalidate } as never,
		);
		const updated = create.renderCall(
			{ task: "continue review", from: "old-worker", mode: "background" } as never,
			theme,
			{ expanded: false, state } as never,
		);
		expect(updated.render(120)[0]).toBe("subagent_create resolved-worker ← old-worker - background timeout 60s");
		expect(updated.render(120).at(-1)).toBe("resolved anthropic/claude high");
		expect(invalidate).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(invalidate).toHaveBeenCalledOnce();
	});

	test("renders wait selection, any/all, and timeout", () => {
		const wait = capture().tools.find((tool) => tool.name === "subagent_wait");
		if (!wait?.renderCall) throw new Error("Missing wait renderer");
		const component = wait.renderCall(
			{ names: ["a", "b"], for: "any", timeout_seconds: 30 } as never,
			theme,
			{} as never,
		);
		expect(component.render(100)).toEqual(["subagent_wait any"]);
	});

	test("registers the expandable notification renderer", () => {
		const renderer = capture().renderers.get(NOTIFICATION_MESSAGE_TYPE);
		if (!renderer) throw new Error("Missing notification renderer");
		const collapsed = renderer(
			{ role: "custom", customType: NOTIFICATION_MESSAGE_TYPE, content: "worker stopped", display: true, timestamp: 1 },
			{ expanded: false },
			theme,
		);
		expect(collapsed?.render(80)).toEqual(["╭─ Subagent update", "│ worker stopped", "╰─"]);
	});
});
