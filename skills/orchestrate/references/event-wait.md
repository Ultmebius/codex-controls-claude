# Wait for decisions with low supervisor overhead

After one meaningful dispatch, keep an event wait pending. Only questions, residual native permission decisions, failures, budget/context warnings and review candidates need Codex reasoning. Ordinary work stays with Claude. Never accompany an empty wait with status, logs, filesystem discovery, replanning or repeated commentary.

The server default and maximum are both 20 minutes (1200000ms, `CCC_WAIT_MS` may lower the default). One wait is one pending event promise: a completion, question, residual permission, failure, budget warning or cancellation wakes it at once; only an idle run reaches the timeout.

**Never pass `timeoutMs` unless an actual host tool-timeout failure already happened.** Omit it for `orchestrator_wait` and `orchestrator_team(action="wait")` so the 20-minute default applies. Mandatory omissions, none of which shorten the wait:

- progress updates or supervisor commentary while work is running;
- a suspected or speculated host limit that has not actually cut a call short;
- `functions.exec`'s `yield_time_ms`, which only returns control from the cell and leaves the pending Promise alive;
- the outer `functions.wait` bound, which resumes that same running exec.

Only after a wait was genuinely terminated by the host may the replacement call carry a shorter `timeoutMs`; record the exact error text and observed bound in the run evidence so the exception is auditable. A speculative shorter wait is a self-inflicted polling loop. The compatibility projection declares `tool_timeout_sec=1260`; portable Agent Plugins `mcp.json` cannot carry a timeout at all. A bounded code-mode chain renews empty responses automatically on the same connection, avoiding a model decision on each empty timeout.

## Codex code mode

The `functions.exec` isolate has no Node imports or filesystem. Use the existing exposed tool; keep the awaited Promise/running cell alive. This example bounds one chain to12empty responses and preserves the entire decisive reply:

```javascript
// @exec: {"yield_time_ms": 1000, "max_output_tokens": 4000}
let cursor = load("workerCursor");
for (let empty = 0; empty < 12; empty++) {
  const raw = await tools.mcp__claude_orchestrator__orchestrator_wait({
    runId: load("workerRunId"), afterSeq: cursor
  });
  const reply = JSON.parse(raw.content.find(c => c.type === "text").text);
  if (raw.isError) { text(reply); break; }
  cursor = reply.nextCursor;
  store("workerCursor", cursor);
  if (reply.events.length || reply.status !== "open" || !reply.timedOut || empty === 11) {
    store("workerDecisionReply", reply);
    text(reply); break;
  }
}
```

Resume a yielded cell with `functions.wait`; it only resumes that same running exec and never reissues the underlying event wait, so it cannot shorten the orchestrator wait. Do not start another competing waiter at an older cursor or abandon its pending Promise. The stored decisive reply preserves full payloads even if tool presentation is shortened; expand necessary evidence from that value or the durable ledger before deciding. An empty finite-chain return means renew the chain, not investigate activity. Host/user cancellation keeps existing worker-stop semantics; no continuation or tool replay is automatic. Team orchestration uses the same approach with team action=wait and a composite cursor, not three worker queries. Clients without code mode may renew the original wait directly.

## Existing SDK clients

The packaged `scripts/event-wait.mjs` exports `waitForDecision`. Import it only in a normal Node client, using that client's already-owned MCP connection:

```javascript
const outcome = await waitForDecision({
  runId, afterSeq, signal,
  wait: async (args, options) => {
    const raw = await client.callTool(
      {name: "orchestrator_wait", arguments: args}, undefined,
      // MCP SDK callTool defaults to a 60s transport timeout: raise it above the
      // 20-minute orchestrator wait. The event argument timeoutMs stays omitted.
      {signal: options.signal, timeout: 1260000}
    );
    const reply = JSON.parse(raw.content.find(c => c.type === "text").text);
    return raw.isError ? {error: reply.error ?? "MCP_ERROR", original: reply} : reply;
  }
});
```

The `timeout` above is the client's transport bound, not the event wait: `arguments` deliberately carries no `timeoutMs`, so the server applies its 20-minute default. The MCP SDK's `callTool` request options default to 60000ms, so a client that leaves it alone silently kills a healthy wait at 60 seconds — always raise it above 1200s here. Shorten either value only after an actual observed host tool-timeout failure, and record that exact error and bound.

The helper preserves the reply and evidence references and returns actionable/terminal/error/cancelled/empty_limit. `maxEmptyWaits` bounds empty replies, defaults12 and allows1..100. It validates nondecreasing cursors and refuses malformed/non-timeout empty replies. It never connects, starts processes, reads status/logs, dispatches, reviews or changes budgets. Abort prevents future renewals and is passed to the callback; an implementation that ignores AbortSignal cannot be forcibly interrupted by this helper. A reply received during cancellation is retained, with the previous validated cursor. Metrics are requests, empty responses and elapsed time, not token savings.

## Tool selection and parallelism

Claude chooses its enabled native/MCP tools by task need. Literal-file fixtures can legitimately use built-ins; previous live communication tests called `codex_supervisor` notify/ask tools. Connected/pending/failed snapshots do not prove actual tool invocation. Preserve native switches and configuration; never force Codex-specific server names into a worker task.

Three active executions are shared across all connected chats, ordinary runs and team children; retained idle transcripts consume no slot and a fourth execution is rejected cleanly until an owned one finishes. Team task graphs are fixed. Choose a team upfront when planned independent tasks need parallelism. More workers do not inherently reduce total tokens.
