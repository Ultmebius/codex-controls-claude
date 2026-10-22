import { describe, expect, it } from "vitest";
import { selectTaskEvidence } from "../src/orchestrator/evidence.js";
import type { Run, Task } from "../src/orchestrator/controller.js";
const run = {
  id: "run",
  maxTurns: 40,
  turnBudget: { limit: 200, used: 7, reserved: 0 },
} as unknown as Run;
const task = {
  id: "a",
  state: "failed",
  revision: 1,
  title: "task",
  instructions: "large-contract-sentinel",
  acceptance: "fixed check",
  artifacts: ["answer.txt"],
  checks: [{ command: "node", args: [] }],
  dependsOn: [],
  attempts: 2,
  repairs: 0,
  continuations: 1,
  reviews: [{ decision: "rejected", checks: [{ exitCode: 1, stderr: "wrong value" }] }],
  result: {
    sessionId: "session",
    result: "worker result",
    isError: true,
    numTurns: 2,
    errorSubtype: "error_max_turns",
    totalCostUsd: 1,
    usage: { input_tokens: 123 },
    modelUsage: { "large-usage-sentinel": { inputTokens: 456 } },
  },
} as unknown as Task;
describe("selective orchestration evidence", () => {
  it("returns result/checks/artifacts without repeating contract or usage", () => {
    const selected = selectTaskEvidence(run, task, ["result", "checks", "artifacts"]);
    expect(selected.result).toMatchObject({
      result: "worker result",
      errorSubtype: "error_max_turns",
    });
    expect(selected.reviews).toEqual(task.reviews);
    expect(JSON.stringify(selected)).not.toMatch(
      /large-contract-sentinel|large-usage-sentinel|totalCostUsd/
    );
  });
  it("expands contract and usage only when explicitly selected", () => {
    const selected = selectTaskEvidence(run, task, ["contract", "usage", "budget"]);
    expect(JSON.stringify(selected)).toContain("large-contract-sentinel");
    expect(JSON.stringify(selected)).toContain("large-usage-sentinel");
    expect(selected.budget).toMatchObject({ run: { used: 7 }, repairs: 0, continuations: 1 });
  });
});
