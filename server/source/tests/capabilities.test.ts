import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  capabilitiesFromInit,
  capabilitiesFromStatus,
  compactCapabilities,
  nativeMcpSignature,
} from "../src/orchestrator/capabilities.js";
import type { SDKSystemMessage, McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("native worker capabilities", () => {
  it("distinguishes init facts and sanitizes status configuration", () => {
    const initial = capabilitiesFromInit({
      tools: ["Read", "Bash", "mcp__ctx__execute"],
      permissionMode: "default",
      mcp_servers: [{ name: "ctx", status: "pending" }],
    } as SDKSystemMessage);
    expect(initial.builtInTools).toEqual(["Read", "Bash"]);
    expect(initial.mcpServers[0].status).toBe("pending");
    const status = [
      {
        name: "ctx",
        status: "connected",
        tools: [{ name: "execute", description: "large description" }],
        config: {
          type: "http",
          url: "https://private",
          headers: { Authorization: "super-secret-value" },
        },
      },
    ] as McpServerStatus[];
    const result = capabilitiesFromStatus(initial, status);
    expect(result.mcpServers[0]).toMatchObject({
      name: "ctx",
      status: "connected",
      toolCount: 1,
      tools: ["execute"],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /super-secret|private|Authorization|large description/
    );
    expect(compactCapabilities(result)?.mcpServers[0]).not.toHaveProperty("tools");
  });
  it("reacts to project MCP switches but ignores Claude history counters", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ccc-mcp-config-"));
    cleanup.push(home);
    const cwd = path.join(home, "project");
    mkdirSync(cwd);
    const file = path.join(home, ".claude.json");
    const data = {
      numStartups: 1,
      mcpServers: { custom: { command: "fixture", env: { TOKEN: "not-exported" } } },
      projects: { [cwd]: { disabledMcpServers: ["custom"], lastCost: 1 } },
    };
    writeFileSync(file, JSON.stringify(data));
    const first = nativeMcpSignature(cwd, home);
    data.numStartups = 99;
    data.projects[cwd].lastCost = 100;
    writeFileSync(file, JSON.stringify(data));
    expect(nativeMcpSignature(cwd, home)).toBe(first);
    data.projects[cwd].disabledMcpServers = [];
    writeFileSync(file, JSON.stringify(data));
    expect(nativeMcpSignature(cwd, home)).not.toBe(first);
    expect(nativeMcpSignature(cwd, home)).not.toContain("not-exported");
  });
});
