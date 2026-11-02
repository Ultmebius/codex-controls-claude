import type { SessionEvent } from "../types.js";
import { sanitizeWorkerName } from "./terminal.js";

/** On-demand public output only. Never includes thinking, prompts or tool arguments. */
export function publicProgress(events: SessionEvent[], afterId: number, secrets: string[] = []) {
  let latestOutput: { at: string; text: string } | undefined;
  let latestTools: { at: string; names: string[] } | undefined;
  const safe = (text: string, limit: number) => {
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
      text = text.split(secret).join("[redacted]");
    return sanitizeWorkerName(text, limit) ?? "";
  };
  for (let i = events.length - 1; i >= 0 && (!latestOutput || !latestTools); i--) {
    const event = events[i];
    if (event.id <= afterId || event.type !== "output") continue;
    if (!event.data || typeof event.data !== "object") continue;
    const data = event.data as {
      type?: string;
      message?: { content?: { type?: string; text?: string; name?: string }[] };
    };
    if (data.type !== "assistant" || !Array.isArray(data.message?.content)) continue;
    const blocks = data.message.content.filter((b) => b && typeof b === "object");
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    if (!latestOutput && text.trim())
      latestOutput = { at: event.timestamp, text: safe(text, 1000) };
    const names = blocks
      .filter((b) => b.type === "tool_use" && typeof b.name === "string")
      .map((b) => safe(b.name!, 100));
    if (!latestTools && names.length) latestTools = { at: event.timestamp, names };
  }
  return { source: "current_native_segment" as const, latestOutput, latestTools };
}
