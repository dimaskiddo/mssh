// ProxyJump authenticates with a key read locally, so `config add` must
// fetch it off the bastion before the new host is ever reached.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { keysDir, runDir, socketFallbackDir } from "../config/paths";
import { serialize } from "../ssh/ssh-config";
import { type Host } from "../ssh/host";
import { promptSelect, promptConfirm } from "../cli/prompt";
import { requireSsh } from "../ssh/ssh-binary";
import { earlySignals, childExitCode, controlPathUsable, pickControlSocketDir } from "../ssh/session";
import { ensureSecureDir, writeSecure, tryUnlink } from "../fs/secure-write";
import { listRemoteKeys, downloadRemoteKey, localKeyName, type RemoteRunner } from "./remote-keys";
import { tempConfigName, controlPathName } from "../fs/temp-names";
import { FIELD_LABELS, KEY_PULL_LABEL, fieldPrompt } from "../cli/field-labels";
import { materializeKeys } from "./key-store";
import { listPulledKeys } from "./local-keys";

// A hung remote in listRemoteKeys/downloadRemoteKey would otherwise block in
// this sync syscall indefinitely — spawnSync itself doesn't process signals
// while blocked, so SIGINT can't interrupt it either.
const REMOTE_COMMAND_TIMEOUT_MS = 15_000;

export function tempConfigRunner(tempConfigPath: string, sshPath: string): RemoteRunner {
  return (sshTarget, remoteArgv) => {
    // "--" guards sshTarget from being read as an option — defense in depth,
    // since isValidHostName already rejects a '-'-prefixed alias at save time.
    const result = spawnSync(sshPath, ["-F", tempConfigPath, "--", sshTarget, ...remoteArgv], {
      encoding: "buffer",
      timeout: REMOTE_COMMAND_TIMEOUT_MS,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: result.stderr ? result.stderr.toString("utf8").trim() : "",
      error: result.error,
    };
  };
}

// accept-new records an unknown bastion key instead of asking a question that
// a piped `ls`/`cat` could never answer. Scoped to this one argv, never the
// temp config, so downloadRemoteKey's cat still runs under strict checking.
export function preflightArgv(tempConfigPath: string, jumpAlias: string): string[] {
  return ["-F", tempConfigPath, "-o", "StrictHostKeyChecking=accept-new", "--", jumpAlias, "true"];
}

// "-F none" is OpenSSH's own "read no config files" switch — without it ssh
// falls back to parsing the user's real ~/.ssh/config for this teardown call,
// which may carry directives (e.g. Match exec) mssh never agreed to run.
export function controlExitArgv(controlPath: string, jumpAlias: string): string[] {
  return ["-F", "none", "-S", controlPath, "-O", "exit", "--", jumpAlias];
}

// `ssh -O exit` can itself fail (e.g. the socket never connected in the first
// place, per the drvfs bug this fixes), so the unlink always runs regardless
// — otherwise the socket file, and the backgrounded ControlPersist master
// behind it, both leak.
export function closeControlMaster(controlPath: string, jumpAlias: string, runExit: () => void): void {
  try {
    runExit();
  } catch {
    // best-effort
  }
  tryUnlink(controlPath);
}

// Checked before requireSsh() and the handshake: a second host behind the
// same bastion shouldn't cost another password/MFA round trip.
async function reuseExistingKey(jumpAlias: string): Promise<string | undefined> {
  const existing = listPulledKeys(jumpAlias);
  if (existing.length === 0) return undefined;

  if (existing.length === 1) {
    const only = existing[0] as string;
    const reuse = await promptConfirm(`A key from ${jumpAlias} was already pulled to ${only}. Use it?`, {
      default: true,
    });
    return reuse ? only : undefined;
  }

  return await promptSelect<string | undefined>(fieldPrompt(KEY_PULL_LABEL), [
    ...existing.map((p) => ({ name: p, value: p as string | undefined })),
    { name: "(pull a new key from the jump host)", value: undefined },
  ]);
}

export async function extractJumpHostKey(jumpHost: Host, jumpAlias: string, password: string): Promise<string | undefined> {
  const reused = await reuseExistingKey(jumpAlias);
  if (reused !== undefined) return reused;

  const sshPath = requireSsh();

  ensureSecureDir(runDir());
  const tmpPath = join(runDir(), tempConfigName(process.pid, randomBytes(8).toString("hex")));
  // Shared control connection avoids re-running the full auth handshake (and MFA) twice.
  // ControlPersist backgrounds the master and the foreground ssh then connects
  // *back* through this socket, so the directory must actually support unix
  // sockets (some mounts, e.g. WSL /mnt drvfs, let the file be created but
  // refuse the connect) — pickControlSocketDir probes for that and falls
  // back to $XDG_RUNTIME_DIR/mssh rather than let ssh die with a confusing
  // "Connection refused".
  const socketDir = await pickControlSocketDir(runDir(), socketFallbackDir());
  const controlPath = join(socketDir, controlPathName(process.pid, randomBytes(8).toString("hex")));
  // Fail fast, before any sensitive work, rather than let ssh die mid-handshake
  // on an obscure sun_path error.
  if (!controlPathUsable(controlPath)) {
    throw new Error(`control socket path is too long for ssh's ControlPath socket limit: ${controlPath}`);
  }
  const runner = tempConfigRunner(tmpPath, sshPath);
  const keyTempPaths: string[] = [];

  // Safety net for a signal arriving mid-prompt, which would skip the finally block below.
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    closeControlMaster(controlPath, jumpAlias, () => {
      spawnSync(sshPath, controlExitArgv(controlPath, jumpAlias), { timeout: REMOTE_COMMAND_TIMEOUT_MS });
    });
    tryUnlink(tmpPath);
    for (const keyTempPath of keyTempPaths) tryUnlink(keyTempPath);
  };
  process.on("exit", cleanup);

  // Every ssh call here is a blocking spawnSync, so there's no live child to
  // forward to — an unhandled signal must run cleanup() itself and exit.
  const signals = earlySignals(process.platform);
  const signalHandlers = new Map(
    signals.map((signal) => [signal, () => { cleanup(); process.exit(childExitCode(null, signal)); }] as const),
  );
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);

  try {
    // The bastion's own IdentityFile may itself be a sealed pulled key —
    // materialize it before ssh ever tries to read it for this handshake.
    const [materializedJumpHost] = materializeKeys([jumpHost], password, keysDir(), runDir(), keyTempPaths);
    const hostForTemp: Host = {
      ...(materializedJumpHost ?? jumpHost),
      extras: [
        ...jumpHost.extras,
        { key: "ControlMaster", value: "auto" },
        { key: "ControlPath", value: `"${controlPath}"` },
        { key: "ControlPersist", value: "300" },
      ],
    };
    writeSecure(tmpPath, serialize([hostForTemp]), undefined, "wx");

    // Interactive and unbounded: the user answers ssh's host-key, password and
    // MFA prompts here, so the piped ls/cat below inherit a live ControlMaster
    // socket and never need a terminal of their own.
    console.log(`Connecting to ${jumpAlias} to look for keys...`);
    const handshake = spawnSync(sshPath, preflightArgv(tmpPath, jumpAlias), { stdio: "inherit" });
    if (handshake.error) {
      throw new Error(`failed to run ssh for ${jumpAlias}: ${handshake.error.message}`);
    }
    if (handshake.status !== 0) {
      throw new Error(
        `could not open a connection to ${jumpAlias} (ssh exited ${handshake.status}). ` +
          `Check the ${FIELD_LABELS.proxyJump}'s hostname, user and identity file with 'mssh config edit ${jumpAlias}'.`,
      );
    }

    // Authenticated: the ControlPersist master keeps the bastion's own key
    // from ever being needed again for this handshake's ls/cat calls, so the
    // decrypted jump-host key needn't sit in run/ for the rest of this flow.
    for (const keyTempPath of keyTempPaths) tryUnlink(keyTempPath);
    keyTempPaths.length = 0;

    const keys = listRemoteKeys(jumpAlias, runner);
    if (keys.length === 0) {
      console.log(
        `No private keys found in ${jumpAlias}:~/.ssh ` +
          `(public keys, authorized_keys, config and known_hosts are not offered).`,
      );
      return undefined;
    }

    const selected = await promptSelect<string | undefined>(fieldPrompt(KEY_PULL_LABEL), [
      { name: "(skip)", value: undefined },
      ...keys.map((k) => ({ name: k, value: k })),
    ]);
    if (selected === undefined) return undefined;

    const localName = localKeyName(jumpAlias, selected);
    ensureSecureDir(keysDir());
    const localPath = join(keysDir(), localName);

    if (existsSync(localPath)) {
      const overwrite = await promptConfirm(`${localPath} already exists. Overwrite?`, { default: false });
      // Declining means "keep what's there" — that file is this bastion's key,
      // so hand it back rather than dropping through to a manual path prompt.
      if (!overwrite) return localPath;
    }

    downloadRemoteKey(jumpAlias, selected, localPath, runner, password);

    return localPath;
  } finally {
    cleanup();
    process.removeListener("exit", cleanup);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  }
}
