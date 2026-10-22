import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log(JSON.stringify({ status: "skipped", reason: "Native self-tests require Windows and .NET 10." }));
} else {
  await import("./prepare-native-tests.mjs");
  execFileSync("dotnet", [fileURLToPath(new URL("../.test-build/native-dist/CodexClaudeTerminal.dll", import.meta.url)), "--self-test"],
    { stdio: "inherit", windowsHide: true });
}
