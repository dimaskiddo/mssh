// Cross-platform secure file/directory writing — the single chokepoint every
// write of sensitive data (config, temp files, downloaded keys) must go through.
import {
  chmodSync,
  chownSync,
  mkdirSync,
  renameSync,
  linkSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
  fsyncSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// Runs a command given as a full argv array (argv[0] is the executable) and
// reports the outcome. Injectable so the Windows ACL path is unit-testable
// from non-Windows dev machines without actually shelling out to icacls.
export type CommandRunner = (argv: string[]) => { status: number | null; error?: Error; stderr?: string };

// The one exported platform check other modules may use (e.g. app-config.ts's
// advisory permission warning) — keeps process.platform referenced in exactly one place.
export function isWindows(): boolean {
  return process.platform === "win32";
}

function defaultRunner(argv: string[]): { status: number | null; error?: Error; stderr?: string } {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("secure-file: empty command");
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: result.status, error: result.error, stderr: result.stderr?.trim() || undefined };
}

// A bare "icacls" is PATH-searched, contradicting ssh-binary.ts's own
// documented threat model (never trust an ambient PATH for a security-
// relevant binary) — resolve the well-known system location instead.
function icaclsPath(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return `${systemRoot}\\System32\\icacls.exe`;
}

// userInfo() can throw when the account has no matching entry — same hazard
// add.ts's defaultUsername() guards against; falls back to the environment.
function lockdownGrantee(): string {
  try {
    const { username } = userInfo();
    if (username !== "") return username;
  } catch {
    // fall through to the environment
  }
  const name = process.env.USERNAME;
  if (!name) {
    throw new Error("secure-file: cannot determine the current Windows user to restrict permissions to");
  }
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${name}` : name;
}

function lockdown(path: string, mode: number, runner: CommandRunner): void {
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
    const reason = result.error ? result.error.message : result.stderr || `exit code ${result.status}`;
    throw new Error(`secure-file: failed to restrict permissions on ${path} via icacls (${reason})`);
  }
}

// Opens the file directly (not writeFileSync) so lockdown() can run between
// open and the write — an existing file keeps its old mode through open(),
// so without this ordering the payload lands at whatever mode it already had.
export function writeSecure(
  path: string,
  data: string | Buffer,
  runner: CommandRunner = defaultRunner,
  flag: "w" | "wx" = "w",
): void {
  const fd = openSync(path, flag, 0o600);
  try {
    lockdown(path, 0o600, runner);
    writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
    fsyncSync(fd); // the payload must be durable before renameSync (writeSecureAtomic) treats it as the new content
  } finally {
    closeSync(fd);
  }
}

// rename()'s directory-entry update needs its own fsync — fsyncing the
// file's fd says nothing about the entry renameSync just changed. Skipped on
// Windows, which does not support opening a directory for fsync.
function fsyncContainingDir(path: string): void {
  if (isWindows()) return;
  const dirFd = openSync(dirname(path), "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

// Writes via a same-directory temp file then renameSync, so a write that dies
// mid-way never leaves the target truncated or missing — rename() is atomic
// only within one filesystem, which a sibling path guarantees.
export function writeSecureAtomic(
  path: string,
  data: string | Buffer,
  runner: CommandRunner = defaultRunner,
  exclusive = false,
): void {
  // pid embedded so sweep.ts's start-of-run cleanup can skip a tmp file
  // whose writer is still alive, rather than racing a concurrent write.
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;

  // Registered before the temp file exists so a kill mid-write still cleans
  // it up; removed in the finally below once cleanup is otherwise guaranteed.
  const cleanupTmp = (): void => {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort; ENOENT just means it's already gone
    }
  };
  process.on("exit", cleanupTmp);

  try {
    try {
      writeSecure(tmp, data, runner, "wx");
    } catch (err) {
      cleanupTmp();
      throw err;
    }

    if (exclusive) {
      try {
        linkSync(tmp, path);
      } catch (err) {
        cleanupTmp();
        throw err;
      }
      cleanupTmp(); // best-effort: path already holds the data via the hard link made above
      fsyncContainingDir(path);
      return;
    }

    try {
      renameSync(tmp, path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;

      // POSIX rename() already replaces the destination atomically, so an
      // EPERM/EEXIST here means the destination was never touched — propagate
      // as-is rather than unlinking first, which risks losing both copies.
      if (!isWindows() || (code !== "EPERM" && code !== "EEXIST")) {
        throw new Error(`secure-file: failed to save ${path} — the new data is intact at ${tmp}: ${(err as Error).message}`);
      }

      // Windows renameSync refuses to replace an existing file, leaving a
      // brief window with neither name valid. On failure here, the temp file
      // is left in place (named in the error) rather than risking both copies.
      try {
        unlinkSync(path);
        renameSync(tmp, path);
      } catch (fallbackErr) {
        throw new Error(
          `secure-file: failed to replace ${path} — the new data is intact at ${tmp}: ${(fallbackErr as Error).message}`,
        );
      }
    }

    fsyncContainingDir(path);
  } finally {
    process.removeListener("exit", cleanupTmp);
  }
}

// `sudo mssh update` runs as root but must not leave a user-owned install
// root-owned. Pure so it's testable without actually running as root.
export function ownershipToRestore(
  stat: { uid: number; gid: number },
  euid: number,
): { uid: number; gid: number } | undefined {
  if (euid !== 0 || stat.uid === euid) return undefined;
  return { uid: stat.uid, gid: stat.gid };
}

// Swaps a running executable's content in place, giving commands/update.ts a
// rollback path if a post-swap smoke test fails. No icacls call here: unlike
// writeSecure/ensureSecureDir, the target must keep whatever ACL/mode the
// install already had (a shared install's permissions must not narrow to
// the user running `mssh update`).
export function replaceExecutable(target: string, data: Buffer): { commit: () => void; rollback: () => void } {
  const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const tmp = `${target}.new-${suffix}`;
  const backup = `${target}.old-${suffix}`;

  const cleanupTmp = (): void => {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort; ENOENT just means it's already gone
    }
  };
  process.on("exit", cleanupTmp);

  try {
    const stat = statSync(target);
    const mode = stat.mode & 0o777;

    const fd = openSync(tmp, "wx", mode);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!isWindows()) {
      // chown before chmod: chown can clear the setuid/setgid bits chmod just set.
      const restore = ownershipToRestore(stat, process.geteuid?.() ?? -1);
      if (restore) chownSync(tmp, restore.uid, restore.gid);
      // openSync's mode is filtered by umask; force it to match exactly.
      chmodSync(tmp, mode);
    }

    if (isWindows()) {
      // A running .exe can't be overwritten but can be renamed aside.
      renameSync(target, backup);
      try {
        renameSync(tmp, target);
      } catch (err) {
        renameSync(backup, target);
        throw err;
      }
    } else {
      // Hard link keeps the original inode reachable under `backup` — the
      // rename below only repoints the `target` directory entry, so a
      // process already running the old binary is unaffected either way.
      linkSync(target, backup);
      renameSync(tmp, target);
      fsyncContainingDir(target);
    }
  } catch (err) {
    cleanupTmp();
    throw err;
  } finally {
    process.removeListener("exit", cleanupTmp);
  }

  return {
    // Windows: the old file may still be locked by the process that's
    // running it, so leave it for sweep.ts to clean up on a later run.
    commit: () => {
      try {
        unlinkSync(backup);
      } catch {
        // best-effort
      }
    },
    rollback: () => {
      if (isWindows()) {
        try {
          unlinkSync(target);
        } catch {
          // best-effort
        }
      }
      renameSync(backup, target);
    },
  };
}

export function ensureSecureDir(path: string, runner: CommandRunner = defaultRunner): void {
  // mode applies to every directory recursive:true creates, intermediates
  // included (verified on this runtime), so no segment is briefly permissive.
  mkdirSync(path, { recursive: true, mode: 0o700 });
  lockdown(path, 0o700, runner);
}
