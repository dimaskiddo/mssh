// ProxyJump reads the key locally, not on the bastion; requireSsh() runs only
// inside that opt-in key-pull branch.
import { userInfo } from "node:os";
import { keysDir } from "../config/paths";
import { discoverDefaultKeyPath } from "../keyring/local-keys";
import { loadHosts, saveHosts } from "../core/store";
import { migratePlaintextKeys, reportMigratedKeys } from "../keyring/key-store";
import { addHost, hostsWithoutProxyJump, emptyToUndefined, hostHasName, findHost, splitTags, type Host } from "../ssh/host";
import { isValidNewHostName } from "../ssh/validate";
import { promptInput, promptSelect, promptConfirm } from "../cli/prompt";
import { FIELD_LABELS, HOST_ALIAS_LABEL, TAGS_LABEL, fieldPrompt } from "../cli/field-labels";
import { hostChoices } from "../cli/pick-host";
import { openConfig } from "../core/require-config";
import { fatal } from "../core/exit";
import { extractJumpHostKey } from "../keyring/jump-key-pull";
import { validateFieldValue, validateTags } from "./edit";

// Names index.ts dispatches on before reaching runConnect — a host with one
// of these would be silently unreachable via `mssh <name>`.
const RESERVED_HOST_NAMES = new Set(["setup", "config", "version", "change-password", "update", "-h", "--help", "--version"]);

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
  tags?: string[];
};

export function buildNewHost(fields: NewHostFields): Host {
  return {
    names: [fields.name],
    hostname: emptyToUndefined(fields.hostname),
    port: emptyToUndefined(fields.port),
    user: emptyToUndefined(fields.user),
    identityFile: emptyToUndefined(fields.identityFile),
    proxyJump: fields.proxyJump,
    ...(fields.tags !== undefined && fields.tags.length > 0 ? { tags: fields.tags } : {}),
    extras: [],
  };
}

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
  const { loaded, path, password } = await openConfig();
  const { settings } = loaded;

  const existingHosts = loadHosts(path, password);
  reportMigratedKeys(migratePlaintextKeys(keysDir(), password).migrated);

  const name = await promptInput(fieldPrompt(HOST_ALIAS_LABEL), {
    validate: (value) => validateNewAlias(value, existingHosts),
  });

  const hostname = (
    await promptInput(fieldPrompt(FIELD_LABELS.hostname), {
      validate: (value) => validateFieldValue("hostname", value),
    })
  ).trim();
  const port = (
    await promptInput(fieldPrompt(FIELD_LABELS.port), {
      default: "22",
      validate: (value) => validateFieldValue("port", value),
    })
  ).trim();
  const user = (
    await promptInput(fieldPrompt(FIELD_LABELS.user), {
      default: defaultUsername(),
      validate: (value) => validateFieldValue("user", value),
    })
  ).trim();

  const tags = splitTags(
    await promptInput(fieldPrompt(TAGS_LABEL), {
      default: "",
      validate: validateTags,
    }),
  );

  let jumpSelection: { host: Host; pattern: string } | undefined;

  const needsJumpHost = await promptConfirm(`Does this host require a ${FIELD_LABELS.proxyJump}?`, {
    default: false,
  });
  if (needsJumpHost) {
    const eligibleJumpHosts = hostsWithoutProxyJump(existingHosts);
    const choices = hostChoices(eligibleJumpHosts);
    if (choices.length === 0) {
      fatal(`No eligible ${FIELD_LABELS.proxyJump} exists yet: a jump host must itself have no ProxyJump. Add one first, then re-run 'mssh config add'.`);
    }

    const pattern = await promptSelect<string>(fieldPrompt(FIELD_LABELS.proxyJump), choices);
    // Same guard as pick-host.ts's pickHost; graver here since the result is sealed to disk.
    const host = findHost(eligibleJumpHosts, pattern);
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
        validate: (value) => validateFieldValue("identityFile", value),
      })
    ).trim();
  }

  const newHost = buildNewHost({ name, hostname, port, user, identityFile, proxyJump: jumpSelection?.pattern, tags });

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
