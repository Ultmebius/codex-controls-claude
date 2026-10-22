import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
const fixtures = vi.hoisted(() => ({ terminals: [] as { kill: ReturnType<typeof vi.fn> }[] }));
vi.mock("../src/orchestrator/terminal.js", () => ({
  TerminalProcess: class extends EventEmitter {
    kill = vi.fn(() => {
      this.emit("exit", 0);
      return true;
    });
    constructor() {
      super();
      fixtures.terminals.push(this);
    }
  },
  terminalInfo: () => [],
  stopTerminalProcesses: vi.fn(),
}));
import { enableOwnedProcesses, processSpawner } from "../src/orchestrator/runtime.js";
describe("per-worker native ownership", () => {
  it("stopping one worker group leaves the other native terminal alive", () => {
    if (process.platform !== "win32") return;
    enableOwnedProcesses();
    const first = new Set<() => void>(),
      second = new Set<() => void>();
    const options = {
      command: "claude",
      args: [],
      env: process.env,
      signal: new AbortController().signal,
    };
    processSpawner(first)!(options);
    processSpawner(second)!(options);
    for (const stop of [...first]) stop();
    expect(fixtures.terminals[0].kill).toHaveBeenCalledTimes(1);
    expect(fixtures.terminals[1].kill).not.toHaveBeenCalled();
    expect(first.size).toBe(0);
    expect(second.size).toBe(1);
    for (const stop of [...second]) stop();
  });
});
