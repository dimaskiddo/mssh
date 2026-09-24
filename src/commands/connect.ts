// `mssh <host> [ssh flags...]`: decrypts the config to a temp file and execs
// real ssh against it. ProxyJump makes ssh re-exec itself as a CHILD process
// with `-F <this same temp path>`, long after spawn() below returns — so
// cleanup binds to the parent ssh process's exit, never to spawn() itself.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { constants } from "node:os";
import { join } from "node:path";
import { configPath, keysDir, loadSettings, resolvePassword, runDir } from "../app-config";
import { ensureSecureDir, writeSecure } from "../secure-file";
import { loadRaw } from "../store";
import { materializeKeys } from "../key-store";
import { requireSsh } from "../ssh-binary";
import {
  parse,
  serialize,
  withKeepAlive,
  hostsForTarget,
  normalizeDirectiveKey,
  REFUSED_DIRECTIVES,
  isPermitLocalCommandNo,
  type Host,
} from "../ssh-config";
import { requireExistingConfig } from "./require-config";
import { fatal } from "../exit";

// Windows doesn't support SIGTERM semantics the same way, and SIGHUP there
// kills the process ~10s later regardless of handlers — forwarding is pointless there.
export function forwardsTermAndHup(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

// Pure: temp config filename. The suffix must come from crypto randomness
// (randomBytes), never a counter, pid or timestamp.
export function tempConfigName(pid: number, randomSuffix: string): string {
  return `cfg-${pid}-${randomSuffix}`;
}

// ssh lets -F redirect the connection entirely, and an -o naming a
// REFUSED_DIRECTIVES option can make it execute a program or load a file —
// not a full getopt, but fails closed on the two flags that can redirect ssh.
export function rejectedFlags(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!/^-[A-Za-z0-9]*[Fo]/.test(arg)) continue;

    if (/^-[A-Za-z0-9]*F/.test(arg)) return arg;

    const after = arg.slice(arg.indexOf("o") + 1);
    const optionValue = after !== "" ? after : argv[i + 1];
    const parts = optionValue?.split(/[\s=]/);
    const rawName = parts?.[0];
    const name = rawName === undefined ? undefined : normalizeDirectiveKey(rawName);
    if (name === undefined) continue;
    const lowerName = name.toLowerCase();
    if (!REFUSED_DIRECTIVES.has(lowerName)) continue;
    // See isPermitLocalCommandNo (ssh-config.ts) — parts[1] is intentionally undecoded here.
    if (isPermitLocalCommandNo(lowerName, parts?.[1])) continue;
    return arg;
  }
  return undefined;
}

// Pure: mirrors shell exit-code convention (128 + signal number) instead of
// collapsing every signal death to a flat 1, so scripts inspecting mssh's
// exit code see the same convention ssh/bash itself uses.
export function childExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) {
    const signalNumber = constants.signals[signal];
    if (signalNumber !== undefined) return 128 + signalNumber;
  }
  return 1;
}

// Injectable so temp-file cleanup and signal forwarding are testable without
// spawning a real ssh process.
export type SpawnFn = (command: string, args: string[], options: { stdio: "inherit" }) => ChildProcess;

// ssh's argv mixes flags and the target in any order; matching every token
// against configured aliases avoids reimplementing ssh's own getopt.
function argvTargets(argv: string[], hosts: Host[]): string[] {
  const names = new Set(hosts.flatMap((h) => h.names));
  return argv.filter((arg) => names.has(arg));
}

// Shared by runConnect and list.ts's bare-`mssh` picker, so every path that
// writes plaintext to disk is guarded by rejectedFlags()/requireSsh() the same way.
export function connectWithRaw(raw: string, argv: string[], password: string, spawnFn: SpawnFn = spawn, hosts?: Host[]): void {
  const rejected = rejectedFlags(argv);
  if (rejected !== undefined) {
    throw new Error(`refusing to pass ${rejected} through: it would override the managed config`);
  }

  const sshPath = requireSsh(); // before any plaintext ever touches disk

  ensureSecureDir(runDir());
  const tmpPath = join(runDir(), tempConfigName(process.pid, randomBytes(8).toString("hex")));
  const keyTempPaths: string[] = [];

  // Registered before writeSecure(), not after, so the temp file is cleaned
  // up even if the write or its permission lockdown fails partway.
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // best-effort; nothing more useful to do at exit time
    }
    for (const keyTempPath of keyTempPaths) {
      try {
        if (existsSync(keyTempPath)) unlinkSync(keyTempPath);
      } catch {
        // best-effort; nothing more useful to do at exit time
      }
    }
  };
  process.on("exit", cleanup); // portable safety net, covers writeSecure() failures too

  // Scoped to only the target plus its ProxyJump chain — this file sits in
  // plaintext on disk for the session, and untouched hosts stay encrypted at rest.
  const allHosts = hosts ?? parse(raw);
  const targets = argvTargets(argv, allHosts);

  // A target matching no alias silently drops its ProxyJump/bastion — this
  // turns that into a loud failure. Heuristic: names the first non-flag token.
  if (targets.length === 0) {
    const candidate = argv.find((arg) => !arg.startsWith("-"));
    if (candidate !== undefined) {
      throw new Error(`"${candidate}" is not a configured host alias — connecting would silently drop its ProxyJump`);
    }
  }

  // Decrypts each scoped host's managed key (if sealed) into runDir and
  // rewrites IdentityFile to the temp copy — only for the temp config below,
  // never for anything saveHosts writes back to the sealed config.
  const targetHosts = materializeKeys(hostsForTarget(allHosts, targets), password, keysDir(), runDir(), keyTempPaths);
  const scoped = serialize(withKeepAlive(targetHosts));

  // "wx" so a pre-existing file at this path is an error, never silently
  // written through. Do not relax to "w".
  writeSecure(tmpPath, scoped, undefined, "wx");

  const child = spawnFn(sshPath, ["-F", tmpPath, ...argv], { stdio: "inherit" });

  process.on("SIGINT", () => child.kill("SIGINT"));
  if (forwardsTermAndHup(process.platform)) {
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    process.on("SIGHUP", () => child.kill("SIGHUP"));
  }

  // Called early (as soon as ssh exits) rather than waiting on process unwind;
  // cleanup() is idempotent so both firing is harmless.
  child.on("exit", (code, signal) => {
    cleanup();
    process.exit(childExitCode(code, signal));
  });

  // Genuine spawn failure only — no session was ever established, so this
  // can't race the ProxyJump re-exec case.
  child.on("error", (err) => {
    cleanup();
    fatal(`failed to run ssh: ${err.message}`);
  });
}

export async function runConnect(argv: string[], spawnFn: SpawnFn = spawn): Promise<void> {
  const loaded = loadSettings();
  const path = configPath(loaded.settings);
  requireExistingConfig(path);
  const password = await resolvePassword(loaded, { forcePrompt: false });
  const raw = loadRaw(path, password);

  connectWithRaw(raw, argv, password, spawnFn);
}
