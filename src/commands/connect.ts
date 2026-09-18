// `mssh <host> [ssh flags...]`: decrypts the config to a temp file and execs
// real ssh against it. The temp file MUST outlive the parent ssh process's
// entire run, not just the spawn() call — see the header note below on why.
//
// ProxyJump: OpenSSH does not handle ProxyJump in-process. When the target
// host has ProxyJump, ssh rewrites it into a ProxyCommand that re-execs the
// ssh binary as a CHILD process, invoked with `-F <this same temp path>`.
// That child does not start until the connection is actually being
// established — well after spawn() below returns control to us. Deleting
// the temp file right after spawn() would make that child ssh fail with a
// missing config. So cleanup is wired to the parent ssh process's actual
// exit (plus a process-exit safety net), never to the spawn() call itself.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { constants } from "node:os";
import { join } from "node:path";
import { configPath, loadSettings, resolvePassword, runDir } from "../app-config";
import { ensureSecureDir, writeSecure } from "../secure-file";
import { loadRaw } from "../store";
import { requireSsh } from "../ssh-binary";
import { parse, serialize, withKeepAlive, hostsForTarget, EXECUTING_DIRECTIVES, type Host } from "../ssh-config";

// Pure: does this platform get SIGTERM/SIGHUP forwarding? Windows doesn't
// support SIGTERM semantics the same way, and SIGHUP there kills the process
// ~10s later regardless of handlers, so forwarding it is pointless/harmful.
// This is a signal-forwarding concern, distinct from secure-file.ts's
// permission-enforcement platform check (chmod vs icacls) and ssh-binary.ts's
// install-guidance platform check — each module owns its own unrelated use
// of process.platform.
export function forwardsTermAndHup(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

// Pure: temp config filename. The suffix must come from crypto randomness
// (randomBytes), never a counter, pid or timestamp.
export function tempConfigName(pid: number, randomSuffix: string): string {
  return `cfg-${pid}-${randomSuffix}`;
}

// ssh lets -F redirect the connection entirely, and an -o naming any
// EXECUTING_DIRECTIVES option make ssh run an arbitrary program — both would
// subvert the temp config we just wrote, so both are refused. Handles the
// attached (`-Fpath`, `-oProxyCommand=...`) and separate (`-F path`,
// `-o ProxyCommand=...`) forms. Same deny-list ssh-config.ts enforces on the
// config-file side, imported rather than duplicated so the two surfaces
// cannot drift apart.
export function rejectedFlags(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;

    if (arg === "-F" || (arg.startsWith("-F") && arg !== "-F")) return arg;

    const inlineValue = arg.startsWith("-o") && arg.length > 2 ? arg.slice(2) : undefined;
    const separateValue = arg === "-o" ? argv[i + 1] : undefined;
    const optionValue = inlineValue ?? separateValue;
    const optionName = optionValue?.split("=")[0]?.trim().toLowerCase();
    if (optionName !== undefined && EXECUTING_DIRECTIVES.has(optionName)) {
      return arg;
    }
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

// ssh's argv mixes flags, flag values and the target in any order (`mssh -G
// myserver` is documented usage), and we deliberately do not reimplement
// ssh's getopt to find the positional. Matching every argv token against the
// configured aliases is enough: a token that is not an alias selects nothing,
// and the worst case is including a host whose name you typed yourself.
export function argvTargets(argv: string[], hosts: Host[]): string[] {
  const names = new Set(hosts.map((h) => h.name));
  return argv.filter((arg) => names.has(arg));
}

// Shared by runConnect and the bare-`mssh` picker (list.ts's runListConnect),
// which already holds a decrypted config from building its host list and
// must not prompt or decrypt a second time. rejectedFlags()/requireSsh()
// live here, not in the caller, so every path that writes plaintext to disk
// is guarded the same way regardless of how it got the raw config.
export async function connectWithRaw(raw: string, argv: string[], spawnFn: SpawnFn = spawn): Promise<void> {
  const rejected = rejectedFlags(argv);
  if (rejected !== undefined) {
    throw new Error(`refusing to pass ${rejected} through: it would override the managed config`);
  }

  const sshPath = requireSsh(); // before any plaintext ever touches disk

  ensureSecureDir(runDir());
  const tmpPath = join(runDir(), tempConfigName(process.pid, randomBytes(8).toString("hex")));

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
  };
  process.on("exit", cleanup); // portable safety net, covers writeSecure() failures too

  // Scoped to only what this connection needs (the target plus its ProxyJump
  // chain), not the whole decrypted config: this file sits in plaintext on
  // disk for the life of the session, and the tool's whole premise is that
  // hosts you're not touching stay encrypted at rest.
  const allHosts = parse(raw);
  const scoped = serialize(withKeepAlive(hostsForTarget(allHosts, argvTargets(argv, allHosts))));

  // "wx" so a pre-existing file at this path is an error, never silently
  // written through. Do not relax to "w".
  writeSecure(tmpPath, scoped, undefined, "wx");

  const child = spawnFn(sshPath, ["-F", tmpPath, ...argv], { stdio: "inherit" });

  process.on("SIGINT", () => child.kill("SIGINT"));
  if (forwardsTermAndHup(process.platform)) {
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    process.on("SIGHUP", () => child.kill("SIGHUP"));
  }

  // Same cleanup() as the process-exit net above, called early (as soon as
  // ssh itself has actually exited) rather than waiting for our own process
  // to unwind — cleanup() is idempotent so both firing is harmless.
  child.on("exit", (code, signal) => {
    cleanup();
    process.exit(childExitCode(code, signal));
  });

  // Genuine spawn failure only (e.g. ssh disappeared between requireSsh()'s
  // check and this call) — no session was ever established, so cleaning up
  // here can't race the ProxyJump re-exec case.
  child.on("error", (err) => {
    cleanup();
    console.error(`failed to run ssh: ${err.message}`);
    process.exit(1);
  });
}

export async function runConnect(argv: string[], spawnFn: SpawnFn = spawn): Promise<void> {
  const { settings } = loadSettings();
  const path = configPath(settings);
  const password = await resolvePassword({ forcePrompt: false });
  const raw = loadRaw(path, password);

  await connectWithRaw(raw, argv, spawnFn);
}
