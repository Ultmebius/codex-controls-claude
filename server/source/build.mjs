import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const version = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8")).version;
await build({ absWorkingDir: fileURLToPath(new URL("./", import.meta.url)), entryPoints: ["src/plugin-entry.ts"],
  outfile: "../index.mjs", bundle: true, platform: "node", target: "node22", format: "esm",
  define: { __PLUGIN_VERSION__: JSON.stringify(version) },
  banner: { js: 'import { createRequire as __cccCreateRequire } from "node:module"; const require = __cccCreateRequire(import.meta.url);' } });

import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
execFileSync("dotnet", ["publish", fileURLToPath(new URL("native/TerminalHost/TerminalHost.csproj", import.meta.url)), "-c", "Release", "-o", fileURLToPath(new URL("../native", import.meta.url)), "--artifacts-path", path.join(tmpdir(), "codex-controls-claude-native-build"), "--ignore-failed-sources"], { stdio: "inherit", windowsHide: true });
