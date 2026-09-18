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
  isValidHostName,
  type Host,
} from "../ssh-config";
import { promptInput, promptSelect, promptConfirm } from "../prompt";
import { requireSsh } from "../ssh-binary";
import { ensureSecureDir, writeSecure } from "../secure-file";
import { listRemoteKeys, downloadRemoteKey, localKeyName, type RemoteRunner } from "../remote-keys";
import { tempConfigName } from "./connect";
import { FIELD_LABELS, HOST_ALIAS_LABEL, KEY_PULL_LABEL, fieldPrompt } from "../field-labels";
import { requireExistingConfig } from "./require-config";

// Names index.ts dispatches on before ever reaching runConnect — a host with
// one of these names would be silently unreachable via `mssh <name>`.
const RESERVED_HOST_NAMES = new Set(["setup", "config", "version", "change-password"]);

function requireValidFieldValue(label: string, value: string): void {
  if (!isValidFieldValue(value)) {
    console.error(`${label} cannot contain a newline.`);
    process.exit(1);
  }
}

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
    name: fields.name,
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
    const result = spawnSync(sshPath, ["-F", tempConfigPath, sshTarget, ...remoteArgv], { encoding: "buffer" });
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
async function extractJumpHostKey(jumpHost: Host): Promise<string | undefined> {
  const sshPath = requireSsh();

  ensureSecureDir(runDir());
  const tmpPath = join(runDir(), tempConfigName(process.pid, randomBytes(8).toString("hex")));
  const runner = tempConfigRunner(tmpPath, sshPath);

  // Safety net for a SIGTERM/SIGHUP arriving while suspended at a prompt
  // below: Node's default disposition skips the finally block that would
  // otherwise unlink this temp config (mirrors connect.ts's net).
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
  process.on("exit", cleanup);

  try {
    writeSecure(tmpPath, serialize([jumpHost]), undefined, "wx");

    const keys = listRemoteKeys(jumpHost.name, runner);
    if (keys.length === 0) {
      console.log(`No keys found on ${jumpHost.name}.`);
      return undefined;
    }

    const selected = await promptSelect<string | undefined>(fieldPrompt(KEY_PULL_LABEL), [
      { name: "(skip)", value: undefined },
      ...keys.map((k) => ({ name: k, value: k })),
    ]);
    if (selected === undefined) return undefined;

    const localName = localKeyName(jumpHost.name, selected);
    ensureSecureDir(keysDir());
    const localPath = join(keysDir(), localName);

    if (existsSync(localPath)) {
      const overwrite = await promptConfirm(`${localPath} already exists. Overwrite?`, { default: false });
      if (!overwrite) return undefined;
    }

    downloadRemoteKey(jumpHost.name, selected, localPath, runner);

    return localPath;
  } finally {
    cleanup();
  }
}

export async function runAdd(): Promise<void> {
  const { settings } = loadSettings();
  const path = configPath(settings);
  requireExistingConfig(path);
  const password = await resolvePassword({ forcePrompt: false });

  const existingHosts = loadHosts(path, password);

  const name = await promptInput(fieldPrompt(HOST_ALIAS_LABEL));
  if (!isValidHostName(name)) {
    console.error("Host name must be non-empty and contain no whitespace.");
    process.exit(1);
    return;
  }
  if (RESERVED_HOST_NAMES.has(name)) {
    console.error(`Host name "${name}" is reserved by mssh itself and would be unreachable; choose another name.`);
    process.exit(1);
    return;
  }
  if (existingHosts.some((h) => h.name === name)) {
    console.error(`Host "${name}" already exists.`);
    process.exit(1);
    return;
  }

  const hostname = await promptInput(fieldPrompt(FIELD_LABELS.hostname));
  requireValidFieldValue(FIELD_LABELS.hostname, hostname);
  const port = await promptInput(fieldPrompt(FIELD_LABELS.port), { default: "22" });
  requireValidFieldValue(FIELD_LABELS.port, port);
  const user = await promptInput(fieldPrompt(FIELD_LABELS.user), { default: defaultUsername() });
  requireValidFieldValue(FIELD_LABELS.user, user);

  let proxyJump: string | undefined;
  let jumpHost: Host | undefined;

  const needsJumpHost = await promptConfirm(`Does this host require a ${FIELD_LABELS.proxyJump}?`, {
    default: false,
  });
  if (needsJumpHost) {
    const eligibleJumpHosts = hostsWithoutProxyJump(existingHosts);
    if (eligibleJumpHosts.length === 0) {
      console.error(
        `No eligible ${FIELD_LABELS.proxyJump} exists yet: a jump host must itself have no ProxyJump. Add one first, then re-run 'mssh config add'.`,
      );
      process.exit(1);
      return;
    }

    proxyJump = await promptSelect<string>(
      fieldPrompt(FIELD_LABELS.proxyJump),
      eligibleJumpHosts.map((h) => ({ name: h.name, value: h.name })),
    );
    jumpHost = eligibleJumpHosts.find((h) => h.name === proxyJump);
  }

  let pulledKeyPath: string | undefined;
  if (jumpHost !== undefined) {
    const wantsExtraction = await promptConfirm(
      `Pull a private key from the ${FIELD_LABELS.proxyJump} to authenticate to this host?`,
      { default: false },
    );
    if (wantsExtraction) {
      pulledKeyPath = await extractJumpHostKey(jumpHost);
    }
  }

  // Only asked when the jump branch produced nothing — a pulled key IS the
  // identity file, so asking for one as well would make the user answer a
  // question whose result is then discarded.
  let identityFile = pulledKeyPath;
  if (identityFile === undefined) {
    identityFile = await promptInput(fieldPrompt(FIELD_LABELS.identityFile), {
      default: settings.DEFAULT_SSH_KEY_PATH,
    });
    requireValidFieldValue(FIELD_LABELS.identityFile, identityFile);
  }

  const newHost = buildNewHost({ name, hostname, port, user, identityFile, proxyJump });

  const updatedHosts = addHost(existingHosts, newHost);
  saveHosts(path, updatedHosts, password);

  console.log(`Host '${name}' added.`);
}
