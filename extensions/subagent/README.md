# Subagent Extension

Run configurable subagents as in-process Pi SDK sessions. Each subagent has an isolated conversation context while sharing a parent-managed lifecycle, live status, and bidirectional messaging channel.

## Features

- **Dynamic configuration**: The parent chooses the task, model, thinking level, system prompt, tools, working directory, context, and limits.
- **In-process sessions**: Subagents use Pi SDK `AgentSession` objects; no child `pi` process is spawned.
- **Persistent conversations**: Child sessions and extension metadata are saved so retained subagents can be recovered after Pi restarts.
- **Background execution**: Multiple subagents can run while the parent continues working.
- **Recursive delegation**: Subagents may create descendants within a harness-enforced depth limit.
- **Live status**: Living subagents share one consolidated dashboard immediately above the editor.
- **Resumable sessions**: Completed, paused, failed, or input-waiting subagents retain their JSONL conversation and are reopened lazily when resumed.
- **Parent-mediated advice**: A child can yield with a structured message and continue after the parent replies.
- **Lifecycle controls**: The parent can inspect, wait for, steer, or reversibly stop subagents.

## Harness Flags

- `--subagent-max-depth <integer>` sets the nonnegative recursion depth limit (default: `3`). A value of `0` disables subagent creation.
- `--subagent-max-concurrency <integer>` sets the positive concurrent-run limit (default: `4`).

These string CLI flags are parsed when the supervisor starts. They are harness policy and are not exposed in model-facing tool schemas.

## Public Tools

### `subagent_create`

Creates a uniquely identified subagent and starts it in the background.

```ts
{
  name?: string;
  task: string;
  model?: string;
  thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  system_prompt?: string;
  tools?: string[];
  cwd?: string;
  context?: string;
  limits?: {
    timeout_seconds?: number;
  };
}
```

The extension returns a generated immutable ID, the effective name, and the initial state. Names are human-readable labels; subsequent tools accept either an ID or an unambiguous name.

The parent-provided system prompt is wrapped in fixed supervisor instructions. Tool access and limits are enforced by the child session configuration rather than by prompt instructions alone.

The tool description is refreshed on parent session start and model selection. Omitting `model` inherits the current parent model, which the description identifies using its canonical `provider/model`. When scoped models are configured, the description includes a bounded list of preferred canonical choices; pinned thinking levels use `provider/model:level`.

`system_prompt` defines the child’s role, behavior, and standing instructions. It is placed in the system-prompt layer and applies to every run in that child session. `context` contains task-specific facts or handoff material from the parent. It is included with the initial task as user-level context, does not override supervisor rules, and remains visible in the child conversation history.

### `subagent_list`

Returns concise snapshots of matching subagents.

```ts
{
  names?: string[];
  states?: SubagentState[];
  detail?: "compact" | "standard";
}
```

A standard snapshot may include:

```ts
{
  id: string;
  name: string;
  state: SubagentState;
  model: string;
  thinking_level: string;
  elapsed_ms: number;
  idle_ms: number;
  turns: number;
  current_activity?: {
    type: "thinking" | "tool";
    name?: string;
    preview?: string;
    started_at?: number;
  };
  last_text_preview?: string;
  pending_question?: string;
  error?: string;
  usage?: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    cost: number;
  };
}
```

Snapshots are derived from child events. The extension does not run an additional model to summarize status.

### `subagent_send`

Sends a message to a subagent. This is used to answer questions, steer active work, provide additional context, or continue an idle session.

```ts
{
  name: string;
  message: string;
  delivery?: "auto" | "steer" | "follow_up";
}
```

`auto` applies state-aware behavior:

- `running`: deliver as a steering message.
- `waiting_parent`, `paused`, `completed`, or `failed`: lazily reopen the persisted session and start a new run with the message while preserving prior context.
- `stopping`: wait for the in-flight stop commit, then lazily reopen and continue. This wait is scoped to that child and does not block unrelated subagents.

`steer` is delivered after the current child turn finishes its tool calls. `follow_up` is delivered after the current child run settles.

### `subagent_wait`

Waits without polling until a selected subagent reaches an interesting state.

```ts
{
  names?: string[];
  events?: Array<"waiting_parent" | "completed" | "failed" | "paused">;
  timeout_seconds?: number;
}
```

The tool streams compact status updates while waiting and returns when a requested event occurs or the timeout expires.

### `subagent_stop`

Stops active work for one subagent.

```ts
{
  name: string;
  reason?: string;
}
```

Stopping is always reversible. It aborts the current run when necessary, transitions the child to `paused`, removes it from the live widget, persists its JSONL and leaf metadata, and disposes its in-memory SDK session. Repeated stop calls are idempotent. `subagent_send` can always reopen and resume a stopped child; there is no model-accessible permanent termination mode.

## Child Tool

### `subagent_yield`

Each child receives a private structured tool for reporting completion or requesting parent input.

```ts
{
  status: "completed" | "needs_input" | "blocked";
  content: string;
}
```

`content` contains the complete handoff: result, question, relevant attempts, paths, artifacts, or other information the parent needs. Calling the tool ends the current child run while retaining its session. `needs_input` and `blocked` map to the public `waiting_parent` state. The parent answers with `subagent_send`.

A normal child response that finishes without calling `subagent_yield` is treated as `completed`.

## States

`SubagentState` includes `creating`, `running`, transient `stopping`, `waiting_parent`, `completed`, `failed`, and `paused`.

```text
creating
   └─ running
       ├─ stopping ──────── paused
       ├─ waiting_parent ── subagent_send ── running
       ├─ completed ─────── subagent_send ── running
       ├─ failed ────────── subagent_send ── running
       └─ paused ────────── subagent_send ── running

any retained state ── subagent_stop ── paused
```

Only `creating`, `running`, and transient `stopping` require a resident SDK session. After a child reaches `waiting_parent`, `completed`, `failed`, or `paused`, the extension persists its state and leaf, disposes the SDK session, and retains compact metadata for lazy resumption.

## Parent Notifications

The extension injects a concise parent-visible message when a subagent:

- requests input,
- completes,
- fails, or
- is unexpectedly paused.

Routine text and tool events remain in the TUI status display and are not copied into the parent model context.

Injected subagent notifications remain extension-generated follow-up messages in the main agent's context and may trigger another turn. Their transcript renderer is invisible in Pi's default collapsed mode: it returns zero lines rather than printing notification text. Ctrl+O expansion reveals each notification as a width-safe card containing its complete state, identity, handoff, or reminder content. The messages remain display-enabled so expansion can reveal them; they are not hidden with `display: false`.

Whenever the main agent settles while one or more descendants remain in `waiting_parent`, the extension appends a concise follow-up listing those children and triggers another main-agent turn. The reminder tells the main agent to answer/continue each child with `subagent_send` or reversibly remove it from the live set with `subagent_stop`. This repeats after settlement until no child remains in `waiting_parent`; stopping is safe because every stopped child remains resumable.

## Recursive Delegation

The extension maintains a parent/child tree and a configured maximum depth. Depth is harness metadata and is not exposed as a model-controlled argument.

A root-created subagent receives an internal remaining-depth budget. A child with remaining depth may receive the subagent management tools; descendants receive a budget reduced by one. At zero remaining depth, `subagent_create` is omitted from that child’s active tools. Child management tools are scoped to the caller’s descendants, so a subagent cannot control its parent or siblings.

The depth limit, concurrency limit, tool policy, and write policy are enforced by the extension. A descendant's built-in tools must be a subset of its parent's, and its canonical working directory must remain within its parent's working directory. Recursive children otherwise use the same lifecycle, persistence, status, notification, and advice protocol.

## Status Display

`subagent_create` and `subagent_send` leave static acknowledgements in the transcript. Their collapsed call cards show up to three lines of the delegated prompt; Ctrl+O expands them to the complete prompt. A create card includes its supplied parent context followed by the task, while a send card shows the complete message. Live child activity is rendered in one consolidated widget immediately above the user editor, rather than by repeatedly updating historical tool rows.

The collapsed dashboard uses one fixed-height, single-line row per living subagent:

```text
Subagents
● cache-review  opus:high  turn 8  $ cargo test cache::invalidation
? migration     gpt-5.4    turn 3  waiting for parent
```

Living states are `creating`, `running`, `stopping`, and `waiting_parent`. Settled children leave the dashboard after their completion, failure, or pause notification is emitted; they remain available through `subagent_list` and can still be resumed when retained. Dashboard order follows creation and resumption order: creation appends a child, and resuming an idle child moves it to the newest position. Steering, tool activity, and other child events never reorder rows. The order is persisted across restarts. The dashboard bounds its height and reports any omitted count.

Ctrl+O follows Pi’s global tool-output expansion state. Expanded mode shows each living child’s latest five turns with available thinking, text, tool-input, and tool-result previews. The supervisor retains and persists only these five compact turn summaries per child for display; complete conversation history remains solely in JSONL. Collapsed rows and expanded detail lines are truncated to terminal width rather than wrapped so routine updates do not change widget height.

Child `message_update`, `tool_execution_*`, `turn_end`, retry, compaction, and lifecycle events update in-memory status and invalidate only the bottom dashboard. Streaming invalidations are throttled. The dashboard does not run clock-only refreshes; elapsed and idle values advance when child events occur. This keeps status current without continuously rewriting transcript history.

## Persistence

Each child uses a persistent `SessionManager.create(cwd, childSessionDir)` session file. The extension also persists the child ID, name, parent ID, session path, generated prompt configuration, tool policy, depth budget, limits, latest lifecycle state, and any queued recursive owner notifications.

When the same parent session is restored, retained child metadata is recovered without keeping every child SDK session resident. Children that were `running` or `stopping` at shutdown are recovered as `paused`. `subagent_send` uses `SessionManager.open()` on demand, restores the persisted leaf ID, rebuilds the child context, and starts the next run. The SDK session is disposed again after the child next settles.

Child session files use a dedicated directory so they do not clutter normal interactive session selection. JSONL is retained for every child throughout the parent session's lifetime; stopping releases memory but does not delete conversation history.

## Session and Safety Model

- Child sessions use an explicit resource loader and do not inherit unrelated extensions, skills, or prompt templates. Recursive management tools are injected directly when the remaining-depth policy allows them.
- Read-only tools are the recommended default.
- Concurrent writers should use separate worktrees; lifecycle management does not prevent semantic file conflicts.
- On parent shutdown or reload, active child runs are aborted, persistent state is flushed, and SDK session objects are disposed. Retained sessions can be recovered later.
- Harness policies enforce recursion depth and concurrency. An optional `timeout_seconds` can abort a child that exceeds its cumulative active-time budget; no model-controlled turn limit is used.
- Important child output is returned through structured yield results or explicit status inspection; continuous streams are not added to parent context.
