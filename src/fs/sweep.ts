// SIGKILL/OOM skip the exit-time cleanup entirely, and orphans only become
// visible on some later run — hence start-of-run, not at-exit.
import { existsSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CFG_NAME, KEY_NAME, CM_NAME, TMP_NAME, BIN_LEFTOVER_NAME, cfgPid, keyPid, cmPid, tmpPid, binLeftoverPid } from "./temp-names";

// process.kill(pid, 0) only probes: ESRCH means gone, EPERM means owned by
// another user but still alive.
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// pidOf returning undefined means the name carries no pid to check — always stale.
export function staleNames(
  names: string[],
  pidOf: (name: string) => number | undefined,
  alive: (pid: number) => boolean,
): string[] {
  return names.filter((name) => {
    const pid = pidOf(name);
    return pid === undefined || !alive(pid);
  });
}

function sweepDir(dir: string, matches: (name: string) => boolean, pidOf: (name: string) => number | undefined): void {
  if (!existsSync(dir)) return;

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // best-effort
  }

  for (const name of staleNames(names.filter(matches), pidOf, isPidAlive)) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // best-effort
    }
  }
}

// configDir may be shared with other tools (it's wherever the user points
// MSSH_CONFIG_PATH), so its .tmp- sweep is scoped to this config's own
// basename. keysDir is ours alone, so every .tmp- name there is fair game.
export function sweepOrphanedTempFiles(runDir: string, configPath: string, keysDir: string): void {
  sweepDir(
    runDir,
    (name) => CFG_NAME.test(name) || KEY_NAME.test(name) || CM_NAME.test(name),
    (name) => cfgPid(name) ?? keyPid(name) ?? cmPid(name),
  );

  const tmpPrefix = `${basename(configPath)}.tmp-`;
  sweepDir(dirname(configPath), (name) => name.startsWith(tmpPrefix) && TMP_NAME.test(name), tmpPid);
  sweepDir(keysDir, (name) => TMP_NAME.test(name), tmpPid);
}

// A running executable can't delete its own old copy (POSIX leaves the
// hard-link backup linked, Windows can't touch the locked .exe at all), so
// this runs on the next invocation instead. Call only when
// isCompiledBinary(Bun.main): under `bun index.ts` this directory is bun's
// own install, not mssh's.
//
// Scoped to `<our own basename>.old-*`/`.new-*` only — binDir is a shared
// location like /usr/local/bin, and matching the suffix pattern alone would
// let this delete another program's same-shaped leftover file.
export function sweepBinaryLeftovers(execPath: string): void {
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return; // best-effort: unresolvable path just means nothing to sweep
  }

  const prefix = `${basename(real)}.`;
  sweepDir(dirname(real), (name) => name.startsWith(prefix) && BIN_LEFTOVER_NAME.test(name), binLeftoverPid);
}
