// `mssh config add`: prompts for a new host, with two gates — needs a jump
// host? and if so, pull a key from it (ProxyJump reads the key locally, not
// on the bastion)? requireSsh() runs only inside that opt-in key-pull branch.
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { configPath, keysDir, loadSettings, resolvePassword, runDir } from "../app-config";
import { discoverDefaultKeyPath, listPulledKeys } from "../local-keys";
import { loadHosts, saveHosts } from "../store";
import { materializeKeys, migratePlaintextKeys, reportMigratedKeys } from "../key-store";
import {
  addHost,
  hostsWithoutProxyJump,
  emptyToUndefined,
  serialize,
  isValidFieldValue,
  isValidNewHostName,
  isValidPort,
  hostHasName,
  connectableNames,
  type Host,
} from "../ssh-config";
import { promptInput, promptSelect, promptConfirm } from "../prompt";
import { requireSsh } from "../ssh-binary";
import { ensureSecureDir, writeSecure } from "../secure-file";
import { listRemoteKeys, downloadRemoteKey, localKeyName, type RemoteRunner } from "../remote-keys";
import { tempConfigName } from "./connect";
import { FIELD_LABELS, HOST_ALIAS_LABEL, KEY_PULL_LABEL, fieldPrompt } from "../field-labels";
import { requireExistingConfig } from "./require-config";
import { fatal } from "../exit";

// Names index.ts dispatches on before reaching runConnect — a host with one
// of these would be silently unreachable via `mssh <name>`.
const RESERVED_HOST_NAMES = new Set(["setup", "config", "version", "change-password", "-h", "--help", "--version"]);

// A hung remote in listRemoteKeys/downloadRemoteKey would otherwise block in
// this sync syscall indefinitely — spawnSync itself doesn't process signals
// while blocked, so SIGINT can't interrupt it either.
const REMOTE_COMMAND_TIMEOUT_MS = 15_000;

// userInfo() throws when the running uid has no passwd entry (common in
// containers) — exactly the situation where a usable fallback matters most.
export function defaultUsername(): string {
  try {
    const name = userInfo().username;
    return name === "" ? "root" : name;
  } catch {
    return "root";
  }
}

type NewHostFields = {
  name: string;
  hostname: string;
  port: string;
  user: string;
  identityFile: string;
  proxyJump: string | undefined;
};

export function buildNewHost(fields: NewHostFields): Host {
  return {
    names: [fields.name],
    hostname: emptyToUndefined(fields.hostname),
    port: emptyToUndefined(fields.port),
    user: emptyToUndefined(fields.user),
    identityFile: emptyToUndefined(fields.identityFile),
    proxyJump: fields.proxyJump,
    extras: [],
  };
}

export function tempConfigRunner(tempConfigPath: string, sshPath: string): RemoteRunner {
  return (sshTarget, remoteArgv) => {
    const result = spawnSync(sshPath, ["-F", tempConfigPath, sshTarget, ...remoteArgv], {
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
  return ["-F", tempConfigPath, "-o", "StrictHostKeyChecking=accept-new", jumpAlias, "true"];
}

// Reaches the jump host directly and offers to pull a private key from its
// ~/.ssh into keysDir(). ProxyJump authenticates with a key read LOCALLY,
// which is why it must be fetched off the bastion first, not used from there.
// Runs before requireSsh() and the interactive handshake: a second host behind
// the same bastion should not cost a second password/MFA round trip just to
// rediscover a key that is already in keysDir().
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

async function extractJumpHostKey(jumpHost: Host, jumpAlias: string, password: string): Promise<string | undefined> {
  const reused = await reuseExistingKey(jumpAlias);
  if (reused !== undefined) return reused;

  const sshPath = requireSsh();

  ensureSecureDir(runDir());
  const tmpPath = join(runDir(), tempConfigName(process.pid, randomBytes(8).toString("hex")));
  // Shared control connection avoids re-running the full auth handshake (and MFA) twice.
  const controlPath = join(runDir(), `cm-${randomBytes(8).toString("hex")}`);
  const runner = tempConfigRunner(tmpPath, sshPath);
  const keyTempPaths: string[] = [];

  // Safety net for a signal arriving mid-prompt, which would skip the finally block below (mirrors connect.ts).
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      spawnSync(sshPath, ["-S", controlPath, "-O", "exit", jumpAlias], { timeout: REMOTE_COMMAND_TIMEOUT_MS });
    } catch {
      // best-effort
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // best-effort
    }
    for (const keyTempPath of keyTempPaths) {
      try {
        if (existsSync(keyTempPath)) unlinkSync(keyTempPath);
      } catch {
        // best-effort
      }
    }
  };
  process.on("exit", cleanup);

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
  }
}

// Extracted so RESERVED_HOST_NAMES, the duplicate-name check, and the
// character-class rule are covered directly by tests without spawning
// runAdd's fs/crypto/terminal dependencies.
export function validateNewAlias(value: string, existingHosts: Host[]): true | string {
  if (!isValidNewHostName(value)) {
    return "Use letters, digits, dot, dash or underscore only.";
  }
  if (RESERVED_HOST_NAMES.has(value)) {
    return `"${value}" is reserved by mssh itself and would be unreachable.`;
  }
  if (existingHosts.some((h) => hostHasName(h, value))) {
    return `Host "${value}" already exists.`;
  }
  return true;
}

export async function runAdd(): Promise<void> {
  const loaded = loadSettings();
  const { settings } = loaded;
  const path = configPath(settings);
  requireExistingConfig(path);
  const password = await resolvePassword(loaded, { forcePrompt: false });

  const existingHosts = loadHosts(path, password);
  reportMigratedKeys(migratePlaintextKeys(keysDir(), password).migrated);

  const name = await promptInput(fieldPrompt(HOST_ALIAS_LABEL), {
    validate: (value) => validateNewAlias(value, existingHosts),
  });

  const hostname = (
    await promptInput(fieldPrompt(FIELD_LABELS.hostname), {
      validate: (value) => (isValidFieldValue(value) ? true : `${FIELD_LABELS.hostname} cannot contain a newline.`),
    })
  ).trim();
  const port = await promptInput(fieldPrompt(FIELD_LABELS.port), {
    default: "22",
    validate: (value) => (value === "" || isValidPort(value) ? true : "Port must be a number between 1 and 65535."),
  });
  const user = (
    await promptInput(fieldPrompt(FIELD_LABELS.user), {
      default: defaultUsername(),
      validate: (value) => (isValidFieldValue(value) ? true : `${FIELD_LABELS.user} cannot contain a newline.`),
    })
  ).trim();

  // Threads the chosen host and picked pattern through to extractJumpHostKey and the new host's ProxyJump.
  let jumpSelection: { host: Host; pattern: string } | undefined;

  const needsJumpHost = await promptConfirm(`Does this host require a ${FIELD_LABELS.proxyJump}?`, {
    default: false,
  });
  if (needsJumpHost) {
    const eligibleJumpHosts = hostsWithoutProxyJump(existingHosts);
    const eligiblePatterns = connectableNames(eligibleJumpHosts);
    if (eligiblePatterns.length === 0) {
      fatal(`No eligible ${FIELD_LABELS.proxyJump} exists yet: a jump host must itself have no ProxyJump. Add one first, then re-run 'mssh config add'.`);
    }

    const pattern = await promptSelect<string>(
      fieldPrompt(FIELD_LABELS.proxyJump),
      eligiblePatterns.map((n) => ({ name: n, value: n })),
    );
    // Same independent-matching-rules guard as edit.ts's picker — graver here since this is sealed to disk.
    const host = eligibleJumpHosts.find((h) => hostHasName(h, pattern));
    if (host !== undefined) jumpSelection = { host, pattern };
  }

  let pulledKeyPath: string | undefined;
  if (jumpSelection !== undefined) {
    const wantsExtraction = await promptConfirm(
      `Pull a private key from the ${FIELD_LABELS.proxyJump} to authenticate to this host?`,
      { default: false },
    );
    if (wantsExtraction) {
      pulledKeyPath = await extractJumpHostKey(jumpSelection.host, jumpSelection.pattern, password);
    }
  }

  // Only asked when the jump branch produced nothing — a pulled key IS the identity file.
  let identityFile = pulledKeyPath;
  if (identityFile === undefined) {
    identityFile = (
      await promptInput(fieldPrompt(FIELD_LABELS.identityFile), {
        default: settings.DEFAULT_SSH_KEY_PATH ?? discoverDefaultKeyPath(),
        validate: (value) => (isValidFieldValue(value) ? true : `${FIELD_LABELS.identityFile} cannot contain a newline.`),
      })
    ).trim();
  }

  const newHost = buildNewHost({ name, hostname, port, user, identityFile, proxyJump: jumpSelection?.pattern });

  const updatedHosts = addHost(existingHosts, newHost);
  try {
    saveHosts(path, updatedHosts, password);
  } catch (err) {
    // pulledKeyPath was already written to disk; a save failure must not leave it unmentioned.
    if (pulledKeyPath !== undefined) {
      console.error(`Note: the key pulled from the jump host was saved at ${pulledKeyPath} even though the host was not added.`);
    }
    throw err;
  }

  console.log(`Host '${name}' added.`);
}
