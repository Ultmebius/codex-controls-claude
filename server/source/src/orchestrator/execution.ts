import type { TurnBudget } from "./budget.js";
import { settleReservation } from "./budget.js";

export interface ExecutionAccount {
  id: string;
  taskId: string;
  attempt: number;
  sessionId?: string;
  epoch?: number;
  startedAt: string;
  requestedLimit: number;
  effectiveLimit: number;
  defaultLimit: number;
  reservedTurns: number;
  observedAssistantMessages: number;
  confirmedTurns?: number;
  provisionalCharge: number;
  status: "reserved" | "confirmed" | "provisional";
  reason?: string;
  settledAt?: string;
}

/** Settlement is idempotent by execution ID; late native evidence replaces a provisional charge. */
export function settleExecution(
  budget: TurnBudget,
  execution: ExecutionAccount,
  reported: number | undefined,
  reason: string
) {
  const known = typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0;
  if (execution.status === "confirmed" || (execution.status === "provisional" && !known))
    return false;
  if (execution.status === "provisional") {
    budget.used -= execution.provisionalCharge;
    budget.estimated = Math.max(0, (budget.estimated ?? 0) - execution.provisionalCharge);
    budget.used += reported!;
  } else settleReservation(budget, execution.reservedTurns, known ? reported : undefined);
  execution.confirmedTurns = known ? reported : undefined;
  execution.provisionalCharge = known ? 0 : execution.reservedTurns;
  execution.reservedTurns = 0;
  execution.status = known ? "confirmed" : "provisional";
  execution.reason = reason;
  execution.settledAt = new Date().toISOString();
  budget.overrun = Math.max(0, budget.used - budget.limit) || undefined;
  return true;
}

export function budgetSummary(budget: TurnBudget) {
  return {
    limit: budget.limit,
    charged: budget.used,
    confirmedTurns: Math.max(0, budget.used - (budget.estimated ?? 0)),
    provisionalCharge: budget.estimated ?? 0,
    reservedTurns: budget.reserved,
    availableTurns: Math.max(0, budget.limit - budget.used - budget.reserved),
    accounting: "SDK-reported turns; provisional is a conservative unknown, not tokens",
  };
}
