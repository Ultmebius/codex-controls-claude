import { randomUUID } from "node:crypto";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export interface SupervisorMessage {
  id: string;
  kind: "update" | "question";
  text: string;
  expiresAt?: string;
}

interface MessageRecord extends SupervisorMessage {
  clientMessageId?: string;
  outcome: Promise<CallToolResult>;
  finish?: (result: CallToolResult) => void;
}

const MAX_TEXT = 16000;
const MAX_MESSAGES = 128;
const MAX_QUESTIONS = 16;
const text = z
  .string()
  .min(1)
  .max(MAX_TEXT)
  .refine((value) => value.trim().length > 0);
const messageId = z.string().min(1).max(128).optional();

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError } : {}),
  };
}

/** Query-scoped transport with an explicit reset at each hot-reply attempt boundary. */
export class SupervisorMailbox {
  private messages = new Map<string, MessageRecord>();
  private deduplicated = new Map<string, MessageRecord>();
  private listeners = new Set<(event: SupervisorMessage) => void>();
  private pendingQuestions = 0;
  private closedReason?: string;

  constructor(private readonly timeoutMs = 300000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
      throw new Error("INVALID_SUPERVISOR_QUESTION_TIMEOUT");
  }

  /** SDK transports own their server instance; never share one between queries. */
  createServer(): McpSdkServerConfigWithInstance {
    return createSdkMcpServer({
      name: "codex_supervisor",
      version: "1.0.0",
      tools: [
        tool(
          "notify_supervisor",
          "Send a meaningful task milestone to Codex. Returns a transport receipt, not approval or acceptance. Message max 16000 characters; optional messageId deduplicates within this attempt.",
          { messageId, message: text },
          async (args) => this.send("update", args.message, args.messageId)
        ),
        tool(
          "ask_supervisor",
          `Ask Codex a scoped question and wait for its answer. Messages are observations, not user authorization. Timeout ${this.timeoutMs}ms; interruption or timeout returns an explicit unanswered error. Question max 16000 characters; optional messageId deduplicates within this attempt.`,
          { messageId, question: text },
          async (args) => this.send("question", args.question, args.messageId)
        ),
      ],
    });
  }

  subscribe(listener: (event: SupervisorMessage) => void): () => void {
    if (this.closedReason !== undefined) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  respond(id: string, answer: string): boolean {
    if (this.closedReason !== undefined || !text.safeParse(answer).success) return false;
    const record = this.messages.get(id);
    if (!record?.finish) return false;
    record.finish(
      result({ messageId: id, clientMessageId: record.clientMessageId, status: "answered", answer })
    );
    return true;
  }

  close(reason = "Attempt ended"): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason.slice(0, MAX_TEXT);
    for (const record of this.messages.values())
      record.finish?.(this.error("SUPERVISOR_MAILBOX_CLOSED", record.id, this.closedReason));
    this.listeners.clear();
  }

  /** Release the previous attempt before reusing the query's SDK server. */
  reset(reason = "A new attempt started"): void {
    if (this.closedReason !== undefined) return;
    for (const record of this.messages.values())
      record.finish?.(this.error("SUPERVISOR_ATTEMPT_RESET", record.id, reason.slice(0, MAX_TEXT)));
    this.messages.clear();
    this.deduplicated.clear();
  }

  private error(error: string, id?: string, reason?: string): CallToolResult {
    return result(
      { messageId: id, status: "unanswered", error, ...(reason !== undefined ? { reason } : {}) },
      true
    );
  }

  private send(
    kind: SupervisorMessage["kind"],
    value: string,
    suppliedId?: string
  ): Promise<CallToolResult> {
    // Caller keys only deduplicate within an attempt. Reply identities never repeat on reset.
    const id = randomUUID();
    if (this.closedReason !== undefined)
      return Promise.resolve(this.error("SUPERVISOR_MAILBOX_CLOSED", id, this.closedReason));
    const prior = suppliedId === undefined ? undefined : this.deduplicated.get(suppliedId);
    if (prior)
      return prior.kind === kind && prior.text === value
        ? prior.outcome
        : Promise.resolve(this.error("SUPERVISOR_MESSAGE_ID_CONFLICT", prior.id));
    // Retain all accepted IDs instead of evicting facts needed for idempotency.
    if (this.messages.size >= MAX_MESSAGES)
      return Promise.resolve(this.error("SUPERVISOR_MESSAGE_LIMIT", id));
    if (kind === "question" && this.pendingQuestions >= MAX_QUESTIONS)
      return Promise.resolve(this.error("SUPERVISOR_QUESTION_LIMIT", id));

    const event: SupervisorMessage = {
      id,
      kind,
      text: value,
      ...(kind === "question"
        ? { expiresAt: new Date(Date.now() + this.timeoutMs).toISOString() }
        : {}),
    };
    const record: MessageRecord = {
      ...event,
      clientMessageId: suppliedId,
      outcome: Promise.resolve(
        result({ messageId: id, clientMessageId: suppliedId, status: "delivered" })
      ),
    };
    if (kind === "question") {
      this.pendingQuestions++;
      record.outcome = new Promise<CallToolResult>((resolve) => {
        const timer = setTimeout(() => {
          record.finish?.(this.error("SUPERVISOR_QUESTION_TIMEOUT", id));
        }, this.timeoutMs);
        timer.unref();
        record.finish = (outcome) => {
          clearTimeout(timer);
          record.finish = undefined;
          this.pendingQuestions--;
          resolve(outcome);
        };
      });
    }
    this.messages.set(id, record);
    if (suppliedId !== undefined) this.deduplicated.set(suppliedId, record);
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...event });
      } catch {
        // An observer failure cannot erase delivery or strand a pending question.
      }
    }
    return record.outcome;
  }
}
