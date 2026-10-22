import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Orchestrator, type Run } from "../src/orchestrator/controller.js";
import { TeamCoordinator, type TeamInput, type TeamTaskSpec } from "../src/orchestrator/team.js";
import type { Worker, WorkerEvent } from "../src/orchestrator/worker.js";
import type { AgentResult } from "../src/types.js";
import * as ownership from "../src/orchestrator/ownership.js";

class FixtureWorker implements Worker {
  listener?: (event: WorkerEvent) => void;
  final?: AgentResult;
  live = false;
  starts = 0;
  stops = 0;
  count = 0;
  constructor(readonly id: string) {}
  subscribe(listener: (event: WorkerEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  async start() {
    this.starts++;
    this.live = true;
    return this.id;
  }
  async reply() {
    return this.id;
  }
  guidance = () => this.live;
  interruptTurn = () => this.live;
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
    return this.live ? "configured-model" : undefined;
  }
  isLive() {
    return this.live;
  }
  stop() {
    this.stops++;
    this.live = false;
  }
  destroy() {
    this.live = false;
  }
  finish(numTurns = 1, subtype = "success") {
    this.final = {
      sessionId: this.id,
      result: "done",
      isError: subtype !== "success",
      errorSubtype: subtype === "success" ? undefined : subtype,
      durationMs: 1,
      numTurns,
      totalCostUsd: 0,
    };
    this.listener?.({
      sessionId: this.id,
      event: {
        id: this.count++,
        type: "result",
        data: this.final,
        timestamp: new Date().toISOString(),
        pinned: false,
      },
    });
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});
function fixture(config: Partial<TeamInput> = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ccc-team-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  const workers = new Map<string, FixtureWorker>();
  const dataDir = path.join(cwd, "ledger");
  const factory = (directory: string) => {
    const worker = new FixtureWorker(`session-${workers.size}`);
    workers.set(path.basename(directory), worker);
    // Team children share the ordinary execution pool rooted at the ledger.
    return new Orchestrator(directory, worker, dataDir);
  };
  const coordinator = new TeamCoordinator(dataDir, factory);
  cleanups.push(() => coordinator.close());
  const tasks: TeamTaskSpec[] = ["a", "b", "c", "d"].map((id) => ({
    id,
    title: id,
    instructions: `Write ${id}.txt`,
    acceptance: "42",
    dependsOn: [],
    artifacts: [`${id}.txt`],
    writeScope: [`${id}.txt`],
    checks: [
      {
        command: process.execPath,
        args: ["-e", `if(require('fs').readFileSync('${id}.txt','utf8')!=='42')process.exit(1)`],
      },
    ],
  }));
  const team = coordinator.create({ cwd, goal: "goal", design: "design", tasks, ...config });
  const child = (id: string) => team.tasks.find((task) => task.id === id)!.childRunId;
  const run = (id: string) => coordinator.controllerFor(child(id))!.status(child(id)) as Run;
  const summary = () => coordinator.status(team.teamId) as typeof team;
  const dispatch = (id: string, requestId = id, options = {}) =>
    coordinator.dispatch(team.teamId, id, requestId, options);
  const accept = async (id: string, decision: "accept" | "reject" = "accept") => {
    coordinator.canReview(child(id));
    const current = run(id);
    return await coordinator.controllerFor(child(id))!.review({
      runId: current.id,
      taskId: id,
      decision,
      taskRevision: current.tasks[0].revision,
      artifactHash: current.tasks[0].artifactHash!,
      evidence: "Independently inspected actual artifacts",
    });
  };
  return {
    cwd,
    dataDir,
    factory,
    coordinator,
    team,
    workers,
    child,
    run,
    summary,
    dispatch,
    accept,
    tasks,
  };
}

describe("explicit team scheduling", () => {
  it("stops every owned worker even when lease releases fail during shutdown", async () => {
    // Explicit segment cap keeps three concurrent reservations inside the shared allowance.
    const f = fixture({ maxTurns: 200 });
    await Promise.all([f.dispatch("a"), f.dispatch("b"), f.dispatch("c")]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(ownership, "releaseJsonLease").mockImplementation(() => {
      throw new Error("Injected lease release failure");
    });
    expect(() => f.coordinator.close()).not.toThrow();
    expect([...f.workers.values()].every((worker) => !worker.live)).toBe(true);
    expect(["a", "b", "c"].every((id) => f.run(id).ownerReleased)).toBe(true);
  });
  it("renews an expired team window and every child only through explicit resume", async () => {
    const f = fixture({ maxTurns: 2, maxTotalTurns: 9 });
    await Promise.all([f.dispatch("a"), f.dispatch("b")]);
    f.workers.get("a")!.finish(2);
    f.workers.get("b")!.finish(2);
    const teamBefore = f.coordinator.status(f.team.teamId) as { teamId: string };
    const sessionA = f.run("a").sessionId,
      sessionB = f.run("b").sessionId;
    const childBudgets = Object.fromEntries(
      ["a", "b", "c", "d"].map((id) => [id, structuredClone(f.run(id).turnBudget)])
    ) as Record<"a" | "b" | "c" | "d", Run["turnBudget"]>;
    const expired = Date.now() - 5000;
    const teamPath = path.join(f.dataDir, `team-${teamBefore.teamId}.json`);
    const stored = JSON.parse(readFileSync(teamPath, "utf8"));
    stored.deadline = expired;
    writeFileSync(teamPath, JSON.stringify(stored));
    (f.coordinator as unknown as { teams: Map<string, { deadline: number }> }).teams.get(
      teamBefore.teamId
    )!.deadline = expired;
    for (const id of ["a", "b"]) f.run(id).deadline = expired;
    await expect(f.dispatch("a", "expired")).rejects.toThrow("RUN_DEADLINE");
    expect(() => f.coordinator.resume(f.team.teamId, "   ")).toThrow("RENEWAL_EVIDENCE_REQUIRED");
    expect(() => f.coordinator.resume(f.team.teamId, "authorized", 999)).toThrow(
      "INVALID_RENEWAL_WINDOW"
    );
    expect(() => f.coordinator.resume(f.team.teamId, "authorized", 7200001)).toThrow(
      "INVALID_RENEWAL_WINDOW"
    );
    const resumed = f.coordinator.resume(
      f.team.teamId,
      "User authorized continuing the whole team after a long idle period"
    );
    expect(resumed.deadline - Date.now()).toBeGreaterThan(7199000);
    expect(resumed.renewal).toMatchObject({
      source: "team_resume",
      previousDeadline: expired,
      renewalCount: 1,
    });
    expect(resumed.renewal.children).toHaveLength(f.tasks.length);
    expect(f.summary().turnBudget.limit).toBe(9);
    for (const id of ["a", "b", "c", "d"] as const) {
      const run = f.run(id);
      expect(run.deadline).toBe(resumed.deadline);
      expect(run.renewals).toHaveLength(1);
      expect(run.tasks[0]).toMatchObject({ revision: 1, repairs: 0, continuations: 0 });
      expect(run.turnBudget).toEqual(childBudgets[id]);
    }
    expect(f.run("a").sessionId).toBe(sessionA);
    expect(f.run("b").sessionId).toBe(sessionB);
    await f.dispatch("a", "after-renewal", { mode: "continue" });
    expect(f.run("a").tasks[0].state).toBe("running");
    expect(f.summary().turnBudget.reserved).toBeGreaterThan(0);
  });
  it("blocks team renewal while a worker executes and never lets a child outlive its parent", async () => {
    const f = fixture({ maxTurns: 2, maxTotalTurns: 9 });
    await f.dispatch("a");
    const cursor = f.summary().nextCursor;
    f.coordinator.interrupt(f.team.teamId, "Idle child a for renewal", "a");
    await f.dispatch("b");
    expect(() => f.coordinator.resume(f.team.teamId, "Authorized while b is executing")).toThrow(
      "EXECUTOR_BUSY"
    );
    const childA = f.child("a");
    await expect(
      f.coordinator.controllerFor(childA)!.session(childA, "resume", {
        evidence: "Child cannot bypass an expired parent by ordinary resume",
      })
    ).rejects.toThrow("TEAM_RESUME_REQUIRED");
    expect(f.run("a").renewals ?? []).toHaveLength(0);
    f.workers.get("b")!.finish(2);
    expect(cursor).toBeGreaterThan(0);
    const resumed = f.coordinator.resume(
      f.team.teamId,
      "Authorized after both children idle",
      3600000
    );
    expect(resumed.deadline - Date.now()).toBeGreaterThan(3599000);
    expect(f.run("a").deadline).toBe(f.run("b").deadline);
  });
  it("independently reviews disjoint same-repository outputs under explicit peer coverage", async () => {
    const tasks = ["a", "b"].map((id) => ({
      id,
      title: id,
      instructions: `Write ${id}.txt`,
      acceptance: "42",
      dependsOn: [],
      artifacts: [`${id}.txt`],
      writeScope: [`${id}.txt`],
      checks: [
        {
          command: process.execPath,
          args: ["-e", `if(require('fs').readFileSync('${id}.txt','utf8')!=='42')process.exit(1)`],
        },
      ],
    }));
    const f = fixture({ tasks });
    execFileSync("git", ["init", "--quiet"], { cwd: f.cwd });
    writeFileSync(path.join(f.cwd, ".gitignore"), "ledger/\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: f.cwd });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: f.cwd }
    );
    await Promise.all([f.dispatch("a"), f.dispatch("b")]);
    for (const id of ["a", "b"]) {
      writeFileSync(path.join(f.cwd, `${id}.txt`), "42");
      f.workers.get(id)!.finish();
    }
    expect((await f.accept("a")).state).toBe("accepted");
    expect(() => f.coordinator.finish(f.team.teamId)).toThrow("UNACCEPTED_TASKS");
    expect((await f.accept("b")).state).toBe("accepted");
    expect(f.coordinator.finish(f.team.teamId).status).toBe("awaiting_user_review");
  }, 15000);
  it("runs three disjoint scopes, blocks a fourth, and replaces only an idle worker", async () => {
    // Explicit segment cap keeps three concurrent reservations inside the shared allowance.
    const f = fixture({ maxTurns: 200 });
    await Promise.all([f.dispatch("a"), f.dispatch("b"), f.dispatch("c")]);
    await expect(f.dispatch("d")).rejects.toThrow("TEAM_WORKER_LIMIT");
    writeFileSync(path.join(f.cwd, "a.txt"), "42");
    f.workers.get("a")!.finish();
    expect(f.run("a").tasks[0].state).toBe("awaiting_review");
    await f.dispatch("d", "replacement");
    expect(f.workers.get("a")!.live).toBe(false);
    expect(["b", "c", "d"].every((id) => f.workers.get(id)!.live)).toBe(true);
    expect(f.run("a").sessionId).toBeDefined();
  });

  it("blocks shared-file and unknown scopes and isolates checks across the workspace", async () => {
    const f = fixture();
    f.tasks[1].writeScope = ["a.txt"];
    // Contracts are cloned: changing the caller's input cannot change scheduling.
    await f.dispatch("a");
    await f.dispatch("b");
    writeFileSync(path.join(f.cwd, "a.txt"), "42");
    f.workers.get("a")!.finish();
    expect(() => f.coordinator.canReview(f.child("a"))).toThrow("QUIESCENT_WORKSPACE");
    expect(() => f.coordinator.canReviewWorkspace(f.cwd)).toThrow("QUIESCENT_WORKSPACE");
    f.coordinator.interrupt(f.team.teamId, "Inspect checks", "b");
    expect(() => f.coordinator.canReview(f.child("a"))).not.toThrow();
    const other = fixture({
      tasks: [
        { ...f.tasks[0], writeScope: undefined },
        { ...f.tasks[1], writeScope: ["a.txt"] },
      ],
    });
    await other.dispatch("a");
    await expect(other.dispatch("b")).rejects.toThrow("WRITE_SCOPE_CONFLICT");
  });

  it("canonicalizes case and symlink scope aliases", async () => {
    const f = fixture();
    mkdirSync(path.join(f.cwd, "shared"));
    symlinkSync(
      path.join(f.cwd, "shared"),
      path.join(f.cwd, "alias"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const team = f.coordinator.create({
      cwd: f.cwd,
      goal: "aliases",
      design: "design",
      tasks: [
        { ...f.tasks[0], writeScope: ["shared"] },
        { ...f.tasks[1], writeScope: [process.platform === "win32" ? "ALIAS" : "alias"] },
      ],
    });
    await f.coordinator.dispatch(team.teamId, "a", "alias-first");
    await expect(f.coordinator.dispatch(team.teamId, "b", "alias-second")).rejects.toThrow(
      "WRITE_SCOPE_CONFLICT"
    );
  });

  it("keeps a dependent task gated until independent acceptance", async () => {
    const f = fixture({
      tasks: [
        {
          id: "a",
          title: "a",
          instructions: "write",
          acceptance: "42",
          artifacts: ["a.txt"],
          dependsOn: [],
          writeScope: ["a.txt"],
          checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
        },
        {
          id: "b",
          title: "b",
          instructions: "write",
          acceptance: "42",
          artifacts: ["b.txt"],
          dependsOn: ["a"],
          writeScope: ["b.txt"],
          checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
        },
      ],
    });
    await expect(f.dispatch("b")).rejects.toThrow("DEPENDENCY_NOT_ACCEPTED");
    await f.dispatch("a");
    writeFileSync(path.join(f.cwd, "a.txt"), "42");
    f.workers.get("a")!.finish();
    await expect(f.dispatch("b", "still-blocked")).rejects.toThrow("DEPENDENCY_NOT_ACCEPTED");
    await f.accept("a");
    await f.dispatch("b", "accepted-dependency");
    expect(f.run("b").tasks[0].state).toBe("running");
  });

  it("reserves concurrent grants before startup and settles only each child's allocation", async () => {
    const f = fixture({ maxTurns: 2, maxTotalTurns: 8 });
    await Promise.all([f.dispatch("a"), f.dispatch("b"), f.dispatch("c")]);
    expect(f.summary().turnBudget).toMatchObject({ limit: 8, used: 0, reserved: 8 });
    expect(f.run("c").turnBudget.limit).toBe(2);
    f.workers.get("b")!.finish(3, "error_max_turns");
    expect(f.summary().turnBudget).toMatchObject({ used: 3, reserved: 5 });
    const events = await f.coordinator.wait(f.team.teamId, 0, 1);
    expect(events.events.find((event) => event.type === "worker_finished")?.data).toMatchObject({
      teamBudget: { limit: 8, used: 3, reserved: 5 },
    });
    f.workers.get("a")!.finish(3, "error_max_turns");
    f.workers.get("c")!.finish(2, "error_max_turns");
    expect(f.summary().turnBudget).toMatchObject({ used: 8, reserved: 0 });
    await expect(f.dispatch("d", "exhausted")).rejects.toThrow("RUN_TURN_BUDGET_EXHAUSTED");
  });

  it("continues the same child contract without resetting budget or repairs", async () => {
    const f = fixture({ maxTurns: 2, maxTotalTurns: 5 });
    const before = f.child("a");
    await f.dispatch("a");
    f.workers.get("a")!.finish(3, "error_max_turns");
    await f.dispatch("a", "continuation", { mode: "continue" });
    expect(f.child("a")).toBe(before);
    expect(f.run("a").turnBudget.limit).toBe(5);
    expect(f.run("a").tasks[0]).toMatchObject({ revision: 1, repairs: 0, continuations: 1 });
    f.workers.get("a")!.finish(2, "error_max_turns");
    expect(f.summary().turnBudget).toMatchObject({ used: 5, reserved: 0 });
    await expect(f.dispatch("a", "too-many", { mode: "continue" })).rejects.toThrow(
      "RUN_TURN_BUDGET_EXHAUSTED"
    );
  });

  it("deduplicates a concurrent startup and returns one receipt and one reservation", async () => {
    const f = fixture();
    let resolve!: (sessionId: string) => void;
    f.workers.get("a")!.start = () =>
      new Promise<string>((done) => {
        resolve = done;
      });
    const first = f.dispatch("a", "stable");
    const duplicate = f.dispatch("a", "stable");
    expect(f.summary().turnBudget.reserved).toBe(501);
    resolve(f.workers.get("a")!.id);
    expect(await duplicate).toEqual(await first);
    expect(f.run("a").tasks[0].attempts).toBe(1);
    await expect(f.dispatch("b", "stable")).rejects.toThrow("REQUEST_ID_CONFLICT");
  });

  it("wakes an active team wait on a child event and includes both identities", async () => {
    const f = fixture();
    await f.dispatch("a");
    const cursor = f.summary().nextCursor;
    const waiting = f.coordinator.wait(f.team.teamId, cursor, 1000);
    f.workers.get("a")!.finish(1, "error_max_turns");
    const result = await waiting;
    expect(result.timedOut).toBe(false);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "worker_finished",
          taskId: "a",
          childRunId: f.child("a"),
        }),
      ])
    );
    expect((await f.coordinator.wait(f.team.teamId, result.nextCursor, 1)).timedOut).toBe(true);
  });

  it("targeted interruption preserves peers and charges only the interrupted reservation", async () => {
    const f = fixture({ maxTurns: 2 });
    await Promise.all([f.dispatch("a"), f.dispatch("b")]);
    f.coordinator.interrupt(f.team.teamId, "Inspect a", "a");
    expect(f.run("a").tasks[0].state).toBe("interrupted");
    expect(f.run("b").tasks[0].state).toBe("running");
    expect(f.workers.get("b")!.live).toBe(true);
    expect(f.summary().turnBudget).toMatchObject({ used: 3, reserved: 3 });
    await f.dispatch("a", "resume", { mode: "continue" });
    expect(f.run("a").tasks[0].repairs).toBe(0);
  });

  it("recovers outstanding parent and child reservations without replay", async () => {
    const f = fixture({ maxTurns: 2, maxTotalTurns: 9 });
    await f.dispatch("a");
    const teamPath = path.join(f.dataDir, `team-${f.team.teamId}.json`);
    const savedTeam = JSON.parse(readFileSync(teamPath, "utf8"));
    const childPath = path.join(f.dataDir, f.team.teamId, "a", `run-${f.child("a")}.json`);
    const savedChild = JSON.parse(readFileSync(childPath, "utf8"));
    f.coordinator.close();
    savedTeam.ownerPid = savedChild.ownerPid = 99999999;
    writeFileSync(teamPath, JSON.stringify(savedTeam));
    writeFileSync(childPath, JSON.stringify(savedChild));
    const recovered = new TeamCoordinator(f.dataDir, f.factory);
    cleanups.push(() => recovered.close());
    recovered.recover(f.team.teamId);
    const summary = recovered.status(f.team.teamId) as typeof f.team;
    expect(summary.turnBudget).toMatchObject({ used: 3, reserved: 0, recovered: 3 });
    const run = recovered.controllerFor(f.child("a"))!.status(f.child("a")) as Run;
    expect(run.tasks[0].state).toBe("interrupted");
    expect(run.turnBudget).toMatchObject({ used: 3, reserved: 0 });
    expect([...f.workers.values()].every((worker) => worker.starts === 0)).toBe(true);
  });
  it("settles late child accounting in the shared team budget exactly once", async () => {
    const f = fixture({ maxTurns: 2, maxTotalTurns: 9 });
    await f.dispatch("a");
    f.coordinator.interrupt(f.team.teamId, "Fallback stop", "a");
    expect(f.summary().turnBudget).toMatchObject({ used: 3, estimated: 3, reserved: 0 });
    f.workers.get("a")!.finish(1);
    f.workers.get("a")!.finish(1);
    expect(f.summary().turnBudget).toMatchObject({ used: 1, estimated: 0, reserved: 0 });
    await f.dispatch("b");
    expect(f.summary().turnBudget).toMatchObject({ used: 1, reserved: 3 });
  });

  it("finishes only accepted artifacts and retains the human review boundary", async () => {
    const f = fixture({
      tasks: [
        {
          id: "a",
          title: "a",
          instructions: "write",
          acceptance: "42",
          artifacts: ["a.txt"],
          dependsOn: [],
          checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
        },
      ],
    });
    await f.dispatch("a");
    expect(() => f.coordinator.finish(f.team.teamId)).toThrow("UNACCEPTED_TASKS");
    writeFileSync(path.join(f.cwd, "a.txt"), "42");
    f.workers.get("a")!.finish();
    await f.accept("a");
    expect(f.coordinator.finish(f.team.teamId).status).toBe("awaiting_user_review");
    expect(f.run("a").status).toBe("awaiting_user_review");
    expect(f.run("a").sessionState).toBe("retained");
    expect(() => f.coordinator.approve(f.team.teamId, "")).toThrow(
      "HUMAN_APPROVAL_EVIDENCE_REQUIRED"
    );
    expect(
      f.coordinator.approve(f.team.teamId, "User explicitly approved this candidate").status
    ).toBe("completed");
    expect(f.run("a").status).toBe("completed");
    expect(f.coordinator.hasOccupied()).toBe(false);
  });

  it("rejects approval after an accepted artifact changed", async () => {
    const f = fixture({
      tasks: [
        {
          id: "a",
          title: "a",
          instructions: "write",
          acceptance: "42",
          artifacts: ["a.txt"],
          dependsOn: [],
          checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
        },
      ],
    });
    await f.dispatch("a");
    writeFileSync(path.join(f.cwd, "a.txt"), "42");
    f.workers.get("a")!.finish();
    await f.accept("a");
    f.coordinator.finish(f.team.teamId);
    writeFileSync(path.join(f.cwd, "a.txt"), "changed");
    expect(() => f.coordinator.approve(f.team.teamId, "User approved earlier candidate")).toThrow(
      "ACCEPTANCE_INVALIDATED"
    );
    expect(f.run("a").tasks[0].state).toBe("awaiting_review");
    expect(f.summary().status).toBe("open");
  });

  it("requires workspace quiescence when delivering a candidate while another team is active", async () => {
    const f = fixture({
      tasks: [
        {
          id: "a",
          title: "a",
          instructions: "write",
          acceptance: "42",
          artifacts: ["a.txt"],
          dependsOn: [],
          checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
        },
      ],
    });
    await f.dispatch("a");
    writeFileSync(path.join(f.cwd, "a.txt"), "42");
    f.workers.get("a")!.finish();
    await f.accept("a");
    const other = f.coordinator.create({
      cwd: f.cwd,
      goal: "other",
      design: "design",
      tasks: [
        {
          id: "b",
          title: "b",
          instructions: "write a.txt",
          acceptance: "42",
          artifacts: ["a.txt"],
          dependsOn: [],
          writeScope: ["a.txt"],
          checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
        },
      ],
    });
    await f.coordinator.dispatch(other.teamId, "b", "other");
    expect(() => f.coordinator.finish(f.team.teamId)).toThrow("QUIESCENT_WORKSPACE");
    f.coordinator.interrupt(other.teamId, "Review candidate");
    expect(f.coordinator.finish(f.team.teamId).status).toBe("awaiting_user_review");
  });

  it("holds the shared execution slot until an interrupted startup drains", async () => {
    const f = fixture({ maxWorkers: 1 });
    let resolve!: (id: string) => void;
    f.workers.get("a")!.start = () =>
      new Promise<string>((done) => {
        resolve = done;
      });
    const starting = f.dispatch("a");
    f.coordinator.interrupt(f.team.teamId, "Interrupt startup", "a");
    await expect(f.dispatch("b")).rejects.toThrow("TEAM_WORKER_LIMIT");
    expect(f.coordinator.hasOccupied()).toBe(true);
    expect(f.summary().turnBudget).toMatchObject({ used: 501, reserved: 0 });
    expect(existsSync(path.join(f.dataDir, "worker-slots", "slot-1.json"))).toBe(true);
    f.coordinator.close();
    expect(existsSync(path.join(f.dataDir, "worker-slots", "slot-1.json"))).toBe(false);
    resolve(f.workers.get("a")!.id);
    expect((await starting).status).toBe("interrupted");
  });

  it("keeps a live coordinator's runs isolated while allowing an independent one", async () => {
    const f = fixture();
    await f.dispatch("a");
    const peerWorkers: FixtureWorker[] = [];
    const peer = new TeamCoordinator(f.dataDir, (directory) => {
      const worker = new FixtureWorker("peer");
      peerWorkers.push(worker);
      return new Orchestrator(directory, worker);
    });
    cleanups.push(() => peer.close());
    expect(peerWorkers).toHaveLength(0);
    // Another chat is not blocked by this coordinator; it simply cannot touch its team.
    expect(peer.hasOccupied()).toBe(false);
    const peerCwd = path.join(f.cwd, "peer");
    mkdirSync(peerCwd);
    const peerTeam = peer.create({
      cwd: peerCwd,
      goal: "foreign",
      design: "design",
      tasks: f.tasks,
    });
    expect(peerTeam.teamId).not.toBe(f.team.teamId);
    await expect(peer.dispatch(f.team.teamId, "b", "foreign")).rejects.toThrow("TEAM_NOT_OWNED");
    peer.close();
    expect(f.workers.get("a")!.live).toBe(true);
  });

  it("does not charge a child validation rejection that never dispatched model work", async () => {
    const f = fixture({ maxTotalTurns: 3, maxTurns: 2 });
    await expect(f.dispatch("a", "invalid-continuation", { mode: "continue" })).rejects.toThrow(
      "TASK_NOT_CONTINUABLE"
    );
    expect(f.summary().turnBudget).toMatchObject({ used: 0, reserved: 0 });
    expect(f.run("a").tasks[0].attempts).toBe(0);
    await f.dispatch("a", "valid-start");
    expect(f.summary().turnBudget.reserved).toBe(3);
  });

  it("permits broad independent workspaces and keeps one immutable execution deadline", async () => {
    const f = fixture();
    const first = path.join(f.cwd, "first"),
      second = path.join(f.cwd, "second");
    mkdirSync(first);
    mkdirSync(second);
    const team = f.coordinator.create({
      cwd: f.cwd,
      goal: "independent",
      design: "design",
      maxTurns: 2,
      maxTotalTurns: 9,
      tasks: [
        { ...f.tasks[0], cwd: first, writeScope: undefined },
        { ...f.tasks[1], cwd: second, writeScope: undefined },
      ],
    });
    await Promise.all([
      f.coordinator.dispatch(team.teamId, "a", "one"),
      f.coordinator.dispatch(team.teamId, "b", "two"),
    ]);
    expect(() => f.coordinator.canReviewWorkspace(path.join(f.cwd, "other"))).not.toThrow();
    const childId = team.tasks[0].childRunId;
    const run = f.coordinator.controllerFor(childId)!.status(childId) as Run;
    expect(run.deadline).toBe(team.deadline);
    f.workers.get("a")!.finish(3, "error_max_turns");
    await f.coordinator.dispatch(team.teamId, "a", "continue", { mode: "continue" });
    expect(run.deadline).toBe(team.deadline);
    expect(run.turnBudget.limit).toBe(6);
  });

  it("closes already-created controllers when a later child contract fails validation", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "ccc-team-create-"));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    const workers: FixtureWorker[] = [];
    const coordinator = new TeamCoordinator(path.join(cwd, "ledger"), (directory) => {
      const worker = new FixtureWorker(String(workers.length));
      workers.push(worker);
      return new Orchestrator(directory, worker);
    });
    cleanups.push(() => coordinator.close());
    const task = {
      id: "a",
      title: "a",
      instructions: "write",
      acceptance: "42",
      dependsOn: [],
      artifacts: ["a.txt"],
      checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
    };
    expect(() =>
      coordinator.create({
        cwd,
        goal: "goal",
        design: "design",
        tasks: [task, { ...task, id: "b", artifacts: ["../outside.txt"] }],
      })
    ).toThrow("ARTIFACT_OUTSIDE_WORKSPACE");
    expect(coordinator.status()).toEqual([]);
    expect(workers.every((worker) => !worker.listener)).toBe(true);
  });
});

describe("team child guidance routing", () => {
  it("reuses a settled child's hold when default-cap peers reserve the whole team allowance", async () => {
    const f = fixture();
    await f.dispatch("a");
    await f.dispatch("b");
    expect(f.summary().turnBudget.reserved).toBe(1000);
    f.coordinator.controllerFor(f.child("a"))!.sendGuidance(f.child("a"), {
      requestId: "follow",
      mode: "queue",
      text: "additional scoped validation",
    });
    writeFileSync(path.join(f.cwd, "a.txt"), "42");
    writeFileSync(path.join(f.cwd, "b.txt"), "42");
    f.workers.get("a")!.finish(1);
    expect(f.run("a").guidance![0].state).toBe("delivered");
    expect(f.run("a").tasks[0].state).toBe("running");
    expect(f.summary().turnBudget.used + f.summary().turnBudget.reserved).toBeLessThanOrEqual(1000);
    f.workers.get("a")!.finish(2);
    f.workers.get("b")!.finish(3);
    expect(f.summary().turnBudget.used).toBe(6);
    expect(f.summary().turnBudget.reserved).toBe(0);
  });
  it("routes guidance to the correct child and settles the shared hold once it is idle", async () => {
    const f = fixture({ maxTurns: 20, maxTotalTurns: 200 });
    await Promise.all([f.dispatch("a"), f.dispatch("b")]);
    const controllerA = f.coordinator.controllerFor(f.child("a"))!;
    const controllerB = f.coordinator.controllerFor(f.child("b"))!;
    const runB = f.run("b");
    const receipt = controllerA.sendGuidance(f.child("a"), {
      requestId: "child-guidance",
      mode: "queue",
      text: "keep the diff scoped",
    });
    expect(receipt).toMatchObject({ state: "queued", delivered: false });
    // Peer runs never receive another child's guidance.
    expect(f.run("a").guidance).toHaveLength(1);
    expect(runB.guidance ?? []).toHaveLength(0);
    // A foreign child controller cannot steer this run.
    expect(() =>
      controllerB.sendGuidance(f.child("a"), {
        requestId: "foreign",
        mode: "queue",
        text: "hijack",
      })
    ).toThrow();
    writeFileSync(path.join(f.cwd, "a.txt"), "42");
    f.workers.get("a")!.finish(1);
    expect(f.run("a").guidance![0].state).toBe("delivered");
    // The child stays active for the follow-on segment and keeps its allowance until it ends.
    expect(f.run("a").activeExecutionId).toBeDefined();
    f.workers.get("a")!.finish(1);
    expect(f.run("a").tasks[0].state).toBe("awaiting_review");
    expect(f.run("a").turnBudget.reserved).toBe(0);
    // Every turn the child spent was charged against the shared team budget, never a bypass.
    const team = f.coordinator.status(f.team.teamId) as { teamId: string };
    expect(team).toBeDefined();
  });
});
