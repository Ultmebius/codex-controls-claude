import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { displayEffort } from "../src/orchestrator/display-settings.js";

describe("display-only native effort", () => {
  it("preserves native effort precedence without modifying inputs", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ccc-effort-"));
    mkdirSync(path.join(home, ".claude"));
    writeFileSync(
      path.join(home, ".claude/settings.json"),
      JSON.stringify({ effortLevel: "low", modelSettings: { custom: { effortLevel: "high" } } })
    );
    const env = { ANTHROPIC_MODEL: "custom[1m]" };
    expect(displayEffort(undefined, env, [], home)).toEqual({
      effort: "high",
      effortSource: "model setting (configured)",
    });
    expect(displayEffort(undefined, env, ["--effort", "medium"], home).effort).toBe("medium");
    const explicit = { ...env, CLAUDE_CODE_EFFORT_LEVEL: "max" };
    expect(displayEffort(undefined, explicit, ["--effort", "medium"], home).effort).toBe("max");
    expect(explicit).toEqual({ ANTHROPIC_MODEL: "custom[1m]", CLAUDE_CODE_EFFORT_LEVEL: "max" });
  });
  it("uses higher scope configuration and never invents a model default", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ccc-effort-"));
    const cwd = path.join(home, "project");
    mkdirSync(path.join(home, ".claude"));
    mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude/settings.json"),
      JSON.stringify({ effortLevel: "high" })
    );
    writeFileSync(
      path.join(cwd, ".claude/settings.local.json"),
      JSON.stringify({ effortLevel: "medium" })
    );
    expect(displayEffort(cwd, {}, [], home).effort).toBe("medium");
    expect(displayEffort(undefined, {}, [], cwd)).toEqual({
      effort: "unknown",
      effortSource: "not reported",
    });
    expect(displayEffort(undefined, { CLAUDE_CODE_EFFORT_LEVEL: "auto" }, [], cwd).effort).toBe(
      "auto"
    );
  });
  it("resolves a generic configured model by exact name and the [1m] suffix only", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ccc-effort-"));
    mkdirSync(path.join(home, ".claude"));
    writeFileSync(
      path.join(home, ".claude/settings.json"),
      JSON.stringify({
        effortLevel: "low",
        modelSettings: {
          "deepseek-flash": { effortLevel: "high" },
          "deepseek-flash[1m]": { effortLevel: "medium" },
          "other-model": { effortLevel: "max" },
        },
      })
    );
    // The configured [1m] suffix is stripped, so the exact base entry resolves first.
    expect(displayEffort(undefined, { ANTHROPIC_MODEL: "deepseek-flash[1m]" }, [], home)).toEqual({
      effort: "high",
      effortSource: "model setting (configured)",
    });
    // Without a configured model, a per-model entry is never borrowed.
    expect(displayEffort(undefined, {}, [], home).effort).toBe("low");
    // A similarly spelled model is not a match: no fuzzy/substring resolution.
    expect(
      displayEffort(undefined, { ANTHROPIC_MODEL: "deepseek-flash-lite" }, [], home).effort
    ).toBe("low");
  });
  it("keeps malformed/native-managed unknowns from changing worker startup", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ccc-effort-"));
    mkdirSync(path.join(home, ".claude"));
    writeFileSync(path.join(home, ".claude/settings.json"), "invalid JSON");
    expect(
      displayEffort(undefined, { CLAUDE_CODE_EFFORT_LEVEL: "\u001b[31m" }, [], home).effort
    ).toBe("unknown");
  });
});
