import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentResult, PermissionRequestRecord, SessionEvent } from "../src/types.js";
import { Orchestrator, type TaskSpec } from "../src/orchestrator/controller.js";
import type { Worker, WorkerEvent } from "../src/orchestrator/worker.js";
import { SessionManager } from "../src/session/manager.js";

class FakeWorker implements Worker {
  listener?: (event: WorkerEvent) => void;
  starts = 0;
  replies = 0;
  stops = 0;
  events: SessionEvent[] = [];
  final?: AgentResult;
  pending: PermissionRequestRecord[] = [];
  subscribe(fn: (event: WorkerEvent) => void) {
    this.listener = fn;
    return () => {
      this.listener = undefined;
    };
  }
  async start() {
    this.starts++;
    return "session-1";
  }
  async reply() {
    this.replies++;
    this.final = undefined;
    return "session-1";
  }
  replay() {
    return this.events;
  }
  result() {
    return this.final;
  }
  permissions() {
    return this.pending;
  }
  respond() {
    this.pending = [];
    return true;
  }
  model() {
    return "deepseek-v4.1-flash";
  }
  stop() {
    this.stops++;
  }
  destroy() {}
  event(type: SessionEvent["type"], data: unknown = {}) {
    const event: SessionEvent = {
      id: this.events.length,
      type,
      data,
      timestamp: new Date().toISOString(),
      pinned: false,
    };
    this.events.push(event);
    this.listener?.({ sessionId: "session-1", event });
  }
  finish() {
    this.final = {
      sessionId: "session-1",
      result: "Implemented",
      isError: false,
      durationMs: 10,
      numTurns: 2,
      totalCostUsd: 0,
    };
    this.event("result", this.final);
  }
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  vi.useRealTimers();
});
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccc-中文 空格-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const worker = new FakeWorker();
  const controller = new Orchestrator(path.join(dir, "data"), worker);
  cleanup.push(() => controller.close());
  const task: TaskSpec = {
    id: "a",
    title: "artifact",
    instructions: "write answer.txt",
    dependsOn: [],
    acceptance: "answer is 42",
    artifacts: ["answer.txt"],
    checks: [
      {
        command: process.execPath,
        args: ["-e", "if(require('fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1)"],
      },
    ],
  };
  const run = controller.plan({
    action: "create",
    cwd: dir,
    goal: "goal",
    design: "design",
    tasks: [task, { ...task, id: "b", dependsOn: ["a"] }],
  });
  return { dir, worker, controller, run, task };
}

describe("Codex orchestration gates", () => {
  it("does not unlock a compact turn at its boundary before the terminal result", async () => {
    const f = fixture();
    f.run.sessionId = "session-1";
    await f.controller.session(f.run.id, "compact");
    f.worker.event("progress", { type: "compact_boundary" });
    expect(f.run.sessionOperation).toBe("compact");
    await expect(f.controller.dispatch(f.run.id, "a", "too-early")).rejects.toThrow(
      "EXECUTOR_BUSY"
    );
    f.worker.finish();
    expect(f.run.sessionOperation).toBeUndefined();
    expect(f.run.tasks.every((t) => t.state === "pending")).toBe(true);
    await f.controller.dispatch(f.run.id, "a", "after-drain");
  });
  it("refuses reopening a historical run while another run is open", () => {
    const f = fixture();
    f.controller.cancel(f.run.id);
    const active = f.controller.plan({
      action: "create",
      cwd: f.dir,
      goal: "new",
      design: "new",
      tasks: [f.task],
    });
    expect(() => f.controller.plan({ action: "reopen", runId: f.run.id })).toThrow(
      "OPEN_RUN_EXISTS"
    );
    expect(active.status).toBe("open");
    expect(f.run.status).toBe("cancelled");
  });
  it("preserves accepted interfaces and supervisor feedback when creating a new context", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "one");
    writeFileSync(path.join(f.dir, "answer.txt"), "42");
    f.worker.finish();
    const task = f.run.tasks[0];
    await f.controller.review({
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      artifactHash: task.artifactHash!,
      decision: "accept",
      evidence: "Confirmed stable interface and user feedback",
    });
    await f.controller.session(f.run.id, "new");
    expect(f.run.checkpoint).toContain("Confirmed stable interface and user feedback");
    expect(f.run.checkpoint).toContain("answer.txt");
    let received = "";
    f.worker.start = async (_cwd?: string, prompt?: string) => {
      received = prompt ?? "";
      return "session-2";
    };
    await f.controller.dispatch(f.run.id, "b", "new-context");
    expect(received).toContain("Supervisor checkpoint");
    expect(received).toContain("answer is 42");
  });
  it("does not lose a result arriving before the dispatch receipt", async () => {
    const f = fixture();
    writeFileSync(path.join(f.dir, "answer.txt"), "42");
    f.worker.start = async () => {
      f.worker.finish();
      return "session-1";
    };
    const receipt = await f.controller.dispatch(f.run.id, "a", "fast");
    const waited = await f.controller.wait(f.run.id, receipt.nextCursor ?? 0, 1);
    expect(waited.events.some((e) => e.type === "worker_finished")).toBe(true);
  });
  it("marks shortened output and preserves full evidence and critical blockers", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "one");
    writeFileSync(path.join(f.dir, "answer.txt"), "42");
    const text = "detail ".repeat(800);
    f.worker.final = {
      sessionId: "session-1",
      result: text,
      isError: false,
      durationMs: 1,
      numTurns: 1,
      totalCostUsd: 0,
    };
    f.worker.event("result", f.worker.final);
    const returned = await f.controller.wait(f.run.id, 0, 1);
    const brief = returned.events.find((e) => e.type === "worker_finished")!.data as {
      result: { summary: string; truncated: boolean; detailRef: { runId: string; taskId: string } };
    };
    expect(brief.result.truncated).toBe(true);
    expect(brief.result.summary.length).toBe(1000);
    expect(brief.result.detailRef).toMatchObject({ runId: f.run.id, taskId: "a" });
    expect(f.run.tasks[0].result!.result).toBe(text);
  });
  it("does not truncate a long blocking question", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "one");
    const text = "BLOCKED: " + "critical question ".repeat(300);
    f.worker.final = {
      sessionId: "session-1",
      result: text,
      isError: false,
      durationMs: 1,
      numTurns: 1,
      totalCostUsd: 0,
    };
    f.worker.event("result", f.worker.final);
    const returned = await f.controller.wait(f.run.id, 0, 1);
    const brief = returned.events.find((e) => e.type === "worker_finished")!.data as {
      result: { summary: string; truncated: boolean };
    };
    expect(brief.result.summary).toBe(text);
    expect(brief.result.truncated).toBe(false);
  });
  it("interrupts a pre-aborted wait while preserving recovery even with buffered events", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "one");
    const abort = new AbortController();
    abort.abort();
    expect((await f.controller.wait(f.run.id, 0, 1000, abort.signal)).status).toBe("open");
    expect(f.run.tasks[0].state).toBe("interrupted");
    expect(f.worker.stops).toBe(1);
  });
  it("supersedes pending contracts and refuses removal of a referenced replacement", () => {
    const f = fixture();
    f.controller.plan({
      action: "update",
      runId: f.run.id,
      tasks: [f.task, { ...f.task, id: "replacement" }],
    });
    f.controller.plan({
      action: "supersede",
      runId: f.run.id,
      taskId: "a",
      replacementId: "replacement",
    });
    expect(f.run.tasks.find((t) => t.id === "a")!.state).toBe("superseded");
    expect(() => f.controller.plan({ action: "update", runId: f.run.id, tasks: [f.task] })).toThrow(
      "MISSING_REPLACEMENT"
    );
    expect(() => f.controller.plan({ action: "finish", runId: f.run.id })).toThrow(
      "UNACCEPTED_REPLACEMENT"
    );
  });
  it("invalidates accepted output changed after its review", async () => {
    const f = fixture();
    f.controller.plan({ action: "update", runId: f.run.id, tasks: [f.task] });
    await f.controller.dispatch(f.run.id, "a", "one");
    writeFileSync(path.join(f.dir, "answer.txt"), "42");
    f.worker.finish();
    const task = f.run.tasks[0];
    await f.controller.review({
      runId: f.run.id,
      taskId: "a",
      taskRevision: task.revision,
      artifactHash: task.artifactHash!,
      decision: "accept",
      evidence: "Read expected result",
    });
    writeFileSync(path.join(f.dir, "answer.txt"), "changed");
    expect(f.controller.plan({ action: "finish", runId: f.run.id }).status).toBe("open");
    expect(task.state).toBe("awaiting_review");
  });
  it("releases a completed session before the next run", async () => {
    const f = fixture();
    f.controller.plan({ action: "update", runId: f.run.id, tasks: [f.task] });
    await f.controller.dispatch(f.run.id, "a", "one");
    writeFileSync(path.join(f.dir, "answer.txt"), "42");
    f.worker.finish();
    const task = f.run.tasks[0];
    await f.controller.review({
      runId: f.run.id,
      taskId: "a",
      taskRevision: task.revision,
      artifactHash: task.artifactHash!,
      decision: "accept",
      evidence: "Read output and verified original acceptance",
    });
    expect(f.controller.plan({ action: "finish", runId: f.run.id }).status).toBe(
      "awaiting_user_review"
    );
    expect(f.worker.stops).toBe(0);
    expect(f.controller.plan({ action: "approve", runId: f.run.id }).status).toBe("completed");
    expect(f.worker.stops).toBe(1);
    const next = f.controller.plan({
      action: "create",
      cwd: f.dir,
      goal: "next",
      design: "next design",
      tasks: [f.task],
    });
    await f.controller.dispatch(next.id, "a", "new");
    expect(f.worker.starts).toBe(2);
  });
  it("cancels asynchronous acceptance promptly without accepting late output", async () => {
    const f = fixture();
    const taskSpec = {
      ...f.task,
      checks: [{ command: process.execPath, args: ["-e", "setTimeout(()=>{},10000)"] }],
    };
    f.controller.plan({ action: "update", runId: f.run.id, tasks: [taskSpec] });
    await f.controller.dispatch(f.run.id, "a", "one");
    writeFileSync(path.join(f.dir, "answer.txt"), "42");
    f.worker.finish();
    const abort = new AbortController(),
      task = f.run.tasks[0];
    const start = performance.now();
    const review = f.controller.review(
      {
        runId: f.run.id,
        taskId: "a",
        taskRevision: task.revision,
        artifactHash: task.artifactHash!,
        decision: "accept",
        evidence: "Independent review",
      },
      abort.signal
    );
    setTimeout(() => abort.abort(), 50);
    await expect(review).rejects.toThrow("REVIEW_INTERRUPTED");
    expect(f.run.status).toBe("open");
    expect(task.state).toBe("awaiting_review");
    expect(performance.now() - start).toBeLessThan(2000);
    expect(task.state).not.toBe("accepted");
  });
  it("retains superseded history and rewires pending dependencies", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "one");
    f.worker.final = {
      sessionId: "session-1",
      result: "Failed",
      isError: true,
      durationMs: 1,
      numTurns: 1,
      totalCostUsd: 0,
    };
    f.worker.event("error", f.worker.final);
    f.controller.plan({
      action: "update",
      runId: f.run.id,
      tasks: [f.task, { ...f.task, id: "b", dependsOn: ["a"] }, { ...f.task, id: "replacement" }],
    });
    f.controller.plan({
      action: "supersede",
      runId: f.run.id,
      taskId: "a",
      replacementId: "replacement",
    });
    expect(f.run.tasks[0].state).toBe("superseded");
    expect(f.run.tasks.find((t) => t.id === "b")!.dependsOn).toEqual(["replacement"]);
    for (const taskId of ["replacement", "b"]) {
      await f.controller.dispatch(f.run.id, taskId, taskId);
      writeFileSync(path.join(f.dir, "answer.txt"), "42");
      f.worker.finish();
      const task = f.run.tasks.find((t) => t.id === taskId)!;
      await f.controller.review({
        runId: f.run.id,
        taskId,
        taskRevision: task.revision,
        artifactHash: task.artifactHash!,
        decision: "accept",
        evidence: "Verified replacement satisfies goal",
      });
    }
    expect(f.controller.plan({ action: "finish", runId: f.run.id }).status).toBe(
      "awaiting_user_review"
    );
    expect(f.controller.plan({ action: "approve", runId: f.run.id }).status).toBe("completed");
  });
  it("blocks dependencies and deduplicates delivery", async () => {
    const f = fixture();
    await expect(f.controller.dispatch(f.run.id, "b", "second")).rejects.toThrow(
      "DEPENDENCY_NOT_ACCEPTED"
    );
    const receipt = await f.controller.dispatch(f.run.id, "a", "first");
    expect(await f.controller.dispatch(f.run.id, "a", "first")).toBe(receipt);
    await expect(f.controller.dispatch(f.run.id, "a", "another")).rejects.toThrow("EXECUTOR_BUSY");
    expect(f.worker.starts).toBe(1);
  });
  it("rejects failed checks despite worker success, then accepts rework and unlocks next task", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "one");
    writeFileSync(path.join(f.dir, "answer.txt"), "wrong");
    f.worker.finish();
    expect(f.run.tasks[0].state).toBe("awaiting_review");
    let task = f.run.tasks[0];
    const rejected = await f.controller.review({
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      artifactHash: task.artifactHash!,
      decision: "accept",
      evidence: "Reviewed bytes and independent expected value",
    });
    expect(rejected.state).toBe("needs_revision");
    expect(rejected.checks[0].exitCode).toBe(1);
    await f.controller.dispatch(f.run.id, "a", "repair");
    writeFileSync(path.join(f.dir, "answer.txt"), "42");
    f.worker.finish();
    task = f.run.tasks[0];
    expect(
      (
        await f.controller.review({
          runId: f.run.id,
          taskId: "a",
          taskRevision: 1,
          artifactHash: task.artifactHash!,
          decision: "accept",
          evidence: "Compared file to original requirement",
        })
      ).state
    ).toBe("accepted");
    await f.controller.dispatch(f.run.id, "b", "next");
    expect(f.worker.replies).toBe(2);
    expect(() => f.controller.plan({ action: "finish", runId: f.run.id })).toThrow(
      "UNACCEPTED_TASKS"
    );
  });
  it("refuses stale artifact hashes and immutable dispatched contract edits", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "one");
    writeFileSync(path.join(f.dir, "answer.txt"), "42");
    f.worker.finish();
    const hash = f.run.tasks[0].artifactHash!;
    writeFileSync(path.join(f.dir, "answer.txt"), "changed");
    await expect(
      f.controller.review({
        runId: f.run.id,
        taskId: "a",
        taskRevision: 1,
        artifactHash: hash,
        decision: "accept",
        evidence: "review",
      })
    ).rejects.toThrow("STALE");
    expect(() =>
      f.controller.plan({
        action: "update",
        runId: f.run.id,
        tasks: [
          { ...f.task, acceptance: "new" },
          { ...f.task, id: "b", dependsOn: ["a"] },
        ],
      })
    ).toThrow("IMMUTABLE");
  });
  it("rejects graph cycles, path escapes and reserved request ids", async () => {
    const f = fixture();
    expect(() =>
      f.controller.plan({
        action: "create",
        cwd: f.dir,
        goal: "x",
        design: "y",
        tasks: [{ ...f.task, dependsOn: ["a"] }],
      })
    ).toThrow("CYCLE");
    expect(() =>
      f.controller.plan({
        action: "create",
        cwd: f.dir,
        goal: "x",
        design: "y",
        tasks: [{ ...f.task, artifacts: ["../escape"] }],
      })
    ).toThrow("OUTSIDE");
    await expect(f.controller.dispatch(f.run.id, "a", "__proto__")).rejects.toThrow("INVALID");
  });
  it("waits quietly without status/log polling, ignores noise and wakes on an actual event", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "one");
    const cursor = f.run.events.at(-1)!.seq;
    let resolved = false;
    const promise = f.controller.wait(f.run.id, cursor, 1000).then((value) => {
      resolved = true;
      return value;
    });
    f.worker.event("progress", { tool_name: "Read" });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);
    expect(f.controller.metrics.statusReads).toBe(0);
    expect(f.controller.metrics.logPolls).toBe(0);
    const start = performance.now();
    f.worker.event("permission_request", { requestId: "p" });
    const returned = await promise;
    expect(performance.now() - start).toBeLessThan(1000);
    expect(returned.events.map((e) => e.type)).toEqual(["permission_required"]);
    expect((await f.controller.wait(f.run.id, returned.nextCursor, 5)).timedOut).toBe(true);
    expect(f.worker.starts).toBe(1);
  });
  it("interrupts execution on host wait cancellation and preserves recovery", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "one");
    const abort = new AbortController();
    const wait = f.controller.wait(f.run.id, f.run.events.at(-1)!.seq, 1000, abort.signal);
    abort.abort();
    expect((await wait).status).toBe("open");
    expect(f.run.tasks[0].state).toBe("interrupted");
    expect(f.worker.stops).toBe(1);
  });
  it("does not add a path veto to native requests and refuses stale responses", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "one");
    f.worker.pending = [
      {
        requestId: "p",
        toolName: "Write",
        input: { file_path: "../escape" },
        summary: "write",
        toolUseID: "t",
        createdAt: "now",
      },
    ];
    expect(f.controller.respond(f.run.id, "p", "allow").decision).toBe("allow");
    expect(() => f.controller.respond(f.run.id, "p", "allow")).toThrow("UNKNOWN");
  });
  it("preserves an interrupted task on connection close and never auto dispatches", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "one");
    f.controller.close();
    const next = new FakeWorker();
    const recovered = new Orchestrator(path.join(f.dir, "data"), next);
    cleanup.push(() => recovered.close());
    const run = recovered.status(f.run.id) as typeof f.run;
    expect(run.tasks[0].state).toBe("interrupted");
    expect(next.starts).toBe(0);
  });
});

it("upstream observers see committed terminal status and cancel transitions", async () => {
  const manager = new SessionManager();
  cleanup.push(() => manager.destroy());
  manager.create({ sessionId: "s", cwd: process.cwd() });
  const statuses: string[] = [];
  manager.subscribe((id) => {
    statuses.push(manager.get(id)?.status ?? "missing");
  });
  manager.pushEvent("s", { type: "result", data: {}, timestamp: "now" });
  manager.update("s", { status: "idle" });
  await Promise.resolve();
  expect(statuses.every((s) => s === "idle")).toBe(true);
  manager.update("s", { status: "running" });
  manager.cancel("s");
  await Promise.resolve();
  expect(statuses.at(-1)).toBe("cancelled");
});
