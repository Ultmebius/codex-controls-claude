import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { defaultWaitMs, inside } from "./runtime.js";
import { budgetSummary } from "./execution.js";
import { claimFile, processAlive as alive } from "./ownership.js";
import { MAX_WAIT_MS } from "./worker-slots.js";
import type { Orchestrator, Run, TaskSpec } from "./controller.js";
import {
  DEFAULT_SEGMENT_TURNS,
  DEFAULT_RUN_TURN_LIMIT,
  availableGrant,
  normalizedBudget,
  reserveGrant,
  settleReservation,
  type TurnBudget,
} from "./budget.js";

export interface TeamTaskSpec extends TaskSpec {
  /** Human label for that worker's terminal tab; defaults to the task title. */
  workerName?: string;
  cwd?: string;
  /** Literal files/directories relative to cwd. Omission or [] reserves the whole workspace. */
  writeScope?: string[];
}
export interface TeamInput {
  cwd: string;
  goal: string;
  design: string;
  tasks: TeamTaskSpec[];
  maxWorkers?: number;
  maxTurns?: number;
  maxTotalTurns?: number;
  runTimeoutMs?: number;
  taskTimeoutMs?: number;
}
export interface TeamEvent {
  seq: number;
  at: string;
  type: string;
  actionable: boolean;
  taskId?: string;
  childRunId?: string;
  data: unknown;
}
interface TeamTask {
  contract: TaskSpec;
  workerName?: string;
  cwd: string;
  writeScope?: string[];
  childRunId: string;
  directory: string;
  state: string;
  starting?: boolean;
  reservation?: { held: number; usedBefore: number; attemptsBefore: number };
}
interface TeamReceipt {
  taskId: string;
  childRunId: string;
  status: "starting" | "started" | "interrupted" | "failed";
  receipt?: Run["receipts"][string];
}
interface Team {
  id: string;
  ownerPid: number;
  ownerId?: string;
  generation?: number;
  ownerReleased?: boolean;
  budgetWarningAt?: number;
  cwd: string;
  goal: string;
  design: string;
  status: "open" | "awaiting_user_review" | "completed" | "cancelled";
  deadline: number;
  taskTimeoutMs: number;
  maxWorkers: number;
  maxTurns: number;
  budget: TurnBudget;
  tasks: TeamTask[];
  receipts: Record<string, TeamReceipt>;
  events: TeamEvent[];
}
type DispatchOptions = NonNullable<Parameters<Orchestrator["dispatch"]>[4]>;

function fail(message: string): never {
  throw new Error(message);
}
/** Canonicalize even not-yet-created files through their nearest existing ancestor. */
function canonical(file: string): string {
  let existing = path.resolve(file);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) fail("WORKSPACE_PATH_UNRESOLVED");
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const result = path
    .join(realpathSync.native(existing), ...suffix)
    .replaceAll("\\", "/")
    .replace(/\/$/, "");
  return process.platform === "win32" ? result.toLowerCase() : result;
}
function overlaps(a: string, b: string) {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
function scopes(task: TeamTask): string[] {
  const root = canonical(task.cwd);
  if (!task.writeScope?.length) return [root];
  return task.writeScope.map((file) => {
    if (!file.trim() || /[*?]/.test(file)) fail("WRITE_SCOPE_REQUIRES_LITERAL_PATH");
    const resolved = canonical(path.resolve(task.cwd, file));
    if (resolved !== root && !resolved.startsWith(root + "/"))
      fail("WRITE_SCOPE_OUTSIDE_WORKSPACE");
    return resolved;
  });
}

/** Explicit scheduling only: child controllers own contracts, execution and acceptance. */
export class TeamCoordinator {
  private teams = new Map<string, Team>();
  private controllers = new Map<string, Orchestrator>();
  private subscriptions: (() => void)[] = [];
  private listeners = new Set<(teamId: string) => void>();
  private pending = new Map<string, Promise<TeamReceipt>>();
  private starts = new Map<string, { valid: boolean }>();
  private closed = false;
  private ownerId = randomUUID();
  private activityListeners = new Set<() => void>();
  subscribeActivity(listener: () => void) {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }
  hasActiveExecutions() {
    return this.ownedTasks().some(
      (task) => task.starting || this.controllers.get(task.childRunId)?.hasActiveExecutions()
    );
  }
  reviewActive() {
    return this.ownedTasks().some((task) => this.controllers.get(task.childRunId)?.reviewActive());
  }

  constructor(
    readonly dataDir: string,
    private factory: (dataDir: string) => Orchestrator
  ) {
    mkdirSync(dataDir, { recursive: true });
    for (const file of readdirSync(dataDir).filter((file) => /^team-[\w-]+\.json$/.test(file))) {
      const team = JSON.parse(readFileSync(path.join(dataDir, file), "utf8")) as Team;
      this.teams.set(team.id, team);
    }
  }

  private save(team: Team) {
    const dest = path.join(this.dataDir, `team-${team.id}.json`);
    if (existsSync(dest)) {
      const disk = JSON.parse(readFileSync(dest, "utf8")) as Team;
      if (
        (disk.generation ?? 0) > (team.generation ?? 0) ||
        (disk.ownerId &&
          disk.ownerId !== team.ownerId &&
          !disk.ownerReleased &&
          alive(disk.ownerPid))
      )
        fail("STALE_TEAM_OWNER");
    }
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(team, null, 2), { mode: 0o600 });
    renameSync(tmp, dest);
  }
  private emit(team: Team, type: string, data: unknown, actionable = true, task?: TeamTask) {
    team.events.push({
      seq: (team.events.at(-1)?.seq ?? 0) + 1,
      at: new Date().toISOString(),
      type,
      data: {
        ...(data && typeof data === "object" && !Array.isArray(data) ? data : { detail: data }),
        teamBudget: { ...team.budget },
      },
      actionable,
      taskId: task?.contract.id,
      childRunId: task?.childRunId,
    });
    this.save(team);
    if (actionable) for (const listener of [...this.listeners]) listener(team.id);
    for (const listener of this.activityListeners) listener();
  }
  private get(teamId: string, writable = true) {
    const team = this.teams.get(teamId) ?? fail("TEAM_NOT_FOUND");
    if (
      writable &&
      (this.closed ||
        team.ownerPid !== process.pid ||
        team.ownerReleased ||
        (team.ownerId && team.ownerId !== this.ownerId) ||
        team.tasks.some((task) => !this.controllers.has(task.childRunId)))
    )
      fail("TEAM_NOT_OWNED");
    return team;
  }
  private syncBudget(team: Team) {
    if (team.tasks.every((t) => this.controllers.has(t.childRunId))) {
      team.budget.used = team.tasks.reduce((n, t) => n + this.run(t).turnBudget.used, 0);
      team.budget.estimated = team.tasks.reduce(
        (n, t) => n + (this.run(t).turnBudget.estimated ?? 0),
        0
      );
      team.budget.overrun = Math.max(0, team.budget.used - team.budget.limit) || undefined;
    }
  }
  private warnBudget(team: Team, current?: TeamTask) {
    const committed = team.budget.used + team.budget.reserved;
    const pendingTasks = team.tasks
      .filter((t) => t !== current && t.state === "pending" && !t.starting)
      .map((t) => t.contract.id);
    if (team.budgetWarningAt || committed < team.budget.limit * 0.7 || !pendingTasks.length) return;
    team.budgetWarningAt = committed;
    this.emit(
      team,
      "budget_risk",
      {
        budget: budgetSummary(team.budget),
        pendingTasks,
        nextActions: ["review_checkpoint", "plan_remaining_stages"],
        warning: "Charged or reserved allowance leaves limited room for pending stages",
      },
      true,
      current
    );
  }
  private syncPeerArtifacts(team: Team) {
    for (const task of team.tasks) {
      const files = team.tasks
        .filter((peer) => peer !== task)
        .flatMap((peer) => {
          const contract = this.run(peer).tasks[0];
          return [...contract.artifacts, ...(contract.additionalArtifacts ?? [])]
            .map((file) => path.resolve(peer.cwd, file))
            .filter((file) => inside(task.cwd, file))
            .map((file) => path.relative(realpathSync.native(task.cwd), canonical(file)));
        });
      this.controllers.get(task.childRunId)!.setPeerArtifacts(task.childRunId, files);
    }
  }
  recover(teamId: string) {
    if (this.closed) fail("TEAM_COORDINATOR_CLOSED");
    const file = path.join(this.dataDir, `team-${teamId}.json`);
    if (!existsSync(file)) fail("TEAM_NOT_FOUND");
    const releaseClaim = claimFile(`${file}.claim`);
    try {
      const team = JSON.parse(readFileSync(file, "utf8")) as Team;
      if (team.ownerId === this.ownerId && !team.ownerReleased)
        return this.summary(this.get(teamId));
      if (!team.ownerReleased && alive(team.ownerPid)) fail("OWNER_STILL_ACTIVE");
      if (this.hasActiveExecutions()) fail("EXECUTOR_BUSY");
      {
        const orphaned = team.budget.reserved;
        team.ownerPid = process.pid;
        team.ownerId = this.ownerId;
        team.ownerReleased = false;
        team.generation = (team.generation ?? 0) + 1;
        this.teams.set(teamId, team);
        for (const task of team.tasks) {
          this.controllers.get(task.childRunId)?.close();
          this.controllers.delete(task.childRunId);
          const controller = this.factory(task.directory);
          controller.attach(task.childRunId);
          task.starting = false;
          task.reservation = undefined;
          this.attach(team, task, controller);
          task.state = this.run(task).tasks[0].state;
        }
        team.budget.reserved = 0;
        this.syncBudget(team);
        this.syncPeerArtifacts(team);
        if (orphaned) team.budget.recovered = (team.budget.recovered ?? 0) + orphaned;
        for (const receipt of Object.values(team.receipts))
          if (receipt.status === "starting") receipt.status = "interrupted";
        this.emit(
          team,
          "team_attached",
          { automaticReplay: false, generation: team.generation },
          false
        );
        return this.summary(team);
      }
    } finally {
      releaseClaim();
    }
  }
  private task(team: Team, taskId: string) {
    return team.tasks.find((task) => task.contract.id === taskId) ?? fail("TASK_NOT_FOUND");
  }
  private run(task: TeamTask): Run {
    return this.controllers.get(task.childRunId)!.status(task.childRunId) as Run;
  }
  private attach(team: Team, task: TeamTask, controller = this.factory(task.directory)) {
    controller.worker.setWriteScope?.(task.cwd, task.writeScope);
    this.controllers.set(task.childRunId, controller);
    this.subscriptions.push(
      controller.subscribeEvents((run, event) => {
        if (
          run.id !== task.childRunId ||
          this.closed ||
          !this.teams.has(team.id) ||
          team.ownerId !== this.ownerId ||
          team.ownerReleased
        )
          return;
        task.state = run.tasks[0].state;
        if (
          task.reservation &&
          run.tasks[0].attempts > task.reservation.attemptsBefore &&
          !run.activeTaskId &&
          !run.sessionOperation
        ) {
          settleReservation(
            team.budget,
            task.reservation.held,
            Math.max(0, run.turnBudget.used - task.reservation.usedBefore)
          );
          task.reservation = undefined;
          this.syncBudget(team);
        }
        if (event.type === "accounting_corrected") this.syncBudget(team);
        this.emit(
          team,
          event.type,
          controller.eventSummary(run.id, event).data,
          event.actionable,
          task
        );
        this.warnBudget(team, task);
      })
    );
  }
  controllerFor(childRunId: string) {
    return this.controllers.get(childRunId);
  }

  create(input: TeamInput) {
    if (this.closed) fail("TEAM_COORDINATOR_CLOSED");
    const maxWorkers = input.maxWorkers ?? 3,
      maxTurns = input.maxTurns ?? DEFAULT_SEGMENT_TURNS;
    const runTimeoutMs = input.runTimeoutMs ?? 7200000;
    const taskTimeoutMs = input.taskTimeoutMs ?? 7200000;
    if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 3)
      fail("INVALID_MAX_WORKERS");
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000)
      fail("INVALID_NATIVE_TURN_LIMIT");
    for (const ms of [runTimeoutMs, taskTimeoutMs])
      if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 7200000)
        fail("INVALID_EXECUTION_DEADLINE");
    if (!input.tasks.length || input.tasks.length > 100) fail("Provide 1 to 100 tasks");
    const ids = new Set(input.tasks.map((task) => task.id));
    if (ids.size !== input.tasks.length) fail("DUPLICATE_TASK_ID");
    const visiting = new Set<string>(),
      done = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) fail("DEPENDENCY_CYCLE");
      if (done.has(id)) return;
      const task = input.tasks.find((task) => task.id === id) ?? fail("UNKNOWN_DEPENDENCY");
      visiting.add(id);
      task.dependsOn.forEach(visit);
      visiting.delete(id);
      done.add(id);
    };
    ids.forEach(visit);
    const team: Team = {
      id: randomUUID(),
      ownerPid: process.pid,
      ownerId: this.ownerId,
      generation: 1,
      cwd: realpathSync(input.cwd),
      goal: input.goal,
      design: input.design,
      status: "open",
      deadline: Date.now() + runTimeoutMs,
      taskTimeoutMs,
      maxWorkers,
      maxTurns,
      budget: normalizedBudget(undefined, input.maxTotalTurns ?? DEFAULT_RUN_TURN_LIMIT),
      tasks: [],
      receipts: {},
      events: [],
    };
    const prepared = input.tasks.map(({ cwd, writeScope, workerName, ...contract }) => {
      const task: TeamTask = {
        contract: structuredClone(contract),
        workerName,
        cwd: realpathSync(cwd ?? team.cwd),
        writeScope: writeScope ? [...writeScope] : undefined,
        state: "pending",
        childRunId: "",
        directory: path.join(this.dataDir, team.id, contract.id),
      };
      scopes(task);
      return task;
    });
    // Validate all contracts before creating the canonical team or opening any worker.
    for (const task of prepared) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(task.contract.id)) fail("INVALID_TASK_ID");
      if (!task.contract.artifacts.length || !task.contract.checks.length)
        fail("TASK_REQUIRES_ARTIFACTS_AND_CHECKS");
    }
    const subscriptionStart = this.subscriptions.length;
    try {
      for (const task of prepared) {
        const controller = this.factory(task.directory);
        try {
          const run = controller.plan({
            action: "create",
            cwd: task.cwd,
            goal: team.goal,
            design: team.design,
            workerName: task.workerName ?? task.contract.title,
            tasks: [
              {
                ...task.contract,
                dependsOn: [],
                instructions:
                  task.contract.instructions +
                  `\nDeclared write scope: ${(task.writeScope?.length ? task.writeScope : ["."]).join(", ")}. Keep all writes within this scope.`,
              },
            ],
            maxTurns,
            maxTotalTurns: 1,
            runTimeoutMs,
            taskTimeoutMs,
          });
          run.deadline = team.deadline;
          task.childRunId = run.id;
          team.tasks.push(task);
          this.attach(team, task, controller);
        } catch (error) {
          controller.close();
          throw error;
        }
      }
    } catch (error) {
      for (const unsubscribe of this.subscriptions.splice(subscriptionStart)) unsubscribe();
      for (const task of team.tasks) {
        this.controllers.get(task.childRunId)?.close();
        this.controllers.delete(task.childRunId);
      }
      throw error;
    }
    this.teams.set(team.id, team);
    this.syncPeerArtifacts(team);
    this.emit(team, "team_created", { maxWorkers, turnBudget: team.budget }, false);
    return this.summary(team);
  }

  private active(task: TeamTask) {
    const run = this.run(task);
    return !!(
      task.starting ||
      task.reservation ||
      run.activeTaskId ||
      run.sessionOperation ||
      this.controllers.get(task.childRunId)?.hasActiveExecutions()
    );
  }
  private occupied(task: TeamTask) {
    return this.active(task) || this.run(task).sessionState === "retained";
  }
  private ownedTasks() {
    return [...this.teams.values()]
      .filter(
        (team) =>
          team.ownerPid === process.pid &&
          !team.ownerReleased &&
          (!team.ownerId || team.ownerId === this.ownerId)
      )
      .flatMap((team) => team.tasks)
      .filter((task) => this.controllers.has(task.childRunId));
  }
  hasOccupied() {
    return this.ownedTasks().some((task) => this.occupied(task));
  }
  canReview(childRunId: string): void {
    const own = this.ownedTasks().find((task) => task.childRunId === childRunId);
    if (!own) fail("CHILD_RUN_NOT_FOUND");
    const team = [...this.teams.values()].find((team) => team.tasks.includes(own))!;
    this.syncPeerArtifacts(team);
    if (
      own.contract.dependsOn.some(
        (id) => this.run(this.task(team, id)).tasks[0].state !== "accepted"
      )
    )
      fail("DEPENDENCY_NOT_ACCEPTED");
    this.canReviewWorkspace(own.cwd);
  }
  canReviewWorkspace(cwd: string): void {
    if (
      this.ownedTasks().some(
        (task) => this.active(task) && overlaps(canonical(cwd), canonical(task.cwd))
      )
    )
      fail("TEAM_CHECKS_REQUIRE_QUIESCENT_WORKSPACE");
  }

  async dispatch(
    teamId: string,
    taskId: string,
    requestId: string,
    options: DispatchOptions = {},
    signal?: AbortSignal
  ): Promise<TeamReceipt> {
    const team = this.get(teamId),
      task = this.task(team, taskId);
    if (!requestId || ["__proto__", "constructor", "prototype"].includes(requestId))
      fail("INVALID_REQUEST_ID");
    const key = `${teamId}:${requestId}`;
    const prior = Object.hasOwn(team.receipts, requestId) ? team.receipts[requestId] : undefined;
    if (prior) {
      if (prior.taskId !== taskId) fail("REQUEST_ID_CONFLICT");
      return this.pending.get(key) ?? prior;
    }
    if (team.status !== "open") fail("TEAM_CLOSED");
    if (Date.now() >= team.deadline) fail("RUN_DEADLINE");
    if (this.active(task)) fail("EXECUTOR_BUSY");
    if (
      task.contract.dependsOn.some(
        (id) => this.run(this.task(team, id)).tasks[0].state !== "accepted"
      )
    )
      fail("DEPENDENCY_NOT_ACCEPTED");
    const all = this.ownedTasks();
    if (
      all.some(
        (other) =>
          other !== task &&
          this.active(other) &&
          scopes(task).some((a) => scopes(other).some((b) => overlaps(a, b)))
      )
    )
      fail("WRITE_SCOPE_CONFLICT");
    if (team.tasks.filter((candidate) => this.active(candidate)).length >= team.maxWorkers)
      fail("TEAM_WORKER_LIMIT");
    const requested = options.maxTurns ?? team.maxTurns;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > 1000)
      fail("INVALID_NATIVE_TURN_LIMIT");
    const grant = availableGrant(team.budget, requested);
    if (!grant) fail("RUN_TURN_BUDGET_EXHAUSTED");
    const run = this.run(task),
      controller = this.controllers.get(task.childRunId)!;
    const attemptsBefore = run.tasks[0].attempts;
    // Hold budget before the first await; the shared slot is acquired by the child dispatch.
    task.starting = true;
    task.reservation = {
      held: reserveGrant(team.budget, grant),
      usedBefore: run.turnBudget.used,
      attemptsBefore,
    };
    const startup = { valid: true };
    this.starts.set(task.childRunId, startup);
    run.turnBudget.limit = run.turnBudget.used + grant + 1;
    run.deadline = Math.min(run.deadline, team.deadline);
    const receipt: TeamReceipt = { taskId, childRunId: task.childRunId, status: "starting" };
    team.receipts[requestId] = receipt;
    this.save(team);
    this.warnBudget(team, task);
    const execution = (async () => {
      try {
        // Retained transcripts are not capacity; only this team's own maxWorkers is enforced here.
        while (
          team.tasks.filter((candidate) => this.occupied(candidate)).length > team.maxWorkers
        ) {
          const idle = team.tasks.find(
            (candidate) => candidate !== task && !this.active(candidate) && this.occupied(candidate)
          );
          if (!idle) fail("TEAM_WORKER_LIMIT");
          await this.controllers.get(idle.childRunId)!.session(idle.childRunId, "close");
        }
        if (!startup.valid || this.closed) fail("TEAM_DISPATCH_INTERRUPTED");
        receipt.receipt = await controller.dispatch(task.childRunId, taskId, requestId, signal, {
          ...options,
          maxTurns: grant,
        });
        receipt.status =
          receipt.receipt.status === "failed"
            ? "failed"
            : receipt.receipt.status === "interrupted"
              ? "interrupted"
              : "started";
        return receipt;
      } catch (error) {
        receipt.status = startup.valid ? "failed" : "interrupted";
        throw error;
      } finally {
        task.starting = false;
        this.starts.delete(task.childRunId);
        if (task.reservation && !run.activeTaskId && !run.sessionOperation) {
          const delta = run.turnBudget.used - task.reservation.usedBefore;
          settleReservation(
            team.budget,
            task.reservation.held,
            delta > 0 || run.tasks[0].attempts === attemptsBefore ? delta : undefined
          );
          task.reservation = undefined;
          this.syncBudget(team);
        }
        this.pending.delete(key);
        this.save(team);
      }
    })();
    this.pending.set(key, execution);
    return execution;
  }

  private summary(team: Team) {
    return {
      teamId: team.id,
      status: team.status,
      deadline: team.deadline,
      maxWorkers: team.maxWorkers,
      turnBudget: { ...team.budget },
      accounting: budgetSummary(team.budget),
      nextCursor: team.events.at(-1)?.seq ?? 0,
      tasks: team.tasks.map((task) => ({
        id: task.contract.id,
        workerName: task.workerName ?? task.contract.title,
        childRunId: task.childRunId,
        dependsOn: task.contract.dependsOn,
        cwd: task.cwd,
        writeScope: task.writeScope,
        state: task.state,
      })),
    };
  }
  status(teamId?: string) {
    return teamId
      ? this.summary(this.get(teamId, false))
      : [...this.teams.values()].map((team) => this.summary(team));
  }
  async wait(teamId: string, afterSeq: number, timeoutMs = defaultWaitMs(), signal?: AbortSignal) {
    const team = this.get(teamId);
    const snapshot = (timedOut = false) => ({
      teamId,
      status: team.status,
      timedOut,
      events: team.events
        .filter((event) => event.seq > afterSeq && event.actionable)
        .sort(
          (a, b) =>
            Number(["permission_required", "worker_question"].includes(b.type)) -
            Number(["permission_required", "worker_question"].includes(a.type))
        ),
      nextCursor: team.events.at(-1)?.seq ?? 0,
    });
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      afterSeq > (team.events.at(-1)?.seq ?? 0)
    )
      fail("INVALID_CURSOR");
    if (signal?.aborted) {
      this.interrupt(teamId, "Host cancelled team wait");
      return snapshot();
    }
    if (snapshot().events.length || team.status !== "open") return snapshot();
    return await new Promise<ReturnType<typeof snapshot>>((resolve) => {
      let settled = false;
      const finish = (timedOut = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(listener);
        signal?.removeEventListener("abort", abort);
        resolve(snapshot(timedOut));
      };
      const listener = (id: string) => {
        if (id === teamId) finish();
      };
      const abort = () => {
        this.interrupt(teamId, "Host cancelled team wait");
        finish();
      };
      const timer = setTimeout(() => finish(true), Math.min(MAX_WAIT_MS, Math.max(1, timeoutMs)));
      this.listeners.add(listener);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  finish(teamId: string) {
    const team = this.get(teamId);
    if (team.status !== "open") fail("TEAM_CLOSED");
    if (
      team.tasks.some((task) => this.active(task) || this.run(task).tasks[0].state !== "accepted")
    )
      fail("UNACCEPTED_TASKS");
    for (const task of team.tasks) this.canReview(task.childRunId);
    for (const task of team.tasks) {
      const child = this.run(task);
      if (child.status === "awaiting_user_review")
        this.controllers.get(task.childRunId)!.plan({ action: "reopen", runId: task.childRunId });
      const run = this.controllers
        .get(task.childRunId)!
        .plan({ action: "finish", runId: task.childRunId });
      if (run.status !== "awaiting_user_review") fail("ACCEPTANCE_INVALIDATED");
    }
    team.status = "awaiting_user_review";
    this.emit(team, "team_candidate_delivered", { humanApprovalRequired: true });
    return this.summary(team);
  }
  approve(teamId: string, evidence: string) {
    const team = this.get(teamId);
    if (team.status !== "awaiting_user_review") fail("USER_REVIEW_NOT_PENDING");
    if (!evidence.trim()) fail("HUMAN_APPROVAL_EVIDENCE_REQUIRED");
    if (
      team.tasks.some((task) => this.active(task) || this.run(task).tasks[0].state !== "accepted")
    )
      fail("UNACCEPTED_TASKS");
    for (const task of team.tasks) this.canReview(task.childRunId);
    // Reuse the original artifact invalidation gate before recording human approval.
    for (const task of team.tasks) {
      const controller = this.controllers.get(task.childRunId)!;
      controller.plan({ action: "reopen", runId: task.childRunId });
      const run = controller.plan({ action: "finish", runId: task.childRunId });
      if (run.status !== "awaiting_user_review") {
        team.status = "open";
        this.emit(
          team,
          "team_acceptance_invalidated",
          { humanApprovalRecorded: false },
          true,
          task
        );
        fail("ACCEPTANCE_INVALIDATED");
      }
    }
    for (const task of team.tasks)
      this.controllers.get(task.childRunId)!.plan({ action: "approve", runId: task.childRunId });
    team.status = "completed";
    this.emit(team, "team_user_approved", { evidence, transcriptRetained: true }, false);
    return this.summary(team);
  }
  async closeSessions(teamId: string) {
    const team = this.get(teamId);
    if (team.tasks.some((task) => this.active(task))) fail("EXECUTOR_BUSY");
    for (const task of team.tasks)
      await this.controllers.get(task.childRunId)!.session(task.childRunId, "close");
    this.emit(team, "team_sessions_closed", { transcriptRetained: true }, false);
    return this.summary(team);
  }
  interrupt(teamId: string, reason = "Supervisor interrupted team", taskId?: string) {
    const team = this.get(teamId);
    for (const task of taskId ? [this.task(team, taskId)] : team.tasks) {
      const startup = this.starts.get(task.childRunId);
      if (startup) startup.valid = false;
      const run = this.run(task);
      if (run.activeTaskId || run.sessionOperation)
        this.controllers.get(task.childRunId)!.interrupt(task.childRunId, reason);
    }
    this.emit(team, "team_interrupted", { reason, taskId });
    return this.summary(team);
  }
  async interruptGracefully(
    teamId: string,
    reason = "Supervisor interrupted team",
    taskId?: string
  ) {
    const team = this.get(teamId);
    await Promise.all(
      (taskId ? [this.task(team, taskId)] : team.tasks).map(async (task) => {
        const startup = this.starts.get(task.childRunId);
        if (startup) startup.valid = false;
        const run = this.run(task);
        if (run.activeTaskId || run.sessionOperation)
          await this.controllers.get(task.childRunId)!.interruptGracefully(task.childRunId, reason);
      })
    );
    this.emit(team, "team_interrupted", { reason, taskId });
    return this.summary(team);
  }
  cancel(teamId: string, reason = "Supervisor cancelled team", taskId?: string) {
    const team = this.get(teamId);
    let cleanupErrors = 0;
    for (const task of taskId ? [this.task(team, taskId)] : team.tasks) {
      const startup = this.starts.get(task.childRunId);
      if (startup) startup.valid = false;
      try {
        this.controllers.get(task.childRunId)!.cancel(task.childRunId, reason);
      } catch {
        cleanupErrors++;
      }
    }
    if (!taskId) team.status = "cancelled";
    this.emit(team, "team_cancelled", { reason, taskId, cleanupErrors });
    return this.summary(team);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    let errors = 0;
    for (const startup of this.starts.values()) startup.valid = false;
    for (const controller of this.controllers.values()) {
      try {
        controller.close();
      } catch {
        errors++;
      }
    }
    for (const unsubscribe of this.subscriptions) unsubscribe();
    for (const team of this.teams.values())
      if (
        team.ownerPid === process.pid &&
        team.tasks.every((task) => this.controllers.has(task.childRunId))
      ) {
        for (const task of team.tasks) {
          const run = this.run(task);
          task.state = run.tasks[0].state;
          if (task.reservation && !run.activeTaskId) {
            settleReservation(
              team.budget,
              task.reservation.held,
              Math.max(0, run.turnBudget.used - task.reservation.usedBefore)
            );
            task.reservation = undefined;
          }
        }
        this.syncBudget(team);
        team.ownerReleased = true;
        try {
          this.save(team);
        } catch {
          errors++;
        }
      }
    for (const listener of [...this.listeners])
      for (const team of this.teams.values()) listener(team.id);
    this.listeners.clear();
    this.activityListeners.clear();
    if (errors) console.error(`Team cleanup completed with ${errors} resource errors`);
  }
}
