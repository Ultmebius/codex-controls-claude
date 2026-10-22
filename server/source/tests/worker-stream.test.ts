import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeWorker } from "../src/orchestrator/worker.js";
import { Orchestrator, type Run } from "../src/orchestrator/controller.js";
import { InputQueue } from "../src/orchestrator/input-queue.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getSessionMessages: vi.fn(),
  model: "arbitrary-provider-model[1m]",
  mcpServerStatus: vi.fn(),
  signature: vi.fn(),
  permissionMode: "default" as import("@anthropic-ai/claude-agent-sdk").PermissionMode,
}));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: mocks.query,
  getSessionMessages: mocks.getSessionMessages,
  AbortError: class AbortError extends Error {},
}));
vi.mock("../src/orchestrator/runtime.js", async (original) => ({
  ...(await original<typeof import("../src/orchestrator/runtime.js")>()),
  localConfig: () => ({
    executable: "fake-claude",
    endpoint: "http://localhost",
    env: { ANTHROPIC_MODEL: mocks.model },
    model: mocks.model,
  }),
  permissionSettings: () => ({ mode: mocks.permissionMode, source: "fixture" }),
}));
vi.mock("../src/orchestrator/capabilities.js", async (original) => ({
  ...(await original<typeof import("../src/orchestrator/capabilities.js")>()),
  nativeMcpSignature: mocks.signature,
}));
let worker: ClaudeWorker;
let cwd: string;
let releaseHold: (() => void) | undefined;
beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), "ccc-stream-"));
  worker = new ClaudeWorker();
  releaseHold = undefined;
  mocks.query.mockReset();
  mocks.permissionMode = "default";
  mocks.signature.mockReset().mockReturnValue("same-config");
  mocks.mcpServerStatus.mockReset().mockResolvedValue([
    {
      name: "ctx",
      status: "connected",
      tools: [{ name: "execute" }],
      config: {
        type: "http",
        url: "https://private",
        headers: { Authorization: "private-token" },
      },
    },
  ]);
  mocks.getSessionMessages.mockReset().mockResolvedValue([]);
  mocks.query.mockImplementation(
    ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Partial<Options> }) => {
      const sessionId = options.resume ?? "live-session";
      return Object.assign(
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: sessionId,
            model: mocks.model,
            tools: ["Read", "Write", "Bash"],
            mcp_servers: [{ name: "ctx", status: "pending" }],
            permissionMode: "default",
          };
          let cumulativeCost = 0;
          for await (const message of prompt) {
            if (options.abortController?.signal.aborted) break;
            if (message.message.content === "fail before output")
              throw new Error("stream failed before second output");
            if (message.message.content === "eof before output") break;
            // Holds one turn open so a native question can arrive while the task is active.
            if (String(message.message.content).includes("hold stream then ask"))
              await new Promise<void>((resolve) => {
                releaseHold = resolve;
              });
            yield {
              type: "assistant",
              session_id: sessionId,
              error: message.message.content === "native rate error" ? "rate_limit" : undefined,
              message: {
                content: [{ type: "text", text: message.message.content }],
                usage:
                  message.message.content === "no usage"
                    ? undefined
                    : { input_tokens: 1000, cache_read_input_tokens: 20000 },
              },
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: sessionId,
              result: "done",
              duration_ms: 1,
              num_turns: 1,
              total_cost_usd: ++cumulativeCost,
              modelUsage: { [mocks.model]: { contextWindow: 1000000 } },
            };
            yield { type: "prompt_suggestion", session_id: sessionId, suggestion: "next?" };
          }
        })(),
        { close() {}, interrupt() {}, mcpServerStatus: mocks.mcpServerStatus }
      );
    }
  );
});
afterEach(() => {
  worker.destroy();
  rmSync(cwd, { recursive: true, force: true });
});
function nextResult() {
  return new Promise<void>((resolve) => {
    const unsubscribe = worker.subscribe(({ event }) => {
      if (event?.type === "result") {
        unsubscribe();
        resolve();
      }
    });
  });
}
describe("persistent SDK streaming", () => {
  it("classifies native API errors despite a success-shaped final envelope and clears them on reply", async () => {
    const failed = nextResult();
    const id = await worker.start(cwd, "native rate error", 40);
    await failed;
    expect(worker.result(id)?.isError).toBe(true);
    expect(worker.result(id)?.errorSubtype).toBe("rate_limit");
    const resumed = nextResult();
    await worker.reply(id, "valid response", 40);
    await resumed;
    expect(worker.result(id)?.isError).toBe(false);
  });
  it.each(["default", "auto", "bypassPermissions"] as const)(
    "passes native %s without forced default or disabled hooks",
    async (mode) => {
      mocks.permissionMode = mode;
      await worker.start(cwd, "first", 40);
      const options = mocks.query.mock.calls[0][0].options;
      expect(options.permissionMode).toBe(mode);
      expect(options.allowDangerouslySkipPermissions).toBe(mode === "bypassPermissions");
      expect(options.settings).toBeUndefined();
      expect(options.includePartialMessages).toBe(true);
      expect(options.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE).toBeUndefined();
      expect(options.env.ANTHROPIC_MODEL).toBe(mocks.model);
      expect(options.hooks).toBeUndefined();
      expect(options.settingSources).toEqual(["user", "project", "local"]);
    }
  );
  it("inherits native CLAUDE.md and never suppresses it", async () => {
    await worker.start(cwd, "first", 40);
    const options = mocks.query.mock.calls[0][0].options;
    // Native preservation: the claude_code preset alone does NOT load filesystem settings, so the
    // user/project/local sources must be present for CLAUDE.md (all three memory scopes) to load.
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.settingSources).toContain("project");
    expect(options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(typeof (options.systemPrompt as { append?: string }).append).toBe("string");
    // No suppression path may be injected: neither the documented disable switch nor CLI bare mode.
    const env = options.env as Record<string, string | undefined>;
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBeUndefined();
    expect(env.CLAUDE_CODE_SIMPLE).toBeUndefined();
    expect(options.args ?? []).not.toContain("--bare");
    // A fresh worker (new segment or reply after close) keeps the same inheritance.
    const second = new ClaudeWorker();
    try {
      await second.start(cwd, "second", 60);
      expect(mocks.query.mock.calls[1][0].options.settingSources).toEqual([
        "user",
        "project",
        "local",
      ]);
    } finally {
      second.destroy();
    }
  });
  it("uses scope only for ledger ownership and adds no tool hook gates", async () => {
    worker.setWriteScope(cwd, ["owned.txt", "module"]);
    await worker.start(cwd, "first", 40);
    const options = mocks.query.mock.calls[0][0].options;
    expect(options.hooks).toBeUndefined();
    expect(options.settings).toBeUndefined();
    expect(options.disallowedTools).toBeUndefined();
    expect(worker.permitsArtifact(cwd, "owned.txt")).toBe(true);
    expect(worker.permitsArtifact(cwd, "other.txt")).toBe(false);
  });
  it("does not launch a query after interruption while the previous query drains", async () => {
    let drain!: () => void;
    const drained = new Promise<void>((resolve) => {
      drain = resolve;
    });
    mocks.query.mockImplementationOnce(() =>
      Object.assign(
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "draining",
            model: mocks.model,
            tools: [],
            mcp_servers: [],
            permissionMode: "default",
          };
          await drained;
        })(),
        { close() {}, interrupt() {} }
      )
    );
    const id = await worker.start(cwd, "first", 2);
    worker.stop(id);
    const pending = worker.start(cwd, "second", 40, undefined, id);
    worker.stop(id);
    drain();
    await expect(pending).rejects.toThrow("STARTUP_CANCELLED");
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("settles controller results when a same-ID cold resume resets event IDs", async () => {
    const controller = new Orchestrator(path.join(cwd, "ledger"), worker);
    try {
      writeFileSync(path.join(cwd, "answer.txt"), "42");
      const run = controller.plan({
        action: "create",
        cwd,
        goal: "goal",
        design: "design",
        tasks: [
          {
            id: "a",
            title: "first",
            instructions: "inspect",
            acceptance: "review",
            artifacts: ["answer.txt"],
            dependsOn: [],
            checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
          },
        ],
      });
      await controller.dispatch(run.id, "a", "first", undefined, { maxTurns: 2 });
      await vi.waitFor(() => expect(run.tasks[0].state).toBe("awaiting_review"));
      await controller.review({
        runId: run.id,
        taskId: "a",
        taskRevision: 1,
        artifactHash: run.tasks[0].artifactHash!,
        decision: "reject",
        evidence: "needs revision",
      });
      await controller.dispatch(run.id, "a", "second", undefined, { maxTurns: 40 });
      await vi.waitFor(() => expect(run.tasks[0].state).toBe("awaiting_review"));
      expect(run.turnBudget.reserved).toBe(0);
      expect(run.turnBudget.used).toBe(2);
      expect(mocks.query.mock.calls[1][0].options.resume).toBe(run.sessionId);
    } finally {
      controller.close();
    }
  });

  it("inherits native built-ins/MCP and sanitizes actual server status", async () => {
    const done = nextResult();
    const id = await worker.start(cwd, "first", 40);
    await done;
    const options = mocks.query.mock.calls[0][0].options;
    expect(options.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(options.strictMcpConfig).toBe(false);
    expect(Object.keys(options.mcpServers)).toEqual(["codex_supervisor"]);
    expect(options.mcpServers.codex_supervisor.type).toBe("sdk");
    expect(worker.capabilities(id)?.mcpServers[0].status).toBe("pending");
    const actual = await worker.refreshCapabilities(id);
    expect(actual?.mcpServers[0]).toMatchObject({ name: "ctx", status: "connected", toolCount: 1 });
    expect(JSON.stringify(actual)).not.toMatch(/private-token|https:\/\/private|Authorization/);
  });
  it("resumes the same conversation with a changed native segment cap", async () => {
    let done = nextResult();
    const id = await worker.start(cwd, "first", 2);
    await done;
    done = nextResult();
    await worker.reply(id, "second", 40);
    await done;
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[1][0].options).toMatchObject({ resume: id, maxTurns: 40 });
  });
  it("reloads changed native MCP settings only at the next task boundary", async () => {
    let done = nextResult();
    const id = await worker.start(cwd, "first", 40);
    await done;
    mocks.signature.mockReturnValue("changed-config");
    done = nextResult();
    await worker.reply(id, "second", 40);
    await done;
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[1][0].options.resume).toBe(id);
  });
  it("does not add cumulative native query costs a second time", async () => {
    let done = nextResult();
    const id = await worker.start(cwd, "first", 40);
    await done;
    done = nextResult();
    await worker.reply(id, "second", 40);
    await done;
    expect(worker.result(id)?.totalCostUsd).toBe(2);
    expect(worker.result(id)?.sessionTotalCostUsd).toBe(2);
  });

  it("does not let an old transcript lookup block a new generation", async () => {
    let release!: (value: unknown[]) => void;
    mocks.getSessionMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const listener = vi.fn();
    const off = worker.subscribe(listener);
    try {
      const id = await worker.start(cwd, "no usage", 12);
      await vi.waitFor(() => expect(mocks.getSessionMessages).toHaveBeenCalledTimes(1));
      worker.stop(id);
      await worker.start(cwd, "new stream usage", 12);
      await vi.waitFor(() =>
        expect(listener.mock.calls.some(([value]) => value.event?.type === "result")).toBe(true)
      );
      expect(worker.context(id)).toMatchObject({ inputTokens: 21000, source: "stream" });
    } finally {
      release([]);
      off();
    }
  });

  it("delivers a delayed terminal before trailing progress through the real controller", async () => {
    let release!: (value: unknown[]) => void;
    mocks.getSessionMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    writeFileSync(path.join(cwd, "answer.txt"), "42");
    const controller = new Orchestrator(path.join(cwd, "ledger"), worker);
    try {
      const run = controller.plan({
        action: "create",
        cwd,
        goal: "no usage",
        design: "one task",
        tasks: [
          {
            id: "a",
            title: "no usage",
            instructions: "no usage",
            dependsOn: [],
            acceptance: "42",
            artifacts: ["answer.txt"],
            checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
          },
        ],
      });
      // All prompts in this test omit stream usage, matching the native CLI path.
      const original = mocks.query.getMockImplementation()!;
      mocks.query.mockImplementation((args) =>
        original({
          ...args,
          prompt: (async function* () {
            for await (const msg of args.prompt)
              yield { ...msg, message: { ...msg.message, content: "no usage" } };
          })(),
        })
      );
      const dispatch = controller.dispatch(run.id, "a", "request");
      await vi.waitFor(() => expect(mocks.getSessionMessages).toHaveBeenCalledTimes(1));
      release([{ type: "assistant", message: { usage: { input_tokens: 12345 } } }]);
      await dispatch;
      const result = await controller.wait(run.id, 0, 1000);
      expect(result.events.some((event) => event.type === "worker_finished")).toBe(true);
      expect(run.tasks[0].state).toBe("awaiting_review");
      expect(run.lastContext?.inputTokens).toBe(12345);
    } finally {
      controller.close();
    }
  });

  it("honors an arbitrary configured model without rewriting family mappings", async () => {
    const done = nextResult();
    const id = await worker.start(cwd, "first", 12);
    await done;
    expect(mocks.query.mock.calls[0][0].options.model).toBe(mocks.model);
    expect(worker.model(id)).toBe(mocks.model);
    expect(mocks.getSessionMessages).not.toHaveBeenCalled();
  });
  it("reads missing usage once from the SDK transcript at completion", async () => {
    mocks.getSessionMessages.mockResolvedValue([
      {
        type: "assistant",
        message: { usage: { input_tokens: 266, cache_read_input_tokens: 9856 } },
      },
    ]);
    const done = nextResult();
    const id = await worker.start(cwd, "no usage", 12);
    await done;
    await worker.replay(id);
    expect(worker.context(id)).toMatchObject({ inputTokens: 10122, source: "transcript" });
    expect(mocks.getSessionMessages).toHaveBeenCalledTimes(1);
    expect(mocks.getSessionMessages).toHaveBeenCalledWith(id, { dir: cwd });
  });
  it("does not reuse the previous turn usage during a warm replay", async () => {
    let done = nextResult();
    const id = await worker.start(cwd, "first", 12);
    await done;
    done = nextResult();
    await worker.reply(id, "no usage");
    await done;
    await worker.replay(id);
    expect(worker.context(id)).toMatchObject({ inputTokens: null, source: "unavailable" });
    expect(mocks.getSessionMessages).toHaveBeenCalledTimes(1);
  });
  it("reports unavailable usage as unknown instead of zero", async () => {
    const done = nextResult();
    const id = await worker.start(cwd, "no usage", 12);
    await done;
    expect(worker.context(id)).toMatchObject({ inputTokens: null, source: "unavailable" });
  });
  it("does not deliver a stale terminal event after stop during transcript lookup", async () => {
    let release!: (value: unknown[]) => void;
    mocks.getSessionMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const listener = vi.fn();
    const off = worker.subscribe(listener);
    const id = await worker.start(cwd, "no usage", 12);
    await vi.waitFor(() => expect(mocks.getSessionMessages).toHaveBeenCalledTimes(1));
    worker.stop(id);
    release([{ type: "assistant", message: { usage: { input_tokens: 999999 } } }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(listener.mock.calls.some(([value]) => value.event?.type === "result")).toBe(false);
    expect(worker.context(id).inputTokens).toBeNull();
    off();
  });
  it("reports EOF before the first response of a later turn", async () => {
    const first = nextResult();
    const id = await worker.start(cwd, "first", 12);
    await first;
    const failure = new Promise<void>((resolve) => {
      const off = worker.subscribe(({ event }) => {
        if (event?.type === "error") {
          off();
          resolve();
        }
      });
    });
    await worker.reply(id, "eof before output");
    await failure;
    expect(worker.result(id)?.isError).toBe(true);
  });
  it("reports failure before any output of a later turn instead of hiding it as trailing output", async () => {
    const first = nextResult();
    const id = await worker.start(cwd, "first", 12);
    await first;
    const failure = new Promise<void>((resolve) => {
      const off = worker.subscribe(({ event }) => {
        if (event?.type === "error") {
          off();
          resolve();
        }
      });
    });
    await worker.reply(id, "fail before output");
    await failure;
    expect(worker.result(id)?.isError).toBe(true);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
  it("uses one query/process for successive tasks and tracks latest context", async () => {
    let done = nextResult();
    const id = await worker.start(cwd, "first", 12);
    await done;
    done = nextResult();
    expect(await worker.reply(id, "second")).toBe(id);
    await done;
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(worker.context(id).inputTokens).toBe(21000);
    expect(worker.context(id).softLimit).toBe(300000);
    expect(worker.context(id).hardLimit).toBe(400000);
  });
  it("passes a saved session to SDK resume after close", async () => {
    let done = nextResult();
    const id = await worker.start(cwd, "first", 12);
    await done;
    worker.stop(id);
    done = nextResult();
    expect(await worker.start(cwd, "follow up", 12, undefined, id)).toBe(id);
    await done;
    expect(mocks.query.mock.calls[1][0].options.resume).toBe(id);
  });
  it("preserves native residual tool input and adds no workspace or POSIX-path veto", async () => {
    const done = nextResult();
    const id = await worker.start(cwd, "first", 12);
    await done;
    const options = mocks.query.mock.calls[0][0].options;
    expect(options.settings).toBeUndefined();
    expect(options.hooks).toBeUndefined();
    worker.manager.update(id, { status: "running" });
    const input = { file_path: "/g/native-selected-path.txt", content: "x" };
    const pending = options.canUseTool("Write", input, {
      signal: new AbortController().signal,
      toolUseID: "native-ask",
    });
    await vi.waitFor(() => expect(worker.permissions(id)).toHaveLength(1));
    const request = worker.permissions(id)[0];
    expect(request.input).toEqual(input);
    expect(worker.respond(id, request.requestId, true)).toBe(true);
    expect(await pending).toMatchObject({ behavior: "allow", updatedInput: input });
  });
  it.each(["default", "auto", "bypassPermissions"] as const)(
    "routes native questions to the supervisor mailbox in %s mode without a permission record",
    async (mode) => {
      mocks.permissionMode = mode;
      const done = nextResult();
      const id = await worker.start(cwd, "first", 12);
      await done;
      const options = mocks.query.mock.calls[0][0].options;
      const received = new Promise<string>((resolve) => {
        worker.subscribeMessages(({ message }) => {
          expect(JSON.parse(message.text).input).toEqual(input);
          resolve(message.id);
        });
      });
      const input = {
        questions: [
          {
            question: "Keep dashboard?",
            options: [{ label: "Keep" }, { label: "Remove" }],
            multiSelect: false,
          },
        ],
      };
      const pending = options.canUseTool("AskUserQuestion", input, {
        signal: new AbortController().signal,
        toolUseID: "native-question",
      });
      const messageId = await received;
      expect(worker.permissions(id)).toEqual([]);
      expect(
        worker.respondMessage(messageId, JSON.stringify({ answers: { "Keep dashboard?": "Keep" } }))
      ).toBe(true);
      expect(await pending).toEqual({
        behavior: "allow",
        updatedInput: { ...input, answers: { "Keep dashboard?": "Keep" } },
      });
      expect(worker.respondMessage(messageId, "late")).toBe(false);
    }
  );
  it("carries a native question through the supervisor ledger and answers the original tool", async () => {
    const controller = new Orchestrator(path.join(cwd, "ledger"), worker);
    try {
      writeFileSync(path.join(cwd, "answer.txt"), "42");
      const run = controller.plan({
        action: "create",
        cwd,
        goal: "goal",
        design: "design",
        tasks: [
          {
            id: "a",
            title: "question",
            instructions: "hold stream then ask",
            acceptance: "42",
            artifacts: ["answer.txt"],
            dependsOn: [],
            checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
          },
        ],
      });
      // The controller only routes messages for a run with a live active task.
      await controller.dispatch(run.id, "a", "ask", undefined, { maxTurns: 12 });
      const options = mocks.query.mock.calls[0][0].options;
      const questions = [
        {
          question: "Which targets?",
          options: [{ label: "Native" }, { label: "Browser" }],
          multiSelect: true,
        },
      ];
      const cursor = controller.cursor(run.id);
      const waiting = controller.wait(run.id, cursor, 5000);
      const pending = options.canUseTool(
        "AskUserQuestion",
        { questions },
        {
          signal: new AbortController().signal,
          toolUseID: "native-question",
        }
      );
      const event = (await waiting).events.find((item) => item.type === "worker_question");
      expect(event?.data).toMatchObject({ requiresResponse: true, trust: "worker_observation" });
      expect(
        controller.respondMessage(
          run.id,
          (event!.data as { messageId: string }).messageId,
          "Native"
        )
      ).toMatchObject({ delivery: "answered_in_worker_tool" });
      expect(await pending).toEqual({
        behavior: "allow",
        updatedInput: { questions, answers: { "Which targets?": "Native" } },
      });
      // The question never became an ordinary permission record or interrupt.
      expect((controller.status(run.id) as Run).tasks[0].decisions).toMatchObject([
        { kind: "question", state: "answered" },
      ]);
      const stored = controller.status(run.id) as Run;
      expect(stored.events.some((item) => item.type === "permission_required")).toBe(false);
    } finally {
      releaseHold?.();
      controller.close();
    }
  });
  it("rejects a second supervisor reply for an already answered native question", async () => {
    const controller = new Orchestrator(path.join(cwd, "ledger"), worker);
    try {
      writeFileSync(path.join(cwd, "answer.txt"), "42");
      const run = controller.plan({
        action: "create",
        cwd,
        goal: "goal",
        design: "design",
        tasks: [
          {
            id: "a",
            title: "question",
            instructions: "hold stream then ask",
            acceptance: "42",
            artifacts: ["answer.txt"],
            dependsOn: [],
            checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
          },
        ],
      });
      await controller.dispatch(run.id, "a", "ask", undefined, { maxTurns: 12 });
      const options = mocks.query.mock.calls[0][0].options;
      const cursor = controller.cursor(run.id);
      const waiting = controller.wait(run.id, cursor, 5000);
      const pending = options.canUseTool(
        "AskUserQuestion",
        { questions: [{ question: "Proceed?" }] },
        { signal: new AbortController().signal, toolUseID: "native-question" }
      );
      const event = (await waiting).events.find((item) => item.type === "worker_question");
      const messageId = (event!.data as { messageId: string }).messageId;
      controller.respondMessage(run.id, messageId, "Yes");
      expect(await pending).toEqual({
        behavior: "allow",
        updatedInput: { questions: [{ question: "Proceed?" }], answers: { "Proceed?": "Yes" } },
      });
      expect(() => controller.respondMessage(run.id, messageId, "Again")).toThrow(
        "MESSAGE_NOT_PENDING_OR_STALE"
      );
    } finally {
      releaseHold?.();
      controller.close();
    }
  });
});
it("closes a waiting input iterator promptly", async () => {
  const queue = new InputQueue();
  const iterator = queue[Symbol.asyncIterator]();
  const waiting = iterator.next();
  queue.close();
  expect((await waiting).done).toBe(true);
  expect(() => queue.send("late")).toThrow("INPUT_CLOSED");
});

describe("active guidance over the real streaming input", () => {
  const task = () => ({
    id: "a",
    title: "guidance",
    instructions: "hold stream then ask",
    acceptance: "42",
    artifacts: ["answer.txt"],
    dependsOn: [],
    checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
  });
  it("delivers one queued input after the native result, keeping the same SDK conversation", async () => {
    writeFileSync(path.join(cwd, "answer.txt"), "42");
    const controller = new Orchestrator(path.join(cwd, "ledger"), worker);
    try {
      const run = controller.plan({
        action: "create",
        cwd,
        goal: "goal",
        design: "design",
        tasks: [task()],
      });
      await controller.dispatch(run.id, "a", "first", undefined, { maxTurns: 12 });
      const sessionId = (controller.status(run.id) as Run).sessionId!;
      const receipt = controller.sendGuidance(run.id, {
        requestId: "guidance-1",
        mode: "queue",
        text: "stay within the declared scope",
        taskId: "a",
        taskRevision: 1,
        sessionId,
      });
      expect(receipt).toMatchObject({ state: "queued", delivered: false });
      // Releasing the held native turn produces the result boundary that delivers the input.
      releaseHold?.();
      await vi.waitFor(() =>
        expect((controller.status(run.id) as Run).guidance?.[0].state).toBe("delivered")
      );
      const current = controller.status(run.id) as Run;
      // The follow-on used the same native session; no new conversation was started.
      expect(current.sessionId).toBe(sessionId);
      expect(mocks.query).toHaveBeenCalledTimes(1);
      expect(current.tasks[0].state).toBe("awaiting_review");
    } finally {
      releaseHold?.();
      controller.close();
    }
  });
  it("interrupts the current native turn and delivers into the same transcript", async () => {
    writeFileSync(path.join(cwd, "answer.txt"), "42");
    const controller = new Orchestrator(path.join(cwd, "ledger"), worker);
    try {
      const run = controller.plan({
        action: "create",
        cwd,
        goal: "goal",
        design: "design",
        tasks: [task()],
      });
      await controller.dispatch(run.id, "a", "first", undefined, { maxTurns: 12 });
      const sessionId = (controller.status(run.id) as Run).sessionId!;
      let interrupted = false;
      const original = worker.interruptTurn.bind(worker);
      worker.interruptTurn = (id: string) => {
        interrupted = true;
        return original(id);
      };
      const receipt = controller.sendGuidance(run.id, {
        requestId: "redirect-1",
        mode: "interrupt",
        text: "switch to the streaming API",
      });
      expect(receipt.state).toBe("interruption_requested");
      expect(interrupted).toBe(true);
      // The old segment's terminal result drains first; only then is the redirect input sent.
      expect((controller.status(run.id) as Run).guidance?.[0].state).toBe("interruption_requested");
      releaseHold?.();
      await vi.waitFor(() =>
        expect((controller.status(run.id) as Run).guidance?.[0].state).toBe("delivered")
      );
      const current = controller.status(run.id) as Run;
      expect(current.sessionId).toBe(sessionId);
      expect(mocks.query).toHaveBeenCalledTimes(1);
      expect(current.turnBudget.reserved).toBe(0);
    } finally {
      releaseHold?.();
      controller.close();
    }
  });
});

describe("independent queued-turn acceptance regressions", () => {
  const scopedTask = () => ({
    id: "a",
    title: "independent queued turn lifecycle",
    instructions: "hold stream then ask",
    acceptance: "42",
    artifacts: ["answer.txt"],
    dependsOn: [],
    checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
  });

  it("waits for the old native interrupt acknowledgement before starting follow-on input", async () => {
    writeFileSync(path.join(cwd, "answer.txt"), "42");
    const original = mocks.query.getMockImplementation()!;
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    mocks.query.mockImplementation((args) =>
      Object.assign(original(args), { interrupt: () => acknowledgement })
    );
    const controller = new Orchestrator(path.join(cwd, "ledger"), worker);
    try {
      const run = controller.plan({
        action: "create",
        cwd,
        goal: "g",
        design: "d",
        tasks: [scopedTask()],
      });
      await controller.dispatch(run.id, "a", "start");
      await vi.waitFor(() => expect(releaseHold).toBeTypeOf("function"));
      controller.sendGuidance(run.id, {
        requestId: "redirect",
        mode: "interrupt",
        text: "hold stream then ask FOLLOW_UP",
      });
      const first = releaseHold;
      releaseHold = undefined;
      first!();
      await vi.waitFor(() => expect(run.executions).toHaveLength(2));
      expect(releaseHold).toBeUndefined();
      expect(run.guidance![0].state).toBe("delivering");
      acknowledge();
      await vi.waitFor(() => expect(releaseHold).toBeTypeOf("function"));
      expect(worker.manager.get(run.sessionId!)?.status).toBe("running");
    } finally {
      acknowledge();
      releaseHold?.();
      controller.close();
    }
  });

  it("never sends delayed follow-on input after cancellation during a native control wait", async () => {
    writeFileSync(path.join(cwd, "answer.txt"), "42");
    const original = mocks.query.getMockImplementation()!;
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    mocks.query.mockImplementation((args) =>
      Object.assign(original(args), { interrupt: () => acknowledgement })
    );
    const controller = new Orchestrator(path.join(cwd, "ledger"), worker);
    try {
      const run = controller.plan({
        action: "create",
        cwd,
        goal: "g",
        design: "d",
        tasks: [scopedTask()],
      });
      await controller.dispatch(run.id, "a", "start");
      await vi.waitFor(() => expect(releaseHold).toBeTypeOf("function"));
      controller.sendGuidance(run.id, {
        requestId: "redirect",
        mode: "interrupt",
        text: "hold stream then ask FOLLOW_UP",
      });
      const first = releaseHold;
      releaseHold = undefined;
      first!();
      await vi.waitFor(() => expect(run.executions).toHaveLength(2));
      controller.cancel(run.id);
      acknowledge();
      await vi.waitFor(() => expect(worker.isLive(run.sessionId!)).toBe(false));
      expect(releaseHold).toBeUndefined();
      expect(run.guidance![0].state).toBe("cancelled");
      expect(mocks.query).toHaveBeenCalledTimes(1);
    } finally {
      acknowledge();
      releaseHold?.();
      controller.close();
    }
  });

  it("reports a rejected native interrupt control request promptly", async () => {
    writeFileSync(path.join(cwd, "answer.txt"), "42");
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation((args) =>
      Object.assign(original(args), {
        interrupt: async () => {
          throw new Error("native control rejected");
        },
      })
    );
    const controller = new Orchestrator(path.join(cwd, "ledger"), worker);
    try {
      const run = controller.plan({
        action: "create",
        cwd,
        goal: "g",
        design: "d",
        tasks: [scopedTask()],
      });
      await controller.dispatch(run.id, "a", "start");
      await vi.waitFor(() => expect(releaseHold).toBeTypeOf("function"));
      controller.sendGuidance(run.id, {
        requestId: "redirect",
        mode: "interrupt",
        text: "new direction",
      });
      await vi.waitFor(() => expect(run.guidance![0].state).toBe("failed"));
      expect(run.guidance![0].reason).toBe("interrupt_failed");
    } finally {
      releaseHold?.();
      controller.close();
    }
  });

  it("keeps the native session running while a queued turn is still working", async () => {
    writeFileSync(path.join(cwd, "answer.txt"), "42");
    const controller = new Orchestrator(path.join(cwd, "ledger"), worker);
    try {
      const run = controller.plan({
        action: "create",
        cwd,
        goal: "g",
        design: "d",
        tasks: [scopedTask()],
      });
      await controller.dispatch(run.id, "a", "start");
      await vi.waitFor(() => expect(releaseHold).toBeTypeOf("function"));
      controller.sendGuidance(run.id, {
        requestId: "next",
        mode: "queue",
        text: "hold stream then ask FOLLOW_UP",
      });
      const first = releaseHold;
      releaseHold = undefined;
      first!();
      await vi.waitFor(() => expect(releaseHold).toBeTypeOf("function"));
      expect(worker.manager.get(run.sessionId!)?.status).toBe("running");
    } finally {
      releaseHold?.();
      controller.close();
    }
  });

  it("uses the reduced remaining allowance as the actual native follow-on cap", async () => {
    writeFileSync(path.join(cwd, "answer.txt"), "42");
    const controller = new Orchestrator(path.join(cwd, "ledger"), worker);
    try {
      const run = controller.plan({
        action: "create",
        cwd,
        goal: "g",
        design: "d",
        tasks: [scopedTask()],
        maxTurns: 5,
        maxTotalTurns: 3,
      });
      await controller.dispatch(run.id, "a", "start");
      await vi.waitFor(() => expect(releaseHold).toBeTypeOf("function"));
      controller.sendGuidance(run.id, {
        requestId: "next",
        mode: "queue",
        text: "hold stream then ask FOLLOW_UP",
      });
      const first = releaseHold;
      releaseHold = undefined;
      first!();
      await vi.waitFor(() => expect(releaseHold).toBeTypeOf("function"));
      const expectedCap = run.executions!.at(-1)!.effectiveLimit;
      expect(expectedCap).toBe(1);
      const actualCap = mocks.query.mock.calls.at(-1)![0].options.maxTurns;
      expect(actualCap).toBeLessThanOrEqual(expectedCap);
    } finally {
      releaseHold?.();
      controller.close();
    }
  });

  it("settles a queued turn whose native stream ends before any response", async () => {
    writeFileSync(path.join(cwd, "answer.txt"), "42");
    const controller = new Orchestrator(path.join(cwd, "ledger"), worker);
    try {
      const run = controller.plan({
        action: "create",
        cwd,
        goal: "g",
        design: "d",
        tasks: [scopedTask()],
      });
      await controller.dispatch(run.id, "a", "start");
      await vi.waitFor(() => expect(releaseHold).toBeTypeOf("function"));
      controller.sendGuidance(run.id, {
        requestId: "next",
        mode: "queue",
        text: "eof before output",
      });
      releaseHold!();
      await vi.waitFor(() => expect(worker.isLive(run.sessionId!)).toBe(false));
      expect(run.tasks[0].state).toBe("failed");
      expect(run.turnBudget.reserved).toBe(0);
    } finally {
      releaseHold?.();
      controller.close();
    }
  });
});
