import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator, type Run, type TaskSpec } from "../src/orchestrator/controller.js";
import type { Worker, WorkerEvent } from "../src/orchestrator/worker.js";
import type { AgentResult, SessionEvent } from "../src/types.js";

/**
 * A worker double that keeps the native conversation alive: results are emitted on demand so a
 * test can place guidance, interrupts and boundaries in a precise order.
 */
class GuidanceWorker implements Worker {
  listener?: (event: WorkerEvent) => void;
  inputs: string[] = [];
  interrupts = 0;
  live = false;
  failGuidance = false;
  failInterrupt = false;
  final?: AgentResult;
  count = 0;
  subscribe(fn: (event: WorkerEvent) => void) {
    this.listener = fn;
    return () => {
      this.listener = undefined;
    };
  }
  async start(_cwd: string, prompt: string) {
    this.live = true;
    this.inputs.push(prompt);
    return "session";
  }
  async reply(_session: string, prompt: string) {
    this.inputs.push(prompt);
    return "session";
  }
  guidance(_session: string, text: string) {
    if (this.failGuidance || !this.live) return false;
    this.inputs.push(text);
    return true;
  }
  interruptTurn(_session: string) {
    if (this.failInterrupt) throw new Error("interrupt transport failed");
    this.interrupts++;
    return true;
  }
  replay() {
    return [];
  }
  result() {
    return this.final;
  }
  permissions() {
    return [];
  }
  respond() {
    return true;
  }
  model() {
    return "configured-model";
  }
  isLive() {
    return this.live;
  }
  stop() {
    this.live = false;
  }
  destroy() {
    this.live = false;
  }
  finish(result: Partial<AgentResult> = {}, sessionId = "session") {
    this.final = {
      sessionId,
      result: "done",
      isError: false,
      durationMs: 1,
      numTurns: 2,
      totalCostUsd: 0,
      ...result,
    };
    const event: SessionEvent = {
      id: this.count++,
      type: this.final.isError ? "error" : "result",
      data: this.final,
      timestamp: new Date().toISOString(),
      pinned: false,
    };
    this.listener?.({ sessionId, event });
  }
}

const dispose: (() => void)[] = [];
afterEach(() => {
  for (const fn of dispose.splice(0).reverse()) fn();
});

function fixture(config: { maxTurns?: number; maxTotalTurns?: number } = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ccc-guidance-"));
  dispose.push(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(path.join(cwd, "answer.txt"), "42");
  const worker = new GuidanceWorker();
  const controller = new Orchestrator(path.join(cwd, "ledger"), worker);
  dispose.push(() => controller.close());
  const spec: TaskSpec = {
    id: "a",
    title: "same contract",
    instructions: "write answer.txt",
    acceptance: "42",
    artifacts: ["answer.txt"],
    dependsOn: [],
    checks: [
      {
        command: process.execPath,
        args: ["-e", "if(require('fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1)"],
      },
    ],
  };
  const run = controller.plan({
    action: "create",
    cwd,
    goal: "goal",
    design: "design",
    tasks: [spec],
    ...config,
  });
  const send = (requestId: string, text: string, mode: "queue" | "interrupt" = "queue") =>
    controller.sendGuidance(run.id, { requestId, mode, text });
  return { cwd, worker, controller, run, spec, send };
}

describe("queued scoped guidance", () => {
  it("retains accepted idempotency keys at the explicit run message bound", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    const original = f.send("q0", "message 0");
    f.worker.finish();
    for (let i = 1; i < 32; i++) {
      f.send(`q${i}`, `message ${i}`);
      f.worker.finish();
    }
    expect(f.send("q0", "message 0").guidanceId).toBe(original.guidanceId);
    expect(() => f.send("overflow", "new message")).toThrow("GUIDANCE_MESSAGE_LIMIT");
    expect(f.run.guidance).toHaveLength(32);
  });
  it("rejects reusing a queue requestId for a different delivery mode", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.send("same-id", "same text", "queue");
    expect(() => f.send("same-id", "same text", "interrupt")).toThrow("REQUEST_ID_CONFLICT");
  });
  it("waits for the native result boundary and sends one input per boundary in FIFO order", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    const first = f.send("q1", "Prefer the streaming API");
    expect(first).toMatchObject({ state: "queued", delivered: false, pendingGuidance: 1 });
    const second = f.send("q2", "Also cover cancellation");
    expect(second).toMatchObject({ state: "queued", delivered: false, pendingGuidance: 2 });
    // Nothing crossed the native queue while the original turn was active.
    expect(f.worker.inputs).toHaveLength(1);

    f.worker.finish();
    // Exactly one message is delivered per boundary so the SDK cannot coalesce them.
    expect(f.worker.inputs.slice(1)).toEqual(["Prefer the streaming API"]);
    expect(f.run.tasks[0].state).toBe("running");
    const records = f.run.guidance!;
    expect(records.map((r) => r.state)).toEqual(["delivered", "queued"]);

    f.worker.finish();
    expect(f.worker.inputs.slice(1)).toEqual([
      "Prefer the streaming API",
      "Also cover cancellation",
    ]);
    expect(f.run.guidance!.map((r) => r.state)).toEqual(["delivered", "delivered"]);

    f.worker.finish();
    // With nothing queued the third boundary is a real task result.
    expect(f.run.tasks[0].state).toBe("awaiting_review");
    expect(f.worker.inputs).toHaveLength(3);
  });

  it("arms a separate settled segment for every delivered boundary", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.send("q1", "One");
    f.send("q2", "Two");
    f.worker.finish();
    f.worker.finish();
    f.worker.finish();
    const executions = f.run.executions!;
    // Initial dispatch plus one reservation per delivered guidance, each settled exactly once.
    expect(executions).toHaveLength(3);
    expect(executions.every((e) => e.status === "confirmed")).toBe(true);
    expect(executions.every((e) => e.reservedTurns === 0)).toBe(true);
    expect(f.run.turnBudget.reserved).toBe(0);
    expect(f.run.turnBudget.used).toBe(6);
    expect(f.run.activeExecutionId).toBeUndefined();
  });

  it("deduplicates a repeated requestId and rejects conflicting reuse", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    const receipt = f.send("same", "stay scoped");
    const repeat = f.send("same", "stay scoped");
    expect(repeat).toMatchObject({ guidanceId: receipt.guidanceId, deduplicated: true });
    expect(() => f.send("same", "different text")).toThrow("REQUEST_ID_CONFLICT");
    expect(f.run.guidance).toHaveLength(1);
  });

  it("rejects guidance for an idle, foreign, stale or missing target", async () => {
    const f = fixture();
    expect(() => f.send("early", "nothing running")).toThrow("NO_ACTIVE_EXECUTION");
    await f.controller.dispatch(f.run.id, "a", "first");
    expect(() =>
      f.controller.sendGuidance(f.run.id, {
        requestId: "wrong-task",
        mode: "queue",
        text: "x",
        taskId: "other",
      })
    ).toThrow("GUIDANCE_TASK_NOT_ACTIVE");
    expect(() =>
      f.controller.sendGuidance(f.run.id, {
        requestId: "stale",
        mode: "queue",
        text: "x",
        taskRevision: 99,
      })
    ).toThrow("STALE_CONTRACT");
    expect(() =>
      f.controller.sendGuidance(f.run.id, {
        requestId: "foreign",
        mode: "queue",
        text: "x",
        sessionId: "another-session",
      })
    ).toThrow("GUIDANCE_SESSION_MISMATCH");
    // A foreign owner cannot write guidance into this run.
    const foreign = new Orchestrator(path.join(f.cwd, "ledger"), new GuidanceWorker());
    dispose.push(() => foreign.close());
    const stolen: Run = JSON.parse(
      f.controller.status(f.run.id) && JSON.stringify(f.controller.status(f.run.id))
    ) as Run;
    stolen.ownerPid = process.pid + 1;
    expect(() =>
      foreign.sendGuidance(stolen.id, { requestId: "x", mode: "queue", text: "y" })
    ).toThrow(/RUN_NOT_FOUND|RUN_OWNED_BY_ANOTHER_CONNECTION/);
    expect(f.worker.inputs).toHaveLength(1);
  });

  it("bounds the pending queue and the guidance text", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    for (let i = 0; i < 8; i++) f.send(`q${i}`, `message ${i}`);
    expect(() => f.send("overflow", "one too many")).toThrow("GUIDANCE_QUEUE_FULL");
    expect(() =>
      f.controller.sendGuidance(f.run.id, {
        requestId: "huge",
        mode: "queue",
        text: "x".repeat(4001),
      })
    ).toThrow("GUIDANCE_TEXT_TOO_LONG");
  });
});

describe("interrupting guidance", () => {
  it("requests a native interruption, then delivers in the same conversation ahead of queued work", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.send("queued", "Background note", "queue");
    const interrupt = f.send("redirect", "Stop and use the SDK path", "interrupt");
    expect(interrupt.state).toBe("interruption_requested");
    expect(interrupt.delivered).toBe(false);
    expect(f.worker.interrupts).toBe(1);
    // The interruption alone must not push input while the old turn is still running.
    expect(f.worker.inputs).toHaveLength(1);

    f.worker.finish();
    // The interrupting message wins the boundary; the queued message stays pending.
    expect(f.worker.inputs.slice(1)).toEqual(["Stop and use the SDK path"]);
    const states = Object.fromEntries(f.run.guidance!.map((r) => [r.requestId, r.state]));
    expect(states).toEqual({ queued: "queued", redirect: "delivered" });
    expect(f.run.tasks[0].state).toBe("running");

    f.worker.finish();
    expect(f.worker.inputs.slice(1)).toEqual(["Stop and use the SDK path", "Background note"]);
  });

  it("fails without delivering when the native interrupt request fails", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.worker.failInterrupt = true;
    const receipt = f.send("redirect", "change course", "interrupt");
    expect(receipt.state).toBe("failed");
    expect(receipt.reason).toBe("interrupt_failed");
    f.worker.finish();
    expect(f.worker.inputs).toHaveLength(1);
    expect(f.run.tasks[0].state).toBe("awaiting_review");
  });

  it("keeps a pending native question answerable until the interrupting turn drains", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    const asking = f.send("question", "waiting", "queue");
    expect(asking.state).toBe("queued");
    f.send("redirect", "new direction", "interrupt");
    // The queued question remains claimable until the boundary actually moves.
    expect(f.run.guidance!.find((r) => r.requestId === "question")!.state).toBe("queued");
    f.worker.finish();
    expect(f.run.tasks[0].state).toBe("running");
  });

  it("reports failure instead of delivering when the interrupt boundary never arrives", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    const receipt = f.send("redirect", "change course", "interrupt");
    expect(receipt.state).toBe("interruption_requested");
    // Simulate the native turn ending without a result for this segment.
    f.worker.live = false;
    f.worker.finish({}, "session");
    expect(f.worker.inputs).toHaveLength(1);
  });
});

describe("failure, cancellation and budget races", () => {
  it("fails a queued message when its transport refuses the input and charges the hold", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.worker.failGuidance = true;
    f.send("q1", "never arrives");
    f.worker.finish();
    const record = f.run.guidance![0];
    expect(record).toMatchObject({ state: "failed", reason: "transport_failed" });
    // A lost input is charged conservatively so allowance can never be freed by the failure.
    expect(f.run.turnBudget.reserved).toBe(0);
    expect(f.run.turnBudget.used).toBeGreaterThan(2);
    expect(f.run.executions!.at(-1)).toMatchObject({
      status: "confirmed",
      reason: "guidance_transport_failed",
      reservedTurns: 0,
    });
    expect(f.run.activeExecutionId).toBeUndefined();
  });

  it("fails queued guidance when the run cannot afford the follow-on segment", async () => {
    const f = fixture({ maxTurns: 3, maxTotalTurns: 5 });
    await f.controller.dispatch(f.run.id, "a", "first");
    f.send("q1", "too expensive");
    f.worker.finish({ numTurns: 5 });
    expect(f.run.guidance![0]).toMatchObject({
      state: "failed",
      reason: "turn_budget_exhausted",
    });
    expect(f.worker.inputs).toHaveLength(1);
  });

  it("cancels pending guidance on cancellation and never delivers it afterwards", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.send("q1", "obsolete");
    f.controller.cancel(f.run.id, "user stopped");
    expect(f.run.guidance![0]).toMatchObject({ state: "cancelled", reason: "cancelled" });
    // A late native result cannot resurrect the message.
    f.worker.finish();
    expect(f.worker.inputs).toHaveLength(1);
  });

  it("cancels pending guidance when an explicit interruption drains the segment", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.send("q1", "obsolete");
    f.controller.interrupt(f.run.id, "stop now");
    expect(f.run.guidance![0]).toMatchObject({ state: "cancelled" });
    expect(f.run.tasks[0].state).toBe("interrupted");
  });

  it("cancels guidance queued for a previous segment on a new dispatch", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.send("q1", "from the first attempt");
    f.controller.interrupt(f.run.id, "restart");
    expect(f.run.guidance![0].state).toBe("cancelled");
    await f.controller.dispatch(f.run.id, "a", "second", undefined, { mode: "continue" });
    expect(f.worker.inputs.at(-1)).toContain("contract revision");
  });

  it("does not deliver queued guidance past a failed native boundary", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.send("q1", "should not follow a failure");
    f.worker.finish({ isError: true, errorSubtype: "error_during_execution", result: "boom" });
    expect(f.run.guidance![0]).toMatchObject({ state: "cancelled" });
    expect(f.worker.inputs).toHaveLength(1);
    expect(f.run.tasks[0].state).toBe("failed");
  });

  it("ignores a native result from an older generation and keeps guidance pending", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.send("q1", "still waiting");
    // An out-of-order terminal event for a stale execution must not move the boundary.
    f.worker.listener?.({
      sessionId: "session",
      event: {
        id: 999,
        type: "result",
        data: { sessionId: "session", numTurns: 1 } as AgentResult,
        timestamp: new Date().toISOString(),
        pinned: false,
      },
      epoch: 99,
    });
    expect(f.run.guidance![0].state).toBe("queued");
    f.worker.finish();
    expect(f.run.guidance![0].state).toBe("delivered");
  });
});

describe("existing question replies stay compatible", () => {
  it("keeps reply semantics separate from guidance fields", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    expect(() => f.controller.respondMessage(f.run.id, "unknown", "answer")).toThrow(
      "MESSAGE_NOT_PENDING_OR_STALE"
    );
    const receipt = f.send("q1", "guidance");
    expect(receipt).not.toHaveProperty("messageId");
    expect(receipt).toMatchObject({ runId: f.run.id, requestId: "q1" });
  });
});

describe("restart and persistence", () => {
  it("never replays guidance across a restart and keeps the audit reason", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.send("q1", "not replayed");
    // A fresh process reads the same ledger while the first is still live; the persisted record
    // is cancelled at load time and never replayed.
    const reloaded = new Orchestrator(path.join(f.cwd, "ledger"), new GuidanceWorker());
    dispose.push(() => reloaded.close());
    const run = reloaded.status(f.run.id) as Run;
    expect(run.guidance![0]).toMatchObject({
      state: "cancelled",
      reason: "not_replayed_after_restart",
    });
    // Loading is passive: the other process's live execution is not adopted or steered.
    expect(run.guidance).toHaveLength(1);
  });
});
