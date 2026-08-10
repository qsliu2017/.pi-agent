import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const ROOT_CALLER_ID = "<parent>";
export const REGISTRY_ENTRY_TYPE = "subagent.registry.v1";
export const NOTIFICATION_MESSAGE_TYPE = "subagent.notification.v1";

export type SubagentState = "creating" | "running" | "stopping" | "waiting_parent" | "completed" | "failed" | "paused";

export type WaitEvent = "waiting_parent" | "completed" | "failed" | "paused";
export type YieldStatus = "completed" | "needs_input" | "blocked";
export type DeliveryMode = "auto" | "steer" | "follow_up";

export interface SubagentLimits {
	timeoutSeconds?: number;
}

export interface UsageSnapshot {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	cost: number;
}

export interface CurrentActivity {
	type: "thinking" | "tool";
	name?: string;
	preview?: string;
	started_at?: number;
}

export interface ToolActivityView {
	toolCallId: string;
	name: string;
	preview?: string;
	resultPreview?: string;
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
}

export interface TurnView {
	index: number;
	textPreview?: string;
	thinkingPreview?: string;
	activities: ToolActivityView[];
	startedAt: number;
	endedAt?: number;
}

export interface SubagentSnapshot {
	id: string;
	name: string;
	state: SubagentState;
	model: string;
	thinking_level: ThinkingLevel;
	elapsed_ms: number;
	idle_ms: number;
	turns: number;
	current_activity?: CurrentActivity;
	last_text_preview?: string;
	pending_question?: string;
	error?: string;
	usage: UsageSnapshot;
}

export interface YieldRecord {
	status: YieldStatus;
	content: string;
	at: number;
}

export interface PendingNotification {
	id: string;
	content: string;
	createdAt: number;
}

export interface PersistedChild {
	id: string;
	name: string;
	parentId: string | null;
	depth: number;
	remainingDepth: number;
	childSessionId: string;
	childLeafId: string | null;
	sessionPath: string;
	cwd: string;
	task: string;
	context?: string;
	modelProvider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	generatedSystemPrompt: string;
	enabledTools: string[];
	limits: SubagentLimits;
	state: SubagentState;
	turns: number;
	createdAt: number;
	updatedAt: number;
	lastActivityAt: number;
	dashboardOrder: number;
	cumulativeActiveMs: number;
	usage: UsageSnapshot;
	latestTurns: TurnView[];
	pendingNotifications: PendingNotification[];
	pendingQuestion?: string;
	lastYield?: YieldRecord;
	error?: string;
}

export interface PersistedRegistry {
	version: 1;
	ownerSessionId: string;
	sequence: number;
	dashboardOrderSequence: number;
	children: PersistedChild[];
}

export interface SubagentToolDetails {
	action: "create" | "send";
	childId: string;
	acceptedAt: number;
	snapshot: SubagentSnapshot;
}

export interface DashboardChildView {
	snapshot: SubagentSnapshot;
	turns: TurnView[];
	dashboardOrder: number;
}

export interface ListSubagentsDetails {
	snapshots: SubagentSnapshot[];
}

export interface WaitSubagentsDetails {
	reason: "pending" | "event" | "timeout" | "cancelled";
	snapshots: SubagentSnapshot[];
	matched?: SubagentSnapshot;
}

export interface StopSubagentDetails {
	childId: string;
	snapshot: SubagentSnapshot;
}
