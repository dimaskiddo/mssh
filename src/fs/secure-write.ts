// The single chokepoint every write of sensitive data must go through.
import { mkdirSync, renameSync, linkSync, unlinkSync, openSync, writeSync, closeSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { isWindows } from "../core/platform";
import { type CommandRunner, defaultRunner, lockdown } from "./acl";
import { tmpSuffix } from "./temp-names";
export type { CommandRunner };

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
export function fsyncContainingDir(path: string): void {
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
  const tmp = `${path}${tmpSuffix(process.pid, randomBytes(8).toString("hex"))}`;

  // Registered before the temp file exists, so an exit mid-write still removes
  // it; removed in the finally below once cleanup is otherwise guaranteed.
  const cleanupTmp = (): void => tryUnlink(tmp);
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
        throw new Error(`secure-write: failed to save ${path} — the new data is intact at ${tmp}: ${(err as Error).message}`);
      }

      // Windows renameSync refuses to replace an existing file, leaving a
      // brief window with neither name valid. On failure here, the temp file
      // is left in place (named in the error) rather than risking both copies.
      try {
        unlinkSync(path);
        renameSync(tmp, path);
      } catch (fallbackErr) {
        throw new Error(
          `secure-write: failed to replace ${path} — the new data is intact at ${tmp}: ${(fallbackErr as Error).message}`,
        );
      }
    }

    fsyncContainingDir(path);
  } finally {
    process.removeListener("exit", cleanupTmp);
  }
}

// No existsSync pre-check: every caller treats any failure, ENOENT included, as ignorable.
export function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort; ENOENT just means it's already gone
  }
}

export function ensureSecureDir(path: string, runner: CommandRunner = defaultRunner): void {
  // mode applies to every directory recursive:true creates, intermediates
  // included (verified on this runtime), so no segment is briefly permissive.
  mkdirSync(path, { recursive: true, mode: 0o700 });
  lockdown(path, 0o700, runner);
}
