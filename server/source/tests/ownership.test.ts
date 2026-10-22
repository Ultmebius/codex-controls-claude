import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { buildSync } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { claimFile, releaseJsonLease } from "../src/orchestrator/ownership.js";
const children: ChildProcess[] = [],
  directories: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
it("releases only verified own metadata if the native helper fails", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccc-helper-failure-"));
  directories.push(root);
  const helper = path.join(root, "broken.dll"),
    file = path.join(root, "lease");
  writeFileSync(helper, "invalid managed assembly");
  vi.stubEnv("CCC_NATIVE_HELPER", helper);
  writeFileSync(file, JSON.stringify({ pid: process.pid, token: "mine" }));
  expect(releaseJsonLease(file, "token", { pid: process.pid, token: "mine" })).toBe(true);
  writeFileSync(file, JSON.stringify({ pid: process.pid, token: "another-owner" }));
  expect(releaseJsonLease(file, "token", { pid: process.pid, token: "mine" })).toBe(false);
  expect(existsSync(file)).toBe(true);
});
it("finds only a matching installed helper after the previous cache disappears", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccc-helper-upgrade-"));
  directories.push(root);
  vi.stubEnv("CCC_NATIVE_HELPER", "");
  const family = path.join(root, "codex-controls-claude"),
    entry = path.join(family, "0.6.1/server/index.mjs");
  mkdirSync(path.dirname(entry), { recursive: true });
  buildSync({
    entryPoints: [fileURLToPath(new URL("../src/orchestrator/ownership.ts", import.meta.url))],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  for (const [version, name] of [
    ["0.6.2", "codex-controls-claude"],
    ["99.0.0", "unrelated-plugin"],
  ]) {
    const dir = path.join(family, version);
    mkdirSync(path.join(dir, "server/native"), { recursive: true });
    mkdirSync(path.join(dir, ".codex-plugin"));
    writeFileSync(path.join(dir, "server/native/CodexClaudeTerminal.dll"), "fixture");
    writeFileSync(path.join(dir, ".codex-plugin/plugin.json"), JSON.stringify({ name, version }));
  }
  const module = (await import(pathToFileURL(entry).href)) as { nativeHelperFile: () => string };
  expect(realpathSync.native(module.nativeHelperFile())).toBe(
    realpathSync.native(path.join(family, "0.6.2/server/native/CodexClaudeTerminal.dll"))
  );
});
function message(child: ChildProcess, key: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const receive = (value: unknown) => {
      if (value && typeof value === "object" && key in value) {
        child.off("message", receive);
        child.off("exit", exit);
        resolve(value as Record<string, unknown>);
      }
    };
    const exit = () => reject(new Error("Lease actor exited before " + key));
    child.on("message", receive);
    child.once("exit", exit);
    child.once("error", reject);
  });
}
it("serializes two stale-claim recoveries across processes and refuses another owner's release", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccc-并发 约束-"));
  directories.push(root);
  buildSync({
    entryPoints: [fileURLToPath(new URL("../src/orchestrator/ownership.ts", import.meta.url))],
    outfile: path.join(root, "ownership.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const actor = path.join(root, "actor.mjs");
  writeFileSync(
    actor,
    `import{claimFile}from'./ownership.mjs';let release;process.on('message',m=>{if(m==='go'){try{release=claimFile(process.argv[2]);process.send({attempt:true,acquired:true});}catch(e){process.send({attempt:true,acquired:false,error:e.message},()=>process.disconnect());}}else if(m==='release'){release();process.send({released:true},()=>process.disconnect());}});process.send({ready:true});`
  );
  const native = fileURLToPath(
    new URL("../.test-build/native-dist/CodexClaudeTerminal.dll", import.meta.url)
  );
  for (let iteration = 0; iteration < 4; iteration++) {
    const file = path.join(root, `claim-${iteration}`);
    writeFileSync(file, JSON.stringify({ pid: 99999999 }));
    const pair = [0, 1].map(() =>
      fork(actor, [file], {
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { ...process.env, CCC_NATIVE_HELPER: native },
      })
    );
    children.push(...pair);
    await Promise.all(pair.map((child) => message(child, "ready")));
    const attempts = pair.map((child) => message(child, "attempt"));
    for (const child of pair) child.send("go");
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
    expect(results.find((r) => !r.acquired)?.error).toBe("RECOVERY_CLAIM_BUSY");
    expect(releaseJsonLease(file, "token", { pid: process.pid, token: "not-the-owner" })).toBe(
      false
    );
    expect(existsSync(file)).toBe(true);
    const owner = pair[results.findIndex((r) => r.acquired)],
      released = message(owner, "released");
    owner.send("release");
    await released;
    expect(existsSync(file)).toBe(false);
    const release = claimFile(file);
    release();
    expect(existsSync(file)).toBe(false);
  }
}, 30000);
