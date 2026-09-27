// Windows ACL lockdown — the equivalent of a POSIX chmod restriction on a
// platform where the mode bits secure-write.ts writes are silently ignored.
import { chmodSync } from "node:fs";
import { userInfo } from "node:os";
import { spawnSync } from "node:child_process";
import { isWindows } from "../core/platform";
import { spawnFailureReason } from "../core/exit";

// Injectable so the Windows ACL path is unit-testable without shelling out to icacls.
export type CommandRunner = (argv: string[]) => { status: number | null; error?: Error; stderr?: string };

export function defaultRunner(argv: string[]): { status: number | null; error?: Error; stderr?: string } {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("acl: empty command");
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: result.status, error: result.error, stderr: result.stderr?.trim() || undefined };
}

// A bare "icacls" is PATH-searched; resolve the well-known system location instead.
function icaclsPath(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return `${systemRoot}\\System32\\icacls.exe`;
}

// userInfo() can throw when the account has no matching entry; falls back to the environment.
function lockdownGrantee(): string {
  try {
    const { username } = userInfo();
    if (username !== "") return username;
  } catch {
    // fall through to the environment
  }
  const name = process.env.USERNAME;
  if (!name) {
    throw new Error("acl: cannot determine the current Windows user to restrict permissions to");
  }
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${name}` : name;
}

export function lockdown(path: string, mode: number, runner: CommandRunner): void {
  if (!isWindows()) {
    chmodSync(path, mode);
    return;
  }

  // :F (full control), not :R (read-only) — this grant must match POSIX's
  // read+write 0600/0700, and it is applied to directories too, which need
  // write access to create files inside them.
  const argv = [icaclsPath(), path, "/inheritance:r", "/grant:r", `${lockdownGrantee()}:F`];
  const result = runner(argv);
  if (result.error || result.status !== 0) {
    throw new Error(`acl: failed to restrict permissions on ${path} via icacls (${spawnFailureReason(result)})`);
  }
}
