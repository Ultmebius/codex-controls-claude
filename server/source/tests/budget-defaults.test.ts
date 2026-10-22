import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator, type Run, type TaskSpec } from "../src/orchestrator/controller.js";
import { TeamCoordinator } from "../src/orchestrator/team.js";
import type { Worker, WorkerEvent } from "../src/orchestrator/worker.js";
import type { AgentResult, SessionEvent } from "../src/types.js";

class FixtureWorker implements Worker {
  listener?: (event: WorkerEvent) => void;
  final?: AgentResult;
  grants: number[] = [];
  count = 0;
  subscribe(listener: (event: WorkerEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  async start(_cwd: string, _prompt: string, turns: number) {
    this.grants.push(turns);
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
  finish(subtype = "success", numTurns = 2) {
    this.final = {
      sessionId: "session",
      result: "done",
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

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function spec(): TaskSpec {
  return {
    id: "a",
    title: "answer",
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
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccc-defaults-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"),
    data = path.join(root, "ledger");
  mkdirSync(cwd);
  const worker = new FixtureWorker(),
    controller = new Orchestrator(data, worker);
  cleanups.push(() => controller.close());
  return { root, cwd, data, worker, controller };
}

describe("orchestration budget defaults", () => {
  it("creates a run with the raised native segment and persistent run defaults", () => {
    const f = fixture();
    const run = f.controller.plan({
      action: "create",
      cwd: f.cwd,
      goal: "goal",
      design: "design",
      tasks: [spec()],
    });
    expect(run.maxTurns).toBe(500);
    expect(run.turnBudget).toMatchObject({ limit: 1000, used: 0, reserved: 0 });
  });

  it("grants the raised default segment cap on a continuation that supplies no cap", async () => {
    const f = fixture();
    const run = f.controller.plan({
      action: "create",
      cwd: f.cwd,
      goal: "goal",
      design: "design",
      tasks: [spec()],
    });
    await f.controller.dispatch(run.id, "a", "first");
    f.worker.finish("error_max_turns", 3);
    expect(run.tasks[0].state).toBe("budget_exhausted");
    await f.controller.dispatch(run.id, "a", "second", undefined, { mode: "continue" });
    expect(f.worker.grants).toEqual([500, 500]);
    expect(run.turnBudget).toMatchObject({ used: 3, reserved: 501 });
  });

  it("preserves explicit create budgets across a reload instead of redefaulting", () => {
    const f = fixture();
    const run = f.controller.plan({
      action: "create",
      cwd: f.cwd,
      goal: "goal",
      design: "design",
      tasks: [spec()],
      maxTurns: 7,
      maxTotalTurns: 33,
    });
    expect(run.maxTurns).toBe(7);
    expect(run.turnBudget.limit).toBe(33);
    f.controller.close();
    const restored = new Orchestrator(f.data, new FixtureWorker());
    cleanups.push(() => restored.close());
    const reloaded = restored.status(run.id) as Run;
    expect(reloaded.maxTurns).toBe(7);
    expect(reloaded.turnBudget).toMatchObject({ limit: 33, used: 0, reserved: 0 });
  });

  it("keeps a pre-budget ledger on its historical cap and accounting", async () => {
    const f = fixture();
    const run = f.controller.plan({
      action: "create",
      cwd: f.cwd,
      goal: "goal",
      design: "design",
      tasks: [spec()],
      maxTurns: 50,
    });
    await f.controller.dispatch(run.id, "a", "first");
    f.worker.finish("success", 3);
    f.controller.close();
    const file = path.join(f.data, `run-${run.id}.json`);
    const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Run>;
    delete saved.turnBudget;
    expect(saved.maxTurns).toBe(50);
    expect(saved.tasks?.[0].attempts).toBe(1);
    writeFileSync(file, JSON.stringify(saved));

    const worker = new FixtureWorker();
    const restored = new Orchestrator(f.data, worker);
    cleanups.push(() => restored.close());
    const reloaded = restored.status(run.id) as Run;
    expect(reloaded.turnBudget).toMatchObject({ limit: 200, used: 3, reserved: 0 });
    expect(reloaded.turnBudget.estimated ?? 0).toBe(0);
    expect(reloaded.maxTurns).toBe(50);
    expect(reloaded.tasks[0].attempts).toBe(1);
    expect(reloaded.tasks[0].result?.numTurns).toBe(3);
    expect(worker.grants).toEqual([]);
  });

  it("defaults teams to the raised shared allowance and per-segment cap", async () => {
    const f = fixture();
    const workers: FixtureWorker[] = [];
    const coordinator = new TeamCoordinator(f.data, () => {
      const worker = new FixtureWorker();
      workers.push(worker);
      return new Orchestrator(path.join(f.data, `child-${workers.length}`), worker);
    });
    cleanups.push(() => coordinator.close());
    const team = coordinator.create({
      cwd: f.cwd,
      goal: "goal",
      design: "design",
      tasks: [spec()],
    });
    expect(coordinator.status(team.teamId)).toMatchObject({
      turnBudget: { limit: 1000, used: 0, reserved: 0 },
    });
    await coordinator.dispatch(team.teamId, "a", "first");
    const child = coordinator
      .controllerFor(team.tasks[0].childRunId)!
      .status(team.tasks[0].childRunId) as Run;
    expect(child.executions?.[0]).toMatchObject({ requestedLimit: 500, effectiveLimit: 500 });
  });

  it("clamps the default segment cap to the remaining persistent headroom", async () => {
    const f = fixture();
    const run = f.controller.plan({
      action: "create",
      cwd: f.cwd,
      goal: "goal",
      design: "design",
      tasks: [spec()],
      maxTotalTurns: 30,
    });
    await f.controller.dispatch(run.id, "a", "first");
    expect(run.maxTurns).toBe(500);
    expect(f.worker.grants).toEqual([29]);
    expect(run.turnBudget).toMatchObject({ limit: 30, used: 0, reserved: 30 });
    expect(run.executions?.[0]).toMatchObject({ requestedLimit: 500, effectiveLimit: 29 });
  });

  it("keeps an explicit 200 segment cap instead of applying the default", async () => {
    const f = fixture();
    const run = f.controller.plan({
      action: "create",
      cwd: f.cwd,
      goal: "goal",
      design: "design",
      tasks: [spec()],
      maxTurns: 200,
    });
    await f.controller.dispatch(run.id, "a", "first");
    expect(run.maxTurns).toBe(200);
    expect(f.worker.grants).toEqual([200]);
    expect(run.turnBudget).toMatchObject({ used: 0, reserved: 201 });
  });
});
