import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const SUBAGENT_STATES = [
	"creating",
	"running",
	"stopping",
	"waiting_parent",
	"completed",
	"failed",
	"paused",
] as const;
export const WAIT_EVENTS = ["waiting_parent", "completed", "failed", "paused"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const SubagentCreateParams = Type.Object({
	name: Type.Optional(Type.String({ description: "Human-readable subagent name" })),
	task: Type.String({ description: "Initial task for the subagent" }),
	model: Type.Optional(Type.String({ description: "Model as provider/model-id, or an unambiguous model id" })),
	thinking_level: Type.Optional(StringEnum(THINKING_LEVELS)),
	system_prompt: Type.Optional(Type.String({ description: "Role and standing instructions for the child" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Built-in tool allowlist" })),
	cwd: Type.Optional(Type.String({ description: "Existing working directory for the child" })),
	context: Type.Optional(Type.String({ description: "Task-specific parent handoff context" })),
	limits: Type.Optional(
		Type.Object({
			timeout_seconds: Type.Optional(Type.Number({ minimum: 0.1 })),
		}),
	),
});

export const SubagentListParams = Type.Object({
	names: Type.Optional(Type.Array(Type.String())),
	states: Type.Optional(Type.Array(StringEnum(SUBAGENT_STATES))),
	detail: Type.Optional(StringEnum(["compact", "standard"] as const)),
});

export const SubagentSendParams = Type.Object({
	name: Type.String({ description: "Subagent id or unambiguous name" }),
	message: Type.String({ description: "Message to deliver" }),
	delivery: Type.Optional(StringEnum(["auto", "steer", "follow_up"] as const)),
});

export const SubagentWaitParams = Type.Object({
	names: Type.Optional(Type.Array(Type.String())),
	events: Type.Optional(Type.Array(StringEnum(WAIT_EVENTS), { minItems: 1 })),
	timeout_seconds: Type.Optional(Type.Number({ minimum: 0.1 })),
});

export const SubagentStopParams = Type.Object({
	name: Type.String({ description: "Subagent id or unambiguous name" }),
	reason: Type.Optional(Type.String()),
});

export const SubagentYieldParams = Type.Object({
	status: StringEnum(["completed", "needs_input", "blocked"] as const),
	content: Type.String({ description: "Complete result, question, or blocking handoff for the parent" }),
});

export type SubagentCreateInput = Static<typeof SubagentCreateParams>;
export type SubagentListInput = Static<typeof SubagentListParams>;
export type SubagentSendInput = Static<typeof SubagentSendParams>;
export type SubagentWaitInput = Static<typeof SubagentWaitParams>;
export type SubagentStopInput = Static<typeof SubagentStopParams>;
export type SubagentYieldInput = Static<typeof SubagentYieldParams>;
