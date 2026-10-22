import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator, type TaskSpec } from "../src/orchestrator/controller.js";
import { TeamCoordinator } from "../src/orchestrator/team.js";
import { defaultWaitMs } from "../src/orchestrator/runtime.js";
import { MAX_WAIT_MS, WORKER_SLOT_LIMIT } from "../src/orchestrator/worker-slots.js";
import type { Worker, WorkerEvent } from "../src/orchestrator/worker.js";
import type { AgentResult } from "../src/types.js";

class WaitWorker implements Worker {
  listener?: (event: WorkerEvent) => void;
  messageListener?: (event: {
    sessionId: string;
    message: import("../src/orchestrator/messaging.js").SupervisorMessage;
  }) => void;
  final?: AgentResult;
  serial = 0;
  epoch = 0;
  subscribe(listener: (event: WorkerEvent) => void) {
    this.listener = listener;
    return () => {};
  }
  subscribeMessages(listener: NonNullable<WaitWorker["messageListener"]>) {
    this.messageListener = listener;
    return () => {};
  }
  async start() {
    this.epoch++;
    return "session";
  }
  async reply() {
    return this.start();
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
    return false;
  }
  model() {
    return "configured-model";
  }
  isLive() {
    return true;
  }
  eventEpoch() {
    return this.epoch;
  }
  stop() {}
  destroy() {}
  event(type: "result" | "error" | "permission_request", data: unknown) {
    this.listener?.({
      sessionId: "session",
      epoch: this.epoch,
      event: {
        id: ++this.serial,
        type,
        data,
        timestamp: new Date().toISOString(),
        pinned: false,
      },
    });
  }
  finish() {
    this.final = {
      sessionId: "session",
      result: "done",
      isError: false,
      durationMs: 1,
      numTurns: 2,
      totalCostUsd: 0,
    };
    this.event("result", this.final);
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const task: TaskSpec = {
  id: "a",
  title: "a",
  instructions: "write",
  dependsOn: [],
  acceptance: "42",
  artifacts: ["answer.txt"],
  checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
};

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccc-long-wait-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"),
    data = path.join(root, "ledger");
  mkdirSync(cwd, { recursive: true });
  const worker = new WaitWorker(),
    controller = new Orchestrator(data, worker, data);
  cleanups.push(() => controller.close());
  const run = controller.plan({
    action: "create",
    cwd,
    goal: "goal",
    design: "design",
    tasks: [task],
  });
  return { root, cwd, data, worker, controller, run };
}

describe("20 minute event wait", () => {
  it("defaults to and caps at 1200000ms", () => {
    expect(defaultWaitMs()).toBe(1200000);
    expect(MAX_WAIT_MS).toBe(1200000);
    vi.stubEnv("CCC_WAIT_MS", "900000");
    expect(defaultWaitMs()).toBe(900000);
    vi.stubEnv("CCC_WAIT_MS", "1200001");
    expect(defaultWaitMs()).toBe(1200000);
  });

  it("keeps one pending promise for the full twenty minutes without polling", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    vi.useFakeTimers();
    const started = Date.now(),
      waiting = f.controller.wait(f.run.id, f.controller.cursor(f.run.id));
    let resolved = false;
    void waiting.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS - 1);
    expect(resolved).toBe(false);
    expect(f.controller.metrics).toMatchObject({ statusReads: 0, logPolls: 0, waitTimeouts: 0 });
    await vi.advanceTimersByTimeAsync(1);
    const result = await waiting;
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBe(MAX_WAIT_MS);
    expect(f.controller.metrics.waitTimeouts).toBe(1);
    expect(f.controller.metrics.waits).toBe(1);
  });

  it("wakes immediately on a completion result instead of waiting the timeout", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    const waiting = f.controller.wait(f.run.id, f.controller.cursor(f.run.id), MAX_WAIT_MS);
    f.worker.finish();
    const result = await waiting;
    expect(result.timedOut).toBe(false);
    expect(result.events[0].type).toBe("worker_finished");
    expect(f.controller.metrics).toMatchObject({ waitTimeouts: 0, wakeups: 1 });
  });

  it("wakes on a question, a permission request and an error", async () => {
    for (const kind of ["question", "permission", "error"] as const) {
      const f = fixture();
      await f.controller.dispatch(f.run.id, "a", "first");
      const waiting = f.controller.wait(f.run.id, f.controller.cursor(f.run.id), MAX_WAIT_MS);
      if (kind === "question")
        f.worker.messageListener?.({
          sessionId: "session",
          message: { id: "q", kind: "question", text: "Choose" },
        });
      else if (kind === "permission")
        f.worker.event("permission_request", {
          requestId: "p",
          toolName: "Bash",
          input: { command: "x" },
        });
      else {
        f.worker.final = {
          sessionId: "session",
          result: "provider failed",
          isError: true,
          errorSubtype: "error_during_execution",
          durationMs: 1,
          numTurns: 1,
          totalCostUsd: 0,
        };
        f.worker.event("error", f.worker.final);
      }
      expect((await waiting).timedOut).toBe(false);
      expect(f.controller.metrics.waitTimeouts).toBe(0);
    }
  });

  it("wakes on cancellation and removes abort listeners deterministically", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    const host = new AbortController();
    const pending = f.controller.wait(
      f.run.id,
      f.controller.cursor(f.run.id),
      MAX_WAIT_MS,
      host.signal
    );
    expect(host.signal).toBeDefined();
    f.controller.cancel(f.run.id, "User stopped");
    host.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    // The run's listener set is empty: no dangling subscriptions from the wait.
    expect((f.controller as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
  });

  it("returns buffered actionable events without registering another wait", async () => {
    const f = fixture();
    vi.useFakeTimers();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.worker.messageListener?.({
      sessionId: "session",
      message: { id: "buffered", kind: "question", text: "Already asked" },
    });
    const result = await f.controller.wait(f.run.id, 0, MAX_WAIT_MS);
    expect(result.events[0].type).toBe("worker_question");
    expect(f.controller.metrics.waits).toBe(1);
    expect(f.controller.metrics.waitTimeouts).toBe(0);
  });

  it("treats a pre-aborted signal as an immediate cancellation", async () => {
    const f = fixture();
    vi.useFakeTimers();
    await f.controller.dispatch(f.run.id, "a", "first");
    const host = new AbortController();
    host.abort();
    const result = await f.controller.wait(
      f.run.id,
      f.controller.cursor(f.run.id),
      MAX_WAIT_MS,
      host.signal
    );
    expect(result.timedOut).toBe(false);
    expect(f.run.tasks[0].state).toBe("interrupted");
    expect(vi.getTimerCount()).toBe(0);
    expect((f.controller as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
  });

  it("rejects a cursor ahead of the ledger before waiting", async () => {
    const f = fixture();
    await expect(f.controller.wait(f.run.id, 99, MAX_WAIT_MS)).rejects.toThrow("CURSOR_AHEAD");
  });

  it("applies the same twenty minute bound and early wake to team waits", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ccc-long-team-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const workers = new Map<string, WaitWorker>();
    const coordinator = new TeamCoordinator(path.join(root, "ledger"), (directory) => {
      const worker = new WaitWorker();
      workers.set(path.basename(directory), worker);
      return new Orchestrator(directory, worker, path.join(root, "ledger"));
    });
    cleanups.push(() => coordinator.close());
    const team = coordinator.create({
      cwd: root,
      goal: "goal",
      design: "design",
      tasks: [{ ...task, writeScope: ["answer.txt"] }],
    });
    await coordinator.dispatch(team.teamId, "a", "first");
    // Fake timers cover the full bound without sleeping; a real short timer covers early wake.
    vi.useFakeTimers();
    const slow = coordinator.wait(
      team.teamId,
      (coordinator.status(team.teamId) as { nextCursor: number }).nextCursor
    );
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);
    expect((await slow).timedOut).toBe(true);
    vi.useRealTimers();
    const cursor = (coordinator.status(team.teamId) as { nextCursor: number }).nextCursor;
    const fast = coordinator.wait(team.teamId, cursor, 5000);
    workers.get("a")!.finish();
    expect((await fast).timedOut).toBe(false);
    expect(WORKER_SLOT_LIMIT).toBe(3);
  });
});
