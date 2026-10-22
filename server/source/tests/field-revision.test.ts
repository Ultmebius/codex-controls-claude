import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Orchestrator, type TaskSpec } from "../src/orchestrator/controller.js";
import { permissionSettings, shutdownWithFallback } from "../src/orchestrator/runtime.js";
import { selectTaskEvidence } from "../src/orchestrator/evidence.js";
import type { Worker, WorkerEvent } from "../src/orchestrator/worker.js";
import type { AgentResult, SessionEvent } from "../src/types.js";
import { createOrchestratorServer } from "../src/orchestrator/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync } from "node:fs";

class WorkerFixture implements Worker {
  listener?: (event: WorkerEvent) => void;
  final?: AgentResult;
  epoch = 0;
  serial = 0;
  stopped = 0;
  scope?: string[];
  interrupt?: Worker["interrupt"];
  messageListener?: (event: {
    sessionId: string;
    message: import("../src/orchestrator/messaging.js").SupervisorMessage;
  }) => void;
  subscribeMessages(listener: NonNullable<WorkerFixture["messageListener"]>) {
    this.messageListener = listener;
    return () => {};
  }
  subscribe(listener: (event: WorkerEvent) => void) {
    this.listener = listener;
    return () => {};
  }
  async start() {
    this.epoch++;
    this.final = undefined;
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
    return "configured";
  }
  eventEpoch() {
    return this.epoch;
  }
  stop() {
    this.stopped++;
  }
  destroy() {}
  permitsArtifact(cwd: string, file: string) {
    return !this.scope || this.scope.includes(path.relative(cwd, path.resolve(cwd, file)));
  }
  emit(type: SessionEvent["type"], data: unknown, epoch = this.epoch) {
    this.listener?.({
      sessionId: "session",
      epoch,
      event: { id: ++this.serial, type, data, timestamp: new Date().toISOString(), pinned: false },
    });
  }
  finish(turns = 2, epoch = this.epoch) {
    this.final = {
      sessionId: "session",
      result: "Changed answer.txt; ready",
      isError: false,
      durationMs: 10,
      totalCostUsd: 0,
      numTurns: turns,
    };
    this.emit("result", this.final, epoch);
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});
function fixture(git = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccc-field-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "中文 workspace"),
    data = path.join(root, "data");
  mkdirSync(cwd);
  if (git) {
    execFileSync("git", ["init", "--quiet"], { cwd });
    writeFileSync(path.join(cwd, "README.md"), "baseline");
    execFileSync("git", ["add", "README.md"], { cwd });
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
        "baseline",
      ],
      { cwd }
    );
  }
  const worker = new WorkerFixture(),
    controller = new Orchestrator(data, worker);
  cleanups.push(() => controller.close());
  const spec: TaskSpec = {
    id: "a",
    title: "answer",
    instructions: "Write answer.txt",
    dependsOn: [],
    acceptance: "42",
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
    cwd,
    goal: "goal",
    design: "design",
    tasks: [spec],
  });
  return { root, cwd, data, worker, controller, run, spec };
}
describe("field feedback recovery and overhead", () => {
  it("runs process fallback and transport closure when primary cleanup throws", async () => {
    const calls: string[] = [];
    await expect(
      shutdownWithFallback(
        () => {
          calls.push("close");
          throw new Error("close failed");
        },
        () => {
          calls.push("stop");
        },
        async () => {
          calls.push("disconnect");
        }
      )
    ).rejects.toThrow("close failed");
    expect(calls).toEqual(["close", "stop", "disconnect"]);
  });
  it("releases its execution slot after an internal drain without another owner call", async () => {
    const f = fixture();
    f.controller.close();
    const workerA = new WorkerFixture(),
      workerB = new WorkerFixture();
    const apiA = createOrchestratorServer(f.data, () => workerA),
      apiB = createOrchestratorServer(f.data, () => workerB);
    const clients: Client[] = [];
    cleanups.push(() => {
      apiA.close();
      apiB.close();
      for (const client of clients) void client.close();
    });
    async function connect(api: typeof apiA, name: string) {
      const client = new Client({ name, version: "1" });
      clients.push(client);
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([api.server.connect(serverSide), client.connect(clientSide)]);
      return async (tool: string, args: Record<string, unknown>) => {
        const reply = await client.callTool({ name: tool, arguments: args });
        const value = JSON.parse((reply.content as { text: string }[])[0].text);
        expect(reply.isError, JSON.stringify(value)).not.toBe(true);
        return value;
      };
    }
    const a = await connect(apiA, "A"),
      b = await connect(apiB, "B");
    const input = { action: "create", cwd: f.cwd, goal: "goal", design: "design", tasks: [f.spec] };
    const runA = await a("orchestrator_plan", input);
    const receipt = await a("orchestrator_dispatch", {
      runId: runA.runId,
      taskId: "a",
      requestId: "first",
    });
    let release!: () => void;
    workerA.interrupt = async () => {
      workerA.finish(2);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const draining = apiA.controller.interruptGracefully(
      runA.runId,
      "Native permission expired",
      "permission"
    );
    await a("orchestrator_wait", { runId: runA.runId, afterSeq: receipt.nextCursor });
    // The settled terminal result released this connection's slot without another owner call.
    expect(existsSync(path.join(f.data, "worker-slots", "slot-1.json"))).toBe(false);
    release();
    await draining;
    expect(existsSync(path.join(f.data, "worker-slots", "slot-1.json"))).toBe(false);
    const runB = await b("orchestrator_plan", input);
    expect(
      (await b("orchestrator_dispatch", { runId: runB.runId, taskId: "a", requestId: "next" }))
        .status
    ).toBe("started");
  });
  it("finishes a sequential graph without treating accepted downstream output as undeclared", async () => {
    const f = fixture(true);
    f.controller.plan({
      action: "update",
      runId: f.run.id,
      tasks: [f.spec, { ...f.spec, id: "b", artifacts: ["next.txt"], dependsOn: ["a"] }],
    });
    await f.controller.dispatch(f.run.id, "a", "a");
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    f.worker.finish();
    const review = (taskId: string) =>
      f.controller.review({
        runId: f.run.id,
        taskId,
        taskRevision: 2,
        artifactHash: f.run.tasks.find((t) => t.id === taskId)!.artifactHash!,
        decision: "accept",
        evidence: "Independent file inspection and fixed check",
      });
    await review("a");
    await f.controller.dispatch(f.run.id, "b", "b");
    writeFileSync(path.join(f.cwd, "next.txt"), "42");
    f.worker.finish();
    await review("b");
    expect(f.controller.plan({ action: "finish", runId: f.run.id }).status).toBe(
      "awaiting_user_review"
    );
    // Two reviews x real Git inventory plus two spawned Node acceptance checks measured
    // 3.7-4.4s on Windows, against vitest's 5s default. This deadline matches the other
    // Git/native integration suites (15-60s); no assertion is relaxed.
  }, 15000);
  it("publishes idle activity after internally triggered graceful drain", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    f.worker.interrupt = async () => {
      f.worker.finish(2);
    };
    let idleNotification = false;
    f.controller.subscribeEvents((_run, event) => {
      if (event.type === "execution_drained")
        idleNotification = !f.controller.hasActiveExecutions();
    });
    await f.controller.interruptGracefully(f.run.id, "Native permission expired", "permission");
    expect(idleNotification).toBe(true);
    expect(f.run.tasks[0].state).toBe("blocked");
  });
  it("inherits permission defaults by scope without touching configuration", () => {
    const f = fixture();
    const home = path.join(f.root, "home");
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const file = path.join(home, ".claude/settings.json");
    writeFileSync(
      file,
      JSON.stringify({ permissions: { defaultMode: "bypassPermissions" }, hooks: { Stop: [] } })
    );
    expect(permissionSettings(f.cwd, home).mode).toBe("bypassPermissions");
    mkdirSync(path.join(f.cwd, ".claude"));
    writeFileSync(
      path.join(f.cwd, ".claude/settings.local.json"),
      JSON.stringify({ permissions: { defaultMode: "auto" } })
    );
    expect(permissionSettings(f.cwd, home).mode).toBe("auto");
    expect(JSON.parse(readFileSync(file, "utf8")).hooks).toEqual({ Stop: [] });
  });
  it("refreshes a run after the previous owner releases, without construction stealing it", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    const peer = new Orchestrator(f.data, new WorkerFixture());
    cleanups.push(() => peer.close());
    expect(() => peer.attach(f.run.id)).toThrow("OWNER_STILL_ACTIVE");
    f.controller.close();
    const used = f.run.turnBudget.used;
    writeFileSync(
      path.join(f.data, `run-${f.run.id}.json.claim`),
      JSON.stringify({ pid: 99999999 })
    );
    const attached = peer.attach(f.run.id);
    expect(attached.attached).toBe(true);
    expect(peer.attach(f.run.id).generation).toBe(attached.generation);
    const restored = peer.status(f.run.id);
    if (Array.isArray(restored)) throw new Error("run expected");
    expect(restored.turnBudget).toMatchObject({ limit: 1000, used, reserved: 0 });
    expect(restored.tasks[0].checks).toEqual(f.spec.checks);
    expect(restored.tasks[0].revision).toBe(1);
    f.worker.finish(1);
    expect((peer.status(f.run.id) as typeof restored).turnBudget.used).toBe(used);
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    const candidate = peer.reconcile({
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      evidence: "Supervisor completed actual workspace",
    });
    expect(
      (
        await peer.review({
          runId: f.run.id,
          taskId: "a",
          taskRevision: 1,
          artifactHash: candidate.artifactHash!,
          decision: "accept",
          evidence: "Actual bytes inspected",
        })
      ).state
    ).toBe("accepted");
    expect(peer.plan({ action: "finish", runId: f.run.id }).status).toBe("awaiting_user_review");
  });
  it("drains an interrupted execution before another dispatch can start", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    let release!: () => void;
    f.worker.interrupt = async () => {
      f.worker.finish(3);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const draining = f.controller.interruptGracefully(f.run.id, "Supervisor adjusts approach");
    expect(f.controller.hasActiveExecutions()).toBe(true);
    await expect(
      f.controller.dispatch(f.run.id, "a", "too-early", undefined, { mode: "continue" })
    ).rejects.toThrow("DRAINING");
    release();
    await draining;
    expect(f.run.turnBudget).toMatchObject({ used: 3, reserved: 0 });
    expect(f.run.turnBudget.estimated ?? 0).toBe(0);
    expect(f.run.tasks[0].state).toBe("interrupted");
    expect(f.run.executions?.[0]).toMatchObject({
      confirmedTurns: 3,
      provisionalCharge: 0,
      effectiveLimit: 500,
    });
  });
  it("corrects one provisional execution from late correlated evidence without affecting the next one", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    const oldEpoch = f.worker.epoch;
    f.controller.interrupt(f.run.id, "Fallback stop");
    expect(f.run.turnBudget).toMatchObject({ used: 501, estimated: 501 });
    await f.controller.dispatch(f.run.id, "a", "next", undefined, { mode: "continue" });
    f.worker.finish(2, oldEpoch);
    f.worker.finish(2, oldEpoch);
    expect(f.run.turnBudget).toMatchObject({ used: 2, estimated: 0, reserved: 499 });
    expect(f.run.tasks[0].state).toBe("running");
    f.worker.finish(4);
    expect(f.run.turnBudget).toMatchObject({ used: 6, reserved: 0 });
  });
  it("records default/requested/effective caps rather than conflating them", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first", undefined, { maxTurns: 6 });
    f.worker.finish(7);
    const evidence = selectTaskEvidence(f.run, f.run.tasks[0], ["budget", "executions"]);
    expect(evidence.budget).toMatchObject({
      defaultSegmentLimit: 500,
      lastExecution: { requestedLimit: 6, effectiveLimit: 6, defaultLimit: 500, confirmedTurns: 7 },
    });
  });
  it("blocks undeclared files, includes them explicitly and hashes the full accepted output", async () => {
    const f = fixture(true);
    await f.controller.dispatch(f.run.id, "a", "first");
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    writeFileSync(path.join(f.cwd, "helper.py"), "helper");
    f.worker.finish();
    const task = f.run.tasks[0],
      input = {
        runId: f.run.id,
        taskId: "a",
        taskRevision: 1,
        artifactHash: task.artifactHash!,
        decision: "accept" as const,
        evidence: "Inspect actual files",
      };
    await expect(f.controller.review(input)).rejects.toThrow("UNDECLARED_CHANGES");
    expect(task.changeInventory?.undeclaredChanges).toEqual(["helper.py"]);
    f.controller.includeArtifacts(f.run.id, "a", ["helper.py"], "Necessary in-scope helper");
    expect(task.artifactHash).not.toBe(input.artifactHash);
    expect((await f.controller.review({ ...input, artifactHash: task.artifactHash! })).state).toBe(
      "accepted"
    );
    writeFileSync(path.join(f.cwd, "another.py"), "not reviewed");
    expect(f.controller.plan({ action: "finish", runId: f.run.id }).status).toBe("open");
  });
  it("detects code committed during execution", async () => {
    const f = fixture(true);
    await f.controller.dispatch(f.run.id, "a", "first");
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    writeFileSync(path.join(f.cwd, "helper.py"), "helper");
    execFileSync("git", ["add", "."], { cwd: f.cwd });
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
        "worker",
      ],
      { cwd: f.cwd }
    );
    f.worker.finish();
    expect(f.run.tasks[0].changeInventory?.undeclaredChanges).toContain("helper.py");
  });
  it("keeps peer-owned writes outside this task acceptance inventory", async () => {
    const f = fixture(true);
    f.worker.scope = ["answer.txt"];
    await f.controller.dispatch(f.run.id, "a", "first");
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    writeFileSync(path.join(f.cwd, "peer.txt"), "peer");
    f.controller.setPeerArtifacts(f.run.id, ["peer.txt"]);
    f.worker.finish();
    expect(f.run.tasks[0].changeInventory).toMatchObject({
      undeclaredChanges: [],
      outsideScopeObservations: ["peer.txt"],
    });
    const task = f.run.tasks[0];
    expect(
      (
        await f.controller.review({
          runId: f.run.id,
          taskId: "a",
          taskRevision: 1,
          artifactHash: task.artifactHash!,
          decision: "accept",
          evidence: "Reviewed owned output; peer separately reviewed",
        })
      ).state
    ).toBe("accepted");
  });
  it("requires review/hash coverage for writes outside an advisory reservation", async () => {
    const f = fixture(true);
    f.worker.scope = ["answer.txt"];
    await f.controller.dispatch(f.run.id, "a", "first");
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    writeFileSync(path.join(f.cwd, "helper.py"), "unexpected helper");
    f.worker.finish();
    const task = f.run.tasks[0];
    const review = () =>
      f.controller.review({
        runId: f.run.id,
        taskId: "a",
        taskRevision: 1,
        artifactHash: task.artifactHash!,
        decision: "accept",
        evidence: "Independent full diff review",
      });
    expect(task.changeInventory?.outsideScopeObservations).toEqual(["helper.py"]);
    await expect(review()).rejects.toThrow("UNDECLARED_CHANGES");
    f.controller.includeArtifacts(
      f.run.id,
      "a",
      ["helper.py"],
      "Inspected necessary authorized helper; no peer owns it"
    );
    expect((await review()).state).toBe("accepted");
    writeFileSync(path.join(f.cwd, "helper.py"), "changed after acceptance");
    expect(f.controller.plan({ action: "finish", runId: f.run.id }).status).toBe("open");
  });
  it("keeps ordinary milestones in audit and wakes only for questions", async () => {
    const f = fixture();
    await f.controller.dispatch(f.run.id, "a", "first");
    vi.useFakeTimers();
    const waiting = f.controller.wait(f.run.id, f.controller.cursor(f.run.id), 180000);
    let resolved = false;
    void waiting.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(resolved).toBe(false);
    expect(f.controller.metrics).toMatchObject({ statusReads: 0, logPolls: 0, waitTimeouts: 0 });
    f.worker.messageListener?.({
      sessionId: "session",
      message: { id: "milestone", kind: "update", text: "Meaningful completed module" },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(false);
    f.worker.messageListener?.({
      sessionId: "session",
      message: {
        id: "question",
        kind: "question",
        text: "Need an actual design choice",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      },
    });
    expect((await waiting).events[0].type).toBe("worker_question");
    await vi.advanceTimersByTimeAsync(120000);
    expect(selectTaskEvidence(f.run, f.run.tasks[0], ["decisions"]).decisions).toMatchObject([
      { id: "question", state: "pending" },
    ]);
    await vi.advanceTimersByTimeAsync(180001);
    expect(selectTaskEvidence(f.run, f.run.tasks[0], ["decisions"]).decisions).toMatchObject([
      { id: "question", state: "expired", automaticReplay: false },
    ]);
  });
});
