import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { inside } from "./runtime.js";

export interface WorkspaceSnapshot {
  source: "git" | "unavailable";
  roots: string[];
  files: Record<string, string | null>;
  heads?: Record<string, string>;
}
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });

/** Boundary-only inventory, including untracked files. Never reads tool logs or polls. */
export function workspaceSnapshot(
  cwd: string,
  artifacts: string[],
  baselineHeads?: Record<string, string>
): WorkspaceSnapshot {
  const roots = new Set<string>();
  for (const file of [".", ...artifacts]) {
    let dir = path.resolve(cwd, file);
    while (!existsSync(dir)) dir = path.dirname(dir);
    if (!statSync(dir).isDirectory()) dir = path.dirname(dir);
    try {
      roots.add(git(dir, ["rev-parse", "--show-toplevel"]).trim());
    } catch {
      /* Non-Git project. */
    }
  }
  const files: Record<string, string | null> = {};
  let available = roots.size > 0;
  const heads: Record<string, string> = {};
  for (const root of roots) {
    try {
      heads[root] = git(root, ["rev-parse", "HEAD"]).trim();
      const changed = git(root, [
        "diff",
        baselineHeads?.[root] ?? "HEAD",
        "--name-only",
        "-z",
        "--no-renames",
      ]);
      const added = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
      for (const name of new Set((changed + added).split("\0").filter(Boolean))) {
        const absolute = path.resolve(root, name);
        if (!inside(cwd, absolute)) continue;
        const relative = path.relative(cwd, absolute).replaceAll("\\", "/");
        files[relative] =
          existsSync(absolute) && statSync(absolute).isFile()
            ? createHash("sha256").update(readFileSync(absolute)).digest("hex")
            : null;
      }
    } catch {
      available = false;
    }
  }
  return { source: available ? "git" : "unavailable", roots: [...roots], files, heads };
}

export function changedSince(baseline: WorkspaceSnapshot | undefined, current: WorkspaceSnapshot) {
  if (!baseline || baseline.source !== "git" || current.source !== "git")
    return { source: "unavailable" as const, changedFiles: [] as string[] };
  return {
    source: "git" as const,
    changedFiles: [...new Set([...Object.keys(baseline.files), ...Object.keys(current.files)])]
      .filter((file) => baseline.files[file] !== current.files[file])
      .sort(),
  };
}
