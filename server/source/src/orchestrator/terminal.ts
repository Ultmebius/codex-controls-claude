import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { nativeHelperFile } from "./ownership.js";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

export interface TerminalInfo {
  title: string;
  ownershipId: string;
  workerName?: string;
  hostPid?: number;
  wtSession?: string;
  workerPid?: number;
  windowHandle?: string;
  windowPid?: number;
  startedMinimized?: boolean;
  windowLaunchMs?: number;
  /** Milliseconds from the start message to the first painted conversation frame. */
  firstFrameMs?: number;
  /** Whether that first frame carried a conversation (false when the readiness cap was reached). */
  firstFramePainted?: boolean;
  paintedColumns?: number;
  paintedRows?: number;
  /** True when the user brought the window forward, so startup deliberately did not minimize it. */
  userRestored?: boolean;
  effort?: string;
  effortSource?: string;
}
interface WindowInfo {
  launchMs?: number;
  handle: string;
  pid: number;
  /**
   * The window was created minimized so Windows Terminal never steals focus. It is then restored
   * without activation so the dashboard paints behind the user's window, and the host minimizes it
   * exactly once after the first conversation frame.
   */
  launchedMinimized?: boolean;
  /** Live state at claim time: false while the window is painting behind the foreground window. */
  minimized: boolean;
  /**
   * System-wide last-input tick observed before Windows Terminal was spawned. A user restore is
   * always preceded by user input; the host compares this baseline at first-frame time so Windows
   * Terminal's own startup activation is not mistaken for a restore.
   */
  inputBaseline?: number;
  /**
   * The launcher observed the user take the window during its startup settle (in front with user
   * input after the launch baseline), so it deliberately did not bury it again. The host honours this
   * as final and never minimizes the window.
   */
  userRestoredAtLaunch?: boolean;
  /** Where the claim ended: "claimed" then "painting", or a legacy "claimed". */
  stage?: string;
}
interface LaunchInfo {
  pipe: string;
  token: string;
  title: string;
  ownershipId: string;
  cwd?: string;
}
interface TerminalOptions {
  launch?: (
    info: LaunchInfo,
    onWindow: (window: WindowInfo) => void,
    onError: (error: Error) => void
  ) => void;
  startupTimeoutMs?: number;
  effort?: string;
  effortSource?: string;
  workerName?: string;
}
/** Display-only label: strip terminal control/escape sequences and bound the tab title. */
export function sanitizeWorkerName(value: unknown, max = 64) {
  if (typeof value !== "string") return undefined;
  /* eslint-disable no-control-regex -- stripping terminal control sequences is the purpose */
  const cleaned = value
    .replace(/\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  /* eslint-enable no-control-regex */
  if (!cleaned) return undefined;
  const chars = [...cleaned];
  return chars.length > max ? chars.slice(0, max).join("").trim() || undefined : cleaned;
}
const active = new Set<TerminalProcess>();
export function terminalInfo() {
  return [...active].map((process) => ({ ...process.info }));
}
export function stopTerminalProcesses() {
  for (const process of [...active]) {
    try {
      process.kill("SIGTERM");
    } catch {
      /* Continue stopping other owned workers. */
    }
  }
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
const nativeHelper = nativeHelperFile;
function closeWindow(info: TerminalInfo) {
  if (!info.windowHandle || info.windowHandle === "0") return;
  const closer = spawn(
    "dotnet.exe",
    [
      nativeHelper(),
      "--close",
      info.windowHandle,
      String(info.windowPid),
      info.title,
      info.ownershipId,
    ],
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
    [
      nativeHelper(),
      "--launch",
      info.pipe,
      info.token,
      info.title,
      info.cwd ?? process.cwd(),
      info.ownershipId,
    ],
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
  /** Last user-input tick at spawn time; the host uses it to tell self-activation from a restore. */
  private inputBaseline?: number;
  /** The launcher saw the user take the window; the host must neither bury nor minimize it. */
  private restoredAtLaunch = false;
  private socket?: Socket;
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly opts: SpawnOptions,
    private readonly options: TerminalOptions = {}
  ) {
    super();
    const id = randomUUID();
    const token = randomUUID();
    const pipe = `\\\\.\\pipe\\codex-controls-claude-${id}`;
    const workerName = sanitizeWorkerName(options.workerName);
    // Display and ownership are separate: equal names still have distinct full identities.
    this.info = {
      title: "Claude Code",
      ownershipId: id,
      workerName,
      effort: options.effort,
      effortSource: options.effortSource,
    };
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
        } else if (message.type === "ready") {
          // The host reports a REAL painted conversation frame, not a timer: the window is
          // minimized exactly once after that frame, so the taskbar preview is composed from the
          // real dashboard. Advisory only, so a missing report changes nothing.
          if (Number.isSafeInteger(message.firstFrameMs))
            this.info.firstFrameMs = Number(message.firstFrameMs);
          if (typeof message.firstFramePainted === "boolean")
            this.info.firstFramePainted = message.firstFramePainted;
          // The host minimizes exactly once, AFTER the first painted conversation frame. A window the
          // user already brought forward is deliberately not minimized and is reported as such.
          if (typeof message.minimized === "boolean")
            this.info.startedMinimized = message.minimized;
          if (message.userRestored === true) this.info.userRestored = true;
          if (Number.isSafeInteger(message.columns))
            this.info.paintedColumns = Number(message.columns);
          if (Number.isSafeInteger(message.rows)) this.info.paintedRows = Number(message.rows);
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
          ownershipId: this.info.ownershipId,
          cwd: opts.cwd,
        },
        (window) => {
          this.info.windowHandle = window.handle;
          this.info.windowPid = window.pid;
          // Captured before the worker existed; the host compares it against input at first-frame
          // time so Windows Terminal's own activation is never mistaken for a user restore.
          if (typeof window.inputBaseline === "number") this.inputBaseline = window.inputBaseline;
          // A user restore observed by the launcher is final: it must reach the host so the single
          // post-frame minimization is skipped rather than overriding the user's choice.
          if (window.userRestoredAtLaunch === true) this.restoredAtLaunch = true;
          // `startedMinimized` is EVIDENCE, never a launch intent: it is set only when the window was
          // actually minimized. The production host minimizes after the first painted conversation
          // frame, so this stays unset until its `ready` report confirms it. `launchedMinimized` is
          // just the spawn intent (Windows Terminal never steals focus), and `minimized` is the live
          // state at claim time — false while the dashboard paints behind the foreground window.
          if (window.minimized) this.info.startedMinimized = true;
          this.info.windowLaunchMs = window.launchMs;
          if (this.finished) closeWindow(this.info);
          else if (window.launchedMinimized === false && !window.minimized)
            fail(new Error("Windows Terminal did not minimize"));
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
    // The gate is "this exact window has been claimed", not "the window is already minimized": the
    // worker must start while the dashboard paints, because the host minimizes only after the first
    // conversation frame. Requiring a completed minimization here would deadlock the two sides.
    if (this.started || this.finished || !this.socket || !this.info.windowHandle) return;
    this.started = true;
    const { command, args, cwd, env } = this.opts;
    this.send({
      type: "start",
      command,
      args,
      cwd,
      env,
      effort: this.options.effort ?? "unknown",
      effortSource: this.options.effortSource ?? "not reported",
      windowHandle: this.info.windowHandle,
      // Observed before the worker existed: the host compares it against the system input tick when
      // the first frame is painted, so Windows Terminal's own startup activation is not mistaken for
      // the user bringing the window forward.
      inputBaseline: this.inputBaseline,
      // The launcher's own restore decision; the host treats it as final and does not minimize.
      windowRestoredAtLaunch: this.restoredAtLaunch,
    });
    this.stdin.on("data", (chunk: Buffer) => {
      if (!this.send({ type: "stdin", data: chunk.toString("base64") })) {
        this.stdin.pause();
        this.socket?.once("drain", () => this.stdin.resume());
      }
    });
    this.stdin.once("end", () => this.send({ type: "end" }));
  }
  private ready() {
    // Startup is complete once the exact window is claimed and the worker is spawned. The single
    // post-first-frame minimization happens later and must not extend the startup timeout: a quiet
    // worker is not a failed launch.
    if (this.info.workerPid && this.info.windowHandle) clearTimeout(this.timer);
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
