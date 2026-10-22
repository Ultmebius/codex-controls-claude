import { build } from "esbuild";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
const version = manifest.version;
if (!process.argv.includes("--native-only")) await build({ absWorkingDir: fileURLToPath(new URL("./", import.meta.url)), entryPoints: ["src/plugin-entry.ts"],
  outfile: "../index.mjs", bundle: true, platform: "node", target: "node22", format: "esm",
  define: { __PLUGIN_VERSION__: JSON.stringify(version) },
  banner: { js: 'import { createRequire as __cccCreateRequire } from "node:module"; const require = __cccCreateRequire(import.meta.url);' } });

if (!process.argv.includes("--js-only")) {
  execFileSync(process.execPath, [fileURLToPath(new URL("native/logo-tools/generate-logo.mjs", import.meta.url)), "--input", path.resolve(fileURLToPath(new URL("../../", import.meta.url)), manifest.extensions["com.openai"].interface.logo)], { stdio: "inherit", windowsHide: true });
  const scratch = mkdtempSync(path.join(tmpdir(), "ccc-native-build-"));
  try {
    execFileSync("dotnet", ["publish", fileURLToPath(new URL("native/TerminalHost/TerminalHost.csproj", import.meta.url)), "-c", "Release", "-o", fileURLToPath(new URL("../native", import.meta.url)), "--artifacts-path", scratch, "--ignore-failed-sources"], { stdio: "inherit", windowsHide: true });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
