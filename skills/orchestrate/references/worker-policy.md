# Worker and call-layer policy

This inventory reflects the user's final instruction: start native Claude Code, assign work, inject communication MCP, and leave ordinary execution to Claude. Blocking native subagents was explicitly retained.

## Native behavior

| Area | Current behavior |
| --- | --- |
| Hooks | No plugin hook callbacks and no settings override. User/project/local hooks, including disable/enable choices, are untouched. |
| Ordinary tools | Claude Code built-in preset plus its own enabled MCP configuration. No copied Codex MCP configuration or ordinary tool allowlist. |
| Subagents | Only Agent, Task, TeamCreate and TeamDelete are blocked, as requested. The plugin manages up to three top-level worker sessions; it is not an OS sandbox against arbitrary shell processes. |
| Permission mode | Reads configured permissions.defaultMode by scope and passes it to the pinned SDK. Actual init metadata is authoritative. Auto uses native classification; bypass avoids ordinary approval requests. Native explicit ask/deny rules still apply. A temporary mode switch in another interactive window is not a configuration change for this session. |
| Tool input | Passed through unchanged. Native-mode calls skip the inherited bridge's Windows path normalization, POSIX path veto and secondary allowlist checks. Native residual approval responses preserve the original input. |
| File access | No plugin file interception or PreToolUse scope gate. writeScope is a scheduling/audit reservation. Native permissions govern access. Out-of-reservation changes are observations to review, not silently assumed to belong to a peer. |
| Worker validation | Allowed normally. Codex still independently verifies actual artifacts and original fixed checks. A specific task can request a read-only investigation or omit tests when that is the assigned work. |
| Model | User-requested ANTHROPIC_MODEL precedence and existing authentication/gateway environment. No forced model family or fallbackModel option. Warm queries keep their startup model until close/resume/new. |
| Settings | user, project and local sources load natively; no rewritten .claude.json/settings files. No injected settings object. |
| Communication | One query-local codex_supervisor MCP with milestone receipt and scoped question/reply tools. Native existing servers keep their settings/switches. |
| Retry | Streaming worker input does not use the upstream bridge's transient-query replay branch. Native Claude/provider retries remain native. Recovery never silently reruns a task. |

## Controls retained in orchestration

These govern dispatch, evidence and owned process lifetime, not individual native tool permission.

| Control | Default / behavior |
| --- | --- |
| Managed concurrency | Up to3 sessions; dependencies and conflicting declared reservations gate dispatch. |
| Segment/run turns | 40 native agentic rounds per segment;200 persistent SDK-reported turns per run/team. Explicit create overrides and same-task continuation remain supported; provisional charges are disclosed separately. |
| Model execution time | Segment/run2h; no silent reset on resume/rework/append. Acceptance/reconciliation may finish after model budget expires. |
| Acceptance | Immutable dispatched contract/checks, fresh artifact/revision hash, independent Codex evidence, fixed-check rerun and dependency acceptance. Additional artifacts inside the task workspace need explicit acknowledgement. This evidence boundary does not prevent Claude from accessing files elsewhere. |
| Rework | Two acceptance repairs by default; budget continuation is separately counted. |
| Context maintenance | Soft suggestion near300K and maintenance before400K, reduced for smaller reported windows. Unknown context remains unknown. |
| Native startup handshake | Default120s; CCC_INIT_TIMEOUT_MS configures1s..10min. |
| Fixed acceptance checks | Default5min overall per review; CCC_CHECK_TIMEOUT_MS configures1s..10min. |
| Residual native decisions / supervisor questions | Default5min; CCC_DECISION_TIMEOUT_MS configures1s..30min. Expired content remains available and requires fresh evaluation on explicit continuation. |
| Event wait transport | Codex package5min default under660s host timeout; portable package45s. No worker status/log polling; ordinary milestones are audited without waking Codex. |
| Communication resource bounds |16K characters/message,128 message IDs/attempt,16 pending questions. Explicit errors on limits; no silent loss of decision evidence. |
| Idle review lifecycle | Useful session retained for user review, suspended after30min idle with transcript preserved. Explicit close/cancel affects owned processes only. |
| Connection ownership | Unique owner/generation, atomic explicit attach, no live-owner takeover. Idle execution leases are released. |
| Terminal display | Styled C# activity view of the real SDK worker. A bounded rendering queue and compact task excerpt affect display only; SDK protocol is forwarded independently. CCC_TERMINAL_COLOR=never selects plain output. |

Subagent blocking is the sole extra native tool block. No plugin claim of filesystem isolation or measured billed-token savings follows from these controls.
