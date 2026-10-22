import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const runtimeEntries = [
  "plugin.json", "mcp.json", ".codex-plugin", ".mcp.json", ".agents/plugins/marketplace.json",
  "skills", "assets", "docs", "scripts", "server/index.mjs", "server/native",
  "README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md",
];

export function exportRuntime(root, destination) {
  root = path.resolve(root);
  destination = path.resolve(destination);
  if (destination === root || root.startsWith(destination + path.sep))
    throw new Error("Destination must not be the plugin root or its parent");
  for (const entry of runtimeEntries) {
    const source = path.join(root, entry);
    if (destination === source || destination.startsWith(source + path.sep))
      throw new Error("Destination overlaps a runtime input");
  }
  if (existsSync(destination) && readdirSync(destination).length)
    throw new Error("Destination must be empty");
  mkdirSync(destination, { recursive: true });
  for (const entry of runtimeEntries) {
    const source = path.join(root, entry);
    if (!existsSync(source)) throw new Error(`Missing runtime entry: ${entry}`);
    cpSync(source, path.join(destination, entry), { recursive: true, dereference: false });
  }
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  if (!process.argv[2]) throw new Error("Usage: npm run package:runtime -- <empty output directory>");
  console.log(`Exported runtime: ${exportRuntime(root, process.argv[2])}`);
}
