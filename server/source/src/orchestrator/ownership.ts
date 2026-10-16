import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function nativeHelperFile() {
  const own = fileURLToPath(new URL("./native/CodexClaudeTerminal.dll", import.meta.url));
  for (const file of [
    process.env.CCC_NATIVE_HELPER,
    own,
    fileURLToPath(new URL("../../../native-dist/CodexClaudeTerminal.dll", import.meta.url)),
  ])
    if (file && existsSync(file)) return file;
  // A normal plugin upgrade may remove the old cache while its server is still shutting down.
  const root = path.resolve(path.dirname(own), "../.."),
    family = path.dirname(root);
  if (
    path.basename(family) === "codex-controls-claude" &&
    /^\d+\.\d+\.\d+/.test(path.basename(root)) &&
    existsSync(family)
  ) {
    for (const version of readdirSync(family)
      .filter((v) => /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const file = path.join(family, version, "server/native/CodexClaudeTerminal.dll");
      try {
        const manifest = JSON.parse(
          readFileSync(path.join(family, version, ".codex-plugin/plugin.json"), "utf8")
        );
        if (
          manifest.name === "codex-controls-claude" &&
          manifest.version === version &&
          existsSync(file)
        )
          return file;
      } catch {
        /* Not a complete matching installation. */
      }
    }
  }
  return own;
}
export function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
const posixOperation = `const fs=require('node:fs'),r=JSON.parse(fs.readFileSync(0,'utf8'));let owner;
if(fs.existsSync(r.file))owner=JSON.parse(fs.readFileSync(r.file,'utf8'));
const matches=owner&&owner.pid===r.record.pid&&owner[r.identity]===r.record[r.identity];
let alive=false;if(Number.isSafeInteger(owner?.pid)&&owner.pid>0){try{process.kill(owner.pid,0);alive=true;}catch(e){alive=e.code==='EPERM';}}
let result;
if(r.release){if(matches)fs.unlinkSync(r.file);result={released:!!matches};}
else if(alive)result=matches&&r.allowSame?{acquired:true}:{error:'LEASE_BUSY'};
else{const temp=r.file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(r.record),{mode:0o600});fs.renameSync(temp,r.file);result={acquired:true};}
process.stdout.write(JSON.stringify(result));`;

/** Metadata CAS under an OS file lock. Permanent guards are never stolen or deleted. */
function leaseOperation(
  file: string,
  identity: string,
  record: Record<string, string | number>,
  release = false,
  allowSame = false
): { acquired?: boolean; released?: boolean; error?: string } {
  const input = JSON.stringify({ file, identity, record, release, allowSame });
  let output: string;
  if (process.platform === "win32") {
    const helper = nativeHelperFile();
    if (!existsSync(helper))
      throw new Error("NATIVE_LEASE_HELPER_MISSING: build the native test helper");
    output = execFileSync("dotnet.exe", [helper, "--lease"], {
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } else {
    output = execFileSync(
      "flock",
      [
        "-x",
        "-w",
        "2",
        file + ".guard",
        process.execPath,
        "--input-type=commonjs",
        "-e",
        posixOperation,
      ],
      { input, encoding: "utf8", timeout: 10000 }
    );
  }
  return JSON.parse(output);
}
export function acquireJsonLease(
  file: string,
  identity: string,
  record: Record<string, string | number>,
  busyError: string,
  allowSame = false
) {
  const result = leaseOperation(file, identity, record, false, allowSame);
  if (!result.acquired)
    throw new Error(result.error === "LEASE_BUSY" ? busyError : "LEASE_GUARD_BUSY");
}
export function releaseJsonLease(
  file: string,
  identity: string,
  record: Record<string, string | number>
) {
  try {
    return leaseOperation(file, identity, record, true).released === true;
  } catch {
    // A live owner cannot be replaced by a legitimate claimant. Only release our exact record.
    if (!existsSync(file)) return false;
    const owner = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (
      record.pid !== process.pid ||
      owner.pid !== process.pid ||
      owner[identity] !== record[identity]
    )
      return false;
    unlinkSync(file);
    return true;
  }
}
export function claimFile(file: string) {
  const record = { pid: process.pid, token: randomUUID() };
  acquireJsonLease(file, "token", record, "RECOVERY_CLAIM_BUSY");
  return () => {
    const released = releaseJsonLease(file, "token", record);
    if (!released && existsSync(file)) throw new Error("STALE_RECOVERY_CLAIM");
  };
}
