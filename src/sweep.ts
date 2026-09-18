// Best-effort start-of-run cleanup for files a killed mssh process leaves
// behind. SIGKILL/OOM skip secure-file.ts's own exit-time cleanup entirely, and
// orphans only become visible on some later run — hence start-of-run, not at-exit.
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// process.kill(pid, 0) sends no signal, only probes: throws ESRCH if the pid
// doesn't exist. EPERM means it exists but is owned by another user — still
// alive, must not be swept.
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

const CFG_NAME = /^cfg-(\d+)-[0-9a-f]+$/;
const TMP_NAME = /\.tmp-(\d+)-[0-9a-f]+$/;

// Matches connect.ts's tempConfigName() convention.
export function cfgPid(name: string): number | undefined {
  const digits = CFG_NAME.exec(name)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

// Matches writeSecureAtomic's tmp-file convention.
export function tmpPid(name: string): number | undefined {
  const digits = TMP_NAME.exec(name)?.[1];
  return digits === undefined ? undefined : Number(digits);
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

// Called once per invocation, before any command touches ~/.mssh — mirrors
// index.ts's migrateLegacyConfig() placement.
export function sweepOrphanedTempFiles(runDir: string, configDir: string): void {
  sweepDir(runDir, (name) => CFG_NAME.test(name), cfgPid);
  sweepDir(configDir, (name) => TMP_NAME.test(name), tmpPid);
}
