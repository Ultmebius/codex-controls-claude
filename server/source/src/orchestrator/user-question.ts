import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { SupervisorMailbox } from "./messaging.js";

const INSTRUCTION =
  'Reply with JSON {"answers":{"<exact question text>":"<selected label or free text>"}} for every question. For multi-select, join labels with ", " or send a JSON array of labels. This is Codex guidance; obtain human input when the decision needs user authorization.';

type Question = { question?: unknown; multiSelect?: unknown };
type Parsed = { answers: Record<string, string> } | { error: string };

/**
 * Interpret one supervisor reply. The documented shape is `{"answers":{...}}`, but a single
 * question also accepts plain free text, including text that happens to be valid JSON (a quoted
 * string, number, boolean or null). Arrays are accepted only for multiSelect questions.
 */
function parseAnswers(reply: string, questions: Question[]): Parsed {
  let parsed: unknown;
  let structured = false;
  try {
    parsed = JSON.parse(reply);
    structured = true;
  } catch {
    // Not JSON: a single question treats the whole reply as free text.
  }
  const single = questions.length === 1 ? questions[0] : undefined;
  let values: Record<string, unknown>;
  if (structured && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    // A flat map keyed by the exact question text is accepted directly, including a question
    // whose text is literally "answers". Otherwise the documented `answers` object is unwrapped.
    const flatAnswer = (value: unknown) => typeof value === "string" || Array.isArray(value);
    const flat =
      !Object.hasOwn(record, "answers") ||
      questions.every((question) => flatAnswer(record[question.question as string]));
    const inner = flat ? record : record.answers;
    if (!inner || typeof inner !== "object" || Array.isArray(inner))
      return { error: "Codex answer has no answers object keyed by the exact question text." };
    values = inner as Record<string, unknown>;
  } else if (single && typeof single.question === "string") {
    if (Array.isArray(parsed)) values = { [single.question]: parsed };
    else values = { [single.question]: typeof parsed === "string" ? parsed : reply };
  } else {
    return {
      error: "Codex answer must be a JSON answers object keyed by the exact question text.",
    };
  }
  // Build entries, not assignments: `answers["__proto__"] = value` would hit the prototype
  // setter and silently drop a legitimate question whose exact text is "__proto__".
  const answered: [string, string][] = [];
  const missing: string[] = [];
  for (const question of questions) {
    const key = question.question as string;
    if (!Object.hasOwn(values, key)) {
      missing.push(key);
      continue;
    }
    const value = values[key];
    if (typeof value === "string" && value.trim() !== "") {
      answered.push([key, value]);
      continue;
    }
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      question.multiSelect === true &&
      value.every((item) => typeof item === "string" && item.trim() !== "")
    ) {
      answered.push([key, value.join(", ")]);
      continue;
    }
    missing.push(key);
  }
  return missing.length > 0
    ? { error: `Codex answer is missing a usable value for: ${missing.join(" | ")}.` }
    : { answers: Object.fromEntries(answered) };
}

/** Answer the native interaction with Codex guidance, preserving the original question payload. */
export async function askCodex(
  mailbox: SupervisorMailbox,
  input: Record<string, unknown>,
  signal: AbortSignal
): Promise<PermissionResult> {
  const questions = input.questions;
  const deny = (message: string): PermissionResult => ({
    behavior: "deny",
    message,
    interrupt: false,
  });
  if (
    !Array.isArray(questions) ||
    questions.length === 0 ||
    questions.some((q) => !q || typeof q.question !== "string" || !q.question.trim())
  )
    return deny("AskUserQuestion has no valid questions to forward to Codex.");
  const keys = questions.map((q) => q.question as string);
  if (new Set(keys).size !== keys.length)
    return deny("AskUserQuestion requires distinct question text for each answer.");
  const response = await mailbox.askQuestion(
    JSON.stringify({ source: "AskUserQuestion", instruction: INSTRUCTION, input }),
    signal
  );
  const content = response.content.find((item) => item.type === "text");
  let outcome: Record<string, unknown> = {};
  try {
    const parsed: unknown = content?.type === "text" ? JSON.parse(content.text) : undefined;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      outcome = parsed as Record<string, unknown>;
  } catch {
    // A malformed transport envelope is unanswered, never an inferred answer.
  }
  if (response.isError || outcome.status !== "answered" || typeof outcome.answer !== "string")
    return deny(
      `Codex question unanswered (${
        typeof outcome.error === "string" ? outcome.error : "NO_ANSWER"
      }). Report BLOCKED with the question; do not assume an answer.`
    );
  const parsed = parseAnswers(outcome.answer, questions);
  if ("error" in parsed)
    return deny(`${parsed.error} Report BLOCKED with the unanswered questions.`);
  return {
    behavior: "allow",
    updatedInput: { ...input, answers: parsed.answers },
  };
}
