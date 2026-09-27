import { chmodSync, chownSync, existsSync, mkdirSync, renameSync, linkSync, openSync, writeSync, closeSync, fsyncSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { isWindows } from "../core/platform";
import { fsyncContainingDir, tryUnlink } from "./secure-write";
import { newSuffix, oldSuffix } from "./temp-names";

// `sudo mssh update` runs as root but must not leave a user-owned install root-owned.
export function ownershipToRestore(
  stat: { uid: number; gid: number },
  euid: number,
): { uid: number; gid: number } | undefined {
  if (euid !== 0 || stat.uid === euid) return undefined;
  return { uid: stat.uid, gid: stat.gid };
}

// No icacls call here: unlike writeSecure/ensureSecureDir, the target must
// keep whatever ACL/mode the install already had.
export function replaceExecutable(target: string, data: Buffer): { commit: () => void; rollback: () => void } {
  const randomSuffix = randomBytes(8).toString("hex");
  const tmp = `${target}${newSuffix(process.pid, randomSuffix)}`;
  const backup = `${target}${oldSuffix(process.pid, randomSuffix)}`;

  const cleanupTmp = (): void => tryUnlink(tmp);
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
    commit: () => tryUnlink(backup),
    rollback: () => {
      if (isWindows()) tryUnlink(target);
      renameSync(backup, target);
    },
  };
}

// A fresh install has no prior owner to preserve — a bin dir like ~/.local/bin
// is not secret, so this uses a plain mkdirSync, not ensureSecureDir's 0700.
export function installExecutable(target: string, data: Buffer): void {
  if (existsSync(target)) {
    replaceExecutable(target, data).commit();
    return;
  }

  mkdirSync(dirname(target), { recursive: true });

  const tmp = `${target}${newSuffix(process.pid, randomBytes(8).toString("hex"))}`;
  const cleanupTmp = (): void => tryUnlink(tmp);
  process.on("exit", cleanupTmp);

  try {
    const fd = openSync(tmp, "wx", 0o755);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!isWindows()) chmodSync(tmp, 0o755); // openSync's mode is filtered by umask

    renameSync(tmp, target);
    fsyncContainingDir(target);
  } catch (err) {
    cleanupTmp();
    throw err;
  } finally {
    process.removeListener("exit", cleanupTmp);
  }
}
