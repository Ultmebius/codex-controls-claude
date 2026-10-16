import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** The SDK owns the live process; this queue supplies user turns without respawning it. */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private pending?: (value: IteratorResult<SDKUserMessage>) => void;
  private ended = false;
  send(text: string, sessionId = "") {
    if (this.ended) throw new Error("INPUT_CLOSED");
    const value: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
    if (this.pending) {
      const resolve = this.pending;
      this.pending = undefined;
      resolve({ value, done: false });
    } else this.items.push(value);
  }
  close() {
    this.ended = true;
    this.pending?.({ value: undefined, done: true });
    this.pending = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        const value = this.items.shift();
        if (value) return { value, done: false };
        if (this.ended) return { value: undefined, done: true };
        return await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.pending = resolve;
        });
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}
