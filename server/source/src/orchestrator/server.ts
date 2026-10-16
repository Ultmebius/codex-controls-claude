import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Orchestrator } from "./controller.js";
import { ClaudeWorker, type Worker } from "./worker.js";
import { TeamCoordinator } from "./team.js";
import { localConfig, ownedProcessCount } from "./runtime.js";
import { terminalInfo } from "./terminal.js";
import { compactCapabilities, type WorkerCapabilities } from "./capabilities.js";
import { EVIDENCE_SECTIONS, selectTaskEvidence } from "./evidence.js";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { acquireJsonLease, releaseJsonLease, nativeHelperFile } from "./ownership.js";
import { budgetSummary } from "./execution.js";
import {
  defaultWaitMs,
  permissionSettings,
  decisionTimeoutMs,
  startupTimeoutMs,
  checkTimeoutMs,
} from "./runtime.js";
declare const __PLUGIN_VERSION__: string;

export async function doctor() {
  const config = localConfig();
  let gatewayStatus: number | null = null;
  let modelListed: boolean | null = null;
  const listingModel = config.model?.replace(/\[.*\]$/, "");
  if (config.endpoint) {
    const headers: Record<string, string> = {};
    const token = config.env.ANTHROPIC_AUTH_TOKEN ?? config.env.ANTHROPIC_API_KEY;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      headers["x-api-key"] = token;
    }
    try {
      const response = await fetch(`${config.endpoint.replace(/\/$/, "")}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      gatewayStatus = response.status;
      if (response.ok) {
        const json = (await response.json()) as { data?: { id?: string }[] };
        if (listingModel && Array.isArray(json.data))
          modelListed = json.data.some((m) => m.id === listingModel || m.id === config.model);
      }
    } catch {
      /* Optional model listing is not an inference prerequisite. */
    }
  }
  let terminalAvailable = true,
    dotnet10Available = true;
  const nativeHelperPresent = process.platform !== "win32" || existsSync(nativeHelperFile());
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", ["wt.exe"], { windowsHide: true, stdio: "ignore" });
    } catch {
      terminalAvailable = false;
    }
    try {
      dotnet10Available = /^Microsoft\.NETCore\.App 10\./m.test(
        execFileSync("dotnet.exe", ["--list-runtimes"], { encoding: "utf8", windowsHide: true })
      );
    } catch {
      dotnet10Available = false;
    }
  }
  return {
    pluginVersion: typeof __PLUGIN_VERSION__ === "undefined" ? "0.0.0-dev" : __PLUGIN_VERSION__,
    node: process.version,
    platform: process.platform,
    claude: execFileSync(config.executable, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    executable: config.executable,
    endpoint: config.endpoint,
    model: config.model ?? "Claude Code default",
    configuredPermissionMode: permissionSettings().mode,
    decisionTimeoutMs: decisionTimeoutMs(),
    defaultWaitMs: defaultWaitMs(),
    startupTimeoutMs: startupTimeoutMs(),
    checkTimeoutMs: checkTimeoutMs(),
    workerPolicy: {
      hooks: "native_untouched",
      ordinaryTools: "native_permission_evaluation",
      blockedTools: ["Agent", "Task", "TeamCreate", "TeamDelete"],
      fileInterception: false,
      pathRewriting: false,
    },
    gatewayStatus,
    modelListed,
    actualInferenceVerified: false,
    ownedProcesses: ownedProcessCount(),
    executionWindow: process.platform === "win32" ? "Windows Terminal (starts minimized)" : "stdio",
    terminals: terminalInfo(),
    communication: "SDK stream -> event waiter -> current Codex tool result",
    idleChatWakeup: false,
    terminalAvailable,
    dotnet10Available,
    nativeHelperPresent,
    healthy: terminalAvailable && dotnet10Available && nativeHelperPresent,
    configurationOnly: true,
  };
}

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .refine((v) => !["__proto__", "constructor", "prototype"].includes(v));
const check = z.object({ command: z.string().min(1), args: z.array(z.string()).max(100) });
const task = z.object({
  id,
  title: z.string().min(1),
  instructions: z.string().min(1),
  dependsOn: z.array(id),
  acceptance: z.string().min(1),
  artifacts: z.array(z.string().min(1)).min(1).max(100),
  checks: z.array(check).min(1).max(20),
});

function taskSummary(run: import("./controller.js").Run, task: import("./controller.js").Task) {
  const executable =
    Date.now() < run.deadline &&
    run.turnBudget.limit - run.turnBudget.used - run.turnBudget.reserved > 1;
  const actions =
    task.state === "awaiting_review"
      ? ["review"]
      : task.state === "accepted"
        ? ["dispatch_ready_downstream"]
        : task.state === "running"
          ? ["wait"]
          : task.state === "pending"
            ? executable
              ? ["dispatch_if_dependencies_accepted"]
              : ["budget_exhausted"]
            : executable
              ? ["continue_with_feedback", "reconcile"]
              : ["reconcile"];
  return {
    id: task.id,
    state: task.state,
    revision: task.revision,
    blocker: task.failure,
    attempts: task.attempts,
    repairs: task.repairs,
    continuations: task.continuations,
    artifactHash: task.artifactHash,
    undeclaredChanges: task.changeInventory?.undeclaredChanges,
    outsideScopeObservations: task.changeInventory?.outsideScopeObservations,
    missingArtifacts: task.checkpoint
      ? Object.entries(task.checkpoint.artifacts)
          .filter(([, hash]) => hash === null)
          .map(([file]) => file)
      : undefined,
    nextActions: actions,
    evidenceRef: {
      runId: run.id,
      taskId: task.id,
      sections: ["result", "checks", "changes", "executions", "decisions"],
    },
  };
}

export function createOrchestratorServer(
  dataDir = process.env.PLUGIN_DATA ??
    process.env.CCC_DATA_DIR ??
    path.join(os.homedir(), ".local", "share", "codex-controls-claude"),
  makeWorker: () => Worker = () => new ClaudeWorker()
) {
  const controller = new Orchestrator(dataDir, makeWorker());
  const teams = new TeamCoordinator(
    path.join(dataDir, "teams"),
    (directory) => new Orchestrator(directory, makeWorker())
  );
  const route = (runId?: string) => (runId && teams.controllerFor(runId)) || controller;
  let reviewInProgress = false;
  const checkWorkspaceQuiescent = (runId: string) => {
    const run = route(runId).status(runId) as import("./controller.js").Run;
    if (teams.controllerFor(runId)) teams.canReview(runId);
    teams.canReviewWorkspace(run.cwd);
    for (const other of controller.status() as import("./controller.js").Run[])
      if (other.activeTaskId || other.sessionOperation)
        throw new Error("CHECKS_REQUIRE_QUIESCENT_EXECUTOR");
  };
  const leasePath = path.join(dataDir, "supervisor.lock");
  const connectionId = randomUUID();
  let leaseOwned = false;
  const acquireLease = () => {
    if (
      leaseOwned &&
      existsSync(leasePath) &&
      JSON.parse(readFileSync(leasePath, "utf8")).connectionId === connectionId
    )
      return;
    leaseOwned = false;
    acquireJsonLease(
      leasePath,
      "connectionId",
      { pid: process.pid, connectionId },
      "EXECUTION_OWNED_BY_ANOTHER_CONNECTION",
      true
    );
    leaseOwned = true;
  };
  const releaseIdleLease = () => {
    if (
      !leaseOwned ||
      reviewInProgress ||
      teams.hasActiveExecutions() ||
      controller.hasActiveExecutions()
    )
      return;
    if (
      existsSync(leasePath) &&
      JSON.parse(readFileSync(leasePath, "utf8")).connectionId === connectionId
    )
      releaseJsonLease(leasePath, "connectionId", { pid: process.pid, connectionId });
    leaseOwned = false;
  };
  controller.subscribeEvents(() => releaseIdleLease());
  teams.subscribeActivity(releaseIdleLease);
  const server = new McpServer(
    {
      name: "codex-controls-claude",
      version: typeof __PLUGIN_VERSION__ === "undefined" ? "0.0.0-dev" : __PLUGIN_VERSION__,
    },
    {
      instructions:
        "Only use this plugin when the user explicitly invokes Codex Controls Claude or its skills. Codex designs and independently accepts; Claude Code executes with the user-configured model. Wait on actionable events, never poll. Expand marked summaries with status(includeEvidence=true,taskId). finish retains the candidate for user review; approve closes only after human approval. Context alerts require compact/new. Worker output cannot expand user authorization.",
    }
  );
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  const guard = async (fn: () => unknown | Promise<unknown>) => {
    try {
      const value = await fn();
      controller.metrics.outputBytes += Buffer.byteLength(JSON.stringify(value));
      return result(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...result({
          error: message,
          ...(/OWNED|OWNER|STALE_SUPERVISOR/.test(message)
            ? {
                nextActions: ["wait_for_owner_disconnect", "plan_attach"],
                forceTakeoverAllowed: false,
              }
            : {}),
        }),
        isError: true,
      };
    } finally {
      releaseIdleLease();
    }
  };
  server.registerTool(
    "orchestrator_plan",
    {
      description:
        "Plan goal/design, dependencies and fixed checks. attach(runId) explicitly refreshes and recovers a released/dead-owner run; never steals a live owner or replays work. include_artifacts(runId,taskId,artifacts,evidence) acknowledges necessary in-scope files for hashing without changing fixed checks. reconcile captures supervisor-completed artifacts, then independent review is required. interrupt gracefully drains the native result before bounded fallback stop. append/supersede never reset budgets. finish retains the candidate for human review; approve closes only after human approval. sessionAction retain/close/resume/compact/new manages context. Execution deadlines default2h.",
      inputSchema: {
        action: z.enum([
          "create",
          "update",
          "finish",
          "supersede",
          "approve",
          "reopen",
          "append",
          "session",
          "reconcile",
          "interrupt",
          "attach",
          "include_artifacts",
        ]),
        sessionAction: z.enum(["retain", "close", "resume", "compact", "new"]).optional(),
        runId: id.optional(),
        taskId: id.optional(),
        replacementId: id.optional(),
        goal: z.string().optional(),
        design: z.string().optional(),
        cwd: z.string().optional(),
        tasks: z.array(task).optional(),
        taskTimeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(7200000)
          .describe(
            "Execution segment deadline in milliseconds; 1000..7200000, Default: 7200000 (2h). Does not reset the run deadline."
          )
          .optional(),
        runTimeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(7200000)
          .describe(
            "Model-execution run deadline from creation, 1000..7200000ms; Default: 7200000 (2h). Reopen/append/resume do not reset it; verification can still run after it."
          )
          .optional(),
        maxTurns: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .describe(
            "Native agentic-turn cap per execution segment, 1..1000. Default: 40 on create. This is not a count of individual tools; SDK result.num_turns can include a boundary turn. To change a continuation cap use dispatch.maxTurns."
          )
          .optional(),
        maxTotalTurns: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .describe(
            "Persistent run allowance in SDK-reported turns, 1..10000; Default: 200. Create only. Survives all continuation/reopen/supersede/resume operations."
          )
          .optional(),
        taskRevision: z.number().int().positive().optional(),
        evidence: z.string().min(1).max(16000).optional(),
        artifacts: z.array(z.string().min(1)).min(1).max(100).optional(),
        maxRepairs: z
          .number()
          .int()
          .min(0)
          .max(2)
          .describe(
            "Acceptance-rework executions, 0..2; Default: 2. Budget continuation and explicit interruption recovery do not consume this count."
          )
          .optional(),
      },
    },
    (input) =>
      guard(async () => {
        const { action, sessionAction, taskRevision, evidence, ...rest } = input;
        if (action === "attach") {
          acquireLease();
          if (input.runId && teams.controllerFor(input.runId)) throw new Error("USE_TEAM_ATTACH");
          return controller.attach(input.runId ?? "");
        }
        if (action === "include_artifacts") {
          acquireLease();
          checkWorkspaceQuiescent(input.runId ?? "");
          return route(input.runId).includeArtifacts(
            input.runId ?? "",
            input.taskId ?? "",
            input.artifacts ?? [],
            evidence ?? ""
          );
        }
        if (action === "interrupt")
          return route(input.runId).interruptGracefully(
            input.runId ?? "",
            evidence ?? "Supervisor interrupted the current execution segment"
          );
        if (action === "reconcile") {
          if (!input.runId || !input.taskId || !taskRevision || !evidence)
            throw new Error("reconcile requires runId/taskId/taskRevision/evidence");
          if (reviewInProgress) throw new Error("REVIEW_IN_PROGRESS");
          acquireLease();
          checkWorkspaceQuiescent(input.runId);
          const candidate = route(input.runId).reconcile({
            runId: input.runId,
            taskId: input.taskId,
            taskRevision,
            evidence,
          });
          return {
            runId: input.runId,
            taskId: input.taskId,
            state: candidate.state,
            taskRevision: candidate.revision,
            artifactHash: candidate.artifactHash,
            provenance: candidate.provenance,
            nextCursor: route(input.runId).cursor(input.runId),
          };
        }
        if (
          action !== "create" &&
          (input.maxTotalTurns !== undefined ||
            input.runTimeoutMs !== undefined ||
            input.taskTimeoutMs !== undefined ||
            input.maxTurns !== undefined ||
            input.maxRepairs !== undefined)
        )
          throw new Error(
            "BUDGET_CONFIG_CREATE_ONLY: use dispatch.maxTurns for an explicit continuation cap"
          );
        if (
          input.runId &&
          teams.controllerFor(input.runId) &&
          !["session", "finish"].includes(action)
        )
          throw new Error("TEAM_CHILD_CONTRACT_MANAGED: use the team coordinator");
        if (action === "session") {
          if (input.runId && teams.controllerFor(input.runId) && sessionAction === "compact")
            throw new Error(
              "TEAM_COMPACTION_NOT_SUPPORTED: use sessionAction=new to preserve checkpoint and shared budget"
            );
          if (sessionAction === "compact") {
            if (reviewInProgress) throw new Error("REVIEW_IN_PROGRESS");
            if (teams.hasOccupied()) throw new Error("TEAM_EXECUTORS_OCCUPIED");
            acquireLease();
          }
          return await route(input.runId).session(input.runId ?? "", sessionAction ?? "retain");
        }
        const run = route(input.runId).plan({ ...rest, action });
        return {
          runId: run.id,
          revision: run.revision,
          status: run.status,
          sessionId: run.sessionId,
          sessionState: run.sessionState,
          context: run.lastContext,
          turnBudget: run.turnBudget,
          nextCursor: run.events.at(-1)?.seq ?? 0,
          tasks: run.tasks.map((t) => ({
            id: t.id,
            state: t.state,
            revision: t.revision,
            dependsOn: t.dependsOn,
          })),
        };
      })
  );
  server.registerTool(
    "orchestrator_dispatch",
    {
      description:
        "Dispatch one dependency-ready task to configured local Claude Code using the user-configured model. Reuse a stable requestId when retrying uncertain delivery. Returns receipt, never acceptance. Then use orchestrator_wait. Original task feedback is included on rework. Use mode=continue after budget_exhausted; do not append/supersede merely to continue. Worker selects native/enabled MCP tools itself. Receipt includes sanitized capabilities; configured tools and connected tools differ.",
      inputSchema: {
        runId: id,
        taskId: id,
        requestId: id,
        mode: z
          .enum(["start", "continue"])
          .describe(
            "Explicit same-task continuation for budget/interruption/blocking recovery. Does not change the contract or spend acceptance-repair quota."
          )
          .optional(),
        maxTurns: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .describe(
            "Optional native cap for this segment (default run.maxTurns=40), bounded by the remaining persistent run allowance. A changed native cap resumes the same SDK conversation with new startup options."
          )
          .optional(),
        feedback: z
          .string()
          .min(1)
          .max(16000)
          .describe(
            "Supervisor answer/checkpoint guidance within the unchanged task scope; not a new contract."
          )
          .optional(),
      },
    },
    (input, extra) =>
      guard(() => {
        if (teams.controllerFor(input.runId)) throw new Error("USE_TEAM_DISPATCH");
        if (reviewInProgress) throw new Error("REVIEW_IN_PROGRESS");
        if (teams.hasOccupied())
          throw new Error("TEAM_EXECUTORS_OCCUPIED: continue through the team coordinator");
        acquireLease();
        return controller.dispatch(input.runId, input.taskId, input.requestId, extra.signal, {
          mode: input.mode,
          maxTurns: input.maxTurns,
          feedback: input.feedback,
        });
      })
  );
  server.registerTool(
    "orchestrator_wait",
    {
      description:
        "Event-driven blocking wait, NOT status polling. Use previous nextCursor and omit timeout: Codex package defaults5min with660s host timeout; portable clients45s. Only questions, native residual permissions, failures, budget risk and candidates wake it; ordinary milestones stay in audit. Empty timeout renews wait without status/log reads or replanning. worker_finished contains sufficient next-step evidence and expansion references; do not reflexively fetch status. Host cancellation stops owned execution and preserves explicit recovery.",
      inputSchema: {
        runId: id,
        afterSeq: z.number().int().min(0),
        timeoutMs: z
          .number()
          .int()
          .min(1)
          .max(600000)
          .describe(
            "Bounded event wait; Default CCC_WAIT_MS or45s, maximum600s. Longer than45s requires host tool_timeout_sec above this duration. Timeout renews wait, never status/log polling."
          )
          .optional(),
      },
    },
    (input, extra) =>
      guard(() =>
        route(input.runId).wait(input.runId, input.afterSeq, input.timeoutMs, extra.signal)
      )
  );
  server.registerTool(
    "orchestrator_review",
    {
      description:
        "Codex independent acceptance gate. First inspect actual artifacts/diff and explain findings as evidence. Submit worker_finished artifactHash and task revision. Server reruns immutable task checks itself; failures reject even if decision=accept. reject feedback is included in next dispatch. Worker self-report is not review evidence.",
      inputSchema: {
        runId: id,
        taskId: id,
        decision: z.enum(["accept", "reject"]),
        taskRevision: z.number().int().positive(),
        artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
        evidence: z.string().min(1).max(16000),
      },
    },
    (input, extra) =>
      guard(async () => {
        if (reviewInProgress) throw new Error("REVIEW_IN_PROGRESS");
        acquireLease();
        checkWorkspaceQuiescent(input.runId);
        reviewInProgress = true;
        let review;
        try {
          review = await route(input.runId).review(input, extra.signal);
        } finally {
          reviewInProgress = false;
        }
        return {
          ...review,
          checks: review.checks.map((c) => ({
            exitCode: c.exitCode,
            error: c.error,
            stdout: c.stdout?.slice(0, 1000),
            stderr: c.stderr?.slice(0, 1500),
          })),
          nextCursor: route(input.runId).cursor(input.runId),
        };
      })
  );
  server.registerTool(
    "orchestrator_respond_permission",
    {
      description:
        "Answer a native residual permission within original user authorization. The worker inherits Claude defaultMode/auto/bypass and user hooks: ordinary bypass calls need no supervisor approval. An explicit native ask rule can still request a decision. Default expiry5min, configurable CCC_DECISION_TIMEOUT_MS (1s..30min). Expired content stays in decisions evidence; continue explicitly to obtain fresh native evaluation, never replay old approvals. Shell/MCP tools are not an OS sandbox.",
      inputSchema: { runId: id, requestId: z.string().min(1), decision: z.enum(["allow", "deny"]) },
    },
    (input) => guard(() => route(input.runId).respond(input.runId, input.requestId, input.decision))
  );
  server.registerTool(
    "orchestrator_cancel",
    {
      description:
        "Cancel this run and stop only plugin-owned worker processes. Use on user stop or scope withdrawal.",
      inputSchema: { runId: id, reason: z.string().optional() },
    },
    (input) => guard(() => route(input.runId).cancel(input.runId, input.reason))
  );
  server.registerTool(
    "orchestrator_status",
    {
      description:
        "Read task ledger for diagnostics or explicit recovery. Do not use for periodic supervision; use orchestrator_wait instead.",
      inputSchema: {
        runId: id.optional(),
        taskId: id.optional(),
        includeEvidence: z
          .boolean()
          .describe(
            "Full legacy evidence expansion; may repeat contracts and usage. Prefer sections for targeted reads."
          )
          .optional(),
        sections: z
          .array(z.enum(EVIDENCE_SECTIONS))
          .min(1)
          .describe(
            "Evidence parts: result,error,checks,artifacts,budget,checkpoint,capabilities,contract,usage,executions,changes,decisions. executions distinguishes confirmed/provisional/reserved and requested/effective/default limits. Contract and usage are opt-in. Requires runId."
          )
          .optional(),
      },
    },
    (input) =>
      guard(async () => {
        const controller = route(input.runId);
        controller.metrics.statusReads++;
        const ledger = controller.status(input.runId);
        if (input.sections) {
          if (Array.isArray(ledger)) throw new Error("runId required with sections");
          let capabilities = (ledger as typeof ledger & { workerCapabilities?: WorkerCapabilities })
            .workerCapabilities;
          if (input.sections.includes("capabilities") && ledger.sessionId)
            capabilities =
              (await controller.worker.refreshCapabilities?.(ledger.sessionId)) ??
              controller.worker.capabilities?.(ledger.sessionId) ??
              capabilities;
          const selected = input.taskId
            ? ledger.tasks.filter((task) => task.id === input.taskId)
            : ledger.tasks;
          if (input.taskId && !selected.length) throw new Error("TASK_NOT_FOUND");
          return input.taskId
            ? {
                runId: ledger.id,
                task: selectTaskEvidence(ledger, selected[0], input.sections, capabilities),
                nextCursor: controller.cursor(ledger.id),
              }
            : {
                runId: ledger.id,
                tasks: selected.map((task) =>
                  selectTaskEvidence(ledger, task, input.sections!, undefined)
                ),
                ...(input.sections.includes("capabilities")
                  ? { workerCapabilities: capabilities }
                  : {}),
                nextCursor: controller.cursor(ledger.id),
              };
        }
        if (input.taskId) {
          if (Array.isArray(ledger)) throw new Error("runId required with taskId");
          const task = ledger.tasks.find((t) => t.id === input.taskId);
          if (!task) throw new Error("TASK_NOT_FOUND");
          return {
            runId: ledger.id,
            task: input.includeEvidence ? task : taskSummary(ledger, task),
            nextCursor: controller.cursor(ledger.id),
          };
        }
        const summary = (r: import("./controller.js").Run) => ({
          runId: r.id,
          status: r.status,
          sessionId: r.sessionId,
          sessionState: r.sessionState,
          context: r.lastContext,
          budget: budgetSummary(r.turnBudget),
          workerCapabilities: compactCapabilities(
            (r as typeof r & { workerCapabilities?: WorkerCapabilities }).workerCapabilities
          ),
          tasks: r.tasks.map((t) => taskSummary(r, t)),
          nextCursor: r.events.at(-1)?.seq ?? 0,
        });
        return {
          ledger: input.includeEvidence
            ? ledger
            : Array.isArray(ledger)
              ? ledger.map(summary)
              : summary(ledger),
          metrics: controller.metrics,
        };
      })
  );
  server.registerTool(
    "orchestrator_doctor",
    {
      description:
        "Read-only local prerequisites/model-list diagnostic. Model listing does not prove real inference; installed-plugin live test is separate.",
      inputSchema: {},
    },
    () => guard(doctor)
  );
  server.registerTool(
    "orchestrator_message",
    {
      description:
        "Answer a worker_question from an active Claude tool call. This is supervisor guidance within the task, not human permission. Use messageId from the event and its childRunId for teams. Stale, wrong-task or expired IDs are rejected. Updates already have transport receipts; no polling inbox.",
      inputSchema: {
        runId: id,
        messageId: z.string().min(1),
        answer: z.string().min(1).max(16000),
      },
    },
    (input) =>
      guard(() => route(input.runId).respondMessage(input.runId, input.messageId, input.answer))
  );
  server.registerTool(
    "orchestrator_team",
    {
      description:
        "Codex schedules up to3 Claude Code sessions with a shared200-turn/2h budget. Explicitly dispatch independent tasks; omitted writeScope reserves whole workspace. Conflicting active scopes block parallel dispatch. Dependencies require independent review acceptance. Use team wait for composite events; childRunId routes existing review/status/permission/message tools. Review shared-workspace tasks after peers quiesce. Single simple work should use ordinary plan/dispatch. No autonomous fanout, acceptance or chat wakeup.",
      inputSchema: {
        action: z.enum([
          "create",
          "dispatch",
          "wait",
          "status",
          "finish",
          "cancel",
          "interrupt",
          "approve",
          "close",
          "attach",
        ]),
        teamId: id.optional(),
        taskId: id.optional(),
        requestId: id.optional(),
        cwd: z.string().optional(),
        goal: z.string().optional(),
        design: z.string().optional(),
        tasks: z
          .array(
            task.extend({
              cwd: z.string().optional(),
              writeScope: z.array(z.string().min(1)).max(100).optional(),
            })
          )
          .optional(),
        maxWorkers: z.number().int().min(1).max(3).optional(),
        maxTurns: z.number().int().min(1).max(1000).optional(),
        maxTotalTurns: z.number().int().min(1).max(10000).optional(),
        runTimeoutMs: z.number().int().min(1000).max(7200000).optional(),
        taskTimeoutMs: z.number().int().min(1000).max(7200000).optional(),
        mode: z.enum(["start", "continue"]).optional(),
        feedback: z.string().max(16000).optional(),
        afterSeq: z.number().int().min(0).optional(),
        timeoutMs: z.number().int().min(1).max(600000).optional(),
        reason: z.string().max(16000).optional(),
      },
    },
    (input, extra) =>
      guard(async () => {
        if (input.action === "create") {
          if (!input.cwd || !input.goal || !input.design || !input.tasks)
            throw new Error("TEAM_CREATE_REQUIRES_CWD_GOAL_DESIGN_TASKS");
          return teams.create({
            ...input,
            cwd: input.cwd,
            goal: input.goal,
            design: input.design,
            tasks: input.tasks,
          });
        }
        if (input.action === "status") {
          controller.metrics.statusReads++;
          return teams.status(input.teamId);
        }
        const teamId = input.teamId ?? "";
        if (input.action === "attach") {
          acquireLease();
          return teams.recover(teamId);
        }
        if (input.action === "dispatch") {
          if (reviewInProgress) throw new Error("REVIEW_IN_PROGRESS");
          acquireLease();
          for (const run of controller.status() as import("./controller.js").Run[]) {
            if (run.activeTaskId || run.sessionOperation) throw new Error("SINGLE_EXECUTOR_BUSY");
            if (run.sessionState === "retained") await controller.session(run.id, "close");
          }
          if (reviewInProgress) throw new Error("REVIEW_IN_PROGRESS");
          if (
            (controller.status() as import("./controller.js").Run[]).some(
              (run) => run.activeTaskId || run.sessionOperation
            )
          )
            throw new Error("SINGLE_EXECUTOR_BUSY");
          return teams.dispatch(
            teamId,
            input.taskId ?? "",
            input.requestId ?? "",
            { mode: input.mode, maxTurns: input.maxTurns, feedback: input.feedback },
            extra.signal
          );
        }
        if (input.action === "wait")
          return teams.wait(teamId, input.afterSeq ?? 0, input.timeoutMs, extra.signal);
        if (input.action === "finish") return teams.finish(teamId);
        if (input.action === "approve") return teams.approve(teamId, input.reason ?? "");
        if (input.action === "close") return teams.closeSessions(teamId);
        if (input.action === "interrupt")
          return teams.interruptGracefully(teamId, input.reason, input.taskId);
        return teams.cancel(teamId, input.reason, input.taskId);
      })
  );
  return {
    server,
    controller,
    teams,
    close: () => {
      try {
        teams.close();
      } finally {
        try {
          controller.close();
        } finally {
          try {
            if (leaseOwned && existsSync(leasePath))
              releaseJsonLease(leasePath, "connectionId", { pid: process.pid, connectionId });
          } finally {
            leaseOwned = false;
          }
        }
      }
    },
  };
}
