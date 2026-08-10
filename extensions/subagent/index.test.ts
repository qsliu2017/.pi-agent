import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageRenderer,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, test, vi } from "vitest";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import subagentSdkExtension, { buildSubagentCreateDescription } from "./index.ts";
import { SubagentListParams, SubagentStopParams } from "./schemas.ts";
import { NOTIFICATION_MESSAGE_TYPE } from "./types.ts";

vi.mock("@earendil-works/pi-ai", () => ({
	StringEnum: (values: readonly string[]) => Type.String({ enum: [...values] }),
}));

vi.mock("./supervisor.ts", () => ({
	DEFAULT_SUBAGENT_MAX_CONCURRENCY: 4,
	DEFAULT_SUBAGENT_MAX_DEPTH: 3,
	SubagentSupervisor: { create: vi.fn() },
}));

type CapturedHandler = (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown;
type ScopedModel = { model: Model<Api>; thinkingLevel?: ThinkingLevel };

function model(provider: string, id: string): Model<Api> {
	return { provider, id } as Model<Api>;
}

function context(currentModel: Model<Api>, scopedModels: ScopedModel[] = []): ExtensionContext {
	return { model: currentModel, scopedModels } as unknown as ExtensionContext;
}

function captureExtension(): {
	tools: ToolDefinition[];
	handlers: Map<string, CapturedHandler[]>;
	messageRenderers: Map<string, MessageRenderer>;
} {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, CapturedHandler[]>();
	const messageRenderers = new Map<string, MessageRenderer>();
	const pi = {
		registerFlag: () => {},
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerMessageRenderer: (customType: string, renderer: MessageRenderer) => {
			messageRenderers.set(customType, renderer);
		},
		on: (event: string, handler: CapturedHandler) => {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
	} as unknown as ExtensionAPI;

	subagentSdkExtension(pi);
	return { tools, handlers, messageRenderers };
}

function requireHandler(handlers: Map<string, CapturedHandler[]>, event: string, index = 0): CapturedHandler {
	const handler = handlers.get(event)?.[index];
	if (!handler) throw new Error(`Missing ${event} handler ${index}`);
	return handler;
}

const renderTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function renderToolCall(tool: ToolDefinition, args: unknown, expanded: boolean, lastComponent?: Component): Component {
	if (!tool.renderCall) throw new Error(`Missing ${tool.name} renderCall`);
	return tool.renderCall(args as never, renderTheme, { expanded, lastComponent } as never);
}

function renderNotification(
	renderer: MessageRenderer,
	content: string,
	expanded: boolean,
	width: number,
	theme: Theme = renderTheme,
): string[] {
	const component = renderer(
		{ role: "custom", customType: NOTIFICATION_MESSAGE_TYPE, content, display: true, timestamp: 1 },
		{ expanded },
		theme,
	);
	if (!component) throw new Error("Notification renderer returned no component");
	return component.render(width);
}

describe("notification message renderer registration", () => {
	test("registers the expandable renderer for NOTIFICATION_MESSAGE_TYPE", () => {
		const { messageRenderers } = captureExtension();
		const renderer = messageRenderers.get(NOTIFICATION_MESSAGE_TYPE);
		if (!renderer) throw new Error("Missing notification message renderer");

		expect([...messageRenderers.keys()]).toContain(NOTIFICATION_MESSAGE_TYPE);
		expect(renderNotification(renderer, "worker completed", false, 80)).toEqual([]);
		expect(renderNotification(renderer, "worker completed", true, 80).map(stripAnsi)).toEqual([
			"╭─ Subagent update",
			"│ worker completed",
			"╰─",
		]);
	});

	test("registered renderer wraps ANSI-styled content within narrow visible widths", () => {
		const renderer = captureExtension().messageRenderers.get(NOTIFICATION_MESSAGE_TYPE);
		if (!renderer) throw new Error("Missing notification message renderer");
		const ansiTheme = {
			fg: (_color: string, text: string) => `\u001b[35m${text}\u001b[39m`,
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
		} as unknown as Theme;
		const lines = renderNotification(renderer, "alpha beta gamma", true, 10, ansiTheme);

		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(10);
		expect(lines.slice(1, -1).map(stripAnsi)).toEqual(["│ alpha", "│ beta", "│ gamma"]);
	});
});

describe("subagent_create model discovery", () => {
	test("registers the initial description on session start with the current canonical parent model", () => {
		const { tools, handlers } = captureExtension();
		expect(tools.map((tool) => tool.name)).toEqual([
			"subagent_list",
			"subagent_send",
			"subagent_wait",
			"subagent_stop",
		]);

		requireHandler(handlers, "session_start")(
			{ type: "session_start", reason: "startup" },
			context(model("anthropic", "claude-sonnet-4-5")),
		);

		const create = tools.at(-1);
		expect(create?.name).toBe("subagent_create");
		expect(create?.description).toContain(
			"Omitting model inherits the current parent model (anthropic/claude-sonnet-4-5).",
		);
		expect(create?.description).not.toContain("Preferred available choices");
		expect(create?.executionMode).toBe("sequential");
		expect(create?.renderCall).toBeTypeOf("function");
		expect(create?.renderResult).toBeTypeOf("function");
	});

	test("re-registers the description with the newly selected model", () => {
		const { tools, handlers } = captureExtension();
		const previous = model("anthropic", "claude-sonnet-4-5");
		const next = model("openai", "gpt-5.4");
		requireHandler(handlers, "session_start")({ type: "session_start", reason: "startup" }, context(previous));
		requireHandler(handlers, "model_select")(
			{ type: "model_select", model: next, previousModel: previous, source: "set" },
			context(previous),
		);

		const registrations = tools.filter((tool) => tool.name === "subagent_create");
		expect(registrations).toHaveLength(2);
		expect(registrations[1]?.description).toContain("current parent model (openai/gpt-5.4)");
		expect(registrations[1]?.description).not.toContain("anthropic/claude-sonnet-4-5");
	});

	test("formats scoped models canonically and includes only pinned thinking levels", () => {
		const description = buildSubagentCreateDescription(model("openai", "gpt-5.4"), [
			{ model: model("anthropic", "claude-opus-4-6"), thinkingLevel: "high" },
			{ model: model("openai", "gpt-5.4") },
			{ model: model("google", "gemini-3-pro"), thinkingLevel: "low" },
		]);

		expect(description).toContain(
			"Preferred available choices: anthropic/claude-opus-4-6:high, openai/gpt-5.4, google/gemini-3-pro:low.",
		);
	});

	test("bounds descriptions with large scoped model sets", () => {
		const scopedModels = Array.from({ length: 500 }, (_, index) => ({
			model: model("provider", `model-${index}-${"x".repeat(40)}`),
			thinkingLevel: index === 0 ? ("xhigh" as const) : undefined,
		}));
		const description = buildSubagentCreateDescription(model("provider", "parent"), scopedModels);

		expect(description.length).toBeLessThanOrEqual(2_000);
		expect(description).toContain("provider/model-0-");
		expect(description).toContain(":xhigh");
		expect(description).toMatch(/, …$/);
	});
});

describe("pause-only lifecycle tools", () => {
	test("does not expose permanent termination or the closed state to models", () => {
		const stopSchema = JSON.parse(JSON.stringify(SubagentStopParams)) as {
			properties: Record<string, unknown>;
		};
		expect(Object.keys(stopSchema.properties)).toEqual(["name", "reason"]);

		const listSchema = JSON.stringify(SubagentListParams);
		expect(listSchema).not.toContain("terminate");
		expect(listSchema).not.toContain("closed");
	});

	test("describes stop as reversible pause-only lifecycle control", () => {
		const { tools } = captureExtension();
		const stop = tools.find((tool) => tool.name === "subagent_stop");
		if (!stop) throw new Error("Missing subagent_stop tool");

		expect(stop.description.toLowerCase()).toMatch(/reversibl/);
		expect(stop.description.toLowerCase()).not.toContain("terminate");
		expect(stop.description.toLowerCase()).not.toContain("permanent");
		expect(stop.promptSnippet?.toLowerCase()).not.toContain("terminate");
	});

	test("registers a parent-settlement hook for repeat waiting-parent reminders", () => {
		const { handlers } = captureExtension();
		expect(handlers.get("agent_settled")).toHaveLength(1);
	});
});

describe("subagent static call cards", () => {
	test("renders create context before the task and expands to the complete composed prompt", () => {
		const { tools, handlers } = captureExtension();
		requireHandler(handlers, "session_start")(
			{ type: "session_start", reason: "startup" },
			context(model("openai", "gpt-5.4")),
		);
		const create = tools.find((tool) => tool.name === "subagent_create");
		if (!create) throw new Error("Missing subagent_create tool");

		const args = {
			name: "worker",
			context: "context one\ncontext two",
			task: "task one\ntask two",
		};
		const collapsed = renderToolCall(create, args, false);
		expect(collapsed.render(80)).toEqual(["subagent_create worker", "context one", "context two", "…"]);

		const expanded = renderToolCall(create, args, true, collapsed);
		expect(expanded).toBe(collapsed);
		expect(expanded.render(80)).toEqual([
			"subagent_create worker",
			"context one",
			"context two",
			"",
			"task one",
			"task two",
		]);
	});

	test("renders the full send message when expanded", () => {
		const { tools } = captureExtension();
		const send = tools.find((tool) => tool.name === "subagent_send");
		if (!send) throw new Error("Missing subagent_send tool");

		const message = "message one\nmessage two\nmessage three\nmessage four";
		const collapsed = renderToolCall(send, { name: "worker", message }, false);
		expect(collapsed.render(80)).toEqual(["subagent_send worker", "message one", "message two", "message three…"]);

		const expanded = renderToolCall(send, { name: "worker", message }, true, collapsed);
		expect(expanded.render(80)).toEqual([
			"subagent_send worker",
			"message one",
			"message two",
			"message three",
			"message four",
		]);
	});
});
