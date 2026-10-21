# Session policy

The persistent SDK input stream reuses the live Claude Code process and conversation. On Windows the actual worker runs in a dedicated minimized Windows Terminal. Restore its taskbar window to inspect activity; minimization occurs only at startup. Idle retention submits no model turn.

- Technical acceptance and finish deliver a candidate awaiting user review. Keep useful context available.
- Same-run refinements use append while time/turn allowance remains. These operations never reset either budget.
- Human approval permits approve, which completes the run and closes the worker.
- Close idle sessions when no useful immediate follow-up is expected. Review-idle sessions suspend after30min, preserving the SDK session ID.
- Resume restores the saved conversation on the next explicit task, within original execution limits. A changed native cap or relevant MCP config reload also resumes that conversation.
- An open run past its execution window stays quiescent until the user explicitly authorizes continuation. `plan(action="session",sessionAction="resume",evidence=...,runTimeoutMs?)` then renews only the model-execution deadline (default2h, bounded1s..2h, forward only) and records the old deadline, new deadline and evidence in the durable audit. The native session ID, task state/revision, contracts, checks, receipts and the persistent turn budget are unchanged; the next dispatch cold-resumes the same conversation with the configured model. Resume without evidence, reopen, append, compact, new context, attach or a failed worker never move the deadline. Busy execution, startup draining, an active review, a foreign owner and completed/cancelled runs block renewal (completed/cancelled still need `reopen`). Teams renew through `orchestrator_team(action="resume",teamId,evidence,runTimeoutMs?)`, which moves the shared window and every existing child only while all are idle; a child cannot renew past an expired parent through an ordinary resume.
- Supervisor interrupt stops a current segment with a checkpoint and preserves its contract. Explicit cancel honors user stop; host connection/wait interruption preserves recoverable ledger state without replay.

Execution segment/run deadlines default2h. The supervisor may stop earlier when work is complete or needs intervention. The persistent1000 SDK-reported-turn allowance does not reset on continuation, append, reopen, supersede, resume, compact or new context. Unknown accounting is conservatively charged and marked estimated. Verification/reconcile may finish after model-execution time expires; it does not grant further model work.

Near300K latest reported input-context tokens consider compact/new. At400K maintenance is required before dispatch, with lower75%/90% limits when a smaller window is reported. Model aliases are preserved. Usage/window metadata is reported evidence, not an independently measured provider capacity; missing metadata remains unknown.

Compaction completes only after its maintenance terminal result. A compact boundary alone never unlocks implementation. New context carries the supervisor checkpoint of design, accepted interfaces, paths, review findings and remaining feedback. Task checkpoints compare declared artifacts, not an entire workspace diff. Inspect actual files/diffs and fixed checks independently.

Normal summaries expose truncation and evidence references. Use status sections for necessary result/check/error/artifact/checkpoint/capability details. Full evidence remains available; short output never replaces acceptance.
