# Changelog

## 0.11.1 — 2026-10-29

- Pending worker questions now send reminders while the active turn remains open; residual permission requests retain their timeout.
- Worker system guidance and every task dispatch now explicitly request proactive use of relevant permitted skills and plugin/MCP capabilities available in the worker's own session, with actual invocation, applied guidance and concise usage reporting.
- Task briefs name requested capabilities when known and retain a generic instruction otherwise. Selection respects native invocation restrictions, uses targeted discovery and reuses settled research; no catalog scan, plugin loading option or permission change was added.
- Clarified that supervisor native-tool/MCP snapshots are partial observations and do not establish a complete inventory or actual use of Claude skills/plugins.

## 0.11.0 — 2026-10-29

- Select one research owner per stage. Codex can hand off settled evidence for implementation or wait for a worker-owned investigation and recommendation before deciding; follow-up work reuses that conversation.
- Expanded complex task briefs with explicit questions, evidence coverage, write boundaries, existing changes, autonomy, dependencies, validation and return requirements. Independent parallel work needs distinct questions and outputs.
- Dispatch now includes the registered fixed checks as command/args JSON. Acceptance starts from actual changes and risks, with fixed checks owned by review and extra repeated full runs justified by new evidence.
- Preserved native tools/settings, event waits, contract immutability and full-contract re-send behavior. Prompt/transport tests do not establish measured model or billing savings.

## 0.10.10 — 2026-10-23

- Added opt-in public progress evidence with timestamps and recent tool names, excluding hidden thinking, prompts and tool arguments.
- Supervision checks current progress and message delivery before discretionary intervention, lets agreed deliverables finish, and redirects scope through the retained conversation.
- Cancelling undelivered guidance emits an actionable event with the actual delivery state and reason.
- Terminal headers identify resumed and continued segments. Segment tool/time counters are distinct from available session totals; historical time/tool totals unavailable after cold resume remain unknown.

## 0.10.9 — 2026-10-23

- Each explicit follow-on dispatch in a retained conversation, including continuation and rework, adds 500 cumulative turns and grants at least 500 native rounds.
- Delivered queue/interrupt inputs receive the same extension. Duplicate request IDs add no credit; accumulated usage and peer reservations remain intact. An exhausted budget also funds the SDK's one boundary reserve.
- Queued work can continue after a native turn-limit boundary by resuming the same conversation. Existing deadlines, ownership and acceptance checks still apply.
- Documented that supervisors must include the concrete review items in rework feedback.

## 0.10.8 — 2026-10-23

- Codex leads design research and material architecture, interface, scope and compatibility decisions; worker autonomy covers bounded implementation judgement.
- A delegated evidence stage is one precise unresolved fact: the same worker reports the finding with its source, asks through the existing `ask_supervisor` path when the choice stays open, then continues in the same session.
- Kept the three dispatch shapes explicit (settled design, one precise unknown, independent modules), short handoffs for small changes and preferred same-session reuse while context is relevant.
- Worker append consolidates the design-authority wording instead of adding to it; no change to controller, protocol, native hooks, tools, permissions or settings.

## 0.10.7 — 2026-10-23

- Added a research handoff policy: one research owner per material question, a compact evidenced handoff in the existing task instructions, and worker reuse of settled research instead of repeated repository discovery or same-level replanning.
- Added `skills/orchestrate/references/research-handoff.md` with the handoff block, coverage and fingerprint guidance, permitted local gap reads and continuation/compaction rules.
- Worker system prompt now states the reuse default and the allowed scoped re-reads, without intercepting native tools or changing permissions, hooks or settings inheritance.
- Continuation feedback is delta-only; compact/new contexts require the supervisor to fold still-necessary research into the controlled design summary.

## 0.10.6 — 2026-10-22

- Clarified native shell configuration and streamlined setup requirements and maintenance instructions.

## 0.10.4 — 2026-10-22

- Replaced the terminal mark with a centred circular pixel ring in the existing 144×96 canvas and 24×16 logical grid.
- Added a clockwise Codex-blue-to-Claude-red gradient loop and matching fallback colours.
- Updated the native dashboard demonstration and README terminal capture to use English throughout.
- Consolidated development setup, build and runtime-export instructions in the testing guide.

## 0.10.3 — 2026-10-22

- Added a first-task walkthrough, public-logo dashboard demonstration and linked usage, dashboard and testing guides.
- Corrected notification wakeups, task replacement and budget/time-renewal descriptions.
- Published the maintained shared-engine source, regression tests, pinned development toolchain and package contracts.
- Added native deterministic checks, artifact drift checks and an explicit runtime export covering Windows and Ubuntu.

## 0.10.2 — 2026-10-22

- Regenerated the compiled terminal animation from the packaged public logo.
- Preserved compatibility metadata during builds and corrected logo-path validation.

## 0.10.1

- Prepared the standalone Codex marketplace package and public repository documentation.
- Added visible acknowledgement of delivered supervisor answers and guidance.

Upstream attribution and the full commit reference are recorded in [LICENSE](LICENSE).
