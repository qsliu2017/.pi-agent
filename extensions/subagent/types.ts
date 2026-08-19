import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const ROOT_CALLER_ID = "<parent>";
export const REGISTRY_ENTRY_TYPE = "subagent.registry.v2";
export const NOTIFICATION_MESSAGE_TYPE = "subagent.notification.v1";

export type SubagentState = "running" | "stopped";
export type SubagentMode = "wait" | "background";
export type WaitFor = "any" | "all";
export type StopReason = "finished" | "error" | "timeout" | "requested" | "cancelled" | "recovered";

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
	from?: string;
	state: SubagentState;
	model: string;
	thinking_level: ThinkingLevel;
	cwd: string;
	timeout_seconds?: number;
	elapsed_ms: number;
	idle_ms: number;
	turns: number;
	current_activity?: CurrentActivity;
	last_text_preview?: string;
	final_response?: string;
	error?: string;
	stop_reason?: StopReason;
	stop_message?: string;
	stopped_at?: number;
	usage: UsageSnapshot;
}

export interface PersistedChild {
	id: string;
	name: string;
	parentId: string | null;
	fromId?: string;
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
	rolePrompt?: string;
	generatedSystemPrompt: string;
	enabledTools: string[];
	limits: SubagentLimits;
	state: SubagentState;
	stopReason?: StopReason;
	stopMessage?: string;
	finalResponse?: string;
	error?: string;
	turns: number;
	createdAt: number;
	updatedAt: number;
	lastActivityAt: number;
	dashboardOrder: number;
	activeMs: number;
	usage: UsageSnapshot;
	latestTurns: TurnView[];
	notifyOnStop: boolean;
}

export interface PersistedRegistry {
	version: 2;
	ownerSessionId: string;
	sequence: number;
	dashboardOrderSequence: number;
	children: PersistedChild[];
}

export interface CreateSubagentDetails {
	action: "create";
	mode: SubagentMode;
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
	reason: "pending" | "settled" | "timeout" | "cancelled";
	started_at: number;
	elapsed_ms: number;
	waitFor: WaitFor;
	snapshots: SubagentSnapshot[];
	settled: number;
	total: number;
	matched?: SubagentSnapshot;
}

export interface StopSubagentDetails {
	childId: string;
	snapshot: SubagentSnapshot;
}
