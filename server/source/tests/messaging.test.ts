import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SupervisorMailbox, type SupervisorMessage } from "../src/orchestrator/messaging.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(timeoutMs = 60000) {
  const mailbox = new SupervisorMailbox(timeoutMs);
  const server = mailbox.createServer();
  const client = new Client({ name: "mailbox-test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  cleanup.push(async () => {
    mailbox.close();
    await client.close();
    await server.instance.close();
  });
  const events: SupervisorMessage[] = [];
  mailbox.subscribe((event) => events.push(event));
  async function call(name: string, args: Record<string, unknown>) {
    const response = await client.callTool({ name, arguments: args });
    const content = response.content as { type: string; text?: string }[];
    const output = content.find((item) => item.type === "text")?.text ?? "{}";
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(output) as Record<string, unknown>;
    } catch {
      value = { error: output };
    }
    return { error: response.isError === true, value };
  }
  function nextMessage() {
    return new Promise<SupervisorMessage>((resolve) => {
      const off = mailbox.subscribe((event) => {
        off();
        resolve(event);
      });
    });
  }
  return { mailbox, server, client, events, call, nextMessage };
}

describe("attempt-scoped supervisor messaging", () => {
  it("creates fresh SDK servers and exposes only bound-identity message inputs", async () => {
    const f = await fixture();
    expect(f.server.name).toBe("codex_supervisor");
    const other = f.mailbox.createServer();
    expect(other.instance).not.toBe(f.server.instance);
    cleanup.push(() => other.instance.close());
    const { tools } = await f.client.listTools();
    expect(tools.map((entry) => entry.name)).toEqual(["notify_supervisor", "ask_supervisor"]);
    for (const entry of tools)
      expect(Object.keys(entry.inputSchema.properties ?? {})).not.toContain("taskId");
  });

  it("acknowledges notifications immediately and deduplicates matching message IDs", async () => {
    const f = await fixture();
    const args = { messageId: "milestone", message: "Implementation complete" };
    const first = await f.call("notify_supervisor", args);
    expect(first).toMatchObject({
      error: false,
      value: { clientMessageId: "milestone", status: "delivered" },
    });
    expect(await f.call("notify_supervisor", args)).toEqual(first);
    expect(f.events).toEqual([{ id: first.value.messageId, kind: "update", text: args.message }]);
    expect((await f.call("notify_supervisor", { ...args, message: "different" })).error).toBe(true);
    expect(f.events).toHaveLength(1);
  });

  it("waits for an answer, shares duplicate questions, and rejects stale replies", async () => {
    const f = await fixture();
    const emitted = f.nextMessage();
    const args = { messageId: "question", question: "Which output format?" };
    const first = f.call("ask_supervisor", args);
    const event = await emitted;
    expect(event).toMatchObject({ kind: "question", text: args.question });
    const duplicate = f.call("ask_supervisor", args);
    expect(f.mailbox.respond("missing", "JSON")).toBe(false);
    expect(f.mailbox.respond(event.id, "JSON")).toBe(true);
    expect(f.mailbox.respond(event.id, "a late answer")).toBe(false);
    expect(await first).toEqual({
      error: false,
      value: {
        messageId: event.id,
        clientMessageId: "question",
        status: "answered",
        answer: "JSON",
      },
    });
    expect(await duplicate).toEqual(await first);
    expect(await f.call("ask_supervisor", args)).toEqual(await first);
    expect(f.events).toHaveLength(1);
    expect(
      (await f.call("notify_supervisor", { messageId: "question", message: args.question })).error
    ).toBe(true);
  });

  it("returns an explicit timeout and retains the idempotent unanswered outcome", async () => {
    const f = await fixture(20);
    vi.useFakeTimers();
    const emitted = f.nextMessage();
    const args = { messageId: "timeout", question: "Need guidance" };
    const pending = f.call("ask_supervisor", args);
    const event = await emitted;
    await vi.advanceTimersByTimeAsync(20);
    const outcome = await pending;
    expect(outcome).toMatchObject({
      error: true,
      value: { messageId: event.id, status: "unanswered", error: "SUPERVISOR_QUESTION_TIMEOUT" },
    });
    expect(f.mailbox.respond(event.id, "late")).toBe(false);
    expect(await f.call("ask_supervisor", args)).toEqual(outcome);
    expect(f.events).toHaveLength(1);
  });

  it("close releases pending questions and prevents further messages or replies", async () => {
    const f = await fixture();
    const emitted = f.nextMessage();
    const pending = f.call("ask_supervisor", { question: "Blocked" });
    const event = await emitted;
    f.mailbox.close("Attempt interrupted");
    f.mailbox.close("second close");
    expect(await pending).toMatchObject({
      error: true,
      value: {
        messageId: event.id,
        status: "unanswered",
        error: "SUPERVISOR_MAILBOX_CLOSED",
        reason: "Attempt interrupted",
      },
    });
    expect(f.mailbox.respond(event.id, "late")).toBe(false);
    expect((await f.call("notify_supervisor", { message: "after close" })).error).toBe(true);
    expect(f.events).toHaveLength(1);
  });

  it("isolates mailboxes and permits synchronous answers from a subscriber", async () => {
    const a = await fixture();
    const b = await fixture();
    let foreignResponse: boolean | undefined;
    const off = a.mailbox.subscribe((event) => {
      if (event.kind === "question") {
        foreignResponse = b.mailbox.respond(event.id, "wrong attempt");
        a.mailbox.respond(event.id, "right attempt");
      }
    });
    expect(
      await a.call("ask_supervisor", { messageId: "only-a", question: "Question" })
    ).toMatchObject({ value: { answer: "right attempt" } });
    off();
    expect(foreignResponse).toBe(false);
    expect(b.events).toHaveLength(0);
  });

  it("resets a hot-reply attempt without letting reused caller keys accept old answers", async () => {
    const f = await fixture();
    const firstEmitted = f.nextMessage();
    const args = { messageId: "same-key", question: "Question" };
    const first = f.call("ask_supervisor", args);
    const previous = await firstEmitted;
    f.mailbox.reset("Next attempt");
    expect(await first).toMatchObject({
      error: true,
      value: { error: "SUPERVISOR_ATTEMPT_RESET" },
    });
    const secondEmitted = f.nextMessage();
    const second = f.call("ask_supervisor", args);
    const current = await secondEmitted;
    expect(current.id).not.toBe(previous.id);
    expect(f.mailbox.respond(previous.id, "stale")).toBe(false);
    expect(f.mailbox.respond(current.id, "current")).toBe(true);
    expect(await second).toMatchObject({ error: false, value: { answer: "current" } });
    f.mailbox.close();
    f.mailbox.reset();
    expect((await f.call("notify_supervisor", { message: "closed permanently" })).error).toBe(true);
  });

  it("limits pending questions without losing accepted message facts", async () => {
    const f = await fixture();
    const pending = [];
    for (let index = 0; index < 16; index++) {
      const emitted = f.nextMessage();
      pending.push(f.call("ask_supervisor", { messageId: `q-${index}`, question: "Question" }));
      await emitted;
    }
    expect(
      await f.call("ask_supervisor", { messageId: "overflow", question: "Question" })
    ).toMatchObject({ error: true, value: { error: "SUPERVISOR_QUESTION_LIMIT" } });
    expect(f.events).toHaveLength(16);
    f.mailbox.close();
    expect((await Promise.all(pending)).every((outcome) => outcome.error)).toBe(true);
  });

  it("bounds the attempt audit without evicting IDs needed for deduplication", async () => {
    const f = await fixture();
    for (let index = 0; index < 128; index++)
      await f.call("notify_supervisor", { messageId: `m-${index}`, message: "milestone" });
    expect(
      await f.call("notify_supervisor", { messageId: "overflow", message: "milestone" })
    ).toMatchObject({ error: true, value: { error: "SUPERVISOR_MESSAGE_LIMIT" } });
    expect(
      (await f.call("notify_supervisor", { messageId: "m-0", message: "milestone" })).error
    ).toBe(false);
    expect(f.events).toHaveLength(128);
  });

  it("rejects oversized or blank text and invalid answers", async () => {
    const f = await fixture();
    expect((await f.call("notify_supervisor", { message: "x".repeat(16001) })).error).toBe(true);
    expect((await f.call("ask_supervisor", { question: " " })).error).toBe(true);
    const emitted = f.nextMessage();
    const pending = f.call("ask_supervisor", { question: "Valid" });
    const event = await emitted;
    expect(f.mailbox.respond(event.id, " ")).toBe(false);
    expect(f.mailbox.respond(event.id, "x".repeat(16001))).toBe(false);
    expect(f.mailbox.respond(event.id, "Valid answer")).toBe(true);
    expect((await pending).error).toBe(false);
  });
});
