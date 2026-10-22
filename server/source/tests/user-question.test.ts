import { afterEach, describe, expect, it, vi } from "vitest";
import { SupervisorMailbox, type SupervisorMessage } from "../src/orchestrator/messaging.js";
import { askCodex } from "../src/orchestrator/user-question.js";

const mailboxes: SupervisorMailbox[] = [];
afterEach(() => {
  mailboxes.splice(0).forEach((mailbox) => mailbox.close());
  vi.useRealTimers();
});
function fixture() {
  const mailbox = new SupervisorMailbox(1000);
  mailboxes.push(mailbox);
  const events: SupervisorMessage[] = [];
  mailbox.subscribe((event) => events.push(event));
  const abort = new AbortController();
  return { mailbox, events, abort };
}
const input = {
  questions: [
    {
      question: "保留界面？",
      header: "界面",
      options: [
        { label: "保留", description: "保留登录入口" },
        { label: "删除", description: "移除界面" },
      ],
      multiSelect: false,
    },
    { question: "哪些组件？", options: [{ label: "CLI" }, { label: "Docker" }], multiSelect: true },
  ],
};
describe("native AskUserQuestion bridge", () => {
  it("preserves all questions/options and returns answers to the original native tool", async () => {
    const f = fixture();
    const pending = askCodex(f.mailbox, input, f.abort.signal);
    expect(f.events).toHaveLength(1);
    expect(f.events[0].kind).toBe("question");
    expect(JSON.parse(f.events[0].text)).toMatchObject({ source: "AskUserQuestion", input });
    const answers = { "保留界面？": "保留", "哪些组件？": "CLI, Docker" };
    expect(f.mailbox.respond(f.events[0].id, JSON.stringify({ answers }))).toBe(true);
    expect(await pending).toEqual({ behavior: "allow", updatedInput: { ...input, answers } });
    expect(input).not.toHaveProperty("answers");
  });
  it("accepts free text for one question", async () => {
    const f = fixture();
    const single = { questions: [input.questions[0]] };
    const pending = askCodex(f.mailbox, single, f.abort.signal);
    f.mailbox.respond(f.events[0].id, "只保留面板登录");
    expect(await pending).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "保留界面？": "只保留面板登录" } },
    });
  });
  // A one-question reply is free text even when that text is itself valid JSON; JSON.parse
  // returning a primitive must never turn a real answer into "unparseable" or an object.
  it.each([
    ["42", "42"],
    ["true", "true"],
    ["null", "null"],
  ])("keeps JSON primitive free text %s for one question", async (reply, expected) => {
    const f = fixture();
    const pending = askCodex(f.mailbox, { questions: [input.questions[0]] }, f.abort.signal);
    f.mailbox.respond(f.events[0].id, reply);
    expect(await pending).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "保留界面？": expected } },
    });
  });
  it("keeps a quoted JSON string as free text without the quotes", async () => {
    const f = fixture();
    const pending = askCodex(f.mailbox, { questions: [input.questions[0]] }, f.abort.signal);
    f.mailbox.respond(f.events[0].id, '"保留登录"');
    expect(await pending).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "保留界面？": "保留登录" } },
    });
  });
  it("joins a structured multiSelect array with the native comma separator", async () => {
    const f = fixture();
    const pending = askCodex(f.mailbox, input, f.abort.signal);
    f.mailbox.respond(
      f.events[0].id,
      JSON.stringify({ answers: { "保留界面？": "保留", "哪些组件？": ["CLI", "Docker"] } })
    );
    expect(await pending).toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: { "保留界面？": "保留", "哪些组件？": "CLI, Docker" },
      },
    });
  });
  it.each([
    ["flat map keyed by question text", input, { "保留界面？": "保留", "哪些组件？": "CLI" }],
    [
      "question text literally named answers",
      { questions: [{ question: "answers", multiSelect: false }] },
      { answers: "flat" },
    ],
  ])("accepts a %s without requiring the wrapper", async (_name, questions, answers) => {
    const f = fixture();
    const pending = askCodex(f.mailbox, questions, f.abort.signal);
    f.mailbox.respond(f.events[0].id, JSON.stringify(answers));
    expect(await pending).toEqual({
      behavior: "allow",
      updatedInput: { ...questions, answers },
    });
  });
  it("keeps a question whose exact text is __proto__ as an own answer key", async () => {
    const f = fixture();
    const questions = { questions: [{ question: "__proto__", multiSelect: false }] };
    const pending = askCodex(f.mailbox, questions, f.abort.signal);
    // A literal string: `{ __proto__: "literal" }` in a test object literal sets the prototype
    // instead of creating a key, which is exactly the bug under test.
    f.mailbox.respond(f.events[0].id, '{"answers":{"__proto__":"literal"}}');
    const result = await pending;
    expect(result).toMatchObject({ behavior: "allow" });
    const answers = (result as unknown as { updatedInput: { answers: Record<string, string> } })
      .updatedInput.answers;
    expect(Object.hasOwn(answers, "__proto__")).toBe(true);
    expect(Object.keys(answers)).toEqual(["__proto__"]);
    expect(answers["__proto__"]).toBe("literal");
    // The prototype itself must not have been mutated into the answer object.
    expect(Object.getPrototypeOf(answers)).toBe(Object.prototype);
  });
  it("rejects an array for a single-select question and non-string array items", async () => {
    const f = fixture();
    const pending = askCodex(f.mailbox, input, f.abort.signal);
    f.mailbox.respond(
      f.events[0].id,
      JSON.stringify({ answers: { "保留界面？": ["保留"], "哪些组件？": ["CLI", 2] } })
    );
    expect(await pending).toMatchObject({ behavior: "deny", interrupt: false });
  });
  it("treats an undecodable transport envelope as unanswered", async () => {
    const f = fixture();
    const pending = askCodex(f.mailbox, input, f.abort.signal);
    f.mailbox.respond(f.events[0].id, "not-json-envelope");
    expect(await pending).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("unanswered"),
    });
  });
  it("names the unanswered questions instead of inventing values", async () => {
    const f = fixture();
    const pending = askCodex(f.mailbox, input, f.abort.signal);
    f.mailbox.respond(f.events[0].id, JSON.stringify({ answers: { "保留界面？": "保留" } }));
    const result = await pending;
    expect(result).toMatchObject({ behavior: "deny" });
    expect((result as { message: string }).message).toContain("哪些组件？");
    expect((result as { message: string }).message).not.toContain("保留界面？");
  });
  it.each([
    "yes",
    '{"answers":{"保留界面？":"保留"}}',
    '{"answers":{"保留界面？":"保留","哪些组件？":""}}',
  ])("rejects incomplete multi-question answers: %s", async (answer) => {
    const f = fixture();
    const pending = askCodex(f.mailbox, input, f.abort.signal);
    f.mailbox.respond(f.events[0].id, answer);
    expect(await pending).toMatchObject({ behavior: "deny", interrupt: false });
  });
  it.each(["timeout", "abort", "reset", "close"])(
    "settles %s without inventing an answer or accepting a stale reply",
    async (action) => {
      vi.useFakeTimers();
      const f = fixture();
      const pending = askCodex(f.mailbox, input, f.abort.signal);
      const id = f.events[0].id;
      if (action === "timeout") await vi.advanceTimersByTimeAsync(1000);
      if (action === "abort") f.abort.abort();
      if (action === "reset") f.mailbox.reset();
      if (action === "close") f.mailbox.close();
      expect(await pending).toMatchObject({
        behavior: "deny",
        message: expect.stringContaining("unanswered"),
      });
      expect(f.mailbox.respond(id, "late")).toBe(false);
    }
  );
  it("does not publish a pre-cancelled question", async () => {
    const f = fixture();
    f.abort.abort();
    expect(await askCodex(f.mailbox, input, f.abort.signal)).toMatchObject({ behavior: "deny" });
    expect(f.events).toEqual([]);
  });
  it.each([
    { questions: [] },
    { questions: [{ question: "" }] },
    { questions: [input.questions[0], input.questions[0]] },
  ])("rejects unusable question keys without publishing", async (value) => {
    const f = fixture();
    expect(await askCodex(f.mailbox, value, f.abort.signal)).toMatchObject({ behavior: "deny" });
    expect(f.events).toEqual([]);
  });
});
