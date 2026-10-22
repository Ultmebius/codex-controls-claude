import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOrchestratorServer } from "../src/orchestrator/server.js";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ccc-api-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const api = createOrchestratorServer(path.join(cwd, "ledger"));
  const client = new Client({ name: "api-regression", version: "1" });
  cleanup.push(async () => {
    api.close();
    await client.close();
    await api.server.close();
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([api.server.connect(serverSide), client.connect(clientSide)]);
  async function call(name: string, args: Record<string, unknown>) {
    const response = await client.callTool({ name, arguments: args });
    const text = response.content as { type: string; text?: string }[];
    return {
      value: JSON.parse(text.find((item) => item.type === "text")?.text ?? "{}"),
      isError: !!response.isError,
    };
  }
  const created = await call("orchestrator_plan", {
    action: "create",
    cwd,
    goal: "one artifact",
    design: "fixed independent check",
    maxTurns: 40,
    maxTotalTurns: 80,
    tasks: [
      {
        id: "a",
        title: "artifact",
        instructions: "contract-sentinel-not-in-brief-evidence",
        dependsOn: [],
        acceptance: "42",
        artifacts: ["answer.txt"],
        checks: [
          {
            command: process.execPath,
            args: [
              "-e",
              "if(require('fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1)",
            ],
          },
        ],
      },
    ],
  });
  expect(created.isError).toBe(false);
  const run = api.controller.status(created.value.runId);
  if (Array.isArray(run)) throw new Error("Expected run");
  return { cwd, api, client, call, run };
}
describe("orchestrator MCP revision contract", () => {
  it("rechecks supervisor activity after awaiting retained-session closure", async () => {
    const f = await fixture();
    f.run.tasks[0].checks = [
      {
        command: process.execPath,
        args: [
          "-e",
          "require('fs').writeFileSync('review-running','1');setTimeout(()=>process.exit(0),300)",
        ],
      },
    ];
    f.run.tasks[0].state = "blocked";
    f.run.tasks[0].attempts = 1;
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    const candidate = f.api.controller.reconcile({
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      evidence: "Supervisor candidate",
    });
    const team = f.api.teams.create({
      cwd: f.cwd,
      goal: "team",
      design: "independent",
      tasks: [{ ...f.run.tasks[0], id: "peer", dependsOn: [], writeScope: ["peer.txt"] }],
    });
    f.run.sessionState = "retained";
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(f.api.controller, "session").mockImplementation(async () => {
      enter();
      await gate;
      f.run.sessionState = "closed";
      return {
        runId: f.run.id,
        action: "close",
        state: "closed",
        sessionId: undefined,
        deadline: f.run.deadline,
        renewal: undefined,
        nextCursor: 0,
      };
    });
    const pendingDispatch = f.call("orchestrator_team", {
      action: "dispatch",
      teamId: team.teamId,
      taskId: "peer",
      requestId: "close-race",
    });
    await entered;
    const review = f.call("orchestrator_review", {
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      artifactHash: candidate.artifactHash,
      decision: "accept",
      evidence: "Review during deferred close",
    });
    await vi.waitFor(() => expect(existsSync(path.join(f.cwd, "review-running"))).toBe(true));
    release();
    expect((await pendingDispatch).value.error).toBe("REVIEW_IN_PROGRESS");
    expect((await review).value.state).toBe("accepted");
  });
  it("holds a cross-connection lease during recovered-candidate verification", async () => {
    const f = await fixture();
    f.run.tasks[0].state = "blocked";
    f.run.tasks[0].attempts = 1;
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    f.api.controller.reconcile({
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      evidence: "Recovered candidate",
    });
    const verified = await f.call("orchestrator_review", {
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      artifactHash: f.run.tasks[0].artifactHash,
      decision: "accept",
      evidence: "Independent original checks",
    });
    expect(verified.isError).toBe(false);
    const other = createOrchestratorServer(path.join(f.cwd, "ledger"));
    cleanup.push(() => other.close());
    const peer = new Client({ name: "other-connection", version: "1" });
    cleanup.push(() => peer.close());
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([other.server.connect(serverSide), peer.connect(clientSide)]);
    const blocked = await peer.callTool({
      name: "orchestrator_plan",
      arguments: {
        action: "reconcile",
        runId: f.run.id,
        taskId: "a",
        taskRevision: 1,
        evidence: "Other connection must not mutate recovered evidence",
      },
    });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toContain("RUN_OWNED_BY_ANOTHER_CONNECTION");
  });
  it("holds the supervisor review barrier for the entire asynchronous check", async () => {
    const f = await fixture();
    f.run.tasks[0].checks = [
      {
        command: process.execPath,
        args: [
          "-e",
          "require('fs').writeFileSync('check-started','1');setTimeout(()=>process.exit(0),300)",
        ],
      },
    ];
    f.run.tasks[0].state = "blocked";
    f.run.tasks[0].attempts = 1;
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    const capture = await f.call("orchestrator_plan", {
      action: "reconcile",
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      evidence: "Supervisor candidate",
    });
    const team = f.api.teams.create({
      cwd: f.cwd,
      goal: "team",
      design: "independent",
      tasks: [{ ...f.run.tasks[0], id: "peer", dependsOn: [], writeScope: ["peer.txt"] }],
    });
    const pending = f.call("orchestrator_review", {
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      artifactHash: capture.value.artifactHash,
      decision: "accept",
      evidence: "Run original long check",
    });
    await vi.waitFor(() => expect(existsSync(path.join(f.cwd, "check-started"))).toBe(true));
    const dispatch = await f.call("orchestrator_team", {
      action: "dispatch",
      teamId: team.teamId,
      taskId: "peer",
      requestId: "racing-review",
    });
    expect(dispatch.isError).toBe(true);
    expect(dispatch.value.error).toBe("REVIEW_IN_PROGRESS");
    expect((await pending).value.state).toBe("accepted");
  });
  it("blocks legacy acceptance while a team peer mutates the same workspace", async () => {
    const f = await fixture();
    f.run.tasks[0].state = "blocked";
    f.run.tasks[0].attempts = 1;
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    const capture = await f.call("orchestrator_plan", {
      action: "reconcile",
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      evidence: "Supervisor current candidate",
    });
    const created = f.api.teams.create({
      cwd: f.cwd,
      goal: "team",
      design: "independent",
      tasks: [{ ...f.run.tasks[0], id: "peer", dependsOn: [], writeScope: ["peer.txt"] }],
    });
    const childId = created.tasks[0].childRunId;
    const child = f.api.teams.controllerFor(childId)!.status(childId);
    if (Array.isArray(child)) throw Error("Expected child");
    child.activeTaskId = "peer";
    child.tasks[0].state = "running";
    const result = await f.call("orchestrator_review", {
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      artifactHash: capture.value.artifactHash,
      decision: "accept",
      evidence: "Should not start immutable checks while peer mutates workspace",
    });
    expect(result.isError).toBe(true);
    expect(result.value.error).toContain("QUIESCENT");
    expect(f.run.tasks[0].state).toBe("awaiting_review");
  });
  it("discovers ten tools and exposes native/run/time budget constraints", async () => {
    const f = await fixture();
    const tools = await f.client.listTools();
    expect(tools.tools).toHaveLength(10);
    const plan = tools.tools.find((tool) => tool.name === "orchestrator_plan")!;
    const properties = plan.inputSchema.properties as Record<
      string,
      { maximum?: number; description?: string }
    >;
    expect(properties.maxTurns.maximum).toBe(1000);
    expect(properties.maxTurns.description).toContain("Default: 500");
    expect(properties.maxTotalTurns.description).toContain("Default: 1000");
    expect(properties.runTimeoutMs.maximum).toBe(7200000);
    const wrong = await f.call("orchestrator_plan", {
      action: "update",
      runId: f.run.id,
      maxTotalTurns: 999,
    });
    expect(wrong.isError).toBe(true);
    expect(wrong.value.error).toContain("BUDGET_CONFIG_CREATE_ONLY");
  });
  it("reconciles current files but still rejects the original failing check", async () => {
    const f = await fixture();
    const task = f.run.tasks[0];
    task.state = "blocked";
    task.attempts = 1;
    writeFileSync(path.join(f.cwd, "answer.txt"), "41");
    const first = await f.call("orchestrator_plan", {
      action: "reconcile",
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      evidence: "Supervisor completed fixture without replaying worker",
    });
    expect(first.isError).toBe(false);
    expect(first.value.provenance.producer).toBe("supervisor_reconcile");
    const reject = await f.call("orchestrator_review", {
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      artifactHash: first.value.artifactHash,
      decision: "accept",
      evidence: "Read actual file; fixed assertion must decide",
    });
    expect(reject.value.state).toBe("needs_revision");
    expect(reject.value.checks[0].exitCode).toBe(1);
    writeFileSync(path.join(f.cwd, "answer.txt"), "42");
    const second = await f.call("orchestrator_plan", {
      action: "reconcile",
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      evidence: "Supervisor corrected the same contract",
    });
    const accept = await f.call("orchestrator_review", {
      runId: f.run.id,
      taskId: "a",
      taskRevision: 1,
      artifactHash: second.value.artifactHash,
      decision: "accept",
      evidence: "Read42; rerun unchanged independent assertion",
    });
    expect(accept.value.state).toBe("accepted");
    const selected = await f.call("orchestrator_status", {
      runId: f.run.id,
      taskId: "a",
      sections: ["result", "checks", "artifacts"],
    });
    expect(JSON.stringify(selected.value)).not.toContain("contract-sentinel-not-in-brief-evidence");
    expect(JSON.stringify(selected.value)).not.toContain("modelUsage");
    const contract = await f.call("orchestrator_status", {
      runId: f.run.id,
      taskId: "a",
      sections: ["contract"],
    });
    expect(JSON.stringify(contract.value)).toContain("contract-sentinel-not-in-brief-evidence");
  });
  it("accepts an evidence-backed resume window and rejects implicit deadline resets", async () => {
    const f = await fixture();
    // Simulate an idle run whose native transcript is cold-resumable; no real model is started.
    const worker = f.api.controller.worker as unknown as Record<string, unknown>;
    worker.start = async () => "session";
    worker.reply = async () => "session";
    worker.model = () => "configured-model";
    worker.isLive = () => true;
    f.run.sessionId = "session";
    f.run.sessionState = "closed";
    f.run.tasks[0].state = "interrupted";
    f.run.tasks[0].attempts = 1;
    const expired = Date.now() - 5000;
    f.run.deadline = expired;
    const budget = { ...f.run.turnBudget };
    const createOnly = await f.call("orchestrator_plan", {
      action: "reopen",
      runId: f.run.id,
      runTimeoutMs: 600000,
    });
    expect(createOnly.isError).toBe(true);
    expect(createOnly.value.error).toContain("BUDGET_CONFIG_CREATE_ONLY");
    const missingEvidence = await f.call("orchestrator_plan", {
      action: "session",
      sessionAction: "resume",
      runId: f.run.id,
    });
    expect(missingEvidence.isError).toBe(false);
    expect(missingEvidence.value.renewal).toBeUndefined();
    expect(missingEvidence.value.deadline).toBe(expired);
    const implicit = await f.call("orchestrator_plan", {
      action: "session",
      sessionAction: "retain",
      runId: f.run.id,
    });
    expect(implicit.isError).toBe(false);
    expect(implicit.value.renewal).toBeUndefined();
    expect(f.run.deadline).toBe(expired);
    expect(f.run.renewals ?? []).toHaveLength(0);
    const renewed = await f.call("orchestrator_plan", {
      action: "session",
      sessionAction: "resume",
      runId: f.run.id,
      evidence: "User authorized continuing the old task after a long idle period",
      runTimeoutMs: 600000,
    });
    expect(renewed.isError).toBe(false);
    expect(renewed.value.renewal).toMatchObject({
      source: "explicit_session_resume",
      previousDeadline: expired,
      requestedRunTimeoutMs: 600000,
      renewalCount: 1,
      turnBudget: budget,
    });
    expect(renewed.value.deadline).toBeGreaterThan(expired);
    expect(f.run.turnBudget).toEqual(budget);
    expect(f.run.tasks[0].revision).toBe(1);
    const dispatched = await f.call("orchestrator_dispatch", {
      runId: f.run.id,
      taskId: "a",
      requestId: "after-renewal",
      mode: "continue",
    });
    expect(dispatched.isError).toBe(false);
  });
  it("team dispatch never closes a peer connection's retained run from its own ledger view", async () => {
    const f = await fixture();
    // Simulate a retained transcript whose live owner is another connection/process.
    const worker = f.api.controller.worker as unknown as Record<string, unknown>;
    worker.start = async () => "session";
    worker.reply = async () => "session";
    worker.model = () => "configured-model";
    worker.isLive = () => true;
    f.run.sessionId = "session";
    f.run.sessionState = "retained";
    f.api.controller["save"](f.run);
    // A stub worker keeps this cross-connection regression noninteractive and process-free.
    const stub = () => ({
      subscribe: () => () => {},
      start: async () => "peer-session",
      reply: async () => "peer-session",
      replay: () => [],
      result: () => undefined,
      permissions: () => [],
      respond: () => true,
      model: () => "configured-model",
      isLive: () => true,
      stop: () => {},
      destroy: () => {},
    });
    const peerApi = createOrchestratorServer(path.join(f.cwd, "ledger"), stub);
    cleanup.push(() => peerApi.close());
    const peerClient = new Client({ name: "peer-connection", version: "1" });
    cleanup.push(() => peerClient.close());
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([peerApi.server.connect(serverSide), peerClient.connect(clientSide)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await peerClient.callTool({ name, arguments: args });
      const text = response.content as { type: string; text?: string }[];
      return {
        value: JSON.parse(text.find((item) => item.type === "text")?.text ?? "{}"),
        isError: !!response.isError,
      };
    };
    const team = await call("orchestrator_team", {
      action: "create",
      cwd: f.cwd,
      goal: "peer team",
      design: "isolated task in the peer connection",
      tasks: [
        {
          id: "peer",
          title: "peer",
          instructions: "write peer.txt",
          dependsOn: [],
          acceptance: "42",
          artifacts: ["peer.txt"],
          writeScope: ["peer.txt"],
          checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
        },
      ],
    });
    expect(team.isError).toBe(false);
    const dispatched = await call("orchestrator_team", {
      action: "dispatch",
      teamId: team.value.teamId,
      taskId: "peer",
      requestId: "peer-dispatch",
    });
    expect(dispatched.isError).toBe(false);
    // The other connection's retained run is untouched and still owned by its original owner.
    const restored = f.api.controller.status(
      f.run.id
    ) as import("../src/orchestrator/controller.js").Run;
    expect(Array.isArray(restored)).toBe(false);
    expect(restored.sessionState).toBe("retained");
    expect(restored.sessionId).toBe("session");
  });
  it("exposes explicit supervisor interruption without cancelling the run", async () => {
    const f = await fixture();
    f.run.activeTaskId = "a";
    f.run.tasks[0].state = "running";
    const stopped = await f.call("orchestrator_plan", {
      action: "interrupt",
      runId: f.run.id,
      evidence: "Supervisor stops this stage for inspection",
    });
    expect(stopped.isError).toBe(false);
    expect(stopped.value.status).toBe("open");
    expect(f.run.tasks[0].state).toBe("interrupted");
    expect(f.run.tasks[0].checkpoint).toBeDefined();
    expect(f.run.turnBudget.limit).toBe(80);
  });
});

describe("orchestrator_message schema", () => {
  it("rejects guidance without an active execution and keeps reply backward compatible", async () => {
    const f = await fixture();
    const guidance = await f.call("orchestrator_message", {
      action: "queue",
      runId: f.run.id,
      requestId: "q1",
      text: "scope reminder",
    });
    expect(guidance.isError).toBe(true);
    expect(guidance.value.error).toMatch(/NO_ACTIVE_EXECUTION/);
    // Missing reply fields and mixed modes are explicit contract errors, not silent no-ops.
    expect(
      (await f.call("orchestrator_message", { runId: f.run.id, answer: "x" })).value.error
    ).toMatch(/REPLY_REQUIRES_MESSAGE_ID_AND_ANSWER/);
    expect(
      (
        await f.call("orchestrator_message", {
          action: "queue",
          runId: f.run.id,
          text: "x",
          answer: "y",
        })
      ).value.error
    ).toMatch(/GUIDANCE_REQUIRES_REQUEST_ID_AND_TEXT|GUIDANCE_TAKES_NO_ANSWER_FIELDS/);
    // The legacy reply shape still reaches the same pending-answer path.
    const reply = await f.call("orchestrator_message", {
      runId: f.run.id,
      messageId: "unknown",
      answer: "yes",
    });
    expect(reply.isError).toBe(true);
    expect(reply.value.error).toMatch(/MESSAGE_NOT_PENDING_OR_STALE/);
  });

  it("queues guidance for a running task and reports the truthful state", async () => {
    const f = await fixture();
    f.run.activeTaskId = "a";
    f.run.tasks[0].state = "running";
    const worker = f.api.controller.worker as unknown as {
      guidance?: (sessionId: string, text: string) => boolean;
      eventEpoch?: (sessionId: string) => number;
    };
    f.run.sessionId = "session";
    f.run.executions = [
      {
        id: "exec-1",
        taskId: "a",
        attempt: 1,
        startedAt: new Date().toISOString(),
        requestedLimit: 40,
        effectiveLimit: 40,
        defaultLimit: 40,
        reservedTurns: 41,
        observedAssistantMessages: 0,
        provisionalCharge: 0,
        status: "reserved",
      },
    ];
    f.run.activeExecutionId = "exec-1";
    f.run.turnBudget.reserved = 41;
    worker.guidance = () => true;
    const queued = await f.call("orchestrator_message", {
      action: "queue",
      runId: f.run.id,
      requestId: "q1",
      text: "keep the diff scoped",
    });
    expect(queued.isError).toBe(false);
    expect(queued.value).toMatchObject({ state: "queued", delivered: false, requestId: "q1" });
    expect(queued.value.states.delivered).toMatch(/input accepted/i);
    const evidence = await f.call("orchestrator_status", {
      runId: f.run.id,
      taskId: "a",
      sections: ["guidance"],
    });
    expect(evidence.value.task.guidance[0]).toMatchObject({ state: "queued", mode: "queue" });
  });
});
