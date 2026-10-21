import { SessionManager } from "../session/manager.js";
import { consumeQuery, type ConsumeQueryHandle } from "../tools/query-consumer.js";
import { buildOptions } from "../utils/build-options.js";
import { toSessionCreateParams } from "../utils/session-create.js";
import { raceWithAbort } from "../utils/race-with-abort.js";
import { DEFAULT_SETTING_SOURCES } from "../types.js";
import type { AgentResult, PermissionRequestRecord, SessionEvent } from "../types.js";
import {
  localConfig,
  inside,
  withinScope,
  processSpawner,
  permissionSettings,
  decisionTimeoutMs,
  startupTimeoutMs,
} from "./runtime.js";
import { InputQueue } from "./input-queue.js";
import { DEFAULT_SEGMENT_TURNS } from "./budget.js";
import { SupervisorMailbox, type SupervisorMessage } from "./messaging.js";
import { askCodex } from "./user-question.js";
import { getSessionMessages, type SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  capabilitiesFromInit,
  capabilitiesFromStatus,
  nativeMcpSignature,
  type WorkerCapabilities,
} from "./capabilities.js";
export type { WorkerCapabilities } from "./capabilities.js";

export interface WorkerEvent {
  sessionId: string;
  event?: SessionEvent;
  epoch?: number;
}
export interface ContextInfo {
  inputTokens: number | null;
  source: "stream" | "transcript" | "unavailable";
  contextWindow: number | null;
  softLimit: number;
  hardLimit: number;
}
export interface Worker {
  subscribeMessages?(
    listener: (event: { sessionId: string; message: SupervisorMessage }) => void
  ): () => void;
  respondMessage?(id: string, answer: string): boolean;
  subscribe(listener: (event: WorkerEvent) => void): () => void;
  start(
    cwd: string,
    prompt: string,
    maxTurns: number,
    signal?: AbortSignal,
    resumeId?: string
  ): Promise<string>;
  reply(
    sessionId: string,
    prompt: string,
    maxTurns?: number,
    signal?: AbortSignal
  ): Promise<string>;
  capabilities?(sessionId: string): WorkerCapabilities | undefined;
  refreshCapabilities?(sessionId: string): Promise<WorkerCapabilities | undefined>;
  eventEpoch?(sessionId: string): number;
  replay(sessionId: string): SessionEvent[] | Promise<SessionEvent[]>;
  result(sessionId: string): AgentResult | undefined;
  permissions(sessionId: string): PermissionRequestRecord[];
  respond(sessionId: string, requestId: string, allow: boolean): boolean;
  model(sessionId: string): string | undefined;
  context?(sessionId: string): ContextInfo;
  isLive?(sessionId: string): boolean;
  maintenanceComplete?(sessionId: string): void;
  interrupt?(sessionId: string, timeoutMs?: number): Promise<void>;
  /**
   * Ask the native runtime to end the current turn without tearing down the conversation.
   * Resolves true only when the control request was actually accepted; a rejected or missing
   * control channel resolves false. The caller still waits for the native result before
   * treating the turn as over.
   */
  interruptTurn?(sessionId: string): boolean | Promise<boolean>;
  /**
   * Put one scoped guidance message into the live streaming input for the next native turn.
   * Returns whether the input was accepted by the queue; it never means the model read it.
   */
  guidance?(sessionId: string, text: string, maxTurns?: number): boolean | Promise<boolean>;
  stop(sessionId?: string): void;
  destroy(): void;
  setWriteScope?(cwd: string, paths?: string[]): void;
  /** Optional human-readable worker label for the owned terminal tab. */
  setName?(name: string | undefined): void;
  permitsArtifact?(cwd: string, file: string): boolean;
}

export class ClaudeWorker implements Worker {
  readonly manager = new SessionManager({
    maxSessions: 1,
    sessionTtlMs: Infinity,
    nativeToolHandling: true,
  });
  private input?: InputQueue;
  private handle?: ConsumeQueryHandle;
  private abort?: AbortController;
  private live = false;
  private lastInputTokens: number | null = null;
  private contextSource: ContextInfo["source"] = "unavailable";
  private generation = 0;
  private eventFloor = -1;
  private hydrated = new Map<string, Promise<void>>();
  private currentId?: string;
  private capabilitySnapshot?: WorkerCapabilities;
  private configurationSignature?: string;
  private processStoppers = new Set<() => void>();
  private writeScope?: { cwd: string; paths: string[] };
  private workerName?: string;
  private nativeError?: string;
  private interruptBarrier?: Promise<boolean>;
  setName(name: string | undefined) {
    this.workerName = name;
  }
  setWriteScope(cwd: string, paths?: string[]) {
    this.writeScope = paths?.length ? { cwd, paths: [...paths] } : undefined;
  }
  permitsArtifact(cwd: string, file: string) {
    // Ledger ownership hint only: this never intercepts a Claude tool call.
    return (
      inside(cwd, file) &&
      (!this.writeScope ||
        this.writeScope.paths.some((scope) => withinScope(this.writeScope!.cwd, scope, file)))
    );
  }
  private mailbox?: SupervisorMailbox;
  private messageListeners = new Set<
    (event: { sessionId: string; message: SupervisorMessage }) => void
  >();

  subscribeMessages(listener: (event: { sessionId: string; message: SupervisorMessage }) => void) {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }
  respondMessage(id: string, answer: string) {
    return this.mailbox?.respond(id, answer) ?? false;
  }

  private captureUsage(message: unknown, source: ContextInfo["source"]) {
    const usage = (message as { usage?: Record<string, unknown> } | undefined)?.usage;
    if (!usage) return;
    const counts = [
      usage.input_tokens,
      usage.cache_read_input_tokens,
      usage.cache_creation_input_tokens,
    ];
    if (
      counts.some((n) => n !== undefined && (typeof n !== "number" || !Number.isFinite(n) || n < 0))
    )
      return;
    const tokens = counts.reduce<number>((total, n) => total + (typeof n === "number" ? n : 0), 0);
    if (tokens > 0) {
      this.lastInputTokens = tokens;
      this.contextSource = source;
    }
  }

  private enrich(sessionId: string, event: SessionEvent, generation: number): Promise<void> {
    if (generation !== this.generation || event.id <= this.eventFloor) return Promise.resolve();
    const key = `${generation}:${sessionId}:${event.id}`;
    let pending = this.hydrated.get(key);
    if (!pending) {
      pending = (async () => {
        if (event.type === "output") {
          const data = event.data as {
            type?: string;
            error?: unknown;
            message?: unknown;
            event?: { message?: unknown };
          };
          if (data.type === "assistant")
            this.nativeError =
              typeof data.error === "string" && /^[a-z_]{1,64}$/.test(data.error)
                ? data.error
                : undefined;
          this.captureUsage(data.message ?? data.event?.message, "stream");
        }
        if (
          event.type === "progress" &&
          (event.data as { type?: string }).type === "compact_boundary"
        ) {
          this.lastInputTokens = null;
          this.contextSource = "unavailable";
        }
        if (!["result", "error"].includes(event.type) || this.contextSource === "stream") return;
        // One local SDK transcript read at a terminal event; never periodic log polling.
        try {
          const messages = await getSessionMessages(sessionId, {
            dir: this.manager.get(sessionId)?.cwd,
          });
          if (generation !== this.generation) return;
          const latest = [...messages].reverse().find((m) => m.type === "assistant");
          this.captureUsage(latest?.message, "transcript");
        } catch {
          // Unknown usage remains null, never a fabricated zero.
        }
      })();
      this.hydrated.set(key, pending);
    }
    return pending;
  }

  subscribe(listener: (event: WorkerEvent) => void) {
    let active = true;
    let delivery = Promise.resolve();
    let deliveryGeneration = this.generation;
    const off = this.manager.subscribe((sessionId, event) => {
      const generation = this.generation;
      if (generation !== deliveryGeneration) {
        deliveryGeneration = generation;
        delivery = Promise.resolve();
      }
      if (sessionId !== this.currentId || (event && event.id <= this.eventFloor)) return;
      delivery = delivery.then(async () => {
        if (!active || generation !== this.generation) return;
        if (event) await this.enrich(sessionId, event, generation);
        if (active && generation === this.generation)
          listener({ sessionId, event, epoch: generation });
      });
    });
    return () => {
      active = false;
      off();
    };
  }

  async start(
    cwd: string,
    prompt: string,
    maxTurns: number,
    signal?: AbortSignal,
    resumeId?: string
  ) {
    if (this.live) throw new Error("SESSION_BUSY");
    const startupGeneration = this.generation;
    const previous = this.handle;
    this.input?.close();
    previous?.close();
    await previous?.done.catch(() => {});
    if (startupGeneration !== this.generation || signal?.aborted)
      throw new Error("STARTUP_CANCELLED");
    this.generation++;
    this.eventFloor = -1;
    this.mailbox?.close("Native query replaced");
    this.interruptBarrier = undefined;
    const mailbox = new SupervisorMailbox(decisionTimeoutMs());
    this.mailbox = mailbox;
    mailbox.subscribe((message) => {
      if (this.mailbox === mailbox && this.currentId)
        for (const listener of [...this.messageListeners])
          listener({ sessionId: this.currentId, message });
    });
    this.hydrated.clear();
    const config = localConfig();
    const permission = permissionSettings(cwd);
    if (resumeId && this.manager.get(resumeId)) this.manager.delete(resumeId);
    const model = config.model;
    this.configurationSignature = nativeMcpSignature(cwd);
    this.capabilitySnapshot = undefined;
    this.input = new InputQueue();
    this.abort = new AbortController();
    const abortController = this.abort;
    this.live = true;
    this.lastInputTokens = null;
    this.nativeError = undefined;
    this.contextSource = "unavailable";
    this.input.send(prompt, resumeId);
    const source = {
      cwd,
      model,
      maxTurns,
      pathToClaudeCodeExecutable: config.executable,
      env: config.env,
      tools: { type: "preset" as const, preset: "claude_code" as const },
      persistSession: true,
      includePartialMessages: true,
      strictMcpConfig: false,
      // Explicit inheritance: the worker runs under the user's own Claude Code configuration.
      // The claude_code system prompt preset does NOT imply filesystem settings, and `project` is
      // what makes CLAUDE.md (user/project/local memory files) load. Passing this explicitly keeps
      // the worker from silently falling back to SDK isolation if build-options is reused with a
      // different source later.
      settingSources: [...DEFAULT_SETTING_SOURCES],
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
        append:
          "You execute the assigned task for Codex. Use your native configured tools, hooks and permissions normally, including subagents and your own validation as useful. Codex independently accepts the final work. Report changed paths, checks, important findings and blockers concisely without omitting acceptance-relevant information. Use codex_supervisor notify_supervisor for meaningful milestones and ask_supervisor for design decisions needed from Codex; native AskUserQuestion is also forwarded to Codex and its answer returned to you. An answer is Codex guidance, not human permission or acceptance. If unanswered, report BLOCKED: with the question. Codex schedules up to3 managed top-level sessions; native subagents follow Claude Code policies. Supervisor tools are not necessarily yours; select from your actually available tools. " +
          "Ask early rather than guessing: send a scoped ask_supervisor question as soon as a choice would change what you build or is hard to undo. Separate the three kinds of input explicitly: facts the user stated, decisions Codex actually answered, and research or implementation choices you are free to make yourself (use judgement there and proceed). Never present your own inference or a design you favour as a user approval, Codex decision or existing requirement, and never fabricate a user authorisation for destructive, outward-facing or scope-expanding work. If the task text and Codex guidance disagree, follow the newest scoped guidance and say so in your report. Guidance Codex queues while you work arrives as a new user turn after your current one; treat it as scope guidance for the same task, not a new task, and keep the original contract, checks and acceptance intact.",
      },
    };
    if (resumeId)
      this.manager.create(
        toSessionCreateParams({
          sessionId: resumeId,
          source,
          permissionMode: permission.mode,
          abortController: this.abort,
        })
      );
    const shared = {
      prompt,
      messageInput: this.input,
      abortController: this.abort,
      options: {
        ...buildOptions(source),
        permissionMode: permission.mode,
        allowDangerouslySkipPermissions: permission.mode === "bypassPermissions",
        spawnClaudeCodeProcess: processSpawner(this.processStoppers, this.workerName),
        mcpServers: { codex_supervisor: mailbox.createServer() },
      },
      nativeToolHandling: true,
      handleUserQuestion: (input: Record<string, unknown>, signal: AbortSignal) =>
        askCodex(mailbox, input, signal),
      permissionRequestTimeoutMs: decisionTimeoutMs(),
      sessionInitTimeoutMs: startupTimeoutMs(),
      sessionManager: this.manager,
      onInit: (init: SDKSystemMessage) => {
        this.capabilitySnapshot = capabilitiesFromInit(init);
        this.currentId = init.session_id;
        if (!this.manager.get(init.session_id))
          this.manager.create(
            toSessionCreateParams({
              sessionId: init.session_id,
              source,
              permissionMode: permission.mode,
              abortController,
            })
          );
      },
    };
    const handle = consumeQuery(
      resumeId
        ? { ...shared, mode: "disk-resume", sessionId: resumeId, waitForInitSessionId: true }
        : { ...shared, mode: "start" }
    );
    this.handle = handle;
    void handle.done
      .finally(() => {
        if (this.handle === handle) this.live = false;
      })
      .catch(() => {});
    try {
      return await raceWithAbort(handle.sdkSessionIdPromise, signal, () => handle.close());
    } catch (error) {
      this.stop(resumeId);
      throw error;
    }
  }

  async reply(sessionId: string, prompt: string, maxTurns?: number, signal?: AbortSignal) {
    const info = this.manager.get(sessionId);
    if (!info) throw new Error("SESSION_RUNTIME_MISSING");
    if (signal?.aborted) throw new Error("DISPATCH_CANCELLED");
    const limit = maxTurns ?? info.maxTurns ?? DEFAULT_SEGMENT_TURNS;
    if (
      !this.live ||
      !this.input ||
      limit !== info.maxTurns ||
      this.configurationSignature !== nativeMcpSignature(info.cwd)
    ) {
      const cwd = info.cwd;
      this.stop(sessionId);
      return await this.start(cwd, prompt, limit, signal, sessionId);
    }
    if (!this.manager.tryAcquire(sessionId, info.status, this.abort!))
      throw new Error("SESSION_BUSY");
    this.generation++;
    this.eventFloor = this.manager.getLastEventId(sessionId) ?? -1;
    this.mailbox?.reset("Next supervised task attempt");
    this.hydrated.clear();
    this.lastInputTokens = null;
    this.nativeError = undefined;
    this.contextSource = "unavailable";
    this.input.send(prompt, sessionId);
    return sessionId;
  }
  eventEpoch(_sessionId: string) {
    return this.generation;
  }
  async replay(sessionId: string) {
    const generation = this.generation;
    const events = this.manager
      .readEvents(sessionId)
      .events.filter((event) => event.id > this.eventFloor);
    for (const event of events) await this.enrich(sessionId, event, generation);
    return generation === this.generation ? events : [];
  }
  result(sessionId: string) {
    const result = this.manager.getResult(sessionId)?.result;
    return result && this.nativeError && !result.isError
      ? { ...result, isError: true, errorSubtype: this.nativeError }
      : result;
  }
  permissions(sessionId: string) {
    return this.manager.listPendingPermissions(sessionId);
  }
  model(sessionId: string) {
    return this.manager.get(sessionId)?.model;
  }
  capabilities(sessionId: string) {
    return this.currentId === sessionId ? this.capabilitySnapshot : undefined;
  }
  async refreshCapabilities(sessionId: string) {
    const snapshot = this.capabilities(sessionId);
    if (!snapshot || !this.handle?.mcpServerStatus) return snapshot;
    const generation = this.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const servers = await Promise.race([
        this.handle.mcpServerStatus(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("CAPABILITY_TIMEOUT")), 3000);
        }),
      ]);
      if (generation === this.generation && this.currentId === sessionId)
        this.capabilitySnapshot = capabilitiesFromStatus(snapshot, servers);
    } catch {
      if (generation === this.generation)
        this.capabilitySnapshot = { ...snapshot, statusRefresh: "unavailable" };
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.capabilities(sessionId);
  }
  isLive(sessionId: string) {
    return this.live && this.currentId === sessionId;
  }
  maintenanceComplete(sessionId: string) {
    this.manager.update(sessionId, { status: "idle" });
  }
  context(sessionId: string): ContextInfo {
    const primary = this.model(sessionId) ?? "";
    const usage = this.result(sessionId)?.modelUsage?.[primary] as
      | { contextWindow?: number }
      | undefined;
    const contextWindow =
      usage?.contextWindow || (this.model(sessionId)?.includes("[1m]") ? 1000000 : null);
    return {
      inputTokens: this.lastInputTokens,
      source: this.contextSource,
      contextWindow,
      softLimit: Math.min(300000, contextWindow ? Math.floor(contextWindow * 0.75) : 300000),
      hardLimit: Math.min(400000, contextWindow ? Math.floor(contextWindow * 0.9) : 400000),
    };
  }
  respond(sessionId: string, requestId: string, allow: boolean) {
    return this.manager.finishRequest(
      sessionId,
      requestId,
      allow
        ? { behavior: "allow" }
        : { behavior: "deny", message: "Supervisor denied permission", interrupt: false },
      "respond"
    );
  }
  stop(sessionId?: string) {
    if (sessionId && this.currentId && sessionId !== this.currentId) {
      this.manager.delete(sessionId);
      return;
    }
    this.generation++;
    let errors = 0;
    this.interruptBarrier = undefined;
    try {
      this.mailbox?.close("Worker stopped");
      this.input?.close();
      this.handle?.close();
      if (sessionId) {
        this.manager.cancel(sessionId, { source: "orchestrator" });
        this.manager.delete(sessionId);
      }
    } catch {
      errors++;
    } finally {
      this.live = false;
      for (const stop of [...this.processStoppers]) {
        try {
          stop();
        } catch {
          errors++;
        }
      }
      this.processStoppers.clear();
      this.currentId = undefined;
    }
    if (errors) console.error(`Worker cleanup completed with ${errors} resource errors`);
  }
  /**
   * Issue the native interrupt control request only. The conversation, its input stream and the
   * supervisor mailbox stay alive so the drained turn can be followed by scoped guidance.
   */
  interruptTurn(sessionId: string): boolean | Promise<boolean> {
    if (sessionId !== this.currentId || !this.handle || !this.live) return false;
    // A pending question belongs to the abandoned tool call and must not stay claimable.
    const generation = this.generation;
    const mailbox = this.mailbox;
    const release = () => {
      if (generation === this.generation)
        mailbox?.interruptPending("Turn interrupted for new guidance");
    };
    if (!this.handle.interruptAsync) {
      return false;
    }
    const previous = this.interruptBarrier;
    const request = this.handle.interruptAsync().catch(() => false);
    const barrier = Promise.all(previous ? [previous, request] : [request]).then((answers) => {
      const accepted = answers.every(Boolean);
      if (accepted) release();
      return accepted;
    });
    this.interruptBarrier = barrier;
    void barrier.then(() => {
      if (this.interruptBarrier === barrier) this.interruptBarrier = undefined;
    });
    return barrier;
  }

  /**
   * Start one follow-on native turn in the same saved conversation. Reuses the existing reply
   * lifecycle so the manager status, native error and context are armed exactly like a normal
   * segment; when the reduced grant differs from the live startup cap the SDK requires a cold
   * resume of the SAME session id rather than silently keeping the larger cap.
   */
  async guidance(sessionId: string, text: string, maxTurns?: number): Promise<boolean> {
    const generation = this.generation;
    // A naturally completed turn can race the native control acknowledgement. Drain all old
    // controls before sending new input so a late interrupt cannot cancel the follow-on turn.
    while (this.interruptBarrier) {
      const barrier = this.interruptBarrier;
      if (!(await barrier)) return false;
      if (this.interruptBarrier === barrier) {
        this.interruptBarrier = undefined;
        break;
      }
    }
    if (generation !== this.generation) return false;
    const info = this.manager.get(sessionId);
    if (!info || sessionId !== this.currentId || !this.live) return false;
    // A turn that is still running cannot accept a follow-on input.
    if (info.status === "running" || info.status === "waiting_permission") return false;
    try {
      await this.reply(sessionId, text, maxTurns);
      return true;
    } catch {
      return false;
    }
  }

  async interrupt(sessionId: string, timeoutMs = 3000) {
    if (sessionId !== this.currentId || !this.handle) return;
    const started = this.manager.getLastEventId(sessionId) ?? -1;
    // Subscribe before requesting interruption so an immediate native result is retained.
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const off = this.manager.subscribe((id, event) => {
        if (
          id === sessionId &&
          event &&
          event.id > started &&
          ["result", "error"].includes(event.type)
        )
          finish();
      });
      const timer = setTimeout(finish, timeoutMs);
      this.handle!.interrupt();
    });
  }
  destroy() {
    try {
      this.stop();
    } finally {
      this.manager.destroy();
    }
  }
}
