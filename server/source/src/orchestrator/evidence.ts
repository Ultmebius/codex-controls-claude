import type { Task, Run } from "./controller.js";
import { budgetSummary } from "./execution.js";
export const EVIDENCE_SECTIONS = [
  "result",
  "error",
  "checks",
  "artifacts",
  "budget",
  "checkpoint",
  "capabilities",
  "contract",
  "usage",
  "executions",
  "changes",
  "decisions",
] as const;
export type EvidenceSection = (typeof EVIDENCE_SECTIONS)[number];
export function selectTaskEvidence(
  run: Run,
  task: Task,
  sections: EvidenceSection[],
  capabilities?: unknown
) {
  const selected: Record<string, unknown> = {
    id: task.id,
    state: task.state,
    revision: task.revision,
  };
  const extended = task;
  const result = task.result;
  for (const section of new Set(sections)) {
    switch (section) {
      case "result":
        selected.result = result
          ? {
              sessionId: result.sessionId,
              result: result.result,
              isError: result.isError,
              numTurns: result.numTurns,
              stopReason: result.stopReason,
              structuredOutput: result.structuredOutput,
              errorSubtype: result.errorSubtype,
              permissionDenials: result.permissionDenials,
            }
          : undefined;
        break;
      case "error":
        selected.error = {
          failure: extended.failure,
          subtype: result?.errorSubtype,
          message: result?.isError || task.state === "blocked" ? result?.result : undefined,
          feedback: task.feedback,
        };
        break;
      case "checks":
        selected.reviews = task.reviews;
        break;
      case "artifacts":
        selected.artifacts = {
          paths: task.artifacts,
          additionalArtifacts: task.additionalArtifacts,
          hash: task.artifactHash,
          provenance: extended.provenance,
        };
        break;
      case "budget":
        selected.budget = {
          run: run.turnBudget,
          summary: budgetSummary(run.turnBudget),
          defaultSegmentLimit: run.maxTurns,
          lastExecution: run.executions?.filter((e) => e.taskId === task.id).at(-1),
          attempts: task.attempts,
          repairs: extended.repairs,
          continuations: extended.continuations,
        };
        break;
      case "checkpoint":
        selected.checkpoint = extended.checkpoint;
        break;
      case "executions":
        selected.executions = run.executions?.filter((e) => e.taskId === task.id);
        break;
      case "changes":
        selected.changes = {
          declaredArtifacts: task.artifacts,
          additionalArtifacts: task.additionalArtifacts ?? [],
          peerArtifacts: run.peerArtifacts ?? [],
          ...task.changeInventory,
        };
        break;
      case "decisions":
        selected.decisions = (task.decisions ?? []).map((d) => ({
          ...d,
          state:
            d.state === "pending" && d.expiresAt && Date.parse(d.expiresAt) <= Date.now()
              ? "expired"
              : d.state,
          nextActions:
            d.state === "pending" && d.expiresAt && Date.parse(d.expiresAt) > Date.now()
              ? [d.kind === "permission" ? "respond_permission" : "respond_message"]
              : ["continue_with_feedback", "reconcile"],
          automaticReplay: false,
        }));
        break;
      case "capabilities":
        selected.workerCapabilities = capabilities;
        break;
      case "contract":
        selected.contract = {
          id: task.id,
          title: task.title,
          instructions: task.instructions,
          dependsOn: task.dependsOn,
          acceptance: task.acceptance,
          artifacts: task.artifacts,
          checks: task.checks,
        };
        break;
      case "usage":
        selected.usage = result
          ? {
              usage: result.usage,
              modelUsage: result.modelUsage,
              totalCostUsd: result.totalCostUsd,
              sessionTotalCostUsd: result.sessionTotalCostUsd,
              costIsClientEstimate: true,
            }
          : undefined;
        break;
    }
  }
  return selected;
}
