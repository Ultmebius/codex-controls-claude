import { describe, expect, it } from "vitest";
import { publicProgress } from "../src/orchestrator/progress.js";
import type { SessionEvent } from "../src/types.js";

const output = (id: number, content: unknown[]): SessionEvent => ({
  id,
  type: "output",
  timestamp: `2026-10-23T05:09:${id.toString().padStart(2, "0")}.000Z`,
  data: { type: "assistant", message: { content } },
  pinned: false,
});

describe("public worker progress", () => {
  it("exposes the latest visible milestone and tool names with their own timestamps", () => {
    const result = publicProgress(
      [
        output(1, [{ type: "text", text: "Still collecting sources" }]),
        output(2, [{ type: "tool_use", name: "Read", input: { secret: "private argument" } }]),
        output(3, [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "text", text: "Evidence is complete; writing the report now." },
        ]),
      ],
      -1
    );
    expect(result.latestOutput).toMatchObject({
      text: "Evidence is complete; writing the report now.",
    });
    expect(result.latestTools).toMatchObject({ names: ["Read"] });
    expect(JSON.stringify(result)).not.toMatch(
      /hidden reasoning|private argument|Still collecting/
    );
  });
  it("keeps prior segments and non-assistant messages out, and redacts before truncation", () => {
    const result = publicProgress(
      [
        output(1, [{ type: "text", text: "old stage" }]),
        { ...output(2, []), data: { type: "user", message: { content: "private prompt" } } },
        output(3, [{ type: "text", text: "x".repeat(995) + "secret-key-12345" }]),
      ],
      1,
      ["secret-key-12345"]
    );
    expect(result.latestOutput?.text.length).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(result)).not.toMatch(/secret-key|old stage|private prompt/);
    expect(
      publicProgress([output(1, [{ type: "thinking", thinking: "private" }])], -1).latestOutput
    ).toBeUndefined();
  });
});
