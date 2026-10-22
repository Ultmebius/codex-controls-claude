import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator, type TaskSpec } from "../src/orchestrator/controller.js";
import type { Worker, WorkerEvent } from "../src/orchestrator/worker.js";
import type { AgentResult, SessionEvent } from "../src/types.js";
class FixtureWorker implements Worker {
  messageListener?: (event: {
    sessionId: string;
    message: { id: string; kind: "question" | "update"; text: string };
  }) => void;
  answered = false;
  subscribeMessages(listener: NonNullable<FixtureWorker["messageListener"]>) {
    this.messageListener = listener;
    return () => {
      this.messageListener = undefined;
    };
  }
  respondMessage() {
    this.answered = true;
    return true;
  }
  listener?: (event: WorkerEvent) => void;
  final?: AgentResult;
  count = 0;
  starts = 0;
  grants: number[] = [];
  resumeIds: (string | undefined)[] = [];
  subscribe(fn: (event: WorkerEvent) => void) {
    this.listener = fn;
    return () => {
      this.listener = undefined;
    };
  }
  async start(
    _cwd: string,
    _prompt: string,
    turns: number,
    _signal?: AbortSignal,
    resumeId?: string
  ) {
    this.starts++;
    this.grants.push(turns);
    this.resumeIds.push(resumeId);
    return "session";
  }
  async reply(_session: string, _prompt: string, turns?: number) {
    if (turns) this.grants.push(turns);
    return "session";
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
  stop() {}
  destroy() {}
  finish(subtype = "success", numTurns = 2, text = "done") {
    this.final = {
      sessionId: "session",
      result: text,
      isError: subtype !== "success",
      errorSubtype: subtype === "success" ? undefined : subtype,
      durationMs: 1,
      numTurns,
      totalCostUsd: 0,
    };
    const event: SessionEvent = {
      id: this.count++,
      type: this.final.isError ? "error" : "result",
      data: this.final,
      timestamp: new Date().toISOString(),
      pinned: false,
    };
    this.listener?.({ sessionId: "session", event });
  }
}
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const fn of dispose.splice(0).reverse()) fn();
});
function fixture(config: { maxTurns?: number; maxTotalTurns?: number } = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ccc-revision-"));
  dispose.push(() => rmSync(cwd, { recursive: true, force: true }));
  const worker = new FixtureWorker();
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
  return { cwd, worker, controller, run, spec };
}
type Revised = { turnBudget: { limit: number; used: number; reserved: number } };
type Counters = {
  repairs: number;
  continuations: number;
  checkpoint?: unknown;
  provenance?: { producer: string };
};
function budget(run: unknown) {
  return (run as Revised).turnBudget;
}
function counters(task: unknown) {
  return task as Counters;
}
function continueTask(f: ReturnType<typeof fixture>, request: string) {
  return Reflect.apply(f.controller.dispatch, f.controller, [
    f.run.id,
    "a",
    request,
    undefined,
    { mode: "continue" },
  ]) as Promise<unknown>;
}
function reconcile(f: ReturnType<typeof fixture>, revision = 1) {
  const api = f.controller as unknown as {
    reconcile(input: {
      runId: string;
      taskId: string;
      taskRevision: number;
      evidence: string;
    }): unknown;
  };
  return api.reconcile({
    runId: f.run.id,
    taskId: "a",
    taskRevision: revision,
    evidence: "Supervisor completed current workspace; preserve original fixed checks",
  });
}
async function review(f: ReturnType<typeof fixture>, decision: "accept" | "reject") {
  return f.controller.review({
    runId: f.run.id,
    taskId: "a",
    taskRevision: 1,
    artifactHash: f.run.tasks[0].artifactHash!,
    decision,
    evidence: "Independently inspected the actual artifact",
  });
}
describe("budget continuation and reconciliation", () => {
  it("delivers a question arriving before startup receipt and rejects stale answers", async () => {
    const f = fixture();
    f.worker.start = async () => {
      f.worker.messageListener?.({
        sessionId: "session",
        message: { id: "question", kind: "question", text: "Need supervisor choice" },
      });
      return "session";
    };
    const cursor = f.controller.cursor(f.run.id);
    const waiting = f.controller.wait(f.run.id, cursor, 1000);
    await f.controller.dispatch(f.run.id, "a", "first");
    expect((await waiting).events.find((e) => e.type === "worker_question")?.data).toMatchObject({
      text: "Need supervisor choice",
    });
    expect(f.controller.respondMessage(f.run.id, "question", "Choice within scope").delivery).toBe(
      "answered_in_worker_tool"
    );
    expect(f.worker.answered).toBe(true);
    expect(() => f.controller.respondMessage(f.run.id, "question", "Duplicate")).toThrow(
      "MESSAGE_NOT_PENDING_OR_STALE"
    );
  });
  it("drains an interrupted startup before allowing another attempt", async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.worker.start = () =>
      new Promise<string>((_resolve, fail) => {
        reject = fail;
      });
    const first = f.controller.dispatch(f.run.id, "a", "first");
    f.controller.interrupt(f.run.id, "Supervisor interrupts startup");
    const charged = budget(f.run).used;
    // Capacity stays held while the interrupted startup promise drains.
    expect(existsSync(path.join(f.cwd, "ledger", "worker-slots", "slot-1.json"))).toBe(true);
    const other = new Orchestrator(path.join(f.cwd, "ledger"), new FixtureWorker());
    dispose.push(() => other.close());
    await expect(
      other.dispatch(f.run.id, "a", "foreign", undefined, { mode: "continue" })
    ).rejects.toThrow("RUN_OWNED_BY_ANOTHER_CONNECTION");
    await expect(continueTask(f, "too-early")).rejects.toThrow("EXECUTOR_STARTUP_DRAINING");
    reject(new Error("late startup rejection"));
    await first;
    expect(existsSync(path.join(f.cwd, "ledger", "worker-slots", "slot-1.json"))).toBe(false);
    expect(f.run.tasks[0].state).toBe("interrupted");
    expect(budget(f.run).used).toBe(charged);
    f.worker.start = async () => "session";
    await continueTask(f, "after-drain");
    expect(f.run.tasks[0].state).toBe("running");
    expect(budget(f.run).reserved).toBeGreaterThan(0);
  });
  it("captures fresh startup failure and permission-timeout checkpoints", async () => {
    const f = fixture();
    f.worker.start = async () => {
      writeFileSync(path.join(f.cwd, "answer.txt"), "partial");
      throw new Error("startup failed");
    };
    await f.controller.dispatch(f.run.id, "a", "failed-start");
    expect(f.run.tasks[0].checkpoint?.changedDeclaredArtifacts).toEqual(["answer.txt"]);
    expect(f.run.events.at(-1)?.data).toMatchObject({
      failureClass: "startup",
      checkpointAvailable: true,
      nextActions: expect.arrayContaining(["reconcile"]),
    });
    const previous = f.run.tasks[0].checkpoint;
    f.worker.start = async () => "session";
    await f.controller.dispatch(f.run.id, "a", "retry");
    expect(f.run.tasks[0].checkpoint).toBeUndefined();
    writeFileSync(path.join(f.cwd, "answer.txt"), "changed-before-permission-timeout");
    f.worker.listener?.({
      sessionId: "session",
      event: {
        id: 0,
        type: "permission_result",
        data: { behavior: "deny", source: "timeout" },
        timestamp: new Date().toISOString(),
        pinned: false,
      },
    });
    expect(f.run.tasks[0].state).toBe("blocked");
    expect(f.run.tasks[0].checkpoint?.artifacts).not.toEqual(previous?.artifacts);
    expect(f.run.events.at(-1)?.data).toMatchObject({
      failureClass: "permission",
      checkpointAvailable: true,
      changedDeclaredArtifacts: ["answer.txt"],
    });
  });

  it("preserves custom budget and charges an orphan reservation on restart", async () => {
    const f = fixture({ maxTurns: 2, maxTotalTurns: 5 });
    await f.controller.dispatch(f.run.id, "a", "first");
    const saved = JSON.parse(JSON.stringify(f.run));
    saved.ownerPid = 99999999;
    f.controller.close();
    writeFileSync(path.join(f.cwd, "ledger", `run-${f.run.id}.json`), JSON.stringify(saved));
    const restored = new Orchestrator(path.join(f.cwd, "ledger"), new FixtureWorker());
    dispose.push(() => restored.close());
    restored.attach(f.run.id);
    const recovered = restored.status(f.run.id);
    if (Array.isArray(recovered)) throw new Error("Expected one run");
    expect(budget(recovered)).toMatchObject({ limit: 5, used: 3, reserved: 0 });
    expect(recovered.tasks[0].state).toBe("interrupted");
    expect(recovered.tasks[0].checkpoint?.accountingKnown).toBe(false);
    expect(recovered.deadline).toBe(saved.deadline);
  });
  it("bounds repeated known zero-progress errors separately from repairs", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    for (let i = 0; i < 2; i++) {
      f.worker.finish("error_during_execution", 0);
      await f.controller.dispatch(f.run.id, "a", `retry-${i}`);
    }
    f.worker.finish("error_during_execution", 0);
    await expect(f.controller.dispatch(f.run.id, "a", "infinite-retry")).rejects.toThrow(
      "ZERO_PROGRESS_RETRY_LIMIT"
    );
    expect(counters(f.run.tasks[0]).repairs).toBe(0);
  });

  it("uses the user-approved two-hour deadlines and supports supervisor interruption", async () => {
    const f = fixture();
    expect(f.run.taskTimeoutMs).toBe(7200000);
    expect(f.run.deadline - Date.parse(f.run.createdAt)).toBeGreaterThanOrEqual(7199999);
    await f.controller.dispatch(f.run.id, "a", "first");
    f.controller.interrupt(f.run.id, "Supervisor pauses this bounded stage for inspection");
    expect(f.run.status).toBe("open");
    expect(f.run.tasks[0].state).toBe("interrupted");
    expect(counters(f.run.tasks[0]).checkpoint).toBeDefined();
    await continueTask(f, "resume");
    expect(counters(f.run.tasks[0]).repairs).toBe(0);
  });

  it("defaults to 500 native turns and a persistent 1000-turn run budget", () => {
    const f = fixture();
    expect(f.run.maxTurns).toBe(500);
    expect(budget(f.run)).toMatchObject({ limit: 1000, used: 0, reserved: 0 });
  });
  it("continues the identical contract without spending repairs or duplicating receipts", async () => {
    const f = fixture({ maxTurns: 2 });
    await f.controller.dispatch(f.run.id, "a", "first");
    f.worker.finish("error_max_turns", 3);
    expect(f.run.tasks[0].state).toBe("budget_exhausted");
    expect(counters(f.run.tasks[0]).checkpoint).toBeDefined();
    const contract = JSON.stringify(f.spec);
    const receipt = await continueTask(f, "continue");
    expect(await continueTask(f, "continue")).toEqual(receipt);
    expect(counters(f.run.tasks[0])).toMatchObject({ repairs: 0, continuations: 1 });
    expect(f.run.tasks[0].revision).toBe(1);
    expect(JSON.stringify(f.spec)).toBe(contract);
    expect(budget(f.run).used).toBe(3);
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    f.worker.finish();
    expect((await review(f, "accept")).state).toBe("accepted");
  });
  it("charges only actual acceptance rework to the repair quota", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    for (let i = 0; i < 3; i++) {
      f.worker.finish("error_max_turns", 2);
      await continueTask(f, `continuation-${i}`);
    }
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    f.worker.finish();
    await review(f, "reject");
    await f.controller.dispatch(f.run.id, "a", "repair-one");
    f.worker.finish();
    await review(f, "reject");
    await f.controller.dispatch(f.run.id, "a", "repair-two");
    f.worker.finish();
    await review(f, "reject");
    expect(counters(f.run.tasks[0]).repairs).toBe(2);
    await expect(f.controller.dispatch(f.run.id, "a", "repair-three")).rejects.toThrow(
      "REPAIR_LIMIT"
    );
  });
  it("bounds the final native grant and cannot evade total budget through replacement", async () => {
    const f = fixture({ maxTurns: 2, maxTotalTurns: 5 });
    await f.controller.dispatch(f.run.id, "a", "first");
    f.worker.finish("error_max_turns", 3);
    await continueTask(f, "second");
    expect(f.worker.grants.at(-1)).toBe(1);
    f.worker.finish("error_max_turns", 2);
    f.controller.plan({
      action: "update",
      runId: f.run.id,
      tasks: [f.spec, { ...f.spec, id: "replacement" }],
    });
    f.controller.plan({
      action: "supersede",
      runId: f.run.id,
      taskId: "a",
      replacementId: "replacement",
    });
    expect(budget(f.run).used).toBe(5);
    await expect(f.controller.dispatch(f.run.id, "replacement", "evade")).rejects.toThrow(
      "RUN_TURN_BUDGET"
    );
  });
  it("does not reset an expired execution deadline on reopen and permits verification only", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    f.worker.finish();
    await review(f, "accept");
    f.controller.plan({ action: "finish", runId: f.run.id });
    const deadline = Date.now() - 100;
    f.run.deadline = deadline;
    f.controller.plan({ action: "reopen", runId: f.run.id });
    expect(f.run.deadline).toBe(deadline);
    f.controller.plan({ action: "append", runId: f.run.id, tasks: [{ ...f.spec, id: "new" }] });
    await expect(f.controller.dispatch(f.run.id, "new", "expired")).rejects.toThrow("RUN_DEADLINE");
  });
  it("reconciles supervisor changes then still rejects the original failing check", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.worker.finish("success", 1, "BLOCKED: tool unavailable");
    writeFileSync(path.join(f.cwd, "answer.txt"), "41");
    reconcile(f);
    expect(f.run.tasks[0].state).toBe("awaiting_review");
    expect(counters(f.run.tasks[0]).provenance?.producer).toBe("supervisor_reconcile");
    expect((await review(f, "accept")).state).toBe("needs_revision");
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    f.run.deadline = Date.now() - 1;
    reconcile(f);
    expect((await review(f, "accept")).state).toBe("accepted");
    expect(f.worker.starts).toBe(1);
    expect(counters(f.run.tasks[0]).repairs).toBe(0);
  });
  it("captures explicitly supervisor-completed pending work without model dispatch or budget reset", async () => {
    const f = fixture();
    const budget = { ...f.run.turnBudget };
    expect(() => reconcile(f)).toThrow(); // no deliverable yet
    writeFileSync(path.join(f.cwd, "answer.txt"), "41");
    reconcile(f);
    expect(f.run.tasks[0].state).toBe("awaiting_review");
    expect((await review(f, "accept")).state).toBe("needs_revision");
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    reconcile(f);
    expect((await review(f, "accept")).state).toBe("accepted");
    expect(f.worker.starts).toBe(0);
    expect(f.run.turnBudget).toEqual(budget);
    expect(counters(f.run.tasks[0]).provenance?.producer).toBe("supervisor_reconcile");
  });
  it("rejects active, stale and missing-artifact reconciliation", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    expect(() => reconcile(f)).toThrow("EXECUTOR_BUSY");
    f.worker.finish("error_max_turns", 2);
    expect(() => reconcile(f, 2)).toThrow("CONTRACT");
    expect(() => reconcile(f)).toThrow();
    expect(f.run.tasks[0].state).toBe("budget_exhausted");
  });
});

describe("explicit expired-run resume renewal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  /** Dispatch once, finish in error, and let the model-execution window expire. */
  async function expired(f: ReturnType<typeof fixture>, subtitle = "error_during_execution") {
    await f.controller.dispatch(f.run.id, "a", "first");
    f.worker.finish(subtitle, 2);
    f.run.deadline = Date.now() - 5000;
    return { deadline: f.run.deadline, task: JSON.stringify(f.run.tasks[0]) };
  }
  it("renews an expired window through explicit resume, then dispatches the same conversation", async () => {
    const f = fixture();
    const { deadline, task } = await expired(f);
    const budgetBefore = { ...f.run.turnBudget };
    const sessionId = f.run.sessionId;
    await expect(
      f.controller.dispatch(f.run.id, "a", "expired", undefined, { mode: "continue" })
    ).rejects.toThrow("RUN_DEADLINE");
    expect(f.run.deadline).toBe(deadline);
    const resumed = await f.controller.session(f.run.id, "resume", {
      evidence: "User explicitly resumes this task after long idle",
    });
    expect(resumed.renewal).toMatchObject({
      source: "explicit_session_resume",
      previousDeadline: deadline,
      requestedRunTimeoutMs: undefined,
      renewalCount: 1,
    });
    expect(resumed.deadline - Date.now()).toBeGreaterThan(7199000);
    expect(f.run.deadline).toBe(resumed.deadline);
    // Only time moved: native conversation, contracts, revisions and the turn budget are intact.
    expect(f.run.sessionId).toBe(sessionId);
    expect(f.run.turnBudget).toEqual(budgetBefore);
    expect(f.run.tasks[0].revision).toBe(1);
    expect(JSON.stringify(f.run.tasks[0])).toBe(task);
    await continueTask(f, "after-renewal");
    expect(f.run.tasks[0].state).toBe("running");
    expect(f.run.tasks[0].attempts).toBe(2);
    expect(f.run.tasks[0].repairs).toBe(0);
    expect(
      f.run.events.filter((event) => event.type === "session_policy").at(-1)?.data
    ).toMatchObject({ action: "resume", renewal: { deadline: resumed.deadline } });
  });
  it("cold-resumes the saved native conversation with a validated custom window", async () => {
    const f = fixture();
    const { deadline } = await expired(f);
    expect(f.worker.resumeIds.at(-1)).toBeUndefined();
    const resumed = await f.controller.session(f.run.id, "resume", {
      evidence: "Explicit resume with a shorter authorized window",
      runTimeoutMs: 600000,
    });
    expect(resumed.renewal).toMatchObject({
      previousDeadline: deadline,
      requestedRunTimeoutMs: 600000,
    });
    expect(resumed.deadline - Date.now()).toBeGreaterThan(599000);
    expect(resumed.deadline - Date.now()).toBeLessThanOrEqual(600000);
    expect(budget(f.run).limit).toBe(1000);
    // A cold execution restarts the configured model against the SAME native session id.
    f.worker.start = Object.assign(
      async (
        _cwd: string,
        _prompt: string,
        _turns: number,
        _signal?: AbortSignal,
        resumeId?: string
      ) => {
        f.worker.starts++;
        f.worker.resumeIds.push(resumeId);
        return resumeId ?? "session";
      },
      {}
    );
    // The fixture worker loses liveness after finish, so dispatch takes the resume path.
    (f.worker as unknown as { model: () => string | undefined }).model = () => undefined;
    await continueTask(f, "cold-resume");
    expect(f.worker.resumeIds.at(-1)).toBe("session");
    expect(f.run.sessionId).toBe("session");
    expect(budget(f.run).limit).toBe(1000);
    expect(f.run.tasks[0].revision).toBe(1);
  });
  it("cannot shorten a live window and keeps an ordinary resume at the current deadline", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.worker.finish("success", 2);
    const deadline = f.run.deadline;
    const plain = await f.controller.session(f.run.id, "resume");
    expect(plain.renewal).toBeUndefined();
    expect(plain.deadline).toBe(deadline);
    const renewed = await f.controller.session(f.run.id, "resume", {
      evidence: "Authorized long continuation",
      runTimeoutMs: 1000,
    });
    expect(renewed.deadline).toBe(deadline);
    expect(renewed.renewal?.previousDeadline).toBe(deadline);
    expect(f.run.renewals).toHaveLength(1);
  });
  it("requires evidence and a bounded window for a renewal", async () => {
    const f = fixture();
    const { deadline } = await expired(f);
    await expect(f.controller.session(f.run.id, "resume", { evidence: "   " })).rejects.toThrow(
      "RENEWAL_EVIDENCE_REQUIRED"
    );
    await expect(
      f.controller.session(f.run.id, "resume", { evidence: "authorized", runTimeoutMs: 999 })
    ).rejects.toThrow("INVALID_RENEWAL_WINDOW");
    await expect(
      f.controller.session(f.run.id, "resume", { evidence: "authorized", runTimeoutMs: 7200001 })
    ).rejects.toThrow("INVALID_RENEWAL_WINDOW");
    await expect(
      f.controller.session(f.run.id, "retain", { runTimeoutMs: 600000 })
    ).rejects.toThrow("BUDGET_CONFIG_CREATE_ONLY");
    expect(f.run.deadline).toBe(deadline);
    expect(f.run.renewals ?? []).toHaveLength(0);
  });
  it("blocks renewal while an execution, review, startup drain or foreign owner holds the run", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.run.deadline = Date.now() - 1;
    await expect(
      f.controller.session(f.run.id, "resume", { evidence: "authorized while busy" })
    ).rejects.toThrow("SESSION_BUSY");
    f.worker.finish("error_max_turns", 2);
    f.run.deadline = Date.now() - 1;
    // Review admission is a real workspace lease; simulate the live review set directly.
    (f.controller as unknown as { reviewing: Set<string> }).reviewing.add(f.run.id);
    await expect(
      f.controller.session(f.run.id, "resume", { evidence: "authorized during review" })
    ).rejects.toThrow("SESSION_BUSY");
    (f.controller as unknown as { reviewing: Set<string> }).reviewing.delete(f.run.id);
    const foreign = new Orchestrator(path.join(f.cwd, "ledger"), new FixtureWorker());
    dispose.push(() => foreign.close());
    await expect(
      foreign.session(f.run.id, "resume", { evidence: "foreign connection renewal" })
    ).rejects.toThrow("RUN_OWNED_BY_ANOTHER_CONNECTION");
    expect(f.run.renewals ?? []).toHaveLength(0);
  });
  it("blocks renewal while a startup is draining", async () => {
    const f = fixture();
    const { deadline } = await expired(f);
    const draining = { valid: false };
    (f.controller as unknown as { startups: Map<string, unknown> }).startups.set(
      f.run.id,
      draining
    );
    await expect(
      f.controller.session(f.run.id, "resume", { evidence: "authorized but draining" })
    ).rejects.toThrow("EXECUTOR_STARTUP_DRAINING");
    (f.controller as unknown as { startups: Map<string, unknown> }).startups.clear();
    expect(f.run.deadline).toBe(deadline);
    await expect(
      f.controller.session(f.run.id, "resume", { evidence: "authorized after drain" })
    ).resolves.toMatchObject({ renewal: { previousDeadline: deadline } });
  });
  it("does not renew on a failed worker, reopen or append, and survives reload/attach", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.worker.finish("error_during_execution", 2);
    const failed = f.run.deadline;
    expect(f.run.deadline).toBe(failed);
    await expect(f.controller.dispatch(f.run.id, "a", "after-failure")).resolves.toBeDefined();
    f.worker.finish("error_during_execution", 2);
    expect(f.run.renewals ?? []).toHaveLength(0);
    const expiredAt = Date.now() - 1;
    f.run.deadline = expiredAt;
    f.controller.plan({ action: "reopen", runId: f.run.id });
    f.controller.plan({ action: "append", runId: f.run.id, tasks: [{ ...f.spec, id: "new" }] });
    expect(f.run.deadline).toBe(expiredAt);
    await expect(f.controller.dispatch(f.run.id, "new", "expired")).rejects.toThrow("RUN_DEADLINE");
    const renewed = await f.controller.session(f.run.id, "resume", {
      evidence: "User reopens the old task after an idle day",
    });
    const saved = JSON.parse(JSON.stringify(f.run));
    saved.ownerPid = 99999999;
    f.controller.close();
    writeFileSync(path.join(f.cwd, "ledger", `run-${f.run.id}.json`), JSON.stringify(saved));
    const restored = new Orchestrator(path.join(f.cwd, "ledger"), new FixtureWorker());
    dispose.push(() => restored.close());
    restored.attach(f.run.id);
    const recovered = restored.status(f.run.id);
    if (Array.isArray(recovered)) throw new Error("Expected one run");
    expect(recovered.deadline).toBe(renewed.deadline);
    expect(recovered.renewals).toHaveLength(1);
    expect(recovered.renewals?.[0]).toMatchObject({
      source: "explicit_session_resume",
      evidence: "User reopens the old task after an idle day",
      previousDeadline: renewed.renewal?.previousDeadline,
    });
    expect(recovered.turnBudget).toEqual(f.run.turnBudget);
    expect(recovered.tasks[0].revision).toBe(1);
    expect(recovered.tasks[0].checks).toEqual(f.spec.checks);
  });
});
