import { describe, expect, it } from "vitest";
import {
  normalizedBudget,
  availableGrant,
  reserveGrant,
  settleReservation,
} from "../src/orchestrator/budget.js";
describe("persistent turn budget", () => {
  it("preserves a custom persisted limit rather than resetting to the default", () => {
    expect(normalizedBudget({ limit: 5, used: 3 }).limit).toBe(5);
    expect(() => normalizedBudget({ limit: 0 })).toThrow("INVALID_RUN_TURN_LIMIT");
  });
  it("reserves the calibrated boundary allowance and shrinks the final grant", () => {
    const budget = normalizedBudget(undefined, 5);
    const first = availableGrant(budget, 2);
    const hold = reserveGrant(budget, first);
    expect(hold).toBe(3);
    settleReservation(budget, hold, 3);
    expect(availableGrant(budget, 40)).toBe(1);
  });
  it("charges unknown accounting conservatively but honors a known zero", () => {
    const budget = normalizedBudget(undefined, 20);
    settleReservation(budget, reserveGrant(budget, 2), undefined);
    expect(budget.used).toBe(3);
    expect(budget.estimated).toBe(3);
    settleReservation(budget, reserveGrant(budget, 2), 0);
    expect(budget.used).toBe(3);
  });
  it("reports unexpected native overruns rather than hiding them with a clamp", () => {
    const budget = normalizedBudget(undefined, 5);
    settleReservation(budget, reserveGrant(budget, 4), 7);
    expect(budget.used).toBe(7);
    expect(budget.overrun).toBe(2);
    expect(availableGrant(budget, 40)).toBe(0);
  });
});
