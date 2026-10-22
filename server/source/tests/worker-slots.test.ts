import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Orchestrator, type Run, type TaskSpec } from "../src/orchestrator/controller.js";
import { TeamCoordinator, type TeamTaskSpec } from "../src/orchestrator/team.js";
import { createOrchestratorServer } from "../src/orchestrator/server.js";
import {
  WORKER_SLOT_LIMIT,
  acquireWorkerSlot,
  releaseWorkerSlot,
  workerSlotStatus,
  workspaceOverlaps,
  workspaceReviewActive,
} from "../src/orchestrator/worker-slots.js";
import type { Worker, WorkerEvent } from "../src/orchestrator/worker.js";
import type { AgentResult } from "../src/types.js";

class FixtureWorker implements Worker {
  listener?: (event: WorkerEvent) => void;
  messageListener?: (event: {
    sessionId: string;
    message: import("../src/orchestrator/messaging.js").SupervisorMessage;
  }) => void;
  final?: AgentResult;
  serial = 0;
  count = 0;
  constructor(readonly id = `session-${++FixtureWorker.instances}`) {}
  static instances = 0;
  subscribeMessages(listener: NonNullable<FixtureWorker["messageListener"]>) {
    this.messageListener = listener;
    return () => {};
  }
  subscribe(listener: (event: WorkerEvent) => void) {
    this.listener = listener;
    return () => {};
  }
  async start() {
    this.count++;
    return this.id;
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
  eventEpoch() {
    return this.count;
  }
  isLive() {
    return true;
  }
  stop() {}
  destroy() {}
  finish(turns = 2) {
    this.final = {
      sessionId: this.id,
      result: "done",
      isError: false,
      durationMs: 1,
      numTurns: turns,
      totalCostUsd: 0,
    };
    this.listener?.({
      sessionId: this.id,
      epoch: this.count,
      event: {
        id: ++this.serial,
        type: "result",
        data: this.final,
        timestamp: new Date().toISOString(),
        pinned: false,
      },
    });
  }
}

const cleanups: (() => void)[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccc-slots-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"),
    data = path.join(root, "ledger");
  mkdirSync(cwd, { recursive: true });
  const task: TaskSpec = {
    id: "a",
    title: "a",
    instructions: "write answer.txt",
    dependsOn: [],
    acceptance: "42",
    artifacts: ["answer.txt"],
    checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
  };
  return { root, cwd, data, task };
}

function ordinary(data: string, cwd: string, task: TaskSpec) {
  const worker = new FixtureWorker(),
    controller = new Orchestrator(data, worker, data);
  cleanups.push(() => controller.close());
  const run = controller.plan({
    action: "create",
    cwd,
    goal: "goal",
    design: "design",
    tasks: [task],
  });
  return { worker, controller, run };
}

async function connect(dataDir: string, cwd: string, task: TaskSpec) {
  const worker = new FixtureWorker(),
    api = createOrchestratorServer(dataDir, () => worker),
    client = new Client({ name: `slot-${FixtureWorker.instances}`, version: "1" });
  cleanups.push(() => {
    api.close();
    void client.close();
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([api.server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await client.callTool({ name, arguments: args });
    return {
      value: JSON.parse((reply.content as { text: string }[])[0].text),
      isError: !!reply.isError,
    };
  };
  const created = await call("orchestrator_plan", {
    action: "create",
    cwd,
    goal: "goal",
    design: "design",
    tasks: [task],
  });
  expect(created.isError, JSON.stringify(created.value)).toBe(false);
  return {
    worker,
    api,
    call,
    runId: created.value.runId as string,
    dispatch: (requestId: string) =>
      call("orchestrator_dispatch", { runId: created.value.runId, taskId: "a", requestId }),
  };
}

describe("shared worker execution slots", () => {
  it("admits exactly three executions across independent connections and frees a slot on completion", async () => {
    const f = fixture();
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    const connections = [
      await connect(f.data, f.cwd, f.task),
      await connect(f.data, f.cwd, f.task),
      await connect(f.data, f.cwd, f.task),
    ];
    for (const [index, connection] of connections.entries())
      expect((await connection.dispatch(`start-${index}`)).value.status).toBe("started");
    expect(workerSlotStatus(f.data).active).toBe(WORKER_SLOT_LIMIT);

    const fourth = await connect(f.data, f.cwd, f.task);
    const rejected = await fourth.dispatch("start-3");
    expect(rejected.isError).toBe(true);
    expect(rejected.value.error).toContain("WORKER_SLOTS_FULL");
    expect(rejected.value.error).toContain("3/3");
    const run = fourth.api.controller.status(fourth.runId) as Run;
    expect(run.tasks[0].attempts).toBe(0);
    expect(run.turnBudget).toMatchObject({ used: 0, reserved: 0 });
    expect(existsSync(path.join(f.data, `run-${fourth.runId}.json`))).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(f.data, `run-${fourth.runId}.json`), "utf8"))
    ).toMatchObject({
      receipts: {},
    });

    // The startup receipt already returned, but start() resolving is not completion.
    expect(workerSlotStatus(f.data).active).toBe(3);
    connections[1].worker.finish();
    expect(workerSlotStatus(f.data).active).toBe(2);
    expect(workerSlotStatus(f.data).slots.map((slot) => slot.runId)).toEqual(
      expect.arrayContaining([connections[0].runId, connections[2].runId])
    );

    expect((await fourth.dispatch("retry-3")).value.status).toBe("started");
    expect(workerSlotStatus(f.data).active).toBe(3);
  }, 30000);

  it("reviews after a peer that was active at startup finishes, using live slots not stale runs", async () => {
    const f = fixture();
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    const other = path.join(f.root, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, "answer.txt"), "42");

    const first = await connect(f.data, f.cwd, f.task);
    expect((await first.dispatch("first")).value.status).toBe("started");
    // B is constructed while A executes, so its in-memory ledger holds A's active snapshot.
    const second = await connect(f.data, f.cwd, f.task);
    expect((second.api.controller.status(first.runId) as Run).activeTaskId).toBe("a");

    expect((await second.dispatch("second")).value.status).toBe("started");
    second.worker.finish();
    const secondRun = second.api.controller.status(second.runId) as Run;
    const secondTask = secondRun.tasks[0];
    expect(secondTask.state).toBe("awaiting_review");
    const review = () =>
      second.call("orchestrator_review", {
        runId: second.runId,
        taskId: "a",
        taskRevision: secondTask.revision,
        artifactHash: secondTask.artifactHash,
        decision: "accept",
        evidence: "Startup-order review after the peer finished",
      });

    // A really executes in this workspace: its live slot must still block the review.
    const blocked = await review();
    expect(blocked.isError).toBe(true);
    expect(blocked.value.error).toBe("CHECKS_REQUIRE_QUIESCENT_EXECUTOR");

    // A different workspace is independent while A executes.
    const disjoint = await connect(f.data, other, f.task);
    expect((await disjoint.dispatch("disjoint")).value.status).toBe("started");
    disjoint.worker.finish();
    const disjointRun = disjoint.api.controller.status(disjoint.runId) as Run;
    const disjointAccepted = await disjoint.call("orchestrator_review", {
      runId: disjoint.runId,
      taskId: "a",
      taskRevision: disjointRun.tasks[0].revision,
      artifactHash: disjointRun.tasks[0].artifactHash,
      decision: "accept",
      evidence: "Disjoint workspace review while the other workspace executes",
    });
    expect(disjointAccepted.value.state).toBe("accepted");

    first.worker.finish();
    await vi.waitFor(() => expect(workerSlotStatus(f.data).active).toBe(0));
    // The stale snapshot is still cached, yet the live pool now says quiescent.
    expect((second.api.controller.status(first.runId) as Run).activeTaskId).toBe("a");
    const accepted = await review();
    expect(accepted.isError).toBe(false);
    expect(accepted.value.state).toBe("accepted");
  }, 30000);

  it("shares the pool between team children and an ordinary run", async () => {
    const f = fixture();
    const workers = new Map<string, FixtureWorker>();
    const coordinator = new TeamCoordinator(path.join(f.data, "teams"), (directory) => {
      const worker = new FixtureWorker(path.basename(directory));
      workers.set(path.basename(directory), worker);
      return new Orchestrator(directory, worker, f.data);
    });
    cleanups.push(() => coordinator.close());
    const teamTasks: TeamTaskSpec[] = ["a", "b", "c"].map((id) => ({
      ...f.task,
      id,
      artifacts: [`${id}.txt`],
      writeScope: [`${id}.txt`],
    }));
    // Explicit segment cap: this test targets pool sharing, not the default segment size.
    const team = coordinator.create({
      cwd: f.cwd,
      goal: "goal",
      design: "design",
      tasks: teamTasks,
      maxTurns: 200,
    });
    await coordinator.dispatch(team.teamId, "a", "team-a");
    await coordinator.dispatch(team.teamId, "b", "team-b");
    expect(workerSlotStatus(f.data).active).toBe(2);

    const solo = ordinary(f.data, f.cwd, f.task);
    await solo.controller.dispatch(solo.run.id, "a", "solo");
    expect(workerSlotStatus(f.data).active).toBe(3);

    await expect(coordinator.dispatch(team.teamId, "c", "team-c")).rejects.toThrow(
      "WORKER_SLOTS_FULL"
    );
    const childC = team.tasks.find((task) => task.id === "c")!.childRunId;
    const runC = coordinator.controllerFor(childC)!.status(childC) as Run;
    expect(runC.tasks[0].attempts).toBe(0);
    expect(runC.turnBudget).toMatchObject({ used: 0, reserved: 0 });

    solo.worker.finish();
    expect(workerSlotStatus(f.data).active).toBe(2);
    await coordinator.dispatch(team.teamId, "c", "team-c-retry");
    expect(workerSlotStatus(f.data).active).toBe(3);
  }, 30000);

  it("counts model-executing context maintenance but no retained transcript", async () => {
    const f = fixture();
    const worker = new FixtureWorker("session-x"),
      controller = new Orchestrator(f.data, worker, f.data);
    cleanups.push(() => controller.close());
    const run = controller.plan({
      action: "create",
      cwd: f.cwd,
      goal: "goal",
      design: "design",
      tasks: [f.task],
    });
    const solo = { worker, controller, run };
    run.sessionId = "session-x";
    await solo.controller.session(solo.run.id, "retain");
    expect(workerSlotStatus(f.data).active).toBe(0);
    await solo.controller.session(solo.run.id, "compact");
    expect(workerSlotStatus(f.data).active).toBe(1);
    solo.worker.finish();
    expect(workerSlotStatus(f.data).active).toBe(0);
    expect(solo.run.sessionOperation).toBeUndefined();
  });

  it("releases a disconnect-held slot and leaves peer connections executing", async () => {
    const f = fixture();
    const first = await connect(f.data, f.cwd, f.task),
      second = await connect(f.data, f.cwd, f.task);
    await first.dispatch("one");
    await second.dispatch("two");
    first.api.close();
    expect(workerSlotStatus(f.data).active).toBe(1);
    const third = await connect(f.data, f.cwd, f.task),
      fourth = await connect(f.data, f.cwd, f.task);
    await third.dispatch("three");
    await fourth.dispatch("four");
    expect(workerSlotStatus(f.data).active).toBe(3);
    // The surviving peer still owns its live run and cannot be taken over.
    expect(() => third.api.controller.attach(second.runId)).toThrow();
    expect(workerSlotStatus(f.data).slots.some((slot) => slot.runId === second.runId)).toBe(true);
  }, 30000);

  it("reclaims only a dead owner's record and never a peer's live slot", () => {
    const f = fixture();
    const first = acquireWorkerSlot(f.data, f.cwd, "run-one"),
      second = acquireWorkerSlot(f.data, f.cwd, "run-two");
    const staleFile = path.join(f.data, "worker-slots", "slot-3.json");
    writeFileSync(
      staleFile,
      JSON.stringify({ pid: 99999999, token: "gone", runId: "dead", cwd: f.cwd })
    );
    const third = acquireWorkerSlot(f.data, f.cwd, "run-three");
    expect(third.slot).toBe(3);

    expect(releaseWorkerSlot(f.data, { ...third, token: "not-this-token" })).toBe(false);
    expect(workerSlotStatus(f.data).active).toBe(3);
    expect(releaseWorkerSlot(f.data, first)).toBe(true);
    expect(releaseWorkerSlot(f.data, second)).toBe(true);
    expect(releaseWorkerSlot(f.data, third)).toBe(true);
    expect(workerSlotStatus(f.data).active).toBe(0);
  });

  it("never overcommits when six OS processes race for three slots", async () => {
    const f = fixture();
    const bundle = path.join(f.root, "worker-slots.mjs");
    buildSync({
      entryPoints: [fileURLToPath(new URL("../src/orchestrator/worker-slots.ts", import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const actor = path.join(f.root, "slot-actor.mjs");
    writeFileSync(
      actor,
      `import{acquireWorkerSlot,releaseWorkerSlot}from'./worker-slots.mjs';let slot;
process.on('message',m=>{if(m==='go'){try{slot=acquireWorkerSlot(process.argv[2],process.argv[3],'run-'+process.pid);process.send({acquired:true,slot:slot.slot});}catch(e){process.send({acquired:false,error:e.message});}}else if(m==='release'){process.send({released:releaseWorkerSlot(process.argv[2],slot)},()=>process.disconnect());}});
process.send({ready:true});`
    );
    const native = fileURLToPath(
      new URL("../.test-build/native-dist/CodexClaudeTerminal.dll", import.meta.url)
    );
    const pair = Array.from({ length: 6 }, () =>
      fork(actor, [f.data, f.cwd], {
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { ...process.env, CCC_NATIVE_HELPER: native },
      })
    );
    children.push(...pair);
    const message = (child: ChildProcess, key: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const receive = (value: unknown) => {
          if (value && typeof value === "object" && key in value) {
            child.off("message", receive);
            resolve(value as Record<string, unknown>);
          }
        };
        child.on("message", receive);
      });
    await Promise.all(pair.map((child) => message(child, "ready")));
    const attempts = pair.map((child) => message(child, "acquired"));
    for (const child of pair) child.send("go");
    const results = await Promise.all(attempts);
    const winners = results.filter((result) => result.acquired);
    expect(winners).toHaveLength(3);
    expect(new Set(winners.map((winner) => winner.slot)).size).toBe(3);
    expect(results.filter((result) => !result.acquired)).toHaveLength(3);
    expect(results.find((result) => !result.acquired)?.error).toContain("WORKER_SLOTS_FULL");

    const owner = pair[results.findIndex((result) => result.acquired)];
    const released = message(owner, "released");
    owner.send("release");
    expect((await released).released).toBe(true);
    const replacement = acquireWorkerSlot(f.data, f.cwd, "replacement");
    expect(replacement.slot).toBeGreaterThanOrEqual(1);
    releaseWorkerSlot(f.data, replacement);
  }, 60000);

  it("blocks execution during an overlapping review in both parent and child workspaces", async () => {
    const f = fixture();
    const childCwd = path.join(f.cwd, "nested", "project");
    mkdirSync(childCwd, { recursive: true });
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    const slowCheck = {
      command: process.execPath,
      args: ["-e", "setTimeout(()=>process.exit(0),400)"],
    };
    const parent = ordinary(f.data, f.cwd, f.task);
    await parent.controller.dispatch(parent.run.id, "a", "parent");
    parent.worker.finish();
    const task = parent.run.tasks[0];
    expect(task.state).toBe("awaiting_review");

    // Forward direction: a child execution already overlapping blocks the parent review.
    const runningChild = ordinary(f.data, childCwd, f.task);
    await runningChild.controller.dispatch(runningChild.run.id, "a", "child-live");
    task.checks = [slowCheck];
    await expect(
      parent.controller.review({
        runId: parent.run.id,
        taskId: "a",
        taskRevision: task.revision,
        artifactHash: task.artifactHash!,
        decision: "accept",
        evidence: "Parent review while child execution overlaps",
      })
    ).rejects.toThrow(/QUIESCENT|WORKSPACE_REVIEW/);
    runningChild.worker.finish();

    // Reverse direction: an in-flight parent review blocks a new overlapping child dispatch.
    const reviewing = parent.controller.review({
      runId: parent.run.id,
      taskId: "a",
      taskRevision: task.revision,
      artifactHash: task.artifactHash!,
      decision: "accept",
      evidence: "Parent review while a child tries to start",
    });
    await vi.waitFor(() => expect(parent.controller.reviewActive()).toBe(true));
    const startingChild = ordinary(f.data, childCwd, f.task);
    await expect(
      startingChild.controller.dispatch(startingChild.run.id, "a", "child-blocked")
    ).rejects.toThrow("WORKSPACE_REVIEW_IN_PROGRESS");
    expect((await reviewing).state).toBe("accepted");
    // Once the review ends, the overlapping workspace may execute again.
    expect(
      (await startingChild.controller.dispatch(startingChild.run.id, "a", "child-allowed")).status
    ).toBe("started");
  }, 30000);

  it("keeps admission until accepted state is persisted, rejecting a contender at the post-hash window", async () => {
    const f = fixture();
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    const parent = ordinary(f.data, f.cwd, f.task);
    await parent.controller.dispatch(parent.run.id, "a", "parent");
    parent.worker.finish();
    const task = parent.run.tasks[0];
    expect(task.state).toBe("awaiting_review");
    const candidateHash = task.artifactHash!;

    // A separate OS process contends while the parent is between the final hash and state save.
    const bundle = path.join(f.root, "controller.mjs");
    buildSync({
      entryPoints: [fileURLToPath(new URL("../src/orchestrator/controller.ts", import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const actor = path.join(f.root, "contender.mjs");
    writeFileSync(
      actor,
      `import{Orchestrator}from'./controller.mjs';import{writeFileSync}from'node:fs';import path from'node:path';
class W{subscribe(){return()=>{}}async start(){writeFileSync(path.join(process.argv[3],'answer.txt'),'changed after final hash');return's'}async reply(){return this.start()}replay(){return[]}result(){}permissions(){return[]}respond(){return true}model(){return'm'}stop(){}destroy(){}}
const controller=new Orchestrator(process.argv[2],new W(),process.argv[2]);
const run=controller.plan({action:'create',cwd:process.argv[3],goal:'g',design:'d',tasks:[JSON.parse(process.argv[4])]});
process.on('message',async m=>{if(m!=='go')return;try{const r=await controller.dispatch(run.id,'a','contender');process.send({ok:true,status:r.status});}catch(e){process.send({ok:false,error:e.message});}controller.close();});
process.send({ready:true});`
    );
    const contender = fork(actor, [f.data, f.cwd, JSON.stringify(f.task)], {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...process.env,
        CCC_NATIVE_HELPER: fileURLToPath(
          new URL("../.test-build/native-dist/CodexClaudeTerminal.dll", import.meta.url)
        ),
      },
    });
    children.push(contender);
    const message = (key: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const receive = (value: unknown) => {
          if (value && typeof value === "object" && key in value) {
            contender.off("message", receive);
            resolve(value as Record<string, unknown>);
          }
        };
        contender.on("message", receive);
      });
    await message("ready");
    const contended = message("ok");

    const internals = parent.controller as unknown as {
      inventory: (run: Run, task: unknown) => unknown;
    };
    const originalInventory = internals.inventory.bind(parent.controller);
    let inventoryCalls = 0;
    // The second inventory call is the post-check window: signal the contender and hold
    // this synchronous commit section open long enough for the cross-process attempt.
    internals.inventory = (run, candidate) => {
      const value = originalInventory(run, candidate);
      if (++inventoryCalls === 2) {
        contender.send("go");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
      }
      return value;
    };
    const reviewed = await parent.controller.review({
      runId: parent.run.id,
      taskId: "a",
      taskRevision: task.revision,
      artifactHash: candidateHash,
      decision: "accept",
      evidence: "Independent review through the post-check window",
    });
    const contenderResult = await contended;
    expect(contenderResult.ok).toBe(false);
    expect(contenderResult.error).toBe("WORKSPACE_REVIEW_IN_PROGRESS");
    expect(reviewed.state).toBe("accepted");
    expect(task.artifactHash).toBe(candidateHash);
    expect(readFileSync(path.join(f.cwd, "answer.txt"), "utf8")).toBe("42");
    expect(
      JSON.parse(readFileSync(path.join(f.data, `run-${parent.run.id}.json`), "utf8")).tasks[0]
    ).toMatchObject({ state: "accepted", artifactHash: candidateHash });
    // Every exit path releases the workspace admission.
    expect(workspaceReviewActive(f.data, f.cwd)).toBe(false);
  }, 60000);

  it("releases workspace admission on failed, changed and cancelled reviews", async () => {
    const f = fixture();
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    const solo = ordinary(f.data, f.cwd, f.task);
    await solo.controller.dispatch(solo.run.id, "a", "dispatch");
    solo.worker.finish();
    const task = solo.run.tasks[0];
    const review = (overrides: Record<string, unknown> = {}, signal?: AbortSignal) =>
      solo.controller.review(
        {
          runId: solo.run.id,
          taskId: "a",
          taskRevision: task.revision,
          artifactHash: task.artifactHash!,
          decision: "accept",
          evidence: "Independent review",
          ...overrides,
        },
        signal
      );
    await expect(review({ artifactHash: "0".repeat(64) })).rejects.toThrow(
      "STALE_ARTIFACT_OR_CONTRACT"
    );
    expect(workspaceReviewActive(f.data, f.cwd)).toBe(false);

    task.checks = [{ command: process.execPath, args: ["-e", "process.exit(0)"] }];
    const host = new AbortController();
    host.abort();
    await expect(review({}, host.signal)).rejects.toThrow("REVIEW_INTERRUPTED");
    expect(workspaceReviewActive(f.data, f.cwd)).toBe(false);
    expect(solo.controller.reviewActive()).toBe(false);

    const changed = {
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('answer.txt','43')"],
    };
    task.checks = [changed];
    await expect(review()).rejects.toThrow("CHECK_CHANGED");
    expect(workspaceReviewActive(f.data, f.cwd)).toBe(false);
    expect(solo.controller.reviewActive()).toBe(false);
  }, 30000);

  it("rejects a second concurrent review with an overlapping workspace but allows disjoint ones", async () => {
    const f = fixture();
    const otherCwd = path.join(f.root, "other-workspace");
    mkdirSync(otherCwd, { recursive: true });
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    writeFileSync(path.join(otherCwd, "answer.txt"), "42");
    const first = ordinary(f.data, f.cwd, f.task),
      peer = ordinary(f.data, f.cwd, f.task),
      disjoint = ordinary(f.data, otherCwd, f.task);
    for (const candidate of [first, peer, disjoint]) {
      await candidate.controller.dispatch(candidate.run.id, "a", "dispatch");
      candidate.worker.finish();
    }
    const slow = { command: process.execPath, args: ["-e", "setTimeout(()=>process.exit(0),400)"] };
    for (const candidate of [first, peer]) candidate.run.tasks[0].checks = [slow];
    const review = (candidate: typeof first) => {
      const task = candidate.run.tasks[0];
      return candidate.controller.review({
        runId: candidate.run.id,
        taskId: "a",
        taskRevision: task.revision,
        artifactHash: task.artifactHash!,
        decision: "accept",
        evidence: "Independent review",
      });
    };
    const reviewing = review(first);
    await vi.waitFor(() => expect(first.controller.reviewActive()).toBe(true));
    await expect(review(peer)).rejects.toThrow("WORKSPACE_REVIEW_IN_PROGRESS");
    // A different project still checks while the first review runs.
    expect((await review(disjoint)).state).toBe("accepted");
    expect((await reviewing).state).toBe("accepted");
  }, 30000);

  it("reports capacity from the pool root injected into the server", async () => {
    const f = fixture();
    const connection = await connect(f.data, f.cwd, f.task);
    await connection.dispatch("one");
    const doctor = await connection.call("orchestrator_doctor", {});
    expect(doctor.value.workerSlots).toMatchObject({ limit: 3, active: 1 });
    expect(doctor.value.workerSlots.slots[0]).toMatchObject({
      pid: process.pid,
      runId: connection.runId,
    });
    expect(JSON.stringify(doctor.value.workerSlots)).not.toMatch(/token|prompt|instructions/);
  });

  it("frees the slot after startup failure and after cancellation", async () => {
    const f = fixture();
    const failing = ordinary(f.data, f.cwd, f.task);
    failing.worker.start = async () => {
      throw new Error("startup failed");
    };
    const receipt = await failing.controller.dispatch(failing.run.id, "a", "failing");
    expect(receipt.status).toBe("failed");
    expect(workerSlotStatus(f.data).active).toBe(0);
    expect(failing.run.turnBudget).toMatchObject({ used: 501, reserved: 0 });

    const cancelled = ordinary(f.data, f.cwd, f.task);
    await cancelled.controller.dispatch(cancelled.run.id, "a", "cancel-me");
    expect(workerSlotStatus(f.data).active).toBe(1);
    cancelled.controller.cancel(cancelled.run.id, "User stopped");
    expect(workerSlotStatus(f.data).active).toBe(0);

    // Capacity is immediately reusable by another connection.
    const next = await connect(f.data, f.cwd, f.task);
    expect((await next.dispatch("next")).value.status).toBe("started");
  }, 30000);

  it("admits only one of two overlapping reviews racing in separate OS processes", async () => {
    const f = fixture();
    const parentCwd = f.cwd,
      childCwd = path.join(f.cwd, "nested");
    mkdirSync(childCwd, { recursive: true });
    const bundle = path.join(f.root, "review-slots.mjs");
    buildSync({
      entryPoints: [fileURLToPath(new URL("../src/orchestrator/worker-slots.ts", import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const actor = path.join(f.root, "review-actor.mjs");
    writeFileSync(
      actor,
      `import{acquireWorkspaceReview,releaseWorkspaceReview}from'./review-slots.mjs';let review;
process.on('message',m=>{if(m==='go'){try{review=acquireWorkspaceReview(process.argv[2],process.argv[3]);process.send({acquired:true});}catch(e){process.send({acquired:false,error:e.message});}}else if(m==='release'){releaseWorkspaceReview(review);process.send({released:true},()=>process.disconnect());}});
process.send({ready:true});`
    );
    const native = fileURLToPath(
      new URL("../.test-build/native-dist/CodexClaudeTerminal.dll", import.meta.url)
    );
    for (let iteration = 0; iteration < 3; iteration++) {
      const pair = [parentCwd, childCwd].map((cwd) =>
        fork(actor, [f.data, cwd], {
          execArgv: [],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          env: { ...process.env, CCC_NATIVE_HELPER: native },
        })
      );
      children.push(...pair);
      const message = (child: ChildProcess, key: string) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const receive = (value: unknown) => {
            if (value && typeof value === "object" && key in value) {
              child.off("message", receive);
              resolve(value as Record<string, unknown>);
            }
          };
          child.on("message", receive);
        });
      await Promise.all(pair.map((child) => message(child, "ready")));
      const attempts = pair.map((child) => message(child, "acquired"));
      for (const child of pair) child.send("go");
      const results = await Promise.all(attempts);
      expect(results.filter((result) => result.acquired)).toHaveLength(1);
      expect(results.find((result) => !result.acquired)?.error).toBe(
        "WORKSPACE_REVIEW_IN_PROGRESS"
      );
      const owner = pair[results.findIndex((result) => result.acquired)],
        released = message(owner, "released");
      owner.send("release");
      await released;
    }
  }, 60000);

  it("treats overlapping workspaces as the same acceptance scope, case-insensitively only on Windows", () => {
    const f = fixture();
    const nested = path.join(f.cwd, "nested", "project");
    mkdirSync(nested, { recursive: true });
    expect(workspaceOverlaps(f.cwd, nested)).toBe(true);
    expect(workspaceOverlaps(nested, f.cwd)).toBe(true);
    expect(workspaceOverlaps(f.cwd, path.join(f.root, "other"))).toBe(false);
    // A symlink alias resolves to the same workspace in both directions.
    symlinkSync(
      f.cwd,
      path.join(f.root, "alias"),
      process.platform === "win32" ? "junction" : "dir"
    );
    expect(workspaceOverlaps(path.join(f.root, "alias"), f.cwd)).toBe(true);
    expect(workspaceOverlaps(f.cwd, path.join(f.root, "alias"))).toBe(true);
    if (process.platform === "win32")
      expect(workspaceOverlaps(f.cwd, f.cwd.toUpperCase())).toBe(true);
    else expect(workspaceOverlaps(f.cwd, f.cwd.toUpperCase())).toBe(false);
  });
});
