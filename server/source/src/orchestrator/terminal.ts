import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

export interface TerminalInfo {
  title: string;
  hostPid?: number;
  wtSession?: string;
  workerPid?: number;
  windowHandle?: string;
  windowPid?: number;
  startedMinimized?: boolean;
  windowLaunchMs?: number;
}
interface WindowInfo {
  launchMs?: number;
  handle: string;
  pid: number;
  minimized: boolean;
}
interface LaunchInfo {
  pipe: string;
  token: string;
  title: string;
  cwd?: string;
}
interface TerminalOptions {
  launch?: (
    info: LaunchInfo,
    onWindow: (window: WindowInfo) => void,
    onError: (error: Error) => void
  ) => void;
  startupTimeoutMs?: number;
}
const active = new Set<TerminalProcess>();
export function terminalInfo() {
  return [...active].map((process) => ({ ...process.info }));
}
export function stopTerminalProcesses() {
  for (const process of [...active]) process.kill("SIGTERM");
}

function killTree(pid?: number) {
  if (!pid) return;
  try {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    /* Already exited. */
  }
}
const nativeHelper = () =>
  fileURLToPath(new URL("./native/CodexClaudeTerminal.dll", import.meta.url));
function closeWindow(info: TerminalInfo) {
  if (!info.windowHandle || info.windowHandle === "0") return;
  const closer = spawn(
    "dotnet.exe",
    [nativeHelper(), "--close", info.windowHandle, String(info.windowPid), info.title],
    { windowsHide: true, stdio: "ignore" }
  );
  closer.on("error", () => {});
}
function launch(
  info: LaunchInfo,
  onWindow: (window: WindowInfo) => void,
  onError: (error: Error) => void
) {
  const launcher = spawn(
    "dotnet.exe",
    [nativeHelper(), "--launch", info.pipe, info.token, info.title, info.cwd ?? process.cwd()],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  let output = "";
  launcher.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  launcher.stderr.resume();
  launcher.once("error", onError);
  launcher.once("close", (code) => {
    if (code !== 0) return onError(new Error("C# Windows Terminal launch/minimization failed"));
    try {
      onWindow(JSON.parse(output.trim()) as WindowInfo);
    } catch {
      onError(new Error("Windows Terminal window could not be verified"));
    }
  });
}

export class TerminalProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly info: TerminalInfo;
  killed = false;
  exitCode: number | null = null;
  private finished = false;
  private connected = false;
  private started = false;
  private socket?: Socket;
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly opts: SpawnOptions,
    options: TerminalOptions = {}
  ) {
    super();
    const id = randomUUID();
    const token = randomUUID();
    const pipe = `\\\\.\\pipe\\codex-controls-claude-${id}`;
    this.info = { title: `Codex Controls Claude ${id.slice(0, 8)}` };
    active.add(this);
    const fail = (error: Error) => {
      if (!this.finished) {
        this.emit("error", error);
        this.finish(1);
      }
    };
    this.timer = setTimeout(
      () => fail(new Error("Windows Terminal startup timed out")),
      options.startupTimeoutMs ?? 20000
    );
    this.timer.unref();
    const abort = () => this.kill("SIGTERM");
    opts.signal.addEventListener("abort", abort, { once: true });
    this.once("exit", () => opts.signal.removeEventListener("abort", abort));
    this.stdin.on("error", () => {});
    this.stdout.on("error", () => {});
    this.server.on("error", fail);
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      if (this.connected || this.finished) {
        socket.destroy();
        return;
      }
      const lines = createInterface({ input: socket, crlfDelay: Infinity });
      let authenticated = false;
      socket.on("error", () => {
        if (authenticated) fail(new Error("Terminal session connection failed"));
      });
      socket.once("close", () => {
        if (authenticated && !this.finished) fail(new Error("Claude Code terminal closed"));
      });
      lines.on("line", (line) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          socket.destroy();
          return;
        }
        if (!authenticated) {
          if (
            message.type !== "hello" ||
            message.token !== token ||
            !Number.isSafeInteger(message.pid) ||
            Number(message.pid) <= 0
          ) {
            socket.destroy();
            return;
          }
          authenticated = true;
          this.connected = true;
          this.socket = socket;
          this.info.hostPid = Number(message.pid);
          this.info.wtSession =
            typeof message.wtSession === "string" ? message.wtSession : undefined;
          this.server.close();
          this.startWorker();
          return;
        }
        if (message.type === "spawned") {
          this.info.workerPid = Number(message.pid);
          this.ready();
        } else if (message.type === "stdout" && typeof message.data === "string") {
          if (!this.stdout.write(Buffer.from(message.data, "base64"))) {
            socket.pause();
            this.stdout.once("drain", () => socket.resume());
          }
        } else if (message.type === "exit")
          this.finish(typeof message.code === "number" ? message.code : 1);
        else if (message.type === "error")
          fail(new Error("Claude Code terminal process failed to start"));
      });
    });
    this.server.listen(pipe, () => {
      if (this.finished) {
        this.server.close();
        return;
      }
      (options.launch ?? launch)(
        {
          pipe,
          token,
          title: this.info.title,
          cwd: opts.cwd,
        },
        (window) => {
          this.info.windowHandle = window.handle;
          this.info.windowPid = window.pid;
          this.info.startedMinimized = window.minimized;
          this.info.windowLaunchMs = window.launchMs;
          if (this.finished) closeWindow(this.info);
          else if (!window.minimized) fail(new Error("Windows Terminal did not minimize"));
          else {
            this.startWorker();
            this.ready();
          }
        },
        fail
      );
    });
    if (opts.signal.aborted) queueMicrotask(abort);
  }
  private startWorker() {
    if (this.started || this.finished || !this.socket || !this.info.startedMinimized) return;
    this.started = true;
    const { command, args, cwd, env } = this.opts;
    this.send({ type: "start", command, args, cwd, env });
    this.stdin.on("data", (chunk: Buffer) => {
      if (!this.send({ type: "stdin", data: chunk.toString("base64") })) {
        this.stdin.pause();
        this.socket?.once("drain", () => this.stdin.resume());
      }
    });
    this.stdin.once("end", () => this.send({ type: "end" }));
  }
  private ready() {
    if (this.info.workerPid && this.info.startedMinimized) clearTimeout(this.timer);
  }
  private send(value: unknown) {
    return this.socket?.write(JSON.stringify(value) + "\n") ?? false;
  }
  private finish(code: number | null) {
    if (this.finished) return;
    this.finished = true;
    this.exitCode = code;
    clearTimeout(this.timer);
    active.delete(this);
    this.stdin.destroy();
    this.stdout.end();
    this.socket?.destroy();
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
    // Only the authenticated host/worker tree and this dedicated window are ours.
    killTree(this.info.hostPid);
    killTree(this.info.workerPid);
    closeWindow(this.info);
    this.emit("exit", code, this.killed ? "SIGTERM" : null);
  }
  kill(_signal: NodeJS.Signals) {
    this.killed = true;
    this.finish(null);
    return true;
  }
}
