import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/** Display-only observation. Never sets Claude's effort or claims upstream enforcement. */
export function displayEffort(
  cwd: string | undefined,
  env: Record<string, string | undefined>,
  args: string[] = [],
  home = os.homedir()
) {
  const valid = (value: unknown) =>
    typeof value === "string" && ["low", "medium", "high", "xhigh", "max", "auto"].includes(value)
      ? value
      : undefined;
  const explicit = valid(env.CLAUDE_CODE_EFFORT_LEVEL);
  if (explicit) return { effort: explicit, effortSource: "environment (configured)" };
  const index = args.lastIndexOf("--effort");
  const cli = valid(
    index >= 0 ? args[index + 1] : args.find((a) => a.startsWith("--effort="))?.slice(9)
  );
  if (cli) return { effort: cli, effortSource: "CLI (configured)" };
  const files = [path.join(home, ".claude/settings.json")];
  if (cwd) {
    const ancestors: string[] = [];
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      ancestors.unshift(dir);
      if (path.dirname(dir) === dir) break;
    }
    for (const dir of ancestors)
      files.push(
        path.join(dir, ".claude/settings.json"),
        path.join(dir, ".claude/settings.local.json")
      );
  }
  let effort = "unknown",
    effortSource = "not reported";
  const model = env.ANTHROPIC_MODEL?.replace(/\[1m\]$/i, "");
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const settings = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      const perModel = model ? valid(settings.modelSettings?.[model]?.effortLevel) : undefined;
      const level = perModel ?? valid(settings.effortLevel);
      if (level) {
        effort = level;
        effortSource = perModel ? "model setting (configured)" : "settings (configured)";
      }
    } catch {
      /* Native Claude owns validation; the display remains explicitly unknown. */
    }
  }
  return { effort, effortSource };
}
