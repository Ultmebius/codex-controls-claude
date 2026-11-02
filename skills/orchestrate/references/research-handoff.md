# Research handoff

Read this when a task carries settled research, when research must be delegated, or when deciding what to pass on a continuation. The main [skill](../SKILL.md) keeps the triggers and the core policy; this file holds the template and the edge cases.

## One owner per material question

For each stage, name its research owner (Codex or the worker), questions, status (settled with evidence, or still open), owed output and handoff condition in the existing brief. A question is not deep-researched by both sides independently at the same time. Select the owner before deep exploration. Decision responsibility and research execution are separate: Codex can decide from evidence the worker collected.

| Situation | Owner | What crosses the boundary |
|---|---|---|
| Final design decisions — architecture, interfaces, scope, compatibility, acceptance | Codex | Decide from available evidence; when worker research is needed, state the open decision and checkpoint instead of prematurely prescribing the answer |
| Codex already read the code or docs and can state the facts | Codex | A Research handoff; the worker implements within it |
| Significant discovery, reproduction, diagnosis or option analysis remains in a bounded subsystem | The worker | Questions, read/run boundaries, expected evidence and recommendation, allowed choices and material decision checkpoint; Codex waits, decides from the return and continues the same session |
| Independent modules with no shared decision | The workers, in parallel | One brief each; no research duplication across them |
| Independent acceptance of finished work | Codex | Not research duplication — review the work and its evidence |

Codex keeps the goal, plan, scope changes and acceptance in every case. Choose Codex-owned research when conclusions are already available or the missing decision is cheaper to settle directly; choose worker-owned research when substantial discovery remains or investigation benefits from its implementation context. Do not complete the investigation before assigning that same investigation. A small phase does not need its own research or planning worker. One worker can research, ask at a material decision checkpoint and implement in the same task/session.

During worker-owned work, Codex waits for the result. Any parallel supervisor activity must name a different question/output and be independent of the worker's open questions. No such activity means wait, not another search of the same topic. If ownership changes, transfer findings, coverage and unresolved questions first, then the previous owner stops investigating the transferred questions. Shared findings are collected once and handed to dependent workers.

## Handoff block

Use the existing `design`, `instructions` and `feedback` fields. No new schema, no persisted research ledger, no automatic source packing. Put one compact block in the task `instructions` for every task with settled research; use a complete brief for complex or worker-researched stages.

For a small settled change, a short inline handoff is the complete form — the decided fact, the evidence needed to implement it and the next step/check, in one or two sentences. It carries no field headings:

```text
Research handoff: subtotal ignores item.quantity; change that term to price * quantity and keep the rest (cart.mjs:1-3, SHA-256 <hash or unknown>). Then run node check.mjs.
```

Use the full template below only when the task genuinely needs those fields — several settled questions, coverage boundaries that matter, delegated evidence, or continuation across sessions. Do not require every template field or a separate research report for a tiny edit. Scale does not lower evidence quality: the decided fact still needs its source, and the allowed scoped reads below are unchanged.

```text
Research handoff
Stage and research owner: <current stage; Codex or worker; questions owned here; handoff condition>
Goal and acceptance: <observable result and what counts as done>
User constraints: <verbatim user constraints, or "none stated">
Settled: <question -> answer>, each with its evidence
Evidence: <path:symbol:range, necessary verbatim excerpt, content fingerprint or unknown>
Coverage: <answered questions and the symbols/call paths they cover; what is still uncovered>
Workspace and boundaries: <cwd, allowed changes, existing dirty work to preserve, peer ownership and exclusions>
Dependencies: <required accepted interfaces/results and available inputs>
Capability use: <proactively invoke relevant permitted skills and plugin/MCP tools available to this worker; name user-requested capabilities and purpose when known; apply guidance and report actual use or material unavailability>
Plan: <settled next steps, or investigation questions and feasible options to evaluate>
Open decisions and autonomy: <what the worker may decide; which material choices need Codex's answer before dependent implementation>
Validation: <fixed checks and relevant local development checks; required environment and known limitations>
Deliverables: <expected paths; findings/evidence, changed paths, commands/results and remaining blockers>
Delegated evidence: <questions, safe read/run boundaries, expected evidence/recommendation and material decision checkpoint, or none>
Read policy: <what may be reused as settled; which scoped reads are otherwise unnecessary>
Escalation: <ask_supervisor at a material ambiguity, conflict or blocker; continue safe independent work; then reuse this session>
```

Rules for filling it in — these apply to both the short form and the full template:

- Keep user-stated facts, researched decisions and inferences visibly separate. Never present an inference as a user requirement.
- A worker-owned brief leaves delegated findings open. It may specify acceptance and constraints without inventing a root cause or prescribing an unresearched design. Detail must remove ambiguity, not predetermine the investigation.
- Include proactive capability use even when Codex does not know the worker's exact skill/plugin inventory. Selection uses the worker's own exposed metadata and actual loaded names; native invocation restrictions still apply. Reuse settled research and loaded guidance. Report only actual use and important availability gaps; do not turn discovery into a full catalog audit or force irrelevant calls.
- Coverage means questions answered, not files touched. "Looked at `worker.ts`" is not a handoff.
- Evidence is what implementation needs: exact signatures, key branches, precise errors or command output. Copy the necessary excerpt; do not paste whole files. In the short form, an exact path and line range is enough when no excerpt is needed to implement.
- Record the path, symbol and line range, plus a capture time and a content fingerprint when the tree has uncommitted changes (HEAD alone does not identify the bytes). If no reliable fingerprint exists, write `unknown`. Never claim a verification that was not performed.
- Point at one artifact and its needed section for material too large to inline. A worker still spends input reading it, but does not repeat the search that produced it.
- Fingerprints are ordinary local file/command work; they do not require re-feeding a whole file to the model. The worker is not expected to re-verify everything each turn — only the material the current step depends on and that may have changed.

Illustrative shape (not real findings):

```text
Research handoff
User constraints: runtime statistics come from in-memory counters; daily history must be preserved.
Settled: the overview reads the daily ledger, not the live counters — located in the status handler totals selection.
Evidence: src/status/handler.ts:getStatusTotals:88-119, captured 2026-10-23, tree fingerprint <sha256 or unknown>; excerpt of the totals branch pasted below.
Coverage: handler and both totals sources examined; UI formatting not covered.
Plan: remap the status fields; run the existing targeted status tests.
Delegated evidence: which fixtures assert the daily-ledger totals — read only those fixture files and report the paths and assertions; updating those fixtures is ordinary implementation work inside the brief.
Read policy: reuse the locations and decision above; only read the branch or fixture you are about to modify.
Escalation: if the two totals turn out not to be independent, ask with the evidence before changing the model.
```

Worker-owned example (illustrative, not a finding):

```text
Stage and research owner: worker owns diagnosis of why imported jobs lose their target language.
Goal: preserve the chosen language through import and execution; Codex decides any storage/API migration.
User constraints: preserve existing jobs and current API clients.
Known: the user reproduced the failure on import; no root cause has been established. Do not assume a UI or storage defect.
Workspace and boundaries: <cwd>; investigate import/parser, job storage and their existing tests; protect <listed dirty paths>. No production data writes.
Questions: where is the language first lost, which callers depend on that shape, and which compatible fix is smallest?
Dependencies: current import format and existing client contract; no peer shares this investigation.
Plan: reproduce with a local fixture, trace only the affected flow, compare viable fixes and recommend one with sources.
Autonomy: choose fixtures and local diagnostic tools. If storage/API semantics must change, ask_supervisor with findings/options before implementing that change; otherwise apply a compatible local fix within this brief.
Validation: run the relevant import and execution regression tests; registered fixed checks are appended by the service.
Deliverables: failure evidence and path/symbol references, recommendation, changed paths, checks/results, unresolved limits.
Supervisor activity: Codex waits for this evidence; it does not investigate the same failure in parallel.
```

The block is guidance plus evidence, not an instruction to skip verification. A worker that finds a contradiction reports it through `ask_supervisor` instead of silently following stale material.

## Worker side

The worker system prompt follows the assigned owner. For Codex-settled work, reuse handoff facts and decisions, execute the stated next step first and avoid repeated research on answered questions or same-level replanning. For worker-owned research, investigate the named questions, return evidence and recommendations and ask at the material decision checkpoint; do not wait for Codex to do the assigned investigation. If ownership is missing and consequential, ask before starting broad research. A legacy task with clear instructions can still proceed normally. Legitimate scoped reads of settled material are:

- the handoff is missing a specific piece the step needs;
- the evidence is stale — the file changed since the recorded fingerprint or content;
- tests or a run disagree with the handoff conclusion;
- a native tool requires a pre-read before editing (behaviour varies by model and conditions; do not assume it is unnecessary);
- context was lost or compacted and the material is no longer available.

When an investigation reaches an unresolved material decision, the worker uses the existing `ask_supervisor` path with findings, sources, options and a recommendation, then continues in the same session. Routine findings and already authorized local choices need no round trip. Local implementation judgement — naming inside an agreed shape, test mechanics, fixture updates that follow the settled semantics, which existing helper to reuse — is the worker's; a change to the agreed architecture, interface, scope, compatibility or fixture semantics is Codex's.

The reason belongs in normal progress or the final report in one clause; it does not need a record per read. New evidence may overturn a settled conclusion — say so with the evidence and escalate material conflicts. Native tools, hooks, permissions and subagent usage are unchanged: this is a working policy, not a tool interceptor, and it cannot guarantee zero reads or any token saving.

## Continuations, compact and new context

The dispatch contract (goal, design, instructions, acceptance, artifacts) and the same-session `reply`/`resume` path stay as they are. What changes is what Codex adds on top, and every addition has to use a mechanism that already exists:

- Continuation feedback is delta only: new facts, changed material, answers to blockers and the concrete next step. Say that the existing task and design continue, and do not restate the whole brief or the whole research. `feedback` is not part of the sealed task contract, so this is the normal channel for an already dispatched task.
- Acceptance starts from actual changes, requirements and risk points. Investigate a specific missing link or contradiction when necessary. The service runs the fixed acceptance checks; avoid an extra manual copy immediately before or after review without changed code, a failure or another concrete reason. Worker debugging checks and the independent review rerun serve different purposes.
- A dispatched task's contract is immutable: `id`, title, `instructions`, `dependsOn`, `acceptance`, `artifacts` and `checks` cannot be rewritten after an attempt (`DISPATCHED_CONTRACT_IMMUTABLE`). Never try to fold new research back into that `instructions` block. Use instead: the run-level `design` through `plan(action="update")` / `append` (updated while the task contracts stay untouched and re-sent on every dispatch), the checkpoint that `makeCheckpoint` builds from `design` and the accepted results, a scoped continuation `feedback`, or a new/superseded task for the next undispatched stage.
- Before a deliberate `compact` or `new` context, write the still-necessary research conclusions, coverage boundary, sources and open questions into that run-level `design`, not into the sealed task text and not as a raw log dump. New context carries the supervisor checkpoint built from `design` plus accepted interfaces and remaining feedback. The controller does not extract any worker internal state, so nothing is preserved unless the supervisor wrote it there before switching.
- A same-session continuation is not proof that all earlier material is still in context. If a step depends on specific evidence after a compact or after a long gap, restate the needed excerpt in the continuation feedback.

## What this does not claim

No new MCP API, no cached knowledge base, no cross-model shared cognition, no guaranteed zero reads and no measured token or elapsed-time saving. Whether the contract re-send itself dominates cost is an open measurement question; a schema-level handoff package and per-session delivered/compact state would be a separate design. Model behaviour varies; the policy states the default and the allowed exceptions, and acceptance still rests on the work and the fixed checks.
