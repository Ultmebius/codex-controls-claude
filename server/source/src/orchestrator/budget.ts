/**
 * Persistent native turn budget for a run.
 *
 * The native `maxTurns` option limits agentic rounds, not individual tools, and the
 * installed SDK/native CLI can report one extra boundary turn on top of the requested
 * grant. Every segment therefore reserves `grant + BOUNDARY_ALLOWANCE` turns so the
 * run-level guard retains a conservative boundary allowance, and settlement charges the SDK-reported
 * `num_turns` instead of any cumulative cost figure.
 */

/** Native segment grant default (agentic rounds per dispatch). */
export const DEFAULT_SEGMENT_TURNS = 40;
/** Persistent run budget in SDK-reported turns. */
export const DEFAULT_RUN_TURN_LIMIT = 200;
/** One extra round is reported by the native CLI at the grant boundary. */
export const BOUNDARY_ALLOWANCE = 1;

export type BudgetStopReason = "native_max_turns" | "provider_budget_cap";

export interface TurnBudget {
  /** Total turns this run may ever spend. Survives append/supersede/reopen/resume. */
  limit: number;
  /** Turns charged from settled terminal events. */
  used: number;
  /** Turns held by in-flight segments (grant + boundary allowance). */
  reserved: number;
  /** Set when a terminal event proved the provider stopped the run for budget reasons. */
  stopReason?: BudgetStopReason;
  /** Turns charged conservatively after an orphaned reservation was recovered. */
  recovered?: number;
  estimated?: number;
  overrun?: number;
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Migration/defaulting for a persisted or newly created budget. */
export function normalizedBudget(
  input: Partial<TurnBudget> | undefined,
  limit = input?.limit ?? DEFAULT_RUN_TURN_LIMIT
): TurnBudget {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("INVALID_RUN_TURN_LIMIT");
  const budget: TurnBudget = {
    limit,
    used: positive(input?.used),
    reserved: positive(input?.reserved),
  };
  if (input?.stopReason) budget.stopReason = input.stopReason;
  if (input?.recovered) budget.recovered = positive(input.recovered);
  if (input?.estimated) budget.estimated = positive(input.estimated);
  if (input?.overrun) budget.overrun = positive(input.overrun);
  return budget;
}

export function budgetRemaining(budget: TurnBudget): number {
  return Math.max(0, budget.limit - budget.used - budget.reserved);
}

/**
 * Largest segment grant that still fits, leaving room for the boundary allowance.
 * A grant below one turn means the run cannot afford another model segment.
 */
export function availableGrant(budget: TurnBudget, segmentTurns: number): number {
  const headroom = budget.limit - budget.used - budget.reserved - BOUNDARY_ALLOWANCE;
  return Math.max(
    0,
    Math.min(Math.max(1, positive(segmentTurns) || DEFAULT_SEGMENT_TURNS), headroom)
  );
}

/** Reserve a segment up front and persist-able value for the outstanding hold. */
export function reserveGrant(budget: TurnBudget, grant: number): number {
  const reserved = Math.max(1, positive(grant)) + BOUNDARY_ALLOWANCE;
  if (reserved > budgetRemaining(budget)) throw new Error("RUN_TURN_BUDGET_EXHAUSTED");
  budget.reserved += reserved;
  budget.stopReason = undefined;
  return reserved;
}

/**
 * Charge a finished segment. `reported` is the SDK-reported num_turns for that
 * segment; when terminal accounting is missing or unusable the full reservation is
 * charged conservatively so budget can never be freed by losing a result.
 */
export function settleReservation(
  budget: TurnBudget,
  reserved: number,
  reported: number | undefined
): number {
  const hold = positive(reserved);
  budget.reserved = Math.max(0, budget.reserved - hold);
  const known = typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0;
  const charge = known ? reported : hold;
  if (!known) budget.estimated = (budget.estimated ?? 0) + charge;
  budget.used += charge;
  if (budget.used > budget.limit) budget.overrun = budget.used - budget.limit;
  return charge;
}
