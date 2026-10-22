import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/event-wait.test.mjs", "package-tests/**"],
    maxWorkers: 2,
    testTimeout: 15000,
    env: {
      CCC_NATIVE_HELPER: fileURLToPath(
        new URL("./.test-build/native-dist/CodexClaudeTerminal.dll", import.meta.url)
      ),
    },
  },
});
