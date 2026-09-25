// Best-effort start-of-run cleanup for files a killed mssh process leaves
// behind. SIGKILL/OOM skip secure-file.ts's own exit-time cleanup entirely, and
// orphans only become visible on some later run — hence start-of-run, not at-exit.
import { existsSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
const KEY_NAME = /^key-(\d+)-[0-9a-f]+$/;
const CM_NAME = /^cm-(\d+)-[0-9a-f]+$/;
const TMP_NAME = /\.tmp-(\d+)-[0-9a-f]+$/;
const BIN_LEFTOVER_NAME = /\.(?:old|new)-(\d+)-[0-9a-f]+$/;

// Matches connect.ts's tempConfigName() convention.
export function cfgPid(name: string): number | undefined {
  const digits = CFG_NAME.exec(name)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

// Matches key-store.ts's keyTempName() convention.
export function keyPid(name: string): number | undefined {
  const digits = KEY_NAME.exec(name)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

// Matches connect.ts's controlPathName() convention. add.ts's own pid-less
// cm-<hex> control sockets never match this and are left alone.
export function cmPid(name: string): number | undefined {
  const digits = CM_NAME.exec(name)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

// Matches writeSecureAtomic's tmp-file convention.
export function tmpPid(name: string): number | undefined {
  const digits = TMP_NAME.exec(name)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

// Matches replaceExecutable's .old-/.new- convention.
export function binLeftoverPid(name: string): number | undefined {
  const digits = BIN_LEFTOVER_NAME.exec(name)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

// Compiled Bun executables mount their bundled files under this virtual FS
// (verified against a real `bun build --compile` output); Windows compiled
// binaries use a "~BUN" marker instead. False under `bun index.ts`, where
// process.execPath is the bun binary itself, not mssh.
export function isCompiledBinary(main: string): boolean {
  return main.startsWith("/$bunfs/") || main.includes("~BUN");
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
export function sweepOrphanedTempFiles(runDir: string, configDir: string, keysDir: string): void {
  sweepDir(
    runDir,
    (name) => CFG_NAME.test(name) || KEY_NAME.test(name) || CM_NAME.test(name),
    (name) => cfgPid(name) ?? keyPid(name) ?? cmPid(name),
  );
  sweepDir(configDir, (name) => TMP_NAME.test(name), tmpPid);
  sweepDir(keysDir, (name) => TMP_NAME.test(name), tmpPid);
}

// A running executable can't delete its own old copy (POSIX leaves the
// hard-link backup linked, Windows can't touch the locked .exe at all), so
// this runs on the next invocation instead — same deferred-cleanup shape as
// sweepOrphanedTempFiles. Call only when isCompiledBinary(Bun.main): under
// `bun index.ts` this directory is bun's own install, not mssh's.
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
