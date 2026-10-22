# Usage, configuration and recovery

Start with the [README](../README.md#first-task). Invoke Codex Controls Claude or its `orchestrate` skill explicitly. Codex owns the goal, design, scope, acceptance and session lifecycle; Claude Code implements bounded stages using its own configured model and tools.

## Task contracts and independent acceptance

Each task declares artifacts, dependencies and executable acceptance checks. Dispatch starts only dependency-ready work. Completion is a candidate: Codex inspects the actual files and diff, then `orchestrator_review` checks the current artifact hash and reruns the original checks. A failed check rejects the candidate and records rework.

Checks remain immutable for a dispatched task. `append` adds work; `supersede` records the replacement and rewires dependents to the replacement's own contract. The old task and its history remain recorded. `reconcile` captures supervisor-completed files for review without spending model work; it does not accept them automatically.

Changes are inventoried against the task baseline, including untracked files. Undeclared changes require inspection and explicit artifact coverage. Results mark truncation; retrieve complete blockers, errors, checks, hashes and related evidence with targeted `orchestrator_status` sections.

## Parallel work

Use an ordinary plan for one worker and `orchestrator_team` for independent tasks. A team declares `dependsOn`, fixed checks, artifacts and literal `writeScope` paths. Only accepted dependencies unlock downstream work.

Three managed executions is the shared ceiling across connected chats, ordinary runs and team children. A fourth request returns `WORKER_SLOTS_FULL`; retained idle transcripts do not consume an execution slot. Use separate Git worktrees for overlapping writes or shared build output, then explicitly integrate accepted results.

`writeScope` is a scheduling reservation and audit contract. Claude Code's native permissions govern what a tool may actually read or write. Native subagents and team tools follow your own Claude Code policies and are separate from the plugin's three managed workers.

## Events and two-way messages

Keep one event wait pending. Completion, a question, a residual permission, failure, cancellation and budget risk wake it. `notify_supervisor` records an ordinary milestone in the audit; it does not wake the pending wait. `ask_supervisor` creates a question that does wake it, and Codex's answer returns inside that original tool call.

Native `AskUserQuestion` uses the same question bridge. The original questions and options arrive as `worker_question`. Answers use `{"answers":{"<exact question text>":"<label or free text>"}}`; a single question also accepts plain text, and a multi-select answer may use an array of labels. A timeout, cancellation, stale ID or incomplete/unparseable reply rejects the pending question explicitly. Decisions expire after five minutes by default.

`orchestrator_message` supports:

- `queue`: one input at the next native result boundary, FIFO, with a follow-on segment reserved from the remaining budget first.
- `interrupt`: request that the current turn end, drain its native boundary, then deliver the urgent input in the same saved conversation ahead of unsent queued messages.
- `reply`: answer a pending worker question.

Limits are eight unsent messages, 32 accepted guidance records per run and 4,000 characters per message. Request IDs are idempotent; changed text or mode requires a new ID. Receipt states include `queued`, `interruption_requested`, `delivering`, `delivered`, `failed` and `cancelled`. Delivery proves transport acceptance. The terminal separately shows the actual Codex answer and the worker's own acknowledgement; files and checks still determine technical acceptance.

## Budgets and execution windows

The defaults describe different limits:

| Limit | Default | Continuation behavior |
|---|---|---|
| Native segment cap | 500 agentic rounds | Continue the same task within the remaining persistent allowance |
| Persistent run/team allowance | 1,000 SDK-reported turns | Preserved across follow-ups, rework and recovery; time renewal does not replenish it |
| Execution window | Two hours | Explicit evidence-backed `resume` may renew time while preserving the contracts and turn budget |
| Acceptance repairs | Two | Separate from budget continuation and interruption recovery |

A segment reaching its native cap can continue on the same conversation if the persistent budget and execution window allow it. An exhausted total allowance remains exhausted. An expired time window may be renewed through `sessionAction="resume"` with evidence of authorized continuation; plain resume, reopen, append and context changes do not silently renew it.

Failure records a checkpoint, failure classification, accounting and next actions. Inspect that evidence before continuing. The defaults and parameter ranges are also described in the live tool schemas.

## Context and session continuity

Warm work reuses the live SDK conversation. `retain`, `close`, `resume`, `compact` and `new` manage it explicitly. Compaction records a checkpoint; a new context carries the checkpoint and accepted interfaces forward while keeping the persistent budget. Usage and context warnings come from reported session data; missing values remain unknown.

Technical `finish` retains the accepted candidate for user review. Human approval is a separate step. Idle review sessions suspend after 30 minutes with their transcripts preserved. Closing a retained session preserves its native transcript for an explicitly resumed task.

After a connection loss, `plan(action="attach", runId)` or the team's attach operation recovers a released or dead-owner run without replaying model work. A live owner cannot be taken over. Stale owners are fenced by identity and generation, and original task revisions, checks, dependencies and accounting remain recorded.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CCC_CLAUDE_PATH` | Resolved `claude` | Explicit installed Claude executable |
| `CCC_WAIT_MS` | 1,200,000 ms | Default wait, up to 20 minutes |
| `CCC_DECISION_TIMEOUT_MS` | 300,000 ms | Decision expiry, configurable from one second to 30 minutes |
| `CCC_INIT_TIMEOUT_MS` | 120,000 ms | Startup bound, one second to ten minutes |
| `CCC_CHECK_TIMEOUT_MS` | 300,000 ms | Check bound, one second to ten minutes |
| `CCC_DATA_DIR` | `~/.local/share/codex-controls-claude` | State directory; host `PLUGIN_DATA` takes precedence |
| `CCC_NATIVE_HELPER` | Packaged DLL | Explicit native helper override |

Model selection checks `~/.claude/settings.json` `env.ANTHROPIC_MODEL` first, then the existing environment/top-level `model`, otherwise Claude Code's native default. Effective user/project/local permission settings and hooks remain in use. Existing sessions keep startup options until an appropriate new session boundary.

The Codex compatibility MCP configuration declares a 1,260-second host tool timeout around the backend's 1,200-second wait. A genuine empty wait continues from its returned cursor. Waiting is event-driven; status is for evidence or recovery, not periodic supervision. The plugin coordinates while Codex is active and does not wake a closed chat.

See [the skill](../skills/orchestrate/SKILL.md) and [worker policy inventory](../skills/orchestrate/references/worker-policy.md) for supervisor contracts and limits.
