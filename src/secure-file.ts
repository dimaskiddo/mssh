// Cross-platform secure file/directory writing. The single chokepoint for
// permission locking down: every write of sensitive data elsewhere in the
// project (encrypted config, temp connect-time config, downloaded jump-host
// keys) must go through writeSecure()/ensureSecureDir(). This is the only
// module that references process.platform, chmodSync, or icacls for
// permission purposes.
import { chmodSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// Runs a command given as a full argv array (argv[0] is the executable) and
// reports the outcome. Injectable so the Windows ACL path is unit-testable
// from non-Windows dev machines without actually shelling out to icacls.
export type CommandRunner = (argv: string[]) => { status: number | null; error?: Error; stderr?: string };

// The one exported platform check other modules may use (e.g. app-config.ts's
// advisory permission warning, which is unrelated to lockdown enforcement but
// still needs to skip POSIX-mode-bit checks on Windows). Keeps process.platform
// itself referenced in exactly one place.
export function isWindows(): boolean {
  return process.platform === "win32";
}

function defaultRunner(argv: string[]): { status: number | null; error?: Error; stderr?: string } {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("secure-file: empty command");
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: result.status, error: result.error, stderr: result.stderr?.trim() || undefined };
}

function lockdown(path: string, mode: number, runner: CommandRunner): void {
  if (!isWindows()) {
    chmodSync(path, mode);
    return;
  }

  // :F (full control), not :R (read-only) — this grant must match POSIX's
  // read+write 0600/0700, and it is applied to directories too, which need
  // write access to create files inside them.
  const argv = ["icacls", path, "/inheritance:r", "/grant:r", `${userInfo().username}:F`];
  const result = runner(argv);
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : result.stderr || `exit code ${result.status}`;
    throw new Error(`secure-file: failed to restrict permissions on ${path} via icacls (${reason})`);
  }
}

// flag "wx" (used for connect.ts's temp config) fails if the target already
// exists instead of silently overwriting a pre-created/symlinked file; the
// default "w" is required for the encrypted config and downloaded keys, which are
// legitimately overwritten across saves.
export function writeSecure(
  path: string,
  data: string | Buffer,
  runner: CommandRunner = defaultRunner,
  flag: "w" | "wx" = "w",
): void {
  // mode is set at creation time, not applied afterwards, so the file is
  // never briefly readable at the filesystem default.
  writeFileSync(path, data, { mode: 0o600, flag });
  lockdown(path, 0o600, runner);
}

// Writes via a same-directory temp file then renameSync, so a write that dies
// mid-way (crash, power loss) never leaves the target truncated or missing —
// the old contents survive until the new ones are fully durable. rename() is
// only atomic within one filesystem, which a sibling path guarantees; a
// system temp dir would not. "wx" on the temp file for the same reason
// writeSecure uses it elsewhere: never silently write through a pre-placed file.
export function writeSecureAtomic(path: string, data: string | Buffer, runner: CommandRunner = defaultRunner): void {
  const tmp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    writeSecure(tmp, data, runner, "wx");
  } catch (err) {
    // The lockdown half of writeSecure (chmod/icacls) can fail after the file
    // is already on disk — don't leave an under-protected temp file behind.
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort; the original error is what matters
    }
    throw err;
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    // Windows renameSync refuses to replace an existing file; POSIX allows it.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EEXIST") {
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort; the original error is what matters
      }
      throw err;
    }
    unlinkSync(path);
    renameSync(tmp, path);
  }
}

export function ensureSecureDir(path: string, runner: CommandRunner = defaultRunner): void {
  // mode applies to every directory recursive:true creates, intermediates
  // included (verified on this runtime), so no segment is briefly permissive.
  mkdirSync(path, { recursive: true, mode: 0o700 });
  lockdown(path, 0o700, runner);
}
