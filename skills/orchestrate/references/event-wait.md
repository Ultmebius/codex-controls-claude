# Wait for decisions with low supervisor overhead

After one meaningful dispatch, keep an event wait pending. Only questions, residual native permission decisions, failures, budget/context warnings and review candidates need Codex reasoning. Ordinary work stays with Claude. Never accompany an empty wait with status, logs, filesystem discovery, replanning or repeated commentary.

The server default and maximum are both 20 minutes (1200000ms, `CCC_WAIT_MS` may lower the default). One wait is one pending event promise: a completion, question, residual permission, failure, budget warning or cancellation wakes it at once; only an idle run reaches the timeout. A full 20-minute call also needs the host's MCP tool timeout to be configured above 1200s — the compatibility projection declares `tool_timeout_sec=1260`. Portable Agent Plugins `mcp.json` cannot carry a timeout. If the current host reports a shorter bound (45s and 300s limits were observed), pass that shorter `timeoutMs` instead of assuming the default fits; a shorter wait is an honest host limitation, not a reason to poll. A bounded code-mode chain can renew empty responses automatically on the same connection, avoiding a model decision on each empty timeout.

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

Resume a yielded cell with `functions.wait`; do not start another competing waiter at an older cursor or abandon its pending Promise. The stored decisive reply preserves full payloads even if tool presentation is shortened; expand necessary evidence from that value or the durable ledger before deciding. An empty finite-chain return means renew the chain, not investigate activity. Host/user cancellation keeps existing worker-stop semantics; no continuation or tool replay is automatic. Team orchestration uses the same approach with team action=wait and a composite cursor, not three worker queries. Clients without code mode may renew the original wait directly.

## Existing SDK clients

The packaged `scripts/event-wait.mjs` exports `waitForDecision`. Import it only in a normal Node client, using that client's already-owned MCP connection:

```javascript
const outcome = await waitForDecision({
  runId, afterSeq, signal,
  wait: async (args, options) => {
    const raw = await client.callTool(
      {name: "orchestrator_wait", arguments: args}, undefined,
      {signal: options.signal, timeout: 60000}
    );
    const reply = JSON.parse(raw.content.find(c => c.type === "text").text);
    return raw.isError ? {error: reply.error ?? "MCP_ERROR", original: reply} : reply;
  }
});
```

The helper preserves the reply and evidence references and returns actionable/terminal/error/cancelled/empty_limit. `maxEmptyWaits` bounds empty replies, defaults12 and allows1..100. It validates nondecreasing cursors and refuses malformed/non-timeout empty replies. It never connects, starts processes, reads status/logs, dispatches, reviews or changes budgets. Abort prevents future renewals and is passed to the callback; an implementation that ignores AbortSignal cannot be forcibly interrupted by this helper. A reply received during cancellation is retained, with the previous validated cursor. Metrics are requests, empty responses and elapsed time, not token savings.

## Tool selection and parallelism

Claude chooses its enabled native/MCP tools by task need. Literal-file fixtures can legitimately use built-ins; previous live communication tests called `codex_supervisor` notify/ask tools. Connected/pending/failed snapshots do not prove actual tool invocation. Preserve native switches and configuration; never force Codex-specific server names into a worker task.

Three active executions are shared across all connected chats, ordinary runs and team children; retained idle transcripts consume no slot and a fourth execution is rejected cleanly until an owned one finishes. Team task graphs are fixed. Choose a team upfront when planned independent tasks need parallelism. More workers do not inherently reduce total tokens.
