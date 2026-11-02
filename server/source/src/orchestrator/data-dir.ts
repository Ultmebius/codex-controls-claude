import os from "node:os";
import path from "node:path";

export function defaultDataDir() {
  return (
    process.env.PLUGIN_DATA ??
    process.env.CCC_DATA_DIR ??
    path.join(os.homedir(), ".local", "share", "codex-controls-claude")
  );
}
