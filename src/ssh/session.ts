// ProxyJump makes ssh re-exec itself as a child with `-F <this same temp
// path>`, long after spawn() below returns — cleanup binds to the parent
// ssh process's exit, never to spawn() itself.
//
// Plaintext in run/ is purged as soon as ssh authenticates, not only at
// exit: ControlPath only opens after ssh_login() returns, and ProxyJump's
// proxy command never forwards -o to the jump child, so mssh's own
// ControlMaster/ControlPath flags (placed first — first -o wins) can't be
// bypassed. Exit/error stay the fallback for auth failure, -G, a user -S,
// an unsafe path, or Windows.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { existsSync, linkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { constants } from "node:os";
import { join } from "node:path";
import { keysDir, runDir } from "../config/paths";
import { ensureSecureDir, writeSecure, tryUnlink } from "../fs/secure-write";
import { tempConfigName, controlPathName } from "../fs/temp-names";
import { materializeKeys } from "../keyring/key-store";
import { requireSsh } from "./ssh-binary";
import { parse, serialize } from "./ssh-config";
import { withKeepAlive, hostsForTarget, type Host } from "./host";
import { rejectedFlags, firstPositional, argvTargets } from "./argv";
import { fatal } from "../core/exit";

// Windows doesn't support SIGTERM semantics the same way, and SIGHUP there
// kills the process ~10s later regardless of handlers — forwarding is pointless there.
export function forwardsTermAndHup(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

export function earlySignals(platform: NodeJS.Platform): NodeJS.Signals[] {
  return forwardsTermAndHup(platform) ? ["SIGINT", "SIGTERM", "SIGHUP"] : ["SIGINT"];
}

// sun_path is 104 (macOS)/108 (Linux) bytes and ssh first binds path plus a
// 17-byte suffix, so leave headroom or ssh dies. `%`/`$` are ControlPath
// tokens and a space would need quoting: reject rather than risk a
// mismatched path.
export function controlPathUsable(path: string): boolean {
  if (Buffer.byteLength(path) + 17 >= 104) return false;
  return /^[A-Za-z0-9._/-]+$/.test(path);
}

// Windows ssh.exe has no ControlMaster (no unix sockets) at all.
export function earlyPurgeUsable(path: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return false;
  return controlPathUsable(path);
}

// A real bind+connect probe: some filesystems (WSL /mnt drvfs, some network
// mounts) let a unix socket file be created but refuse the connect back to
// it, which ssh's own ControlPersist relies on — existsSync alone can't catch that.
export function socketDirUsable(
  dir: string,
  link: (existingPath: string, newPath: string) => void = linkSync,
): Promise<boolean> {
  const bindPath = join(dir, controlPathName(process.pid, randomBytes(8).toString("hex")));
  const linkedPath = join(dir, controlPathName(process.pid, randomBytes(8).toString("hex")));

  return new Promise((resolve) => {
    const server = createServer();
    const finish = (ok: boolean): void => {
      server.close();
      tryUnlink(bindPath);
      tryUnlink(linkedPath);
      resolve(ok);
    };

    server.once("error", () => finish(false));
    server.listen(bindPath, () => {
      // ssh itself binds at a temp name, then link()s it into the real
      // ControlPath and connects through the link — some filesystems (WSL
      // /mnt drvfs) accept the direct bind but refuse connect() through the
      // link, so a probe that skips this step reports a false positive.
      try {
        link(bindPath, linkedPath);
      } catch {
        return finish(false);
      }
      const client = createConnection(linkedPath);
      client.once("connect", () => {
        client.destroy();
        finish(true);
      });
      client.once("error", () => finish(false));
    });
  });
}

// Windows is skipped entirely — no ControlMaster there, so no socket dir is
// ever needed and this must never probe or create one.
export async function pickControlSocketDir(
  runDirPath: string,
  fallback: string | undefined,
  probe: (dir: string) => Promise<boolean> = socketDirUsable,
  ensureDir: (dir: string) => void = ensureSecureDir,
): Promise<string> {
  if (await probe(runDirPath)) return runDirPath;

  if (fallback !== undefined) {
    ensureDir(fallback);
    if (await probe(fallback)) return fallback;
  }

  throw new Error(
    "control sockets don't work in ~/.mssh/run (e.g. a WSL /mnt drive) and no usable $XDG_RUNTIME_DIR " +
      "or /run/user/<uid> was found — move ~/.mssh onto a Linux filesystem.",
  );
}

// 128 + signal number, so scripts see the same exit code ssh/bash would give.
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

// Single entry for every path that writes plaintext config, so
// rejectedFlags()/requireSsh() guard all of them.
export function connectWithRaw(raw: string, argv: string[], password: string, spawnFn: SpawnFn = spawn, hosts?: Host[]): void {
  const rejected = rejectedFlags(argv);
  if (rejected !== undefined) {
    throw new Error(`refusing to pass ${rejected} through: it would override the managed config`);
  }

  const sshPath = requireSsh(); // before any plaintext ever touches disk

  ensureSecureDir(runDir());
  const tmpPath = join(runDir(), tempConfigName(process.pid, randomBytes(8).toString("hex")));
  const controlPath = join(runDir(), controlPathName(process.pid, randomBytes(8).toString("hex")));
  const usePurge = earlyPurgeUsable(controlPath, process.platform);
  const keyTempPaths: string[] = [];

  let pollTimer: ReturnType<typeof setInterval> | undefined;

  // Registered before writeSecure(), not after, so the temp file is cleaned
  // up even if the write or its permission lockdown fails partway.
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (pollTimer !== undefined) clearInterval(pollTimer);
    tryUnlink(tmpPath);
    for (const keyTempPath of keyTempPaths) tryUnlink(keyTempPath);
    if (usePurge) tryUnlink(controlPath);
  };
  process.on("exit", cleanup);

  // Before ssh exists to forward a signal to, an unhandled one must still
  // purge what's already on disk: Bun's default disposition for SIGINT/TERM/HUP
  // terminates without running the "exit" handler above, so this isn't redundant.
  const signals = earlySignals(process.platform);
  const earlyHandlers = new Map(
    signals.map((signal) => [signal, () => { cleanup(); process.exit(childExitCode(null, signal)); }] as const),
  );
  for (const [signal, handler] of earlyHandlers) process.on(signal, handler);

  // Scoped to only the target plus its ProxyJump chain — this file sits in
  // plaintext on disk for the session, and untouched hosts stay encrypted at rest.
  const allHosts = hosts ?? parse(raw);
  const targets = argvTargets(argv, allHosts);

  // A target matching no alias would silently drop its ProxyJump: fail loudly instead.
  if (targets.length === 0) {
    const candidate = firstPositional(argv);
    if (candidate !== undefined) {
      throw new Error(`"${candidate}" is not a configured host alias — connecting would silently drop its ProxyJump`);
    }
  }

  const targetHosts = materializeKeys(hostsForTarget(allHosts, targets), password, keysDir(), runDir(), keyTempPaths);
  const scoped = serialize(withKeepAlive(targetHosts));

  // "wx" so a pre-existing file at this path is an error, never silently
  // written through. Do not relax to "w".
  writeSecure(tmpPath, scoped, undefined, "wx");

  const controlArgs = usePurge ? ["-o", "ControlMaster=yes", "-o", `ControlPath=${controlPath}`] : [];
  const child = spawnFn(sshPath, ["-F", tmpPath, ...controlArgs, ...argv], { stdio: "inherit" });

  if (usePurge) {
    pollTimer = setInterval(() => {
      if (existsSync(controlPath)) cleanup();
    }, 100);
    pollTimer.unref();
  }

  for (const [signal, handler] of earlyHandlers) process.removeListener(signal, handler);
  const forwardHandlers = new Map(signals.map((signal) => [signal, () => child.kill(signal)] as const));
  for (const [signal, handler] of forwardHandlers) process.on(signal, handler);

  // Removes every listener this call added — matters only for a process that
  // runs connectWithRaw more than once (tests), where they'd otherwise pile up.
  const detachListeners = (): void => {
    process.removeListener("exit", cleanup);
    for (const [signal, handler] of forwardHandlers) process.removeListener(signal, handler);
  };

  child.on("exit", (code, signal) => {
    cleanup();
    detachListeners();
    process.exit(childExitCode(code, signal));
  });

  // Genuine spawn failure only — no session was ever established, so this
  // can't race the ProxyJump re-exec case.
  child.on("error", (err) => {
    cleanup();
    detachListeners();
    fatal(`failed to run ssh: ${err.message}`);
  });
}
