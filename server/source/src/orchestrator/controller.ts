import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import type { AgentResult } from "../types.js";
import type { Worker, WorkerEvent, ContextInfo } from "./worker.js";
import { inside, executeCheck } from "./runtime.js";
import { compactCapabilities, type WorkerCapabilities } from "./capabilities.js";
import {
  DEFAULT_SEGMENT_TURNS,
  DEFAULT_RUN_TURN_LIMIT,
  normalizedBudget,
  availableGrant,
  reserveGrant,
  settleReservation,
  type TurnBudget,
} from "./budget.js";

export interface Check {
  command: string;
  args: string[];
}
export interface TaskSpec {
  id: string;
  title: string;
  instructions: string;
  dependsOn: string[];
  acceptance: string;
  artifacts: string[];
  checks: Check[];
}
type TaskState =
  | "pending"
  | "running"
  | "awaiting_review"
  | "accepted"
  | "needs_revision"
  | "blocked"
  | "failed"
  | "superseded"
  | "interrupted"
  | "budget_exhausted";
export interface Task extends TaskSpec {
  revision: number;
  state: TaskState;
  attempts: number;
  repairs: number;
  continuations: number;
  zeroProgressRetries?: number;
  failure?: { kind: string; subtype?: string };
  checkpoint?: {
    at: string;
    taskRevision: number;
    sessionId?: string;
    reason: string;
    artifacts: Record<string, string | null>;
    changedDeclaredArtifacts: string[];
    accountingKnown: boolean;
    artifactComparison: "known" | "unavailable";
  };
  provenance?: { producer: "worker" | "supervisor_reconcile"; at: string; note?: string };
  baselineArtifacts?: Record<string, string | null>;
  feedback?: string;
  artifactHash?: string;
  result?: AgentResult;
  reviews: unknown[];
  startedAt?: number;
  supersededBy?: string;
}
export interface RunEvent {
  seq: number;
  type: string;
  taskId?: string;
  data: unknown;
  at: string;
  actionable: boolean;
}
export interface Run {
  id: string;
  goal: string;
  design: string;
  cwd: string;
  revision: number;
  status: "open" | "awaiting_user_review" | "completed" | "cancelled";
  sessionState?: "retained" | "closed" | "resume_pending";
  sessionOperation?: "compact";
  compactBoundarySeen?: boolean;
  checkpoint?: string;
  previousSessions?: string[];
  lastContext?: ContextInfo;
  createdAt: string;
  deadline: number;
  taskTimeoutMs: number;
  maxTurns: number;
  turnBudget: TurnBudget;
  workerCapabilities?: WorkerCapabilities;
  maxRepairs: number;
  tasks: Task[];
  events: RunEvent[];
  receipts: Record<
    string,
    {
      taskId: string;
      attempt: number;
      sessionId?: string;
      status: string;
      startupMs?: number;
      nextCursor?: number;
      nativeLimit?: number;
      turnBudget?: TurnBudget;
      workerCapabilities?: ReturnType<typeof compactCapabilities>;
    }
  >;
  sessionId?: string;
  activeTaskId?: string;
  ownerPid: number;
}

function taskContract(task: TaskSpec): TaskSpec {
  const { id, title, instructions, dependsOn, acceptance, artifacts, checks } = task;
  return { id, title, instructions, dependsOn, acceptance, artifacts, checks };
}

function fail(message: string): never {
  throw new Error(message);
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class Orchestrator {
  private runs = new Map<string, Run>();
  private listeners = new Set<(runId: string) => void>();
  private seen = new Map<string, { epoch: number; id: number }>();
  private startups = new Map<string, { valid: boolean }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: () => void;
  private unsubscribeMessages?: () => void;
  private pendingMessages = new Map<string, { runId: string; taskId: string; sessionId: string }>();
  private closed = false;
  private reviewing = new Set<string>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private eventSubscribers = new Set<(run: Run, event: RunEvent) => void>();

  subscribeEvents(listener: (run: Run, event: RunEvent) => void) {
    this.eventSubscribers.add(listener);
    return () => {
      this.eventSubscribers.delete(listener);
    };
  }
  readonly metrics = {
    waits: 0,
    wakeups: 0,
    waitTimeouts: 0,
    statusReads: 0,
    logPolls: 0,
    outputBytes: 0,
  };

  constructor(
    readonly dataDir: string,
    readonly worker: Worker
  ) {
    mkdirSync(dataDir, { recursive: true });
    for (const file of readdirSync(dataDir).filter((f) => /^run-[\w-]+\.json$/.test(f))) {
      const run = JSON.parse(readFileSync(path.join(dataDir, file), "utf8")) as Run;
      this.migrate(run);
      const last = run.events.at(-1);
      if (
        !alive(run.ownerPid) &&
        run.status === "cancelled" &&
        last?.type === "run_cancelled" &&
        [
          "Execution deadline exceeded",
          "MCP connection closed",
          "Host cancelled wait",
          "Host cancelled acceptance",
        ].includes((last.data as { reason?: string }).reason ?? "")
      )
        run.status = "open";
      if (
        (run.status === "open" || run.status === "awaiting_user_review") &&
        !alive(run.ownerPid)
      ) {
        if (run.turnBudget.reserved) {
          const orphaned = run.turnBudget.reserved;
          settleReservation(run.turnBudget, orphaned, undefined);
          run.turnBudget.recovered = (run.turnBudget.recovered ?? 0) + orphaned;
        }
        run.ownerPid = process.pid;
        run.activeTaskId = undefined;
        run.sessionState = "closed";
        run.sessionOperation = undefined;
        for (const task of run.tasks)
          if (task.state === "running") {
            task.state = "interrupted";
            task.failure = { kind: "interrupted" };
            try {
              this.captureCheckpoint(run, task, "Owner process was lost", false);
            } catch {
              /* Workspace may no longer exist. */
            }
          }
        this.runs.set(run.id, run);
        this.emit(run, "recovered", { automaticReplay: false });
      } else this.runs.set(run.id, run);
    }
    this.unsubscribe = worker.subscribe((event) => this.consume(event));
    this.unsubscribeMessages = worker.subscribeMessages?.(({ sessionId, message }) => {
      const run =
        [...this.runs.values()].find(
          (r) => r.sessionId === sessionId && r.activeTaskId && r.status === "open"
        ) ??
        [...this.runs.values()].find(
          (r) => r.activeTaskId && r.status === "open" && this.startups.get(r.id)?.valid
        );
      if (!run || this.closed) return;
      run.sessionId = sessionId;
      if (message.kind === "question")
        this.pendingMessages.set(message.id, {
          runId: run.id,
          taskId: run.activeTaskId!,
          sessionId,
        });
      this.emit(
        run,
        message.kind === "question" ? "worker_question" : "worker_message",
        {
          messageId: message.id,
          kind: message.kind,
          text: message.text,
          trust: "worker_observation",
          requiresResponse: message.kind === "question",
          nextActions: message.kind === "question" ? ["respond_message"] : ["continue_wait"],
        },
        run.activeTaskId
      );
    });
  }

  respondMessage(runId: string, messageId: string, answer: string) {
    const run = this.get(runId);
    const pending = this.pendingMessages.get(messageId);
    if (
      !pending ||
      pending.runId !== runId ||
      pending.taskId !== run.activeTaskId ||
      run.sessionId !== pending.sessionId ||
      !this.worker.respondMessage?.(messageId, answer)
    )
      fail("MESSAGE_NOT_PENDING_OR_STALE");
    this.pendingMessages.delete(messageId);
    this.emit(
      run,
      "supervisor_answered",
      {
        messageId,
        answer,
        delivery: "answered_in_worker_tool",
        trust: "supervisor_scope_guidance",
      },
      pending.taskId,
      false
    );
    return {
      runId,
      messageId,
      delivery: "answered_in_worker_tool",
      nextCursor: this.cursor(runId),
    };
  }

  private migrate(run: Run) {
    if (!run.turnBudget) {
      let used = 0,
        observed = 0;
      for (const event of run.events)
        if (event.type === "worker_finished") {
          const count = (event.data as { result?: AgentResult }).result?.numTurns;
          if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
            used += count;
            observed++;
          }
        }
      const missing = Math.max(0, run.tasks.reduce((n, task) => n + task.attempts, 0) - observed);
      run.turnBudget = normalizedBudget({
        used: used + missing * (run.maxTurns + 1),
        estimated: missing * (run.maxTurns + 1),
      });
    } else run.turnBudget = normalizedBudget(run.turnBudget);
    for (const task of run.tasks) {
      if (task.repairs === undefined) {
        let pendingRepair = false,
          repairs = 0;
        for (const event of run.events.filter((event) => event.taskId === task.id)) {
          if (event.type === "task_rejected") pendingRepair = true;
          if (event.type === "dispatch_intent") {
            if (pendingRepair) repairs++;
            pendingRepair = false;
          }
        }
        task.repairs = repairs;
      }
      task.continuations ??= Math.max(0, task.attempts - 1 - task.repairs);
      if (task.state === "failed" && task.result?.errorSubtype === "error_max_turns")
        task.state = "budget_exhausted";
    }
  }

  private artifactSnapshot(run: Run, task: Task) {
    return Object.fromEntries(
      task.artifacts.map((file) => {
        if (!inside(run.cwd, file)) fail("ARTIFACT_OUTSIDE_WORKSPACE");
        const absolute = path.resolve(run.cwd, file);
        return [
          file,
          existsSync(absolute)
            ? createHash("sha256").update(readFileSync(absolute)).digest("hex")
            : null,
        ];
      })
    );
  }
  private captureCheckpoint(run: Run, task: Task, reason: string, accountingKnown: boolean) {
    const artifacts = this.artifactSnapshot(run, task);
    task.checkpoint = {
      at: new Date().toISOString(),
      taskRevision: task.revision,
      sessionId: run.sessionId,
      reason,
      artifacts,
      artifactComparison: task.baselineArtifacts ? "known" : "unavailable",
      changedDeclaredArtifacts: task.baselineArtifacts
        ? task.artifacts.filter((file) => artifacts[file] !== task.baselineArtifacts?.[file])
        : [],
      accountingKnown,
    };
    return task.checkpoint;
  }
  private dependenciesAccepted(run: Run, task: Task) {
    return task.dependsOn.every((id) => {
      let dependency = this.task(run, id);
      const seen = new Set<string>();
      while (
        dependency.state === "superseded" &&
        dependency.supersededBy &&
        !seen.has(dependency.id)
      ) {
        seen.add(dependency.id);
        dependency = this.task(run, dependency.supersededBy);
      }
      return dependency.state === "accepted";
    });
  }
  private stoppedTask(
    run: Run,
    task: Task,
    reason: string,
    kind: string,
    state: Task["state"],
    eventType: string
  ) {
    const startup = this.startups.get(run.id);
    if (startup) startup.valid = false;
    settleReservation(run.turnBudget, run.turnBudget.reserved, undefined);
    run.activeTaskId = undefined;
    run.sessionOperation = undefined;
    run.sessionState = "closed";
    this.release(run);
    task.state = state;
    task.failure = { kind };
    task.result = {
      sessionId: run.sessionId ?? "",
      result: reason,
      isError: true,
      errorSubtype: "orchestrator_" + kind,
      numTurns: 0,
      durationMs: Date.now() - (task.startedAt ?? Date.now()),
      totalCostUsd: 0,
    };
    task.checkpoint = undefined;
    let checkpoint: Task["checkpoint"];
    try {
      checkpoint = this.captureCheckpoint(run, task, reason, false);
    } catch (error) {
      task.feedback = `Checkpoint capture failed: ${String(error)}`;
    }
    this.emit(
      run,
      eventType,
      {
        state: task.state,
        result: task.result,
        reason,
        failureClass: kind,
        checkpointAvailable: !!checkpoint,
        changedDeclaredArtifacts: checkpoint?.changedDeclaredArtifacts,
        nextActions:
          Date.now() < run.deadline && availableGrant(run.turnBudget, run.maxTurns) > 0
            ? ["continue", "reconcile", "cancel"]
            : ["reconcile", "cancel"],
        turnBudget: run.turnBudget,
      },
      task.id
    );
  }
  private stopExecution(run: Run, reason: string, kind: "interrupted" | "time_budget") {
    const startup = this.startups.get(run.id);
    if (startup) startup.valid = false;
    const task = run.activeTaskId ? this.task(run, run.activeTaskId) : undefined;
    this.worker.stop(run.sessionId);
    if (task)
      this.stoppedTask(
        run,
        task,
        reason,
        kind,
        kind === "time_budget" ? "budget_exhausted" : "interrupted",
        "worker_finished"
      );
    else {
      settleReservation(run.turnBudget, run.turnBudget.reserved, undefined);
      run.sessionOperation = undefined;
      run.sessionState = "closed";
      this.release(run);
      this.emit(run, "execution_interrupted", { reason, turnBudget: run.turnBudget });
    }
  }

  private save(run: Run) {
    const dest = path.join(this.dataDir, `run-${run.id}.json`);
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(run, null, 2), { mode: 0o600 });
    renameSync(tmp, dest);
  }

  private emit(run: Run, type: string, data: unknown, taskId?: string, actionable = true) {
    if (["worker_finished", "worker_failed", "task_blocked", "run_cancelled"].includes(type))
      for (const [id, pending] of this.pendingMessages)
        if (pending.runId === run.id) this.pendingMessages.delete(id);
    if (
      [
        "plan_created",
        "plan_updated",
        "task_accepted",
        "task_rejected",
        "candidate_delivered",
        "task_superseded",
      ].includes(type)
    )
      actionable = false;
    const event: RunEvent = {
      seq: (run.events.at(-1)?.seq ?? 0) + 1,
      type,
      data,
      taskId,
      at: new Date().toISOString(),
      actionable,
    };
    run.events.push(event);
    this.save(run);
    for (const subscriber of [...this.eventSubscribers]) subscriber(run, event);
    if (actionable) for (const listener of [...this.listeners]) listener(run.id);
    return event;
  }

  private get(id: string, writable = true) {
    const run = this.runs.get(id) ?? fail("RUN_NOT_FOUND");
    if (writable && run.ownerPid !== process.pid) fail("RUN_OWNED_BY_ANOTHER_CONNECTION");
    return run;
  }

  cursor(runId: string) {
    return this.get(runId, false).events.at(-1)?.seq ?? 0;
  }

  eventSummary(runId: string, event: RunEvent) {
    return this.brief(event, runId);
  }

  private brief(event: RunEvent, runId: string): RunEvent {
    if (event.type !== "worker_finished") return event;
    const data = event.data as {
      state: string;
      artifactHash?: string;
      result?: AgentResult;
      feedback?: string;
      elapsedMs?: number;
      context?: ContextInfo;
      artifacts?: string[];
      failureClass?: string;
      checkpointAvailable?: boolean;
      changedDeclaredArtifacts?: string[];
      nextActions?: string[];
      turnBudget?: TurnBudget;
    };
    return {
      ...event,
      data: {
        state: data.state,
        artifactHash: data.artifactHash,
        elapsedMs: data.elapsedMs,
        context: data.context,
        artifacts: data.artifacts,
        failureClass: data.failureClass,
        checkpointAvailable: data.checkpointAvailable,
        changedDeclaredArtifacts: data.changedDeclaredArtifacts,
        nextActions: data.nextActions,
        turnBudget: data.turnBudget,
        checkpointRef: data.checkpointAvailable
          ? { tool: "orchestrator_status", runId, taskId: event.taskId, sections: ["checkpoint"] }
          : undefined,
        result: data.result
          ? {
              sessionId: data.result.sessionId,
              summary: ["failed", "blocked"].includes(data.state)
                ? data.result.result
                : data.result.result.slice(0, 1000),
              truncated:
                !["failed", "blocked"].includes(data.state) && data.result.result.length > 1000,
              detailRef: {
                runId,
                taskId: event.taskId,
                tool: "orchestrator_status",
                includeEvidence: true,
              },
              isError: data.result.isError,
              numTurns: data.result.numTurns,
              errorSubtype: data.result.errorSubtype,
              structuredOutput: data.result.structuredOutput,
              stopReason: data.result.stopReason,
              permissionDenials: data.result.permissionDenials,
            }
          : undefined,
        feedback: data.feedback,
      },
    };
  }

  private task(run: Run, id: string) {
    return run.tasks.find((t) => t.id === id) ?? fail("TASK_NOT_FOUND");
  }
  private open(run: Run, execution = false) {
    if (run.status !== "open") fail("RUN_CLOSED");
    if (execution && Date.now() >= run.deadline) fail("RUN_DEADLINE");
  }

  private validateTasks(cwd: string, specs: TaskSpec[]) {
    if (!specs.length || specs.length > 100) fail("Provide 1 to 100 tasks");
    const ids = new Set(specs.map((t) => t.id));
    if (ids.size !== specs.length) fail("DUPLICATE_TASK_ID");
    for (const task of specs) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(task.id)) fail("INVALID_TASK_ID");
      if (!task.artifacts.length || !task.checks.length)
        fail("Each task needs artifacts and executable acceptance checks");
      for (const file of task.artifacts) if (!inside(cwd, file)) fail("ARTIFACT_OUTSIDE_WORKSPACE");
      for (const id of task.dependsOn) if (!ids.has(id)) fail("UNKNOWN_DEPENDENCY");
    }
    const visiting = new Set<string>(),
      done = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) fail("DEPENDENCY_CYCLE");
      if (done.has(id)) return;
      visiting.add(id);
      for (const dep of specs.find((t) => t.id === id)!.dependsOn) visit(dep);
      visiting.delete(id);
      done.add(id);
    };
    for (const id of ids) visit(id);
  }

  private validateReplacements(tasks: Task[], requireAccepted = false) {
    for (const task of tasks.filter((t) => t.state === "superseded")) {
      const seen = new Set<string>([task.id]);
      let current = task;
      while (current.state === "superseded") {
        const next = tasks.find((t) => t.id === current.supersededBy);
        if (!next) fail("MISSING_REPLACEMENT");
        if (seen.has(next.id)) fail("REPLACEMENT_CYCLE");
        seen.add(next.id);
        current = next;
      }
      if (requireAccepted && current.state !== "accepted") fail("UNACCEPTED_REPLACEMENT");
    }
  }

  plan(input: {
    action: "create" | "update" | "finish" | "supersede" | "approve" | "reopen" | "append";
    taskId?: string;
    replacementId?: string;
    runId?: string;
    goal?: string;
    design?: string;
    cwd?: string;
    tasks?: TaskSpec[];
    taskTimeoutMs?: number;
    runTimeoutMs?: number;
    maxTurns?: number;
    maxTotalTurns?: number;
    maxRepairs?: number;
  }): Run {
    if (input.action === "create") {
      if (!input.cwd || !input.goal || !input.design || !input.tasks)
        fail("create requires cwd, goal, design, tasks");
      const cwd = realpathSync(input.cwd);
      this.validateTasks(cwd, input.tasks);
      if ([...this.runs.values()].some((r) => r.ownerPid === process.pid && r.status === "open"))
        fail("OPEN_RUN_EXISTS: finish or cancel the current run before creating another");
      for (const previous of this.runs.values())
        if (previous.ownerPid === process.pid && previous.status === "awaiting_user_review")
          this.closeSession(previous);
      const run: Run = {
        id: randomUUID(),
        goal: input.goal,
        design: input.design,
        cwd,
        revision: 1,
        status: "open",
        createdAt: new Date().toISOString(),
        deadline: Date.now() + (input.runTimeoutMs ?? 7200000),
        taskTimeoutMs: input.taskTimeoutMs ?? 7200000,
        maxTurns: input.maxTurns ?? DEFAULT_SEGMENT_TURNS,
        turnBudget: normalizedBudget(undefined, input.maxTotalTurns ?? DEFAULT_RUN_TURN_LIMIT),
        maxRepairs: input.maxRepairs ?? 2,
        tasks: input.tasks.map((t) => ({
          ...t,
          revision: 1,
          state: "pending",
          attempts: 0,
          repairs: 0,
          continuations: 0,
          reviews: [],
        })),
        events: [],
        receipts: {},
        ownerPid: process.pid,
      };
      this.runs.set(run.id, run);
      this.emit(run, "plan_created", { revision: 1 });
      return run;
    }
    const run = this.get(input.runId ?? "");
    if (input.action === "approve") {
      if (run.status !== "awaiting_user_review") fail("USER_REVIEW_NOT_PENDING");
      this.closeSession(run);
      run.status = "completed";
      this.emit(
        run,
        "user_approved",
        { sessionId: run.sessionId, transcriptRetained: true },
        undefined,
        false
      );
      return run;
    }
    if (input.action === "reopen" || input.action === "append") {
      if (
        [...this.runs.values()].some(
          (r) => r.id !== run.id && r.ownerPid === process.pid && r.status === "open"
        )
      )
        fail("OPEN_RUN_EXISTS");
      if (input.action === "append") {
        const additions = input.tasks ?? fail("append requires new tasks");
        if (additions.some((t) => run.tasks.some((old) => old.id === t.id)))
          fail("DUPLICATE_TASK_ID");
        this.validateTasks(run.cwd, [...run.tasks, ...additions]);
      }
      for (const previous of this.runs.values())
        if (
          previous.id !== run.id &&
          previous.ownerPid === process.pid &&
          previous.status === "awaiting_user_review"
        )
          this.closeSession(previous);
      if (run.status === "awaiting_user_review" || run.status === "completed") {
        run.status = "open";
        const idle = this.idleTimers.get(run.id);
        if (idle) clearTimeout(idle);
        this.idleTimers.delete(run.id);
      }
      if (input.action === "reopen") {
        this.open(run);
        this.emit(run, "run_reopened", { sessionId: run.sessionId }, undefined, false);
        return run;
      }
      const additions = input.tasks ?? fail("append requires new tasks");
      if (additions.some((t) => run.tasks.some((old) => old.id === t.id)))
        fail("DUPLICATE_TASK_ID");
      const existing = run.tasks.map(
        ({ id, title, instructions, dependsOn, acceptance, artifacts, checks }) => ({
          id,
          title,
          instructions,
          dependsOn,
          acceptance,
          artifacts,
          checks,
        })
      );
      return this.plan({ ...input, action: "update", tasks: [...existing, ...additions] });
    }
    this.open(run);
    if (this.reviewing.has(run.id)) fail("REVIEW_IN_PROGRESS");
    if (input.action === "supersede") {
      const old = this.task(run, input.taskId ?? "");
      const replacement = this.task(run, input.replacementId ?? "");
      if (
        old.id === replacement.id ||
        old.state === "running" ||
        replacement.attempts !== 0 ||
        replacement.state !== "pending"
      )
        fail("INVALID_REPLACEMENT");
      const rewired = run.tasks.map((task) =>
        task.attempts === 0
          ? {
              ...task,
              dependsOn: task.dependsOn.map((id) => (id === old.id ? replacement.id : id)),
            }
          : { ...task }
      );
      this.validateTasks(run.cwd, rewired);
      const oldInPlan = rewired.find((t) => t.id === old.id)!;
      oldInPlan.state = "superseded";
      oldInPlan.supersededBy = replacement.id;
      this.validateReplacements(rewired);
      run.tasks = rewired;
      run.revision++;
      this.emit(
        run,
        "task_superseded",
        { replacementId: replacement.id, revision: run.revision },
        old.id
      );
      return run;
    }
    if (input.action === "finish") {
      this.validateReplacements(run.tasks, true);
      if (
        run.activeTaskId ||
        run.tasks.some((t) => t.state !== "accepted" && t.state !== "superseded")
      )
        fail("UNACCEPTED_TASKS");
      for (const task of run.tasks.filter((t) => t.state === "accepted")) {
        const hash = this.hash(run, task);
        if (hash !== task.artifactHash) {
          task.state = "awaiting_review";
          task.artifactHash = hash;
          this.emit(
            run,
            "acceptance_invalidated",
            { artifactHash: hash, reason: "Artifact changed after acceptance; review again" },
            task.id
          );
          return run;
        }
      }
      run.status = "awaiting_user_review";
      run.sessionState = run.sessionId && this.worker.model(run.sessionId) ? "retained" : "closed";
      this.emit(run, "candidate_delivered", {
        acceptedTasks: run.tasks.filter((t) => t.state === "accepted").length,
        supersededTasks: run.tasks.filter((t) => t.state === "superseded").length,
      });
      this.release(run);
      const idle = setTimeout(() => {
        this.closeSession(run);
        this.emit(run, "idle_session_suspended", { transcriptRetained: true }, undefined, false);
      }, 1800000);
      idle.unref();
      this.idleTimers.set(run.id, idle);
      return run;
    }
    if (!input.tasks) fail("update requires complete tasks list");
    this.validateTasks(run.cwd, input.tasks);
    for (const old of run.tasks.filter((t) => t.state === "superseded")) {
      if (!input.tasks.some((t) => t.id === old.supersededBy)) fail("MISSING_REPLACEMENT");
    }
    for (const old of run.tasks.filter((t) => t.attempts > 0 || t.state === "superseded")) {
      const next =
        input.tasks.find((t) => t.id === old.id) ?? fail("DISPATCHED_CONTRACT_IMMUTABLE");
      const contract = {
        id: old.id,
        title: old.title,
        instructions: old.instructions,
        dependsOn: old.dependsOn,
        acceptance: old.acceptance,
        artifacts: old.artifacts,
        checks: old.checks,
      };
      if (JSON.stringify(contract) !== JSON.stringify(taskContract(next)))
        fail("DISPATCHED_CONTRACT_IMMUTABLE");
    }
    run.revision++;
    run.tasks = input.tasks.map((t) => {
      const old = run.tasks.find((x) => x.id === t.id);
      return old && (old.attempts > 0 || old.state === "superseded")
        ? old
        : {
            ...t,
            revision: run.revision,
            state: "pending",
            attempts: 0,
            repairs: 0,
            continuations: 0,
            reviews: [],
          };
    });
    if (input.design) run.design = input.design;
    this.emit(run, "plan_updated", { revision: run.revision });
    return run;
  }

  private closeSession(run: Run) {
    const startup = this.startups.get(run.id);
    if (startup) startup.valid = false;
    const timer = this.idleTimers.get(run.id);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(run.id);
    if (run.sessionId && this.worker.model(run.sessionId)) this.worker.stop(run.sessionId);
    run.sessionState = "closed";
    if (run.sessionOperation) settleReservation(run.turnBudget, run.turnBudget.reserved, undefined);
    run.sessionOperation = undefined;
    this.release(run);
    this.save(run);
  }

  private makeCheckpoint(run: Run) {
    return JSON.stringify({
      goal: run.goal,
      designAndDecisions: run.design,
      accepted: run.tasks
        .filter((t) => t.state === "accepted")
        .map((t) => ({
          id: t.id,
          contract: t.acceptance,
          artifacts: t.artifacts,
          implementation: t.result?.result,
          structuredOutput: t.result?.structuredOutput,
          supervisorReview: t.reviews.at(-1),
        })),
      remaining: run.tasks
        .filter((t) => !["accepted", "superseded"].includes(t.state))
        .map((t) => ({ id: t.id, title: t.title, dependsOn: t.dependsOn, feedback: t.feedback })),
    });
  }

  async session(runId: string, action: "retain" | "close" | "resume" | "compact" | "new") {
    const run = this.get(runId),
      beforeCursor = this.cursor(runId);
    if ((run.status === "completed" || run.status === "cancelled") && action !== "close")
      fail("REOPEN_RUN_FIRST");
    if (
      action !== "close" &&
      [...this.runs.values()].some(
        (r) => r.id !== run.id && r.ownerPid === process.pid && r.status === "open"
      )
    )
      fail("OPEN_RUN_EXISTS");
    if (run.activeTaskId || this.reviewing.has(run.id) || run.sessionOperation)
      fail("SESSION_BUSY");
    if (action === "close") this.closeSession(run);
    else if (action === "new") {
      run.checkpoint = this.makeCheckpoint(run);
      this.closeSession(run);
      run.previousSessions ??= [];
      if (run.sessionId) run.previousSessions.push(run.sessionId);
      run.sessionId = undefined;
      run.lastContext = undefined;
    } else if (action === "retain")
      run.sessionState =
        run.sessionId && this.worker.model(run.sessionId) ? "retained" : "resume_pending";
    else if (action === "resume") {
      if (!run.sessionId) fail("NO_TRANSCRIPT_TO_RESUME");
      run.sessionState = this.worker.model(run.sessionId) ? "retained" : "resume_pending";
    } else {
      if (!run.sessionId) fail("NO_SESSION_TO_COMPACT");
      if (Date.now() >= run.deadline) fail("RUN_DEADLINE");
      const nativeLimit = availableGrant(run.turnBudget, run.maxTurns);
      if (nativeLimit < 1) fail("RUN_TURN_BUDGET_EXHAUSTED");
      this.acquire(run);
      reserveGrant(run.turnBudget, nativeLimit);
      this.save(run);
      run.sessionOperation = "compact";
      run.compactBoundarySeen = false;
      run.checkpoint = this.makeCheckpoint(run);
      const timeout = setTimeout(
        () => {
          this.closeSession(run);
          this.emit(run, "context_maintenance_failed", {
            reason: "Compaction timed out; transcript retained. Resume or start a new context.",
          });
        },
        Math.min(180000, Math.max(1, run.deadline - Date.now()))
      );
      timeout.unref();
      this.timers.set(run.id, timeout);
      const startup = { valid: true };
      this.startups.set(run.id, startup);
      try {
        const prompt =
          "/compact Preserve these supervisor-confirmed facts and user feedback; omit raw logs. " +
          run.checkpoint;
        if (this.worker.model(run.sessionId) && this.worker.isLive?.(run.sessionId) !== false)
          await this.worker.reply(run.sessionId, prompt, nativeLimit);
        else {
          this.seen.delete(run.sessionId);
          run.sessionId = await this.worker.start(
            run.cwd,
            prompt,
            nativeLimit,
            undefined,
            run.sessionId
          );
        }
        if (startup.valid) run.sessionState = "retained";
        else this.worker.stop(run.sessionId);
      } catch (error) {
        if (startup.valid) {
          settleReservation(run.turnBudget, run.turnBudget.reserved, undefined);
          run.sessionOperation = undefined;
          this.release(run);
        }
        throw error;
      } finally {
        if (this.startups.get(run.id) === startup) {
          this.startups.delete(run.id);
          if (!run.activeTaskId && !run.sessionOperation) this.release(run);
        }
      }
    }
    this.emit(
      run,
      "session_policy",
      { action, state: run.sessionState, sessionId: run.sessionId },
      undefined,
      false
    );
    return {
      runId,
      action,
      state: run.sessionState,
      sessionId: run.sessionId,
      nextCursor: beforeCursor,
    };
  }

  private acquire(run: Run) {
    // Stopped startup promises must drain before a shared worker can be reused.
    if (this.startups.size) fail("EXECUTOR_STARTUP_DRAINING");
    const lock = path.join(this.dataDir, "executor.lock");
    if (existsSync(lock)) {
      const owner = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; runId: string };
      if (alive(owner.pid)) fail("EXECUTOR_BUSY");
      unlinkSync(lock);
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid, runId: run.id }), {
      flag: "wx",
      mode: 0o600,
    });
  }
  private release(run: Run) {
    const timer = this.timers.get(run.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(run.id);
    if (this.startups.has(run.id)) return;
    const lock = path.join(this.dataDir, "executor.lock");
    if (existsSync(lock)) {
      const owner = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; runId: string };
      if (owner.pid === process.pid && owner.runId === run.id) unlinkSync(lock);
    }
  }

  async dispatch(
    runId: string,
    taskId: string,
    requestId: string,
    signal?: AbortSignal,
    options: { mode?: "start" | "continue"; maxTurns?: number; feedback?: string } = {}
  ) {
    const run = this.get(runId);
    if (["__proto__", "constructor", "prototype"].includes(requestId)) fail("INVALID_REQUEST_ID");
    const prior = Object.hasOwn(run.receipts, requestId) ? run.receipts[requestId] : undefined;
    if (prior) {
      if (prior.taskId !== taskId) fail("REQUEST_ID_CONFLICT");
      return prior;
    }
    this.open(run, true);
    if (this.reviewing.has(run.id)) fail("REVIEW_IN_PROGRESS");
    if (run.activeTaskId || run.sessionOperation) fail("EXECUTOR_BUSY");
    if (
      run.sessionId &&
      run.lastContext &&
      run.lastContext.inputTokens !== null &&
      run.lastContext.inputTokens >= run.lastContext.hardLimit
    )
      fail("CONTEXT_MAINTENANCE_REQUIRED: compact or new before dispatch");
    const task = this.task(run, taskId);
    if (
      ![
        "pending",
        "needs_revision",
        "blocked",
        "failed",
        "interrupted",
        "budget_exhausted",
      ].includes(task.state)
    )
      fail("TASK_NOT_DISPATCHABLE");
    if (
      options.mode === "continue" &&
      !["budget_exhausted", "blocked", "failed", "interrupted"].includes(task.state)
    )
      fail("TASK_NOT_CONTINUABLE");
    if (task.state === "budget_exhausted" && options.mode !== "continue")
      fail("EXPLICIT_CONTINUATION_REQUIRED");
    if (task.state === "needs_revision" && task.repairs >= run.maxRepairs) fail("REPAIR_LIMIT");
    if (!this.dependenciesAccepted(run, task)) fail("DEPENDENCY_NOT_ACCEPTED");
    const zeroProgress =
      task.attempts > 0 &&
      task.result?.isError &&
      task.result.numTurns === 0 &&
      task.checkpoint?.accountingKnown &&
      task.checkpoint.changedDeclaredArtifacts.length === 0;
    if (zeroProgress && (task.zeroProgressRetries ?? 0) >= 2) fail("ZERO_PROGRESS_RETRY_LIMIT");
    const requested = options.maxTurns ?? run.maxTurns;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > 1000)
      fail("INVALID_NATIVE_TURN_LIMIT");
    const nativeLimit = availableGrant(run.turnBudget, requested);
    if (nativeLimit < 1) fail("RUN_TURN_BUDGET_EXHAUSTED");
    const baseline = this.artifactSnapshot(run, task);
    this.acquire(run);
    reserveGrant(run.turnBudget, nativeLimit);
    if (task.state === "needs_revision") task.repairs++;
    else if (task.attempts > 0) task.continuations++;
    if (options.feedback) task.feedback = options.feedback;
    if (zeroProgress) task.zeroProgressRetries = (task.zeroProgressRetries ?? 0) + 1;
    else task.zeroProgressRetries = 0;
    task.baselineArtifacts = baseline;
    task.attempts++;
    task.startedAt = Date.now();
    task.state = "running";
    task.result = undefined;
    task.checkpoint = undefined;
    task.artifactHash = undefined;
    run.activeTaskId = task.id;
    const receipt: Run["receipts"][string] = {
      taskId,
      attempt: task.attempts,
      sessionId: run.sessionId,
      status: "starting",
      nextCursor: this.cursor(runId),
      nativeLimit,
      turnBudget: { ...run.turnBudget },
    };
    run.receipts[requestId] = receipt;
    this.emit(
      run,
      "dispatch_intent",
      { requestId, attempt: task.attempts, taskRevision: task.revision },
      taskId,
      false
    );
    const prompt = `Overall goal: ${run.goal}\nDesign: ${run.design}\nWorkspace: ${run.cwd}\nTask ${task.id} (contract revision ${task.revision}): ${task.title}\n${task.instructions}\nAcceptance: ${task.acceptance}\nExpected artifacts: ${task.artifacts.join(", ")}\nSupervisor feedback: ${task.feedback ?? "none"}\nExecute only this task. Do not run downstream tasks. If blocked return BLOCKED: and a concrete question. Report changed paths and checks; supervisor independently decides acceptance.`;
    const timer = setTimeout(
      () => {
        this.stopExecution(run, "Execution deadline exceeded", "time_budget");
      },
      Math.min(run.taskTimeoutMs, run.deadline - Date.now())
    );
    timer.unref();
    this.timers.set(run.id, timer);
    const startup = { valid: true };
    this.startups.set(run.id, startup);
    try {
      // A recovered transcript is never replayed automatically. Explicit dispatch starts a new session if runtime is gone.
      if (
        run.sessionId &&
        this.worker.model(run.sessionId) &&
        this.worker.isLive?.(run.sessionId) !== false
      )
        receipt.sessionId = await this.worker.reply(run.sessionId, prompt, nativeLimit, signal);
      else {
        if (run.sessionId) this.seen.delete(run.sessionId);
        receipt.sessionId = await this.worker.start(
          run.cwd,
          (!run.sessionId && run.checkpoint
            ? "Supervisor checkpoint: " + this.makeCheckpoint(run) + "\n"
            : "") + prompt,
          nativeLimit,
          signal,
          run.sessionId
        );
      }
      if (!startup.valid || this.closed || run.status !== "open") {
        receipt.status = "interrupted";
        this.worker.stop(receipt.sessionId);
        this.save(run);
        return receipt;
      }
      run.sessionId = receipt.sessionId;
      run.sessionState = "retained";
      receipt.startupMs = Date.now() - task.startedAt;
      receipt.status = "started";
      run.workerCapabilities =
        (await this.worker.refreshCapabilities?.(run.sessionId)) ??
        this.worker.capabilities?.(run.sessionId) ??
        run.workerCapabilities;
      receipt.workerCapabilities = compactCapabilities(run.workerCapabilities);
      if (!startup.valid || this.closed || run.status !== "open") {
        this.worker.stop(run.sessionId);
        return receipt;
      }
      this.emit(
        run,
        "worker_started",
        { requestId, sessionId: run.sessionId, model: this.worker.model(run.sessionId) },
        taskId,
        false
      );
      const events = await this.worker.replay(run.sessionId);
      if (startup.valid && !this.closed && run.status === "open")
        for (const event of events)
          this.consume({
            sessionId: run.sessionId,
            event,
            epoch: this.worker.eventEpoch?.(run.sessionId),
          });
      return receipt;
    } catch (error) {
      if (startup.valid && !this.closed && run.status === "open") {
        this.worker.stop(receipt.sessionId ?? run.sessionId);
        this.stoppedTask(run, task, String(error), "startup", "failed", "worker_failed");
        receipt.status = "failed";
      } else receipt.status = "interrupted";
      this.save(run);
      return receipt;
    } finally {
      if (this.startups.get(run.id) === startup) {
        this.startups.delete(run.id);
        if (!run.activeTaskId && !run.sessionOperation) this.release(run);
      }
    }
  }

  private hash(run: Run, task: Task) {
    const hash = createHash("sha256");
    for (const file of [...task.artifacts].sort()) {
      if (!inside(run.cwd, file)) fail("ARTIFACT_OUTSIDE_WORKSPACE");
      hash.update(file);
      hash.update("\0");
      hash.update(readFileSync(path.resolve(run.cwd, file)));
    }
    return hash.digest("hex");
  }

  private consume({ sessionId, event, epoch = 0 }: WorkerEvent) {
    if (this.closed || !event) return;
    const run = [...this.runs.values()].find(
      (r) =>
        r.sessionId === sessionId &&
        (r.activeTaskId || r.sessionOperation) &&
        (r.status === "open" || r.status === "awaiting_user_review")
    );
    const prior = this.seen.get(sessionId);
    if (!run || (prior?.epoch === epoch && event.id <= prior.id)) return;
    this.seen.set(sessionId, { epoch, id: event.id });
    if (run.sessionOperation === "compact") {
      if (
        event.type === "progress" &&
        (event.data as { type?: string }).type === "compact_boundary"
      ) {
        run.compactBoundarySeen = true;
        this.save(run);
        return;
      }
      if (event.type === "result" || event.type === "error") {
        const result = this.worker.result(sessionId);
        settleReservation(
          run.turnBudget,
          run.turnBudget.reserved,
          result && (!result.isError || result.errorSubtype) ? result.numTurns : undefined
        );
        run.sessionOperation = undefined;
        run.lastContext = this.worker.context?.(sessionId);
        this.release(run);
        this.emit(
          run,
          event.type === "error" ||
            this.worker.result(sessionId)?.isError ||
            !run.compactBoundarySeen
            ? "context_maintenance_failed"
            : "context_compacted",
          { context: run.lastContext, boundaryObserved: run.compactBoundarySeen }
        );
      }
      return;
    }
    const task = this.task(run, run.activeTaskId!);
    if (event.type === "permission_request") {
      this.emit(run, "permission_required", event.data, task.id);
      return;
    }
    if (event.type === "permission_result") {
      const data = event.data as { behavior?: string; source?: string };
      this.emit(run, "permission_resolved", event.data, task.id, data.behavior === "deny");
      if (data.behavior === "deny" && data.source === "timeout") {
        this.worker.stop(sessionId);
        this.stoppedTask(
          run,
          task,
          "Permission timed out; explicitly dispatch to retry",
          "permission",
          "blocked",
          "task_blocked"
        );
      }
      return;
    }
    if (event.type === "result" || event.type === "error") {
      task.result = this.worker.result(sessionId) ?? (event.data as AgentResult);
      const accountingKnown = !task.result.isError || !!task.result.errorSubtype;
      settleReservation(
        run.turnBudget,
        run.turnBudget.reserved,
        accountingKnown ? task.result.numTurns : undefined
      );
      const budgetStop = ["error_max_turns", "error_max_budget_usd"].includes(
        task.result.errorSubtype ?? ""
      );
      task.failure = budgetStop
        ? {
            kind:
              task.result.errorSubtype === "error_max_turns" ? "turn_budget" : "provider_budget",
            subtype: task.result.errorSubtype,
          }
        : task.result.isError
          ? { kind: "execution", subtype: task.result.errorSubtype }
          : undefined;
      if (budgetStop)
        run.turnBudget.stopReason =
          task.result.errorSubtype === "error_max_turns"
            ? "native_max_turns"
            : "provider_budget_cap";
      task.state = budgetStop
        ? "budget_exhausted"
        : task.result.isError
          ? "failed"
          : /^BLOCKED:/m.test(task.result.result)
            ? "blocked"
            : "awaiting_review";
      if (task.state === "awaiting_review") {
        try {
          task.artifactHash = this.hash(run, task);
        } catch (error) {
          task.state = "failed";
          task.feedback = `Artifact capture failed: ${String(error)}`;
        }
      }
      task.provenance = { producer: "worker", at: new Date().toISOString() };
      try {
        this.captureCheckpoint(run, task, task.failure?.kind ?? task.state, accountingKnown);
      } catch (error) {
        task.feedback = `Checkpoint capture failed: ${String(error)}`;
      }
      run.activeTaskId = undefined;
      run.lastContext = this.worker.context?.(sessionId);
      this.release(run);
      this.emit(
        run,
        "worker_finished",
        {
          state: task.state,
          artifactHash: task.artifactHash,
          result: task.result,
          feedback: task.feedback,
          elapsedMs: Date.now() - (task.startedAt ?? Date.now()),
          context: run.lastContext,
          artifacts: task.artifacts,
          failureClass: task.failure?.kind,
          checkpointAvailable: !!task.checkpoint,
          changedDeclaredArtifacts: task.checkpoint?.changedDeclaredArtifacts,
          nextActions:
            task.state === "awaiting_review"
              ? ["review"]
              : Date.now() < run.deadline && availableGrant(run.turnBudget, run.maxTurns) > 0
                ? ["continue", "reconcile", "cancel"]
                : ["reconcile", "cancel"],
          turnBudget: run.turnBudget,
        },
        task.id
      );
      if (
        run.lastContext &&
        run.lastContext.inputTokens !== null &&
        run.lastContext.inputTokens >= run.lastContext.softLimit
      )
        this.emit(run, "context_maintenance_recommended", run.lastContext, task.id);
      return;
    }
    // Audit metadata only; do not persist raw prompts, hidden reasoning, auth output or tool arguments.
    const data = event.data as {
      type?: string;
      tool_name?: string;
      message?: { content?: { type?: string; name?: string }[] };
    };
    const tools = data.message?.content?.filter((c) => c.type === "tool_use").map((c) => c.name);
    if (tools?.length || data.tool_name)
      this.emit(run, "tool_activity", { tools: tools ?? [data.tool_name] }, task.id, false);
  }

  async wait(runId: string, afterSeq: number, timeoutMs = 45000, signal?: AbortSignal) {
    const run = this.get(runId);
    this.metrics.waits++;
    const snapshot = () => ({
      runId,
      events: run.events
        .filter((e) => e.seq > afterSeq && e.actionable)
        .map((e) => this.brief(e, runId)),
      nextCursor: run.events.at(-1)?.seq ?? 0,
      status: run.status,
      timedOut: false,
    });
    if (afterSeq > (run.events.at(-1)?.seq ?? 0)) fail("CURSOR_AHEAD");
    if (signal?.aborted) {
      if (run.activeTaskId || run.sessionOperation)
        this.stopExecution(run, "Host cancelled wait", "interrupted");
      else {
        this.closeSession(run);
        this.emit(run, "host_wait_interrupted", { automaticReplay: false });
      }
      return snapshot();
    }
    if (snapshot().events.length || (run.status !== "open" && !run.sessionOperation))
      return snapshot();
    return await new Promise<ReturnType<typeof snapshot> & { timedOut?: boolean }>((resolve) => {
      let settled = false;
      const finish = (timedOut = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(listener);
        signal?.removeEventListener("abort", abort);
        if (timedOut) this.metrics.waitTimeouts++;
        else this.metrics.wakeups++;
        resolve({ ...snapshot(), timedOut });
      };
      const listener = (id: string) => {
        if (id === runId) finish();
      };
      const abort = () => {
        if (run.activeTaskId || run.sessionOperation)
          this.stopExecution(run, "Host cancelled wait", "interrupted");
        else {
          this.closeSession(run);
          this.emit(run, "host_wait_interrupted", { automaticReplay: false });
        }
        finish();
      };
      const timer = setTimeout(() => finish(true), Math.min(45000, Math.max(1, timeoutMs)));
      this.listeners.add(listener);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  interrupt(runId: string, reason: string) {
    const run = this.get(runId);
    this.open(run);
    if (!reason.trim()) fail("INTERRUPTION_REASON_REQUIRED");
    if (this.reviewing.has(run.id)) fail("REVIEW_IN_PROGRESS");
    if (!run.activeTaskId && !run.sessionOperation) fail("NO_ACTIVE_EXECUTION");
    this.stopExecution(run, reason, "interrupted");
    return {
      runId,
      status: run.status,
      sessionId: run.sessionId,
      turnBudget: run.turnBudget,
      nextCursor: this.cursor(runId),
    };
  }

  reconcile(input: {
    runId: string;
    taskId: string;
    taskRevision: number;
    evidence: string;
  }): Task {
    const run = this.get(input.runId);
    this.open(run);
    if (run.activeTaskId || run.sessionOperation || this.reviewing.has(run.id))
      fail("EXECUTOR_BUSY");
    const task = this.task(run, input.taskId);
    if (input.taskRevision !== task.revision) fail("STALE_CONTRACT");
    if (!input.evidence.trim()) fail("INDEPENDENT_REVIEW_REQUIRED");
    if (
      ![
        "blocked",
        "failed",
        "interrupted",
        "budget_exhausted",
        "needs_revision",
        "awaiting_review",
      ].includes(task.state)
    )
      fail("TASK_NOT_RECONCILABLE");
    if (!this.dependenciesAccepted(run, task)) fail("DEPENDENCY_NOT_ACCEPTED");
    this.acquire(run);
    try {
      if (run.sessionId && this.worker.model(run.sessionId)) this.worker.stop(run.sessionId);
      run.sessionState = "closed";
      const hash = this.hash(run, task);
      task.artifactHash = hash;
      task.state = "awaiting_review";
      task.provenance = {
        producer: "supervisor_reconcile",
        at: new Date().toISOString(),
        note: input.evidence,
      };
      task.failure = undefined;
      this.captureCheckpoint(run, task, "supervisor_reconcile", true);
      this.emit(
        run,
        "candidate_reconciled",
        { artifactHash: hash, provenance: task.provenance, nextActions: ["review"] },
        task.id,
        false
      );
      return task;
    } finally {
      this.release(run);
    }
  }

  async review(
    input: {
      runId: string;
      taskId: string;
      decision: "accept" | "reject";
      taskRevision: number;
      artifactHash: string;
      evidence: string;
    },
    signal?: AbortSignal
  ) {
    const run = this.get(input.runId);
    this.open(run);
    const task = this.task(run, input.taskId);
    if (!this.dependenciesAccepted(run, task)) fail("DEPENDENCY_NOT_ACCEPTED");
    if (task.state !== "awaiting_review") fail("TASK_NOT_AWAITING_REVIEW");
    if (
      input.taskRevision !== task.revision ||
      input.artifactHash !== task.artifactHash ||
      this.hash(run, task) !== input.artifactHash
    )
      fail("STALE_ARTIFACT_OR_CONTRACT");
    if (!input.evidence.trim()) fail("INDEPENDENT_REVIEW_REQUIRED");
    if (this.reviewing.has(run.id) || run.activeTaskId) fail("EXECUTOR_BUSY");
    this.acquire(run);
    this.reviewing.add(run.id);
    const abort = new AbortController();
    const hostCancel = () => {
      abort.abort();
      this.closeSession(run);
    };
    signal?.addEventListener("abort", hostCancel, { once: true });
    const deadline = setTimeout(() => abort.abort(), 40000);
    const checks: Array<
      Check & { exitCode: number | null; stdout: string; stderr: string; error?: string }
    > = [];
    try {
      if (signal?.aborted) hostCancel();
      for (const check of task.checks) {
        if (abort.signal.aborted) {
          checks.push({
            ...check,
            exitCode: null,
            stdout: "",
            stderr: "",
            error: "Acceptance cancelled or deadline exceeded",
          });
          break;
        }
        checks.push({
          ...check,
          ...(await executeCheck(check.command, check.args, run.cwd, abort.signal)),
        });
      }
      if (abort.signal.aborted) {
        task.reviews.push({
          at: new Date().toISOString(),
          decision: "interrupted",
          artifactHash: input.artifactHash,
          taskRevision: input.taskRevision,
          evidence: input.evidence,
          checks,
        });
        this.emit(
          run,
          "review_interrupted",
          {
            reason: signal?.aborted ? "Host cancelled acceptance" : "Acceptance deadline exceeded",
            artifactHash: input.artifactHash,
          },
          task.id
        );
        fail("REVIEW_INTERRUPTED");
      }
      this.open(run);
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", hostCancel);
      this.reviewing.delete(run.id);
      this.release(run);
    }
    // Checks must not alter reviewed outputs while generating evidence.
    if (this.hash(run, task) !== input.artifactHash) fail("CHECK_CHANGED_ARTIFACT");
    const accepted =
      input.decision === "accept" && checks.every((c) => c.exitCode === 0 && !c.error);
    task.reviews.push({
      at: new Date().toISOString(),
      decision: accepted ? "accepted" : "rejected",
      artifactHash: input.artifactHash,
      taskRevision: task.revision,
      evidence: input.evidence,
      checks,
    });
    task.state = accepted ? "accepted" : "needs_revision";
    task.feedback = accepted
      ? undefined
      : `${input.evidence}\nChecks: ${JSON.stringify(checks.map((c) => ({ exitCode: c.exitCode, stderr: c.stderr?.slice(0, 800) })))}`;
    this.emit(
      run,
      accepted ? "task_accepted" : "task_rejected",
      { checks, evidence: input.evidence, artifactHash: input.artifactHash },
      task.id
    );
    return {
      taskId: task.id,
      state: task.state,
      checks,
      remainingRepairs: Math.max(0, run.maxRepairs - task.repairs),
    };
  }

  respond(runId: string, requestId: string, decision: "allow" | "deny") {
    const run = this.get(runId);
    this.open(run);
    if (!run.sessionId || !run.activeTaskId) fail("NO_ACTIVE_EXECUTION");
    const request =
      this.worker.permissions(run.sessionId).find((p) => p.requestId === requestId) ??
      fail("PERMISSION_EXPIRED_OR_UNKNOWN");
    if (decision === "allow") {
      if (!request.toolName.trim()) fail("INVALID_PENDING_TOOL");
      for (const key of ["file_path", "path", "notebook_path"]) {
        const value = request.input[key];
        if (typeof value === "string" && !inside(run.cwd, value))
          fail("PERMISSION_OUTSIDE_WORKSPACE");
      }
      if (request.blockedPath && !inside(run.cwd, request.blockedPath))
        fail("PERMISSION_OUTSIDE_WORKSPACE");
    }
    if (!this.worker.respond(run.sessionId, requestId, decision === "allow"))
      fail("PERMISSION_EXPIRED_OR_UNKNOWN");
    return { requestId, decision };
  }

  status(runId?: string) {
    this.metrics.statusReads++;
    return runId ? this.get(runId, false) : [...this.runs.values()];
  }

  cancel(runId: string, reason = "Supervisor cancelled") {
    const run = this.get(runId);
    if (run.status !== "open" && run.status !== "awaiting_user_review")
      return { runId, status: run.status };
    settleReservation(run.turnBudget, run.turnBudget.reserved, undefined);
    if (run.activeTaskId) this.task(run, run.activeTaskId).state = "interrupted";
    const startup = this.startups.get(run.id);
    if (startup) startup.valid = false;
    run.status = "cancelled";
    run.activeTaskId = undefined;
    this.worker.stop(run.sessionId);
    const idle = this.idleTimers.get(run.id);
    if (idle) clearTimeout(idle);
    this.idleTimers.delete(run.id);
    this.release(run);
    this.emit(run, "run_cancelled", { reason });
    return { runId, status: run.status };
  }

  close() {
    if (this.closed) return;
    for (const run of this.runs.values()) {
      if (
        run.ownerPid === process.pid &&
        (run.status === "open" || run.status === "awaiting_user_review")
      ) {
        if (run.activeTaskId || run.sessionOperation)
          this.stopExecution(run, "MCP connection closed", "interrupted");
        else {
          this.closeSession(run);
          this.emit(run, "connection_closed", { automaticReplay: false }, undefined, false);
        }
      }
    }
    this.closed = true;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.unsubscribe();
    this.unsubscribeMessages?.();
    this.pendingMessages.clear();
    this.worker.destroy();
    this.listeners.clear();
    this.eventSubscribers.clear();
  }
}
