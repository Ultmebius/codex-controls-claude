import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { exportRuntime } from "../scripts/package-runtime.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const json = name => JSON.parse(readFileSync(path.join(root, name), "utf8"));
const manifest = json("plugin.json"), compat = json(".codex-plugin/plugin.json");
const contained = (base, reference) => {
  assert.ok(reference.startsWith("./"), `Expected a plugin-relative path: ${reference}`);
  const file = realpathSync(path.resolve(base, reference));
  const relative = path.relative(realpathSync(base), file);
  assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return file;
};

test("portable and compatibility manifests identify the same plugin and interface", () => {
  assert.equal(manifest.name, "codex-controls-claude");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  for (const field of ["name", "version", "description", "homepage", "repository", "license"])
    assert.equal(compat[field], manifest[field], field);
  assert.deepEqual(compat.interface, manifest.extensions["com.openai"].interface);
  assert.equal(compat.requires_local_executor, true);
  assert.equal(manifest.extensions["com.openai"].requires_local_executor, true);
  assert.equal(json("server/source/package.json").version, manifest.version);
  assert.ok(compat.interface.shortDescription.length <= 30);
});

test("icons are contained square PNG assets and skills have matching frontmatter", () => {
  for (const field of ["logo", "composerIcon"]) {
    const raw = readFileSync(contained(root, compat.interface[field]));
    assert.deepEqual(raw.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(raw.readUInt32BE(16), raw.readUInt32BE(20));
    assert.ok(raw.readUInt32BE(16) >= 48 && raw.readUInt32BE(16) <= 4096);
  }
  for (const name of ["setup", "orchestrate"]) {
    const text = readFileSync(path.join(root, "skills", name, "SKILL.md"), "utf8");
    assert.match(text, /^---\r?\n/);
    assert.match(text, new RegExp(`\\nname: ${name}\\r?\\n`));
    assert.match(text, /\ndescription:/);
  }
});

test("marketplace resolves this checkout and both MCP launch configurations are complete", () => {
  const marketplace = json(".agents/plugins/marketplace.json");
  const entry = marketplace.plugins.find(plugin => plugin.name === manifest.name);
  assert.equal(entry.source.source, "local");
  assert.equal(contained(root, entry.source.path), realpathSync(root));
  assert.equal(entry.policy.authentication, "ON_INSTALL");
  const portable = json("mcp.json").mcpServers["claude-orchestrator"];
  const overlay = json(".mcp.json").mcpServers["claude-orchestrator"];
  assert.equal(portable.type, "stdio");
  assert.equal(portable.command, "node");
  assert.deepEqual(portable.args, ["${PLUGIN_ROOT}/server/index.mjs"]);
  assert.equal(portable.cwd, "${PLUGIN_ROOT}");
  assert.deepEqual(overlay.args, portable.args);
  assert.equal(overlay.tool_timeout_sec, 1260);
  assert.equal(overlay.env.CCC_WAIT_MS, "1200000");
  assert.ok(existsSync(path.join(root, "server/index.mjs")));
  assert.ok(existsSync(path.join(root, "server/native/CodexClaudeTerminal.dll")));
});

test("runtime export excludes the development harness and preserves the launch files", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ccc-export-"));
  try {
    const destination = exportRuntime(root, path.join(scratch, "plugin"));
    assert.ok(existsSync(path.join(destination, "server/index.mjs")));
    assert.ok(existsSync(path.join(destination, ".codex-plugin/plugin.json")));
    assert.ok(!existsSync(path.join(destination, "server/source")));
    assert.ok(!existsSync(path.join(destination, ".github")));
    assert.ok(!existsSync(path.join(destination, "node_modules")));
    assert.deepEqual(readFileSync(path.join(destination, "server/index.mjs")), readFileSync(path.join(root, "server/index.mjs")));
    assert.throws(() => exportRuntime(root, destination), /empty/);
    assert.throws(() => exportRuntime(root, root), /plugin root/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("local documentation links resolve and prose contains no invisible zero-width spaces", () => {
  const files = ["README.md", "CONTRIBUTING.md", "CHANGELOG.md", ...readdirSync(path.join(root, "docs")).filter(name => name.endsWith(".md")).map(name => `docs/${name}`)];
  for (const name of files) {
    const file = path.join(root, name), text = readFileSync(file, "utf8");
    assert.ok(!text.includes("\u200b"), name);
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(path.resolve(path.dirname(file), target)), `${name}: ${target}`);
    }
  }
});

test("cold bundled MCP advertises exactly the ten orchestration tools without a model call", { timeout: 30000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ccc-mcp-contract-"));
  const client = new Client({ name: "package-contract", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server/index.mjs")],
    cwd: root, env: { ...process.env, PLUGIN_DATA: scratch }, stderr: "pipe" });
  transport.stderr?.resume();
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, manifest.version);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
      "orchestrator_cancel", "orchestrator_dispatch", "orchestrator_doctor", "orchestrator_message",
      "orchestrator_plan", "orchestrator_respond_permission", "orchestrator_review",
      "orchestrator_status", "orchestrator_team", "orchestrator_wait",
    ]);
  } finally {
    await client.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
