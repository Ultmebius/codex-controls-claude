import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireJsonLease, releaseJsonLease, processAlive } from "./ownership.js";

/** Shared execution capacity: model-executing runs, not retained transcripts. */
export const WORKER_SLOT_LIMIT = 3;
export const MAX_WAIT_MS = 1200000;
const BUSY = "WORKER_SLOT_BUSY";

export interface WorkerSlot {
  slot: number;
  pid: number;
  token: string;
  runId: string;
  cwd: string;
  startedAt: string;
}

function slotFile(poolRoot: string, slot: number) {
  return path.join(poolRoot, "worker-slots", `slot-${slot}.json`);
}

/** Resolve symlinks; case-insensitive comparison is Windows-only. */
export function canonicalWorkspace(cwd: string) {
  let resolved = path.resolve(cwd);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    /* A missing workspace still has a stable absolute spelling. */
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function workspaceOverlaps(a: string, b: string) {
  const left = canonicalWorkspace(a),
    right = canonicalWorkspace(b);
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
}

function record(slot: WorkerSlot) {
  return {
    pid: slot.pid,
    token: slot.token,
    runId: slot.runId,
    cwd: slot.cwd,
    startedAt: slot.startedAt,
  };
}

/**
 * Exactly three live records may exist under one pool, across processes and connections.
 * Each slot is an OS-guarded JSON lease, so a dead owner is reclaimed without touching peers.
 */
export function acquireWorkerSlot(poolRoot: string, cwd: string, runId: string): WorkerSlot {
  mkdirSync(path.join(poolRoot, "worker-slots"), { recursive: true });
  const candidate = {
    pid: process.pid,
    token: randomUUID(),
    runId,
    cwd,
    startedAt: new Date().toISOString(),
  };
  for (let slot = 1; slot <= WORKER_SLOT_LIMIT; slot++) {
    try {
      acquireJsonLease(slotFile(poolRoot, slot), "token", candidate, BUSY);
      return { ...candidate, slot };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== BUSY) throw error;
    }
  }
  const status = workerSlotStatus(poolRoot);
  throw new Error(
    `WORKER_SLOTS_FULL: ${status.active}/${status.limit} worker execution slots are active across connections; retry after an owned execution finishes`
  );
}

/** Releases only this token's live record; a stale callback cannot free a newer owner. */
export function releaseWorkerSlot(poolRoot: string, slot: WorkerSlot): boolean {
  const file = slotFile(poolRoot, slot.slot);
  if (!existsSync(file)) return false;
  return releaseJsonLease(file, "token", record(slot));
}

export function workerSlotStatus(poolRoot: string) {
  const slots: Omit<WorkerSlot, "token">[] = [];
  for (let slot = 1; slot <= WORKER_SLOT_LIMIT; slot++) {
    try {
      const owner = JSON.parse(readFileSync(slotFile(poolRoot, slot), "utf8")) as WorkerSlot;
      if (processAlive(owner.pid))
        slots.push({
          slot,
          pid: owner.pid,
          runId: owner.runId,
          cwd: owner.cwd,
          startedAt: owner.startedAt,
        });
    } catch {
      /* Missing, malformed or concurrently replaced slot. */
    }
  }
  return { limit: WORKER_SLOT_LIMIT, active: slots.length, slots };
}

/** True when a live worker slot covers the same or an overlapping workspace. */
export function activeExecutionInWorkspace(poolRoot: string, cwd: string) {
  return workerSlotStatus(poolRoot).slots.some((slot) => workspaceOverlaps(slot.cwd, cwd));
}

interface ReviewRecord {
  pid: number;
  token: string;
  cwd: string;
}

function liveReviews(poolRoot: string, prune: boolean) {
  const directory = path.join(poolRoot, "reviews"),
    reviews: Array<{ file: string; record: ReviewRecord }> = [];
  let files: string[] = [];
  try {
    files = readdirSync(directory).filter((file) => file.endsWith(".json"));
  } catch {
    return reviews;
  }
  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(path.join(directory, file), "utf8")) as ReviewRecord;
      if (processAlive(record.pid)) reviews.push({ file, record });
      // A dead owner's record is never reused and must not block admission forever.
      else if (prune) unlinkSync(path.join(directory, file));
    } catch {
      /* Concurrent release or malformed record. */
    }
  }
  return reviews;
}

/**
 * One short OS-guarded critical section per pool. Both execution admission and review
 * admission take it, so a started execution and an overlapping review cannot interleave.
 */
export function withAdmissionGuard<T>(poolRoot: string, action: () => T): T {
  const guardFile = path.join(poolRoot, "reviews", "admission"),
    guard = { pid: process.pid, token: randomUUID() },
    deadline = Date.now() + 5000;
  mkdirSync(path.dirname(guardFile), { recursive: true });
  // Contention is expected and brief: retry instead of failing a legitimate admission.
  for (;;) {
    try {
      acquireJsonLease(guardFile, "token", guard, "ADMISSION_GUARD_BUSY");
      break;
    } catch (error) {
      if (!(error instanceof Error) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    releaseJsonLease(guardFile, "token", guard);
  }
}

/**
 * Short cross-process admission for acceptance checks. Overlapping scopes conflict in both
 * directions (parent/child and symlink aliases); disjoint workspaces stay independent.
 */
export function acquireWorkspaceReview(poolRoot: string, cwd: string, verify?: () => void) {
  return withAdmissionGuard(poolRoot, () => {
    if (liveReviews(poolRoot, true).some(({ record }) => workspaceOverlaps(record.cwd, cwd)))
      throw new Error("WORKSPACE_REVIEW_IN_PROGRESS");
    // Checked inside the same critical section so no execution can start in between.
    verify?.();
    const directory = path.join(poolRoot, "reviews"),
      record: ReviewRecord = {
        pid: process.pid,
        token: randomUUID(),
        cwd: canonicalWorkspace(cwd),
      },
      file = path.join(directory, `${record.token}.json`);
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    return { file, slot: record };
  });
}

export function releaseWorkspaceReview(review: ReturnType<typeof acquireWorkspaceReview>) {
  releaseJsonLease(review.file, "token", {
    pid: review.slot.pid,
    token: review.slot.token,
    cwd: review.slot.cwd,
  });
}

/** True when any live review covers the same or an overlapping workspace. */
export function workspaceReviewActive(poolRoot: string, cwd: string) {
  return liveReviews(poolRoot, false).some(({ record }) => workspaceOverlaps(record.cwd, cwd));
}
