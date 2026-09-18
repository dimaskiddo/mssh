// `mssh config add`: prompts for a new host's connection details, then two
// explicit gates — does this host need a jump host (bastion), and if so
// should a private key be pulled from THAT bastion to authenticate to the
// new host (ProxyJump requires the key to be read locally, not on the
// bastion). Answering no to the first gate makes it a plain host.
// requireSsh() is only called inside the opt-in key-extraction branch — a
// plain add (no jump host) needs no ssh binary at all.
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { configPath, keysDir, loadSettings, resolvePassword, runDir } from "../app-config";
import { loadHosts, saveHosts } from "../store";
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

// Names index.ts dispatches on before ever reaching runConnect — a host with
// one of these names would be silently unreachable via `mssh <name>`.
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

export type NewHostFields = {
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

// Injects `-F <tempConfigPath>` ahead of the ssh target, so ssh resolves the
// new host's connection details from the short-lived temp config instead of
// the real (still-unsaved) one. Keeps remote-keys.ts's RemoteRunner seam
// completely unchanged.
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

// Reaches the JUMP host directly (not the new host — a jump host has no
// ProxyJump of its own, so a single-host temp config resolves it on its
// own) and offers to pull a private key from its ~/.ssh into keysDir().
// Returns the pulled key's local path, meant to become the new host's
// identityFile: ProxyJump authenticates to the far side of the tunnel with a
// key read LOCALLY, which is exactly why it has to be fetched off the
// bastion first — this is a different key from whatever authenticates to
// the bastion itself (DEFAULT_SSH_KEY_PATH), so it always takes precedence
// here. Returns undefined if no keys are found, none is selected, or an
// overwrite is declined; only requireSsh()'s own guidance-and-exit is fatal.
async function extractJumpHostKey(jumpHost: Host, jumpAlias: string): Promise<string | undefined> {
  const sshPath = requireSsh();

  ensureSecureDir(runDir());
  const tmpPath = join(runDir(), tempConfigName(process.pid, randomBytes(8).toString("hex")));
  // listRemoteKeys and downloadRemoteKey are two separate ssh invocations to
  // the same host; without a shared control connection, each re-runs the
  // full auth handshake — twice the MFA prompts for one logical operation.
  const controlPath = join(runDir(), `cm-${randomBytes(8).toString("hex")}`);
  const runner = tempConfigRunner(tmpPath, sshPath);

  // Safety net for a SIGTERM/SIGHUP arriving while suspended at a prompt
  // below: Node's default disposition skips the finally block that would
  // otherwise unlink this temp config (mirrors connect.ts's net).
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      spawnSync(sshPath, ["-S", controlPath, "-O", "exit", jumpAlias], { timeout: REMOTE_COMMAND_TIMEOUT_MS });
    } catch {
      // best-effort; ControlPersist's timeout reaps the socket regardless
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // best-effort; nothing more useful to do at exit time
    }
  };
  process.on("exit", cleanup);

  try {
    const hostForTemp: Host = {
      ...jumpHost,
      extras: [
        ...jumpHost.extras,
        { key: "ControlMaster", value: "auto" },
        { key: "ControlPath", value: `"${controlPath}"` },
        { key: "ControlPersist", value: "30" },
      ],
    };
    writeSecure(tmpPath, serialize([hostForTemp]), undefined, "wx");

    const keys = listRemoteKeys(jumpAlias, runner);
    if (keys.length === 0) {
      console.log(`No keys found on ${jumpAlias}.`);
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
      if (!overwrite) return undefined;
    }

    downloadRemoteKey(jumpAlias, selected, localPath, runner);

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

  // Threads both the chosen Host block and the specific pattern the user
  // picked (a multi-pattern jump host offers several) through to
  // extractJumpHostKey and into the new host's ProxyJump value.
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
      pulledKeyPath = await extractJumpHostKey(jumpSelection.host, jumpSelection.pattern);
    }
  }

  // Only asked when the jump branch produced nothing — a pulled key IS the
  // identity file, so asking for one as well would make the user answer a
  // question whose result is then discarded.
  let identityFile = pulledKeyPath;
  if (identityFile === undefined) {
    identityFile = (
      await promptInput(fieldPrompt(FIELD_LABELS.identityFile), {
        default: settings.DEFAULT_SSH_KEY_PATH,
        validate: (value) => (isValidFieldValue(value) ? true : `${FIELD_LABELS.identityFile} cannot contain a newline.`),
      })
    ).trim();
  }

  const newHost = buildNewHost({ name, hostname, port, user, identityFile, proxyJump: jumpSelection?.pattern });

  const updatedHosts = addHost(existingHosts, newHost);
  try {
    saveHosts(path, updatedHosts, password);
  } catch (err) {
    // pulledKeyPath was written to disk well before this point; a save
    // failure here must not leave it unmentioned, or it sits as an orphan
    // the user never knows to clean up (or reuse) by hand.
    if (pulledKeyPath !== undefined) {
      console.error(`Note: the key pulled from the jump host was saved at ${pulledKeyPath} even though the host was not added.`);
    }
    throw err;
  }

  console.log(`Host '${name}' added.`);
}
