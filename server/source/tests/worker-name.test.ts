import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator, type Run, type TaskSpec } from "../src/orchestrator/controller.js";
import { TeamCoordinator, type TeamTaskSpec } from "../src/orchestrator/team.js";
import type { Worker, WorkerEvent } from "../src/orchestrator/worker.js";
import type { AgentResult } from "../src/types.js";

const spawned = vi.hoisted(() => ({ options: [] as { workerName?: string }[] }));
vi.mock("../src/orchestrator/terminal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/orchestrator/terminal.js")>()),
  TerminalProcess: class {
    kill = vi.fn(() => true);
    constructor(_opts: unknown, options: { workerName?: string }) {
      spawned.options.push(options);
    }
    once() {}
  },
}));
import { enableOwnedProcesses, processSpawner } from "../src/orchestrator/runtime.js";

class NamedWorker implements Worker {
  listener?: (event: WorkerEvent) => void;
  live = false;
  name?: string;
  startedAs?: string;
  constructor(readonly id: string) {}
  subscribe(listener: (event: WorkerEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  setName(name: string | undefined) {
    this.name = name;
  }
  async start() {
    this.startedAs = this.name;
    this.live = true;
    return this.id;
  }
  async reply() {
    return this.id;
  }
  replay() {
    return [];
  }
  result(): AgentResult | undefined {
    return undefined;
  }
  permissions() {
    return [];
  }
  respond() {
    return true;
  }
  model() {
    return this.live ? "configured-model" : undefined;
  }
  isLive() {
    return this.live;
  }
  stop() {
    this.live = false;
  }
  destroy() {}
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  spawned.options.length = 0;
});
function fixture(workerName?: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccc-name-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, "data");
  const worker = new NamedWorker("session-1");
  const controller = new Orchestrator(dataDir, worker);
  cleanup.push(() => controller.close());
  const task: TaskSpec = {
    id: "a",
    title: "artifact",
    instructions: "write answer.txt",
    dependsOn: [],
    acceptance: "answer is 42",
    artifacts: ["answer.txt"],
    checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
  };
  const create = (name = workerName) =>
    controller.plan({
      action: "create",
      cwd: dir,
      goal: "goal",
      design: "design",
      workerName: name,
      tasks: [task],
    });
  return { dir, dataDir, worker, create, controller: () => controller };
}

describe("worker display name propagation", () => {
  it("defaults a single run to its first task title and persists it", async () => {
    const f = fixture();
    const run = f.create(undefined);
    expect(run.workerName).toBe("artifact");
    await f.controller().dispatch(run.id, "a", "one");
    expect(f.worker.startedAs).toBe("artifact");
    const saved = JSON.parse(
      readFileSync(path.join(f.dataDir, `run-${run.id}.json`), "utf8")
    ) as Run;
    expect(saved.workerName).toBe("artifact");
  });

  it("keeps an explicit name stable across dispatch and cold resume", async () => {
    const f = fixture("UI 修复");
    const run = f.create();
    expect(run.workerName).toBe("UI 修复");
    await f.controller().dispatch(run.id, "a", "one");
    expect(f.worker.startedAs).toBe("UI 修复");
    f.controller().close();
    const resumed = new Orchestrator(f.dataDir, new NamedWorker("session-2"));
    cleanup.push(() => resumed.close());
    const loaded = resumed.status(run.id) as Run;
    expect(loaded.workerName).toBe("UI 修复");
  });

  it("loads ledgers written before worker names existed", () => {
    const f = fixture("UI 修复");
    const run = f.create();
    f.controller().close();
    const file = path.join(f.dataDir, `run-${run.id}.json`);
    const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Run>;
    delete saved.workerName;
    writeFileSync(file, JSON.stringify(saved));
    const loaded = new Orchestrator(f.dataDir, new NamedWorker("session-2"));
    cleanup.push(() => loaded.close());
    expect((loaded.status(run.id) as Run).workerName).toBe("artifact");
  });

  it("propagates team workerName ?? task.title to each child run", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ccc-team-name-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const runs: Run[] = [];
    const factory = (directory: string) => {
      const controller = new Orchestrator(directory, new NamedWorker(`session-${runs.length}`));
      const original = controller.plan.bind(controller);
      controller.plan = ((input: Parameters<Orchestrator["plan"]>[0]) => {
        const run = original(input);
        runs.push(run);
        return run;
      }) as Orchestrator["plan"];
      return controller;
    };
    const coordinator = new TeamCoordinator(path.join(dir, "ledger"), factory);
    cleanup.push(() => coordinator.close());
    const base = {
      instructions: "write",
      acceptance: "42",
      dependsOn: [],
      artifacts: ["a.txt"],
      checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
    };
    const tasks: TeamTaskSpec[] = [
      { ...base, id: "a", title: "预算配置", workerName: "预算" },
      { ...base, id: "b", title: "UI 修复" },
    ];
    const team = coordinator.create({ cwd: dir, goal: "goal", design: "design", tasks });
    expect(runs.map((run) => run.workerName)).toEqual(["预算", "UI 修复"]);
    expect(team.tasks.map((task) => task.workerName)).toEqual(["预算", "UI 修复"]);
    // Display metadata never becomes part of the task contract.
    expect(Object.keys(runs[0].tasks[0])).not.toContain("workerName");
  });
});

describe("terminal tab names", () => {
  it("sanitizes hostile names, bounds length, and preserves Chinese/whitespace", async () => {
    const { sanitizeWorkerName } = await vi.importActual<
      typeof import("../src/orchestrator/terminal.js")
    >("../src/orchestrator/terminal.js");
    expect(sanitizeWorkerName("  UI \u001b[31m修复\u001b[0m  ")).toBe("UI 修复");
    expect(sanitizeWorkerName("\u001b]0;title\u0007预算配置")).toBe("预算配置");
    expect(sanitizeWorkerName("\u001b]0;title\u001b\\预算配置")).toBe("预算配置");
    expect(
      sanitizeWorkerName("\u001b]8;;https://example.test\u001b\\UI 修复\u001b]8;;\u001b\\")
    ).toBe("UI 修复");
    expect(sanitizeWorkerName("line\nbreak\tname")).toBe("line break name");
    expect(sanitizeWorkerName("a".repeat(200))).toHaveLength(64);
    expect(sanitizeWorkerName("\u001b[2J\u0007  ")).toBeUndefined();
    expect(sanitizeWorkerName(undefined)).toBeUndefined();
  });

  it("keeps equal visible names with distinct private ownership identities", async () => {
    const { TerminalProcess, terminalInfo } = await vi.importActual<
      typeof import("../src/orchestrator/terminal.js")
    >("../src/orchestrator/terminal.js");
    const make = () => {
      const abort = new AbortController();
      const process = new TerminalProcess(
        { command: "fixture", args: [], env: {}, signal: abort.signal },
        { workerName: "UI 修复", launch() {} }
      );
      return { process, abort };
    };
    const first = make(),
      second = make();
    try {
      expect(first.process.info.workerName).toBe("UI 修复");
      expect(first.process.info.title).toBe("Claude Code");
      expect(second.process.info.title).toBe("Claude Code");
      expect(first.process.info.ownershipId).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.process.info.ownershipId).not.toBe(second.process.info.ownershipId);
      expect(terminalInfo().map((info) => info.workerName)).toEqual(["UI 修复", "UI 修复"]);
      const exits = [once(first.process, "exit"), once(second.process, "exit")];
      first.abort.abort();
      second.abort.abort();
      await Promise.all(exits);
      expect(terminalInfo()).toEqual([]);
    } finally {
      first.abort.abort();
      second.abort.abort();
    }
  });

  it("forwards the name from worker spawn options to the terminal", () => {
    if (process.platform !== "win32") return;
    enableOwnedProcesses();
    processSpawner(new Set(), "预算配置")!({
      command: "claude",
      args: [],
      env: process.env,
      signal: new AbortController().signal,
    });
    expect(spawned.options.at(-1)?.workerName).toBe("预算配置");
  });
});
