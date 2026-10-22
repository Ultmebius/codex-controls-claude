import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  execFileSync("dotnet", [
    "publish", fileURLToPath(new URL("../native/TerminalHost/TerminalHost.csproj", import.meta.url)),
    "-c", "Release", "-o", fileURLToPath(new URL("../.test-build/native-dist", import.meta.url)),
    "--artifacts-path", fileURLToPath(new URL("../.test-build/artifacts", import.meta.url)),
    "--ignore-failed-sources",
  ], { stdio: "inherit", windowsHide: true });
}
