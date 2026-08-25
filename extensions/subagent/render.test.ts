import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
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
import { renderSubagentNotificationCard, SubagentDashboard, selectDashboardChildren } from "./render.ts";
import type { DashboardChildView, SubagentSnapshot } from "./types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return {
		id: "child",
		name: "worker",
		state: "running",
		model: "test/model",
		thinking_level: "off",
		cwd: "/repo",
		elapsed_ms: 1_000,
		idle_ms: 100,
		turns: 1,
		usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, cost: 0 },
		...overrides,
	};
}

function view(overrides: Partial<DashboardChildView> = {}): DashboardChildView {
	return {
		snapshot: snapshot(),
		turns: [],
		dashboardOrder: 1,
		parentId: null,
		...overrides,
	};
}

describe("dashboard", () => {
	test("shows only running children in stable activation order", () => {
		const children = selectDashboardChildren([
			view({ snapshot: snapshot({ id: "stopped", state: "stopped" }), dashboardOrder: 1 }),
			view({ snapshot: snapshot({ id: "b", name: "b" }), dashboardOrder: 3 }),
			view({ snapshot: snapshot({ id: "a", name: "a" }), dashboardOrder: 2 }),
		]);
		expect(children.map((child) => child.snapshot.id)).toEqual(["a", "b"]);
	});

	test("renders recursive children as a tree", () => {
		const dashboard = new SubagentDashboard(
			() => [
				view({ snapshot: snapshot({ id: "parent", name: "parent" }), dashboardOrder: 1 }),
				view({ snapshot: snapshot({ id: "first", name: "first" }), dashboardOrder: 2, parentId: "parent" }),
				view({ snapshot: snapshot({ id: "second", name: "second" }), dashboardOrder: 3, parentId: "parent" }),
			],
			() => false,
			() => 8,
			theme,
		);
		expect(dashboard.render(100).map((line) => line.split(/\s{2}/)[0])).toEqual([
			"Subagents",
			"● parent",
			"├─ ● first",
			"└─ ● second",
		]);
	});

	test("renders a bounded width-safe live widget", () => {
		const dashboard = new SubagentDashboard(
			() => [view({ snapshot: snapshot({ name: "long-worker-name", current_activity: { type: "tool", name: "bash", preview: "very long command" } }) })],
			() => false,
			() => 5,
			theme,
		);
		const lines = dashboard.render(24);
		expect(lines[0]).toBe("Subagents");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});
});

describe("tool cards", () => {
	test("updates a finalized background create card when its child later stops", () => {
		const registry = new CreateCardRegistry();
		const invalidate = vi.fn();
		const running = snapshot({ id: "id", state: "running" });
		const details = registry.bind(
			{ action: "create", mode: "background", childId: "id", acceptedAt: 1, snapshot: running },
			invalidate,
		);
		expect(details.snapshot.state).toBe("running");
		registry.update([snapshot({ id: "id", state: "stopped", stop_reason: "finished", final_response: "done" })]);
		expect(invalidate).toHaveBeenCalledOnce();
		const rebound = registry.bind(details, invalidate);
		expect(rebound.snapshot.state).toBe("stopped");
		expect(rebound.snapshot.final_response).toBe("done");
	});

	const createInput = {
		name: "worker",
		mode: "wait" as const,
		task: "one\ntwo\nthree\nfour\nfive\nsix",
		cwd: "/repo",
		model: "test/model",
		thinkingLevel: "low" as const,
		timeoutSeconds: 30,
	};

	test("renders the create card with bounded prompt sections and footer", () => {
		const lines = renderSubagentCreateCall(
			{ ...createInput, from: "source", systemPrompt: "role one\nrole two\nrole three\nrole four" },
			theme,
			false,
		).render(100);
		expect(lines).toEqual([
			"subagent_create worker ← source - wait timeout 30s",
			"role one",
			"role two",
			"role three…",
			"one",
			"two",
			"three",
			"four",
			"five…",
			"/repo test/model low",
		]);
	});

	test("renders wait handoffs below the prompt with five/all collapsed/expanded lines", () => {
		const handoff = "one\ntwo\nthree\nfour\nfive\nsix";
		const details = {
			action: "create" as const,
			mode: "wait" as const,
			childId: "id",
			acceptedAt: 1,
			snapshot: snapshot({ state: "stopped", final_response: handoff, stop_reason: "finished" }),
		};
		expect(renderSubagentCreateResult(details, theme, false, false).render(80)).toEqual([
			"id stopped",
			"one",
			"two",
			"three",
			"four",
			"five…",
		]);
		expect(renderSubagentCreateResult(details, theme, true, false).render(80)).toEqual([
			"id stopped",
			"one",
			"two",
			"three",
			"four",
			"five",
			"six",
		]);
	});

	test("keeps background handoffs out of the create result card", () => {
		const running = renderSubagentCreateResult(
			{ action: "create", mode: "background", childId: "id", acceptedAt: 1, snapshot: snapshot() },
			theme,
			false,
			true,
		);
		expect(running.render(80)).toEqual(["id running"]);
		const stopped = renderSubagentCreateResult(
			{
				action: "create",
				mode: "background",
				childId: "id",
				acceptedAt: 1,
				snapshot: snapshot({ state: "stopped", final_response: "notification only", stop_reason: "finished" }),
			},
			theme,
			true,
			false,
		);
		expect(stopped.render(80)).toEqual(["id stopped"]);
	});

	test("renders informative any/all wait lifecycle cards", () => {
		const pending = {
			reason: "pending" as const,
			started_at: 1,
			elapsed_ms: 5_000,
			waitFor: "all" as const,
			snapshots: [
				snapshot({ id: "a", name: "a", state: "stopped", elapsed_ms: 30_000, stopped_at: 10_001 }),
				snapshot({ id: "b", name: "b", state: "running" }),
				snapshot({ id: "c", name: "c", state: "stopped", elapsed_ms: 35_000, stopped_at: 15_001 }),
			],
			settled: 2,
			total: 3,
		};
		expect(renderSubagentWaitCall({ names: ["a", "b", "c"], waitFor: "all", timeoutSeconds: 20, details: pending }, theme).render(100)).toEqual([
			"subagent_wait all",
		]);
		expect(renderSubagentWaitResult(pending, 20, theme, false).render(100)).toEqual([
			"a done after 10s",
			"b running",
			"c done after 15s",
			"timeout 20s",
		]);

		const settled = {
			...pending,
			reason: "settled" as const,
			elapsed_ms: 19_000,
			snapshots: pending.snapshots.map((item) =>
				item.id === "b" ? snapshot({ id: "b", name: "b", state: "stopped", elapsed_ms: 39_000, stopped_at: 19_001 }) : item,
			),
			settled: 3,
		};
		expect(renderSubagentWaitCall({ names: ["a", "b", "c"], waitFor: "all", timeoutSeconds: 20, details: settled }, theme).render(100)).toEqual([
			"subagent_wait all done after 19s",
		]);
		expect(renderSubagentWaitResult(settled, 20, theme, false).render(100)).toEqual([
			"a done after 10s",
			"b done after 19s",
			"c done after 15s",
		]);
		const anySettled = {
			...pending,
			reason: "settled" as const,
			waitFor: "any" as const,
			elapsed_ms: 10_000,
			snapshots: [
				snapshot({ id: "a", name: "a", state: "running" }),
				snapshot({ id: "b", name: "b", state: "stopped", elapsed_ms: 30_000, stopped_at: 10_001 }),
				snapshot({ id: "c", name: "c", state: "running" }),
			],
			settled: 1,
			matched: snapshot({ id: "b", name: "b", state: "stopped", elapsed_ms: 30_000, stopped_at: 10_001 }),
		};
		expect(renderSubagentWaitCall({ names: ["a", "b", "c"], waitFor: "any", timeoutSeconds: 20, details: anySettled }, theme).render(100)).toEqual([
			"subagent_wait any done after 10s",
		]);
		expect(renderSubagentWaitResult(anySettled, 20, theme, false).render(100)).toEqual([
			"a",
			"b done after 10s",
			"c",
		]);

		const timedOut = { ...pending, reason: "timeout" as const, elapsed_ms: 20_000 };
		expect(renderSubagentWaitCall({ names: ["a", "b", "c"], waitFor: "all", timeoutSeconds: 20, details: timedOut }, theme).render(100)).toEqual([
			"subagent_wait all timeout after 20s",
		]);
		expect(renderSubagentWaitResult(timedOut, 20, theme, false).render(100)).toEqual([
			"a done after 10s",
			"b",
			"c done after 15s",
		]);
		expect(renderSubagentWaitCall({ names: ["a"], waitFor: "any", timeoutSeconds: 20 }, theme).render(100)).toEqual([
			"subagent_wait",
		]);
	});

	test("keeps every card line within the available width", () => {
		const cards = [
			renderSubagentCreateCall({ ...createInput, systemPrompt: "a very long system prompt", task: "a very long task" }, theme, false),
			renderSubagentWaitCall({ names: ["a-very-long-child-name"], waitFor: "all", timeoutSeconds: 30 }, theme),
			renderSubagentListCall({ states: ["running", "stopped"], detail: "standard" }, theme),
			renderSubagentStopCall({ name: "a-very-long-child-name", reason: "a long reason" }, theme, false),
		];
		for (const card of cards) {
			for (const line of card.render(18)) expect(visibleWidth(line)).toBeLessThanOrEqual(18);
		}
	});

	test("renders list and stop cards", () => {
		expect(renderSubagentListCall({ states: ["running"], detail: "standard" }, theme).render(100)).toEqual([
			"subagent_list running - standard",
		]);
		expect(
			renderSubagentListResult({ snapshots: [snapshot({ id: "id", name: "worker" })] }, "compact", theme, false).render(100),
		).toEqual(["worker id running turn 1"]);
		expect(renderSubagentStopCall({ name: "worker", reason: "because" }, theme, false).render(100)).toEqual([
			"subagent_stop worker",
			"because",
		]);
		expect(
			renderSubagentStopResult({ childId: "id", snapshot: snapshot({ state: "stopped" }) }, theme, false).render(100),
		).toEqual(["id stopped"]);
	});
});

describe("notifications", () => {
	test("shows five/all handoff lines when collapsed/expanded", () => {
		const content = "[subagent worker (id)] state=stopped\none\ntwo\nthree\nfour\nfive\nsix";
		const collapsed = renderSubagentNotificationCard(content, theme, false);
		expect(collapsed.render(40)).toEqual([
			"╭─ Subagent update",
			"│ worker id stopped",
			"│ one",
			"│ two",
			"│ three",
			"│ four",
			"│ five…",
			"╰─",
		]);
		const expanded = renderSubagentNotificationCard(content, theme, true, collapsed);
		expect(expanded.render(40)).toEqual([
			"╭─ Subagent update",
			"│ worker id stopped",
			"│ one",
			"│ two",
			"│ three",
			"│ four",
			"│ five",
			"│ six",
			"╰─",
		]);
		const narrow = expanded.render(14);
		expect(narrow[0]).toContain("Subagent");
		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(14);
	});
});
