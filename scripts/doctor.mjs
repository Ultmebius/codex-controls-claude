import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const entry = fileURLToPath(new URL("../server/index.mjs", import.meta.url));
const result = spawnSync(process.execPath, [entry, "--doctor"], { stdio: "inherit", windowsHide: true });
process.exitCode = result.status ?? 1;
