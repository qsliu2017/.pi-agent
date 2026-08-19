# Subagent Extension

Run isolated subagents as in-process Pi SDK sessions. The extension keeps the parent focused while children research, implement, test, or recursively delegate work with independent context and configurable cost.

## User Stories

1. **Parallel research and review** — As the main agent, I want independent read-only workers to investigate a topic or review a large codebase from different perspectives, then combine concise findings without importing their working context.
2. **Parallel implementation** — As the main agent, I want workers to implement separate submodules concurrently, ask for decisions when needed, and continue follow-up work from retained history.
3. **Focused delegation for large tasks** — As the main agent, I want to own the overall plan while delegating details to cheaper models or lower thinking levels. A child may recursively decompose a subtask that is still too large for one focused context.
4. **Bounded risky execution** — As the main agent, I want to delegate a test or command that may deadlock, wait long enough for legitimate work, and recover after a timeout instead of blocking an unattended parent session forever.

### Requirements

- Run independent children concurrently.
- Wait for delegated work by default so the parent does not finish early.
- Allow explicit background work when the parent must react to one child while siblings continue.
- Reuse a retained child's history for questions, corrections, and follow-up work.
- Keep child transcripts out of the parent context; return only final handoffs, failures, and lifecycle notices.
- Configure model, thinking level, role, tools, cwd, context, and timeout per child.
- Support bounded recursive delegation with descendant-only management scope.
- Abort potentially stuck runs with an enforceable timeout.
- Default to read-only tools; use separate worktrees for concurrent writers.
- Persist child sessions and lineage across Pi restarts.
- Keep the model-facing protocol small: create, wait, list, and stop.

## Design

A child is an immutable, one-run session node. Follow-up work creates a new child from an old child's retained history.

A child ends with a concise final assistant response containing its results, artifacts, blockers, or questions. If input is needed, child instructions tell it to stop, ask a direct question, and wait for the parent to create a continuation with the answer.

A child is `running` while its model run is active and `stopped` afterward for any reason. The stopped snapshot carries its final response or error. The parent interprets the handoff and creates a continuation when it contains a question.

### Tool Set

#### `subagent_create`

```ts
subagent_create({
  task: string,
  from?: string, // retained child ID or unambiguous name
  mode?: "wait" | "background", // default: "wait"
  name?: string,
  model?: string, // provider/model-id or unambiguous model ID
  thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  system_prompt?: string,
  tools?: string[], // built-in tool allowlist
  cwd?: string,
  context?: string,
  limits?: {
    timeout_seconds?: number, // per-run execution limit
  },
})
```

Without `from`, create a fresh child. With `from`, create a new child whose initial conversation is copied from the source child's active history, followed by `task`. The source stays immutable. Its model, thinking level, role, cwd, and tool policy are inherited unless safely overridden.

- `mode: "wait"` waits for `stopped` and returns the complete final handoff or error. This is the default.
- `mode: "background"` returns after durable acceptance. The final handoff or error is delivered later as a parent follow-up.
- Cancelling a waiting call releases the wait but retains the child as background work.
- A source must be `stopped`. Wait for or stop a running source before branching from it.

#### `subagent_wait`

```ts
subagent_wait({
  names?: string[], // child IDs or unambiguous names
  for?: "any" | "all", // default: "all"
  timeout_seconds?: number, // parent-wait limit; does not stop children
})
```

Wait for already-background work:

- `for: "any"` returns when the first selected child becomes `stopped`.
- `for: "all"` returns when every selected child becomes `stopped`.
- Without `names`, selection is the caller-visible active children when the wait starts.
- A wait timeout releases only the parent; selected children keep running.

#### `subagent_list`

```ts
subagent_list({
  names?: string[],
  states?: Array<"running" | "stopped">,
  detail?: "compact" | "standard", // default: "standard"
})
```

Return event-derived snapshots without invoking another model. Snapshots include identity, lineage, state, model, effort, timing, activity, turns, usage, final preview, and errors.

#### `subagent_stop`

```ts
subagent_stop({
  name: string, // child ID or unambiguous name
  reason?: string,
})
```

Abort an active run, retain its durable history, and mark it `stopped`. The same child ID never runs again; create from it to continue the work.

### Subagent States

```ts
type SubagentState = "running" | "stopped"
```

- **`running`** — The child was durably accepted and its model run has not settled.
- **`stopped`** — The child has no active run. Its snapshot carries the final response, error, timeout, or explicit stop reason.

Setup failure before durable acceptance returns a tool error and creates no child. Internal setup and cancellation phases are not exposed as additional public states. Wait and stop operations resolve only after the relevant child reaches `stopped`.

### Advanced Usage Patterns

1. **Advisor loop** — Ask the child in `task` to stop and end with a direct question whenever it needs a decision. Answer with `subagent_create({ from: childId, task: answer })`, then repeat from the newest lineage node.
2. **Parallel cohort** — Emit multiple default-wait creates in one assistant response for self-contained work; Pi runs them concurrently and returns the cohort together. For interactive work, create with `mode: "background"`, call `subagent_wait({ names, for: "any" })`, handle that child, and finish with `for: "all"`.
3. **Alternative branches** — Create multiple children from the same retained source with different hypotheses, review feedback, or implementation strategies.
4. **Hierarchical delegation** — Give a large child enough remaining depth to create scoped descendants. Each level receives direct-child handoffs and returns one concise response upward.
5. **Potentially hanging test** — Use a default-wait create with a deliberately long `limits.timeout_seconds`. After timeout, inspect the stopped child's error and create a continuation from its retained history.
6. **Cost-controlled delegation** — Use a cheaper model or lower thinking level for detailed child work while keeping planning and synthesis in the main session.

### TUI

The TUI has two surfaces: a live widget for active work and transcript cards for individual tool calls.

#### Active Subagents Widget

```text
Subagents
● api-review  claude-sonnet low  turn 3  read src/server.ts
● test-runner gpt-5.4 minimal   turn 1  $ bun test
```

- The widget shows only `running` children in creation order and disappears when none remain.
- Collapsed mode uses one line per child: status, name, model and thinking level, turn count, and current activity.
- Expanded mode shows the latest five turns with thinking, text, tool calls, results, errors, token usage, elapsed time, and idle time.
- Its height is capped at 40% of the terminal, between 4 and 24 lines. When space is limited, the final line reports omitted lines or children.
- Live events update only the widget and are throttled to avoid excessive redraws. Routine child streams never become parent chat messages.

#### Tool Call Cards

Each model-facing tool has a compact transcript card. Values in `{{braces}}` are dynamic; lines marked with `?` are omitted when absent. The final status line updates reactively while the call is active and, for background creates, after the tool call has returned.

**`subagent_create`**

A typical background call looks like this:

```text
subagent_create reviewer - background timeout 60s
Review the API boundary and report compatibility risks.
packages/api anthropic/claude-sonnet high
7dc8… running
```

The header includes the optional name, continuation source, mode, and run timeout. The body previews at most three system-prompt lines and five task lines. The configuration row is intentionally differential: cwd, model, and thinking effort appear only when they differ from the parent, and a differing cwd is relative to the parent's cwd. If nothing differs, that row is absent. The UUID status row remains live after a background create returns, changing to `stopped` when the child settles. Expanding the card reveals unabridged instructions, context, and the final handoff or error.

**`subagent_wait`**

A wait card is a small cohort monitor rather than a numeric progress summary:

```text
subagent_wait all
api-review done after 10s
test-runner running
docs-review done after 15s
timeout 20s
```

Its header shows `any` or `all` for a cohort, but omits the strategy when exactly one child is selected. While waiting, each row says `running` or `done after Ns`, where the duration is measured from the start of this wait rather than from child creation. The final row shows the parent-wait timeout. The header changes when the wait settles:

```text
subagent_wait all done after 19s
api-review done after 10s
test-runner done after 19s
docs-review done after 15s
```

A timed-out wait uses `timeout after Ns` in the header. Children still running at completion or timeout remain as bare names, making it clear that the wait ended without claiming they finished. The timeout footer is shown only while waiting. Expanding the card adds complete handoffs from children that stopped.

**`subagent_list`**

```text
subagent_list {{states? | all}} - {{detail: compact | standard}}
{{name}} {{uuid}} {{state}} turn {{turns}}
{{name}} {{uuid}} {{state}} turn {{turns}}
{{additional rows; overflow ends with an omitted count}}
```

Expanded compact cards show all matching rows. Expanded standard cards additionally show lineage, model, effort, timing, activity, usage, final response, and errors.

**`subagent_stop`**

```text
subagent_stop {{name}}
{{reason? at most 3 lines}}
{{uuid}} {{running | stopped, reactive}}
```

Expanding the card reveals the complete stop reason and retained final handoff or error.

Background completions appear as expandable **Subagent update** cards:

```text
Subagent update
{{name}} {{uuid}} stopped
{{final handoff or error; collapsed to a preview}}
```

When tool output is collapsed, the update keeps one handoff preview line; expanding it reveals the complete handoff or error.

### Flags

- `--subagent-max-depth <integer>` — Maximum recursive depth. Default: `3`; `0` disables creation.
- `--subagent-max-concurrency <integer>` — Maximum concurrent child runs. Default: `4`.

Limits are supervisor policy, not model-facing tool parameters. Concurrency admission is fail-fast, preventing recursive wait deadlocks behind active ancestors.

### Session Model

- Each child is an in-process Pi SDK `AgentSession`; no child `pi` process is spawned.
- Each child uses a persistent `SessionManager` JSONL session. Registry metadata records identity, owner, lineage source, active leaf, configuration, state, timeout, usage, and compact UI status.
- `from` clones the source's active conversation branch into a new session. It is a lineage edge, not an extra recursion edge; the new child belongs directly to the caller at the depth of a fresh child.
- Child sessions use an explicit resource loader and do not inherit unrelated extensions, skills, or prompt templates. Recursive management tools are injected by the supervisor.
- Descendants can only narrow built-in tool access, must remain inside the parent's canonical cwd, and cannot relax depth, concurrency, write, or timeout policy.
- Routine child thinking, text, and tool streams update status UI only. Wait results and background notifications carry final handoffs into the direct owner's context.
- Background completion notices and outstanding-work reminders are persisted and claimed by immutable child ID to avoid loss or duplication.
- On shutdown or reload, active runs are aborted, durable state is flushed, and SDK sessions are disposed. Retained history can be used as the source of a new child after recovery.
