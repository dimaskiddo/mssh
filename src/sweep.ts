// Best-effort start-of-run cleanup for files a killed mssh process leaves
// behind. writeSecureAtomic's own process.on("exit") net (secure-file.ts)
// only fires on a graceful shutdown — SIGKILL, SIGQUIT/SIGABRT, and an OOM
// kill still leave orphans that no running process will ever clean up, and
// they only become visible on some *later* invocation, which is why this
// runs at start-of-run rather than at exit. connect.ts's run-dir temp
// configs are plaintext; store.ts's config-directory .tmp-* siblings are
// sealed ciphertext under whatever password wrote them — clutter removal
// either way, not a secrecy fix.
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

// Pure so "skip a file whose pid is live" is unit-testable without real
// processes or a filesystem. pidOf returning undefined means the name
// carries no pid to check — always stale.
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
    return; // best-effort; a listing failure here is not this function's problem
  }

  for (const name of staleNames(names.filter(matches), pidOf, isPidAlive)) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // best-effort; a concurrent delete or permission error is not fatal here
    }
  }
}

// Called once per invocation, before any command touches ~/.mssh — mirrors
// index.ts's migrateLegacyConfig() placement.
export function sweepOrphanedTempFiles(runDir: string, configDir: string): void {
  sweepDir(runDir, (name) => CFG_NAME.test(name), cfgPid);
  sweepDir(configDir, (name) => TMP_NAME.test(name), tmpPid);
}
