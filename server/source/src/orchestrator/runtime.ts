import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { TerminalProcess, terminalInfo, stopTerminalProcesses } from "./terminal.js";
import type { Options, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

export function localConfig() {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const settings = (
    existsSync(settingsPath)
      ? JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""))
      : {}
  ) as { env?: Record<string, string>; model?: string };
  const env: Record<string, string | undefined> = { ...process.env, ...settings.env };
  const model = env.ANTHROPIC_MODEL?.trim() || settings.model?.trim() || undefined;
  if (model) env.ANTHROPIC_MODEL = model;
  let executable = process.env.CCC_CLAUDE_PATH;
  if (!executable) {
    const native = path.join(
      os.homedir(),
      ".local",
      "bin",
      process.platform === "win32" ? "claude.exe" : "claude"
    );
    if (existsSync(native)) executable = native;
    else {
      const command = process.platform === "win32" ? "where.exe" : "which";
      executable = execFileSync(command, ["claude"], { encoding: "utf8", windowsHide: true })
        .trim()
        .split(/\r?\n/)[0];
    }
  }
  if (!executable || !existsSync(executable)) throw new Error("Local Claude executable not found");
  const endpoint = env.ANTHROPIC_BASE_URL;
  if (endpoint) {
    const url = new URL(endpoint);
    if (url.username || url.password) throw new Error("Endpoint URL must not contain credentials");
  }
  return { env, executable: realpathSync(executable), endpoint, model };
}

/** Resolve through existing ancestors so a symlink cannot escape the task workspace. */
export function inside(root: string, target: string): boolean {
  let existing = path.resolve(root, target);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return false;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const resolved = path.join(realpathSync(existing), ...suffix);
  const relative = path.relative(realpathSync(root), resolved);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function withinScope(cwd: string, scope: string, target: string): boolean {
  const resolve = (value: string) => {
    let existing = path.resolve(cwd, value);
    const suffix: string[] = [];
    while (!existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error("UNRESOLVED_SCOPE");
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
    return path.join(realpathSync(existing), ...suffix);
  };
  const relative = path.relative(resolve(scope), resolve(target));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

const children = new Set<ChildProcessWithoutNullStreams>();
let enabled = false;
export function enableOwnedProcesses() {
  enabled = true;
}
export function ownedProcessCount() {
  return children.size + terminalInfo().length;
}

function terminate(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      /* Already exited. */
    }
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

export function stopOwnedProcesses() {
  stopTerminalProcesses();
  for (const child of [...children]) terminate(child);
}

export function executeCheck(command: string, args: string[], cwd: string, signal: AbortSignal) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; error?: string }>(
    (resolve) => {
      const child = spawn(command, args, {
        cwd,
        stdio: "pipe",
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      children.add(child);
      let stdout = "",
        stderr = "",
        error: string | undefined;
      const abort = () => {
        error = "Acceptance check cancelled or timed out";
        terminate(child);
      };
      signal.addEventListener("abort", abort, { once: true });
      const finish = (exitCode: number | null) => {
        children.delete(child);
        signal.removeEventListener("abort", abort);
        resolve({ exitCode, stdout, stderr, error });
      };
      child.stdout.on("data", (data: Buffer) => {
        stdout = (stdout + data.toString()).slice(0, 8000);
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(0, 4000);
      });
      child.once("error", (err) => {
        error = err.message;
        finish(null);
      });
      child.once("close", finish);
      child.stdin.end();
      if (signal.aborted) abort();
    }
  );
}

export function processSpawner(stoppers?: Set<() => void>): Options["spawnClaudeCodeProcess"] {
  if (!enabled) return undefined;
  return (opts: SpawnOptions) => {
    if (process.platform === "win32") {
      const terminal = new TerminalProcess(opts);
      const stop = () => terminal.kill("SIGTERM");
      stoppers?.add(stop);
      terminal.once("exit", () => stoppers?.delete(stop));
      return terminal;
    }
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: "pipe",
      windowsHide: true,
      detached: true,
    });
    children.add(child);
    const stop = () => terminate(child);
    stoppers?.add(stop);
    const abort = () => terminate(child);
    opts.signal.addEventListener("abort", abort, { once: true });
    child.once("exit", () => {
      children.delete(child);
      stoppers?.delete(stop);
      opts.signal.removeEventListener("abort", abort);
    });
    child.once("error", () => {
      children.delete(child);
      stoppers?.delete(stop);
      opts.signal.removeEventListener("abort", abort);
    });
    if (opts.signal.aborted) abort();
    // SDK owns stdin/stdout. Never mirror prompts or credentials to diagnostics.
    child.stderr.resume();
    return child;
  };
}
