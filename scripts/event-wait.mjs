/** Renew bounded empty waits on an existing connection; never dispatch or inspect state. */
export async function waitForDecision({wait, runId, afterSeq, maxEmptyWaits = 12, signal}) {
  if (typeof wait !== 'function' || typeof runId !== 'string' || !runId.trim()) throw new TypeError('wait and runId are required');
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new RangeError('Invalid cursor');
  if (!Number.isSafeInteger(maxEmptyWaits) || maxEmptyWaits < 1 || maxEmptyWaits > 100) throw new RangeError('maxEmptyWaits must be 1..100');
  const started = performance.now();
  let cursor = afterSeq, waits = 0, emptyWaits = 0, reply = null;
  const result = outcome => ({outcome, reply, nextCursor: cursor, waits, emptyWaits, elapsedMs: performance.now() - started});
  for (;;) {
    if (signal?.aborted) return result('cancelled');
    waits++;
    try { reply = await wait({runId, afterSeq: cursor}, {signal}); }
    catch (error) { if (signal?.aborted) return result('cancelled'); throw error; }
    if (signal?.aborted) return result('cancelled');
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new TypeError('Malformed wait reply');
    if (reply.error) return result('error');
    if (!Number.isSafeInteger(reply.nextCursor) || reply.nextCursor < cursor) throw new RangeError('Missing or backward cursor');
    if (!Array.isArray(reply.events) || typeof reply.status !== 'string') throw new TypeError('Missing wait events/status');
    cursor = reply.nextCursor;
    if (reply.events.length) return result('actionable');
    if (reply.status !== 'open') return result('terminal');
    if (reply.timedOut !== true) throw new TypeError('Empty open reply was not a timed-out wait');
    emptyWaits++;
    if (emptyWaits >= maxEmptyWaits) return result('empty_limit');
  }
}
