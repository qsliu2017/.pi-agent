import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import {
	renderStaticSubagentCall,
	renderStaticSubagentResult,
	renderSubagentNotificationCard,
	SubagentDashboard,
	selectDashboardChildren,
} from "./render.ts";
import type { DashboardChildView, SubagentSnapshot, TurnView } from "./types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return {
		id: "child-1",
		name: "worker",
		state: "running",
		model: "test/test-model",
		thinking_level: "off",
		elapsed_ms: 0,
		idle_ms: 0,
		turns: 1,
		usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 },
		...overrides,
	};
}

function view(
	overrides: Omit<Partial<DashboardChildView>, "snapshot"> & { snapshot?: Partial<SubagentSnapshot> } = {},
): DashboardChildView {
	return {
		snapshot: snapshot(overrides.snapshot),
		turns: overrides.turns ?? [],
		dashboardOrder: overrides.dashboardOrder ?? 1,
	};
}

function turn(index: number, overrides: Partial<TurnView> = {}): TurnView {
	return {
		index,
		textPreview: `text-${index}`,
		activities: [],
		startedAt: index,
		endedAt: index + 1,
		...overrides,
	};
}

function dashboard(children: DashboardChildView[], expanded: boolean, maxLines = 24): SubagentDashboard {
	return new SubagentDashboard(
		() => children,
		() => expanded,
		() => maxLines,
		theme,
	);
}

describe("SubagentDashboard", () => {
	test("filters settled children and renders oldest activation first", () => {
		const selected = selectDashboardChildren([
			view({ snapshot: { id: "old", name: "old", state: "running" }, dashboardOrder: 10 }),
			view({ snapshot: { id: "done", name: "done", state: "completed" }, dashboardOrder: 40 }),
			view({ snapshot: { id: "new", name: "new", state: "waiting_parent" }, dashboardOrder: 30 }),
			view({ snapshot: { id: "paused", name: "paused", state: "paused" }, dashboardOrder: 50 }),
			view({ snapshot: { id: "middle", name: "middle", state: "stopping" }, dashboardOrder: 20 }),
		]);

		expect(selected.map((child) => child.snapshot.id)).toEqual(["old", "middle", "new"]);
	});

	test("keeps create order stable across child activity events", () => {
		const first = view({ snapshot: { id: "first", name: "first" }, dashboardOrder: 1 });
		const second = view({ snapshot: { id: "second", name: "second" }, dashboardOrder: 2 });

		second.snapshot.current_activity = { type: "tool", name: "bash", started_at: 100 };
		first.snapshot.current_activity = { type: "thinking", started_at: 200 };
		second.turns.push(turn(1, { endedAt: 300 }));

		expect(selectDashboardChildren([second, first]).map((child) => child.snapshot.id)).toEqual(["first", "second"]);
	});

	test("collapsed mode renders one fixed single-line row per living child", () => {
		const lines = dashboard(
			[
				view({
					snapshot: {
						name: "runner",
						state: "running",
						thinking_level: "high",
						turns: 8,
						current_activity: { type: "tool", name: "bash", preview: "cargo test\ncache" },
					},
					dashboardOrder: 1,
				}),
				view({
					snapshot: { name: "waiting", state: "waiting_parent", turns: 3, pending_question: "Which API?" },
					dashboardOrder: 2,
				}),
				view({ snapshot: { name: "done", state: "completed" }, dashboardOrder: 3 }),
			],
			false,
		).render(120);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("Subagents");
		expect(lines[1]).toContain("● runner  test-model:high  turn 8  $ cargo test cache");
		expect(lines[2]).toContain("? waiting  test-model  turn 3  waiting for parent");
		expect(lines.join("\n")).not.toContain("done");
	});

	test("expanded mode renders available details for only the latest five turns", () => {
		const turns = Array.from({ length: 6 }, (_, index) => turn(index + 1));
		turns[5] = turn(6, {
			thinkingPreview: "inspect the file",
			textPreview: "The implementation is safe.",
			activities: [
				{
					toolCallId: "tool-1",
					name: "read",
					preview: "src/index.ts",
					resultPreview: "export const value = 1;",
					startedAt: 1,
					endedAt: 2,
				},
			],
		});
		const output = dashboard(
			[
				view({
					snapshot: { elapsed_ms: 119_600, idle_ms: 2_000, turns: 6 },
					turns,
				}),
			],
			true,
		).render(120);
		const text = output.join("\n");

		expect(text).not.toContain("text-1");
		for (let index = 2; index <= 5; index++) expect(text).toContain(`text-${index}`);
		expect(text).toContain("thinking: inspect the file");
		expect(text).toContain("text: The implementation is safe.");
		expect(text).toContain("tool: read src/index.ts");
		expect(text).toContain("result: export const value = 1;");
		expect(text).toContain("2m0s");
		expect(text).not.toContain("1m60s");
	});

	test("truncates every row instead of wrapping and respects the width", () => {
		const lines = dashboard(
			[
				view({
					snapshot: {
						name: "worker-with-a-very-long-name",
						current_activity: { type: "thinking", preview: "x".repeat(200) },
					},
				}),
			],
			false,
		).render(24);

		expect(lines).toHaveLength(2);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});

	test("bounds dashboard height and reports omitted children", () => {
		const children = Array.from({ length: 4 }, (_, index) =>
			view({ snapshot: { id: String(index), name: `worker-${index}` }, dashboardOrder: index + 1 }),
		);
		const lines = dashboard(children, false, 4).render(120);

		expect(lines).toHaveLength(4);
		expect(lines.at(-1)).toContain("2 more lines (2 subagents omitted)");
	});

	test("follows the global expansion state without transcript render state", () => {
		let expanded = false;
		const component = new SubagentDashboard(
			() => [view({ turns: [turn(1)] })],
			() => expanded,
			() => 24,
			theme,
		);
		expect(component.render(120)).toHaveLength(2);
		expanded = true;
		expect(component.render(120).join("\n")).toContain("text: text-1");
	});
});

describe("subagent notification card", () => {
	test("renders zero transcript lines while collapsed and all multiline content while expanded", () => {
		const content =
			"[subagent worker] state=waiting_parent\nNeed approval for the migration.\n\nAttempted:\n- dry run\n- validation";
		const component = renderSubagentNotificationCard(content, theme, false);
		expect(component.render(80)).toEqual([]);

		const expanded = renderSubagentNotificationCard(content, theme, true, component);
		expect(expanded).toBe(component);
		const text = expanded.render(80).map(stripAnsi).join("\n");
		expect(text).toContain("Subagent update");
		expect(text).toContain(
			"[subagent worker] state=waiting_parent\n│ Need approval for the migration.\n│ \n│ Attempted:\n│ - dry run\n│ - validation",
		);
	});

	test("wraps complete content safely at narrow widths without truncating the handoff", () => {
		const content = "alpha beta gamma\nlong-token-123456789";
		const lines = renderSubagentNotificationCard(content, theme, true).render(8);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(8);
		const body = lines
			.slice(1, -1)
			.map((line) => stripAnsi(line).replace(/^│ ?/, ""))
			.join("");
		expect(body.replace(/\s/g, "")).toBe(content.replace(/\s/g, ""));
		expect(lines.join("\n")).not.toContain("…");
	});

	test("keeps ANSI-styled lines width-safe and toggles repeatedly through the reused component", () => {
		const ansiTheme = {
			fg: (_color: string, text: string) => `\u001b[35m${text}\u001b[0m`,
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
		} as unknown as Theme;
		const content = "first notification line\nsecond line";
		const component = renderSubagentNotificationCard(content, ansiTheme, false);
		expect(component.render(11)).toEqual([]);
		renderSubagentNotificationCard(content, ansiTheme, true, component);
		const expanded = component.render(11);
		for (const line of expanded) expect(visibleWidth(line)).toBeLessThanOrEqual(11);
		const expandedBody = expanded
			.slice(1, -1)
			.map((line) => stripAnsi(line).replace(/^│ ?/, ""))
			.join("")
			.replace(/\s/g, "");
		expect(expandedBody).toContain("firstnotificationline");
		renderSubagentNotificationCard(content, ansiTheme, false, component);
		expect(component.render(11)).toEqual([]);
		renderSubagentNotificationCard(content, ansiTheme, true, component);
		expect(stripAnsi(component.render(40).join("\n"))).toContain("second line");
	});
});

describe("static subagent tool rendering", () => {
	test("keeps the header separate and collapses the prompt body to three rendered lines", () => {
		const component = renderStaticSubagentCall(
			"create",
			"worker",
			"line one\nline two\nline three\nline four",
			theme,
		);
		const lines = component.render(80);

		expect(lines).toEqual(["subagent_create worker", "line one", "line two", "line three…"]);
		expect(lines.slice(1)).toHaveLength(3);
		expect(lines.join("\n")).not.toContain("line four");
	});

	test("wraps prompt lines safely to width and marks collapsed wrapping truncation", () => {
		const lines = renderStaticSubagentCall(
			"send",
			"worker-with-a-long-name",
			"first line\nsecond line contains several words\nthird-line-is-a-very-long-token",
			theme,
		).render(12);

		expect(stripAnsi(lines[0] ?? "")).toBe("subagent_...");
		expect(lines.slice(1).map(stripAnsi)).toEqual(["first line", "second line", "contains…"]);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
	});

	test("shows the full multiline prompt when expanded and reuses the component while toggling", () => {
		const content = "line one\nline two\nline three\nline four";
		const collapsed = renderStaticSubagentCall("send", "worker", content, theme);
		const expanded = renderStaticSubagentCall("send", "worker", content, theme, true, collapsed);

		expect(expanded).toBe(collapsed);
		expect(expanded.render(80)).toEqual(["subagent_send worker", "line one", "line two", "line three", "line four"]);

		const collapsedAgain = renderStaticSubagentCall("send", "worker", content, theme, false, expanded);
		expect(collapsedAgain).toBe(collapsed);
		expect(collapsedAgain.render(80)).toEqual(["subagent_send worker", "line one", "line two", "line three…"]);
	});

	test("renders a static acknowledgement from tool result details", () => {
		const component = renderStaticSubagentResult(
			{
				action: "create",
				childId: "child-1",
				acceptedAt: 1,
				snapshot: snapshot({ name: "worker", state: "running" }),
			},
			theme,
		);

		expect(component.render(120)).toEqual(["Created worker (child-1) · running"]);
		expect(component.render(24)).toHaveLength(1);
		expect(visibleWidth(component.render(24)[0] ?? "")).toBeLessThanOrEqual(24);
	});
});
