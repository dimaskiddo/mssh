// Cross-platform secure file/directory writing. The single chokepoint for
// permission locking down: every write of sensitive data elsewhere in the
// project (encrypted config, temp connect-time config, downloaded jump-host
// keys) must go through writeSecure()/ensureSecureDir(). This is the only
// module that references process.platform, chmodSync, or icacls for
// permission purposes.
import {
  chmodSync,
  mkdirSync,
  renameSync,
  linkSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
  fsyncSync,
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

// A bare "icacls" is PATH-searched, contradicting ssh-binary.ts's own
// documented threat model (never trust an ambient PATH for a security-
// relevant binary) — resolve the well-known system location instead.
function icaclsPath(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return `${systemRoot}\\System32\\icacls.exe`;
}

// userInfo() throws when the running account has no matching entry — same
// hazard add.ts's defaultUsername() documents and guards against. Unlike
// that POSIX fallback ("root"), a Windows icacls grantee must be a real
// account name or the command fails outright (safely — lockdown() already
// throws on a non-zero exit), so this falls back to the environment instead
// of guessing, and includes the domain when one is set (domain machines).
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

// Opens the file directly instead of writeFileSync so lockdown() can run
// between open and the write of the actual payload — mode/ACLs are applied
// to the fd's already-created-or-truncated file, then the sensitive bytes go
// in. "mode is set at creation" is only true for a brand-new path: an
// existing file (restored from a backup that dropped modes, written by an
// older mssh, pre-created by something else) keeps its old permissions
// through open(), so without this ordering the payload would land on disk
// at whatever mode the file already had, however briefly. "wx" (used for
// connect.ts's temp config) fails if the target already exists instead of
// silently overwriting a pre-created/symlinked file; the default "w" is
// required for the encrypted config and downloaded keys, which are
// legitimately overwritten across saves.
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

// rename()'s directory-entry update needs its own fsync: fsyncing the file's
// fd (writeSecure, above) makes the bytes durable but says nothing about the
// directory entry that now points at them, and that entry is exactly what
// renameSync just changed. Skipped on Windows, which does not support
// opening a directory for fsync.
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
// mid-way (crash, power loss) never leaves the target truncated or missing —
// the old contents survive until the new ones are fully durable. rename() is
// only atomic within one filesystem, which a sibling path guarantees; a
// system temp dir would not. "wx" on the temp file for the same reason
// writeSecure uses it elsewhere: never silently write through a pre-placed file.
// exclusive: true fails (EEXIST) instead of replacing when path already
// exists — for a caller (setup.ts) whose existsSync check sits before
// interactive prompts, so the real guard against a concurrent create has to
// be atomic, not checked. linkSync, unlike renameSync, never silently
// replaces an existing destination on either POSIX or Windows, so it stands
// in for rename in this mode rather than adding a second temp-file dance.
export function writeSecureAtomic(
  path: string,
  data: string | Buffer,
  runner: CommandRunner = defaultRunner,
  exclusive = false,
): void {
  // pid embedded so sweep.ts's start-of-run cleanup can skip a tmp file
  // whose writer is still alive, rather than racing a concurrent write.
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;

  // Registered before the temp file exists, removed in the finally below:
  // a kill between creating tmp and the rename/link no catch block here can
  // see. Matches connect.ts's/add.ts's own per-file exit net. Every explicit
  // catch below also calls cleanupTmp() so the file is gone the moment
  // control returns to the caller, not just at process exit — except the two
  // "intact at tmp" error paths, which leave it for the caller to recover.
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
      // EPERM/EEXIST reaching here (a sticky-bit directory, an immutable
      // attribute, some overlay/network mounts) means the destination was
      // never touched — propagate it as-is. Unlinking first, as the Windows
      // branch below must, would turn a recoverable failure into total loss.
      if (!isWindows() || (code !== "EPERM" && code !== "EEXIST")) {
        throw new Error(`secure-file: failed to save ${path} — the new data is intact at ${tmp}: ${(err as Error).message}`);
      }

      // Windows renameSync refuses to replace an existing file, so there is
      // no way to avoid a brief window with neither name pointing at the old
      // file. If either step here fails, the temp file is left in place
      // (never deleted) and named in the error, rather than risking both
      // copies being gone.
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

export function ensureSecureDir(path: string, runner: CommandRunner = defaultRunner): void {
  // mode applies to every directory recursive:true creates, intermediates
  // included (verified on this runtime), so no segment is briefly permissive.
  mkdirSync(path, { recursive: true, mode: 0o700 });
  lockdown(path, 0o700, runner);
}
