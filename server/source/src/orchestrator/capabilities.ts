import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SDKSystemMessage, McpServerStatus } from "@anthropic-ai/claude-agent-sdk";

export interface WorkerCapabilities {
  source: "sdk_init" | "sdk_status";
  capturedAt: string;
  permissionMode: string;
  builtInTools: string[];
  mcpServers: { name: string; status: string; toolCount?: number; tools?: string[] }[];
  policy: {
    builtIns: "claude_code_default";
    mcp: "native_enabled_configuration";
    permissions: "native_configuration";
    hooks: "native_configuration";
    blockedTools: string[];
  };
  statusRefresh?: "unavailable";
}
export function capabilitiesFromInit(init: SDKSystemMessage): WorkerCapabilities {
  return {
    source: "sdk_init",
    capturedAt: new Date().toISOString(),
    permissionMode: init.permissionMode,
    builtInTools: init.tools.filter((tool) => !tool.startsWith("mcp__")),
    mcpServers: (init.mcp_servers ?? []).map((server) => ({
      name: server.name,
      status: server.status,
    })),
    policy: {
      builtIns: "claude_code_default",
      mcp: "native_enabled_configuration",
      permissions: "native_configuration",
      hooks: "native_configuration",
      blockedTools: ["Agent", "Task", "TeamCreate", "TeamDelete"],
    },
  };
}
export function capabilitiesFromStatus(
  initial: WorkerCapabilities,
  servers: McpServerStatus[]
): WorkerCapabilities {
  return {
    ...initial,
    source: "sdk_status",
    capturedAt: new Date().toISOString(),
    statusRefresh: undefined,
    mcpServers: servers.map((server) => ({
      name: server.name,
      status: server.status,
      ...(server.tools
        ? { toolCount: server.tools.length, tools: server.tools.map((tool) => tool.name) }
        : {}),
    })),
  };
}
export function compactCapabilities(snapshot?: WorkerCapabilities) {
  return snapshot
    ? { ...snapshot, mcpServers: snapshot.mcpServers.map(({ tools: _tools, ...server }) => server) }
    : undefined;
}

const switches = [
  "disabledMcpServers",
  "enabledMcpServers",
  "disabledMcpjsonServers",
  "enabledMcpjsonServers",
  "enableAllProjectMcpServers",
];
function json(file: string): Record<string, unknown> {
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>)
    : {};
}
function selected(value: Record<string, unknown>) {
  return Object.fromEntries(
    ["mcpServers", "enabledPlugins", "permissions", "hooks", "disableAllHooks", ...switches]
      .filter((key) => value[key] !== undefined)
      .map((key) => [
        key,
        switches.includes(key) && Array.isArray(value[key])
          ? [...(value[key] as unknown[])].sort()
          : value[key],
      ])
  );
}
function normalize(file: string) {
  const resolved = path.resolve(file).replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)])
    );
  return value;
}
/** At task boundaries only. Hash relevant native settings, never copy credentials or rewrite config. */
export function nativeMcpSignature(cwd: string, home = os.homedir()): string {
  const config = json(path.join(home, ".claude.json"));
  const projects = config.projects as Record<string, Record<string, unknown>> | undefined;
  const target = normalize(cwd);
  const scopes = Object.entries(projects ?? {})
    .filter(([dir]) => target === normalize(dir) || target.startsWith(normalize(dir) + "/"))
    .map(([dir, value]) => [normalize(dir), selected(value)]);
  const sources = [
    selected(config),
    scopes,
    selected(json(path.join(home, ".claude/settings.json"))),
    json(path.join(cwd, ".mcp.json")),
    selected(json(path.join(cwd, ".claude/settings.json"))),
    selected(json(path.join(cwd, ".claude/settings.local.json"))),
  ];
  return createHash("sha256")
    .update(JSON.stringify(stable(sources)))
    .digest("hex");
}
