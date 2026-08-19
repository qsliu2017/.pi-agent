import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const SUBAGENT_STATES = ["running", "stopped"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const SUBAGENT_MODES = ["wait", "background"] as const;
export const WAIT_FOR = ["any", "all"] as const;

export const SubagentCreateParams = Type.Object({
	task: Type.String({ description: "Initial or continuation task for the new subagent" }),
	from: Type.Optional(Type.String({ description: "Stopped source subagent ID or unambiguous name" })),
	mode: Type.Optional(StringEnum(SUBAGENT_MODES, { description: 'Return on "stopped" or after background acceptance' })),
	name: Type.Optional(Type.String({ description: "Human-readable subagent name" })),
	model: Type.Optional(Type.String({ description: "Model as provider/model-id, or an unambiguous model id" })),
	thinking_level: Type.Optional(StringEnum(THINKING_LEVELS)),
	system_prompt: Type.Optional(Type.String({ description: "Role and standing instructions for the child" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Built-in tool allowlist" })),
	cwd: Type.Optional(Type.String({ description: "Existing working directory for the child" })),
	context: Type.Optional(Type.String({ description: "Task-specific parent handoff context" })),
	limits: Type.Optional(
		Type.Object({
			timeout_seconds: Type.Optional(Type.Number({ minimum: 0.1, description: "Per-run execution limit" })),
		}),
	),
});

export const SubagentListParams = Type.Object({
	names: Type.Optional(Type.Array(Type.String())),
	states: Type.Optional(Type.Array(StringEnum(SUBAGENT_STATES))),
	detail: Type.Optional(StringEnum(["compact", "standard"] as const)),
});

export const SubagentWaitParams = Type.Object({
	names: Type.Optional(Type.Array(Type.String())),
	for: Type.Optional(StringEnum(WAIT_FOR)),
	timeout_seconds: Type.Optional(Type.Number({ minimum: 0.1 })),
});

export const SubagentStopParams = Type.Object({
	name: Type.String({ description: "Subagent id or unambiguous name" }),
	reason: Type.Optional(Type.String()),
});

export type SubagentCreateInput = Static<typeof SubagentCreateParams>;
export type SubagentListInput = Static<typeof SubagentListParams>;
export type SubagentWaitInput = Static<typeof SubagentWaitParams>;
export type SubagentStopInput = Static<typeof SubagentStopParams>;
