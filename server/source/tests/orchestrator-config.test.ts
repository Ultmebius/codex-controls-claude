import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { localConfig } from "../src/orchestrator/runtime.js";

let home: string;
function settings(value: unknown) {
  writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify(value));
}
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "ccc-config-"));
  mkdirSync(path.join(home, ".claude"));
  const executable = path.join(home, "claude.exe");
  writeFileSync(executable, "fixture");
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("CCC_CLAUDE_PATH", executable);
  vi.stubEnv("ANTHROPIC_MODEL", "inherited-model");
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
describe("Claude Code model configuration", () => {
  it("prioritizes settings env and preserves arbitrary aliases and family mappings", () => {
    settings({
      model: "top-level-model",
      env: {
        ANTHROPIC_MODEL: "my-provider-model[1m]",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "my-small-model",
      },
    });
    const config = localConfig();
    expect(config.model).toBe("my-provider-model[1m]");
    expect(config.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("my-small-model");
  });
  it("falls back to inherited model, then top-level model, then native default", () => {
    settings({ model: "top-level-model" });
    expect(localConfig().model).toBe("inherited-model");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    expect(localConfig().model).toBe("top-level-model");
    settings({});
    expect(localConfig().model).toBeUndefined();
  });
  it("supports native authentication without gateway or settings file", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "");
    const config = localConfig();
    expect(config.model).toBeUndefined();
    expect(config.endpoint).toBeFalsy();
  });
  it("rejects gateway URLs containing credentials", () => {
    settings({ env: { ANTHROPIC_BASE_URL: "http://user:secret@localhost" } });
    expect(() => localConfig()).toThrow("Endpoint URL must not contain credentials");
  });
});
