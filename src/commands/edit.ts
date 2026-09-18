// `mssh config edit [name]`: pick (or take by name) a host, pick a modeled
// field, prompt a new value, and re-save the whole config. No plaintext file
// ever hits disk — load, mutate in memory, re-encrypt.
import { configPath, loadSettings, resolvePassword } from "../app-config";
import { loadHosts, saveHosts } from "../store";
import {
  updateHostField,
  hostsWithoutProxyJump,
  emptyToUndefined,
  isValidFieldValue,
  hostHasName,
  connectableNames,
  hostLabel,
  type Host,
  type ModeledField,
} from "../ssh-config";
import { promptInput, promptSelect } from "../prompt";
import { FIELD_LABELS, FIELD_PICKER_LABEL, HOST_ALIAS_LABEL, fieldPrompt } from "../field-labels";
import { requireExistingConfig } from "./require-config";
import { fatal } from "../exit";

export const FIELD_CHOICES: Array<{ name: string; value: ModeledField }> = (
  Object.keys(FIELD_LABELS) as ModeledField[]
).map((value) => ({ name: FIELD_LABELS[value], value }));

export function findHost(hosts: Host[], name: string): Host | undefined {
  return hosts.find((h) => hostHasName(h, name));
}

// Shared by edit.ts and delete.ts. Lists one entry per pattern; the pattern
// picked (not necessarily the host's first name) is what CLI commands
// downstream need to identify this specific alias.
export async function pickHost(hosts: Host[]): Promise<{ host: Host; pattern: string } | undefined> {
  if (hosts.length === 0) {
    console.log("No hosts configured.");
    return undefined;
  }

  const patterns = connectableNames(hosts);
  const pattern = await promptSelect<string>(
    fieldPrompt(HOST_ALIAS_LABEL),
    patterns.map((n) => ({ name: n, value: n })),
  );
  const host = findHost(hosts, pattern);
  return host === undefined ? undefined : { host, pattern };
}

// proxyJump's picker offers no way to leave the field untouched (unlike the
// text prompts below, which prefill the current value as the default) —
// KEEP distinguishes "leave as-is" from "(none)", which both would
// otherwise resolve to the same undefined.
const KEEP = Symbol("keep");

async function promptNewValue(hosts: Host[], target: Host, field: ModeledField): Promise<string | undefined | typeof KEEP> {
  if (field === "proxyJump") {
    // A host can't jump through itself, hence the self-exclusion (by
    // identity, not name — a multi-pattern host is one object) before
    // filtering for jump-eligibility.
    const eligible = hostsWithoutProxyJump(hosts.filter((h) => h !== target));
    return promptSelect<string | undefined | typeof KEEP>(fieldPrompt(FIELD_LABELS.proxyJump), [
      { name: "(keep)", value: KEEP },
      { name: "(none)", value: undefined },
      ...connectableNames(eligible).map((n) => ({ name: n, value: n })),
    ]);
  }

  const label = FIELD_LABELS[field];
  const current = await promptInput(fieldPrompt(label), { default: target[field] ?? "" });
  // UX check mirroring ssh-config.ts's load-bearing one in serialize(): catch
  // an injected newline here with a clear message instead of a generic throw
  // at save time.
  if (!isValidFieldValue(current)) {
    fatal(`${label} cannot contain a newline.`);
  }
  return emptyToUndefined(current);
}

export async function runEdit(name?: string): Promise<void> {
  const loaded = loadSettings();
  const path = configPath(loaded.settings);
  requireExistingConfig(path);
  const password = await resolvePassword(loaded, { forcePrompt: false });

  const hosts = loadHosts(path, password);

  let target: Host | undefined;
  let targetName: string;
  if (name !== undefined) {
    target = findHost(hosts, name);
    if (!target) {
      fatal(`Host "${name}" not found.`);
    }
    targetName = name;
  } else {
    const picked = await pickHost(hosts);
    if (!picked) return;
    target = picked.host;
    targetName = picked.pattern;
  }

  const field = await promptSelect<ModeledField>(fieldPrompt(FIELD_PICKER_LABEL), FIELD_CHOICES);
  const value = await promptNewValue(hosts, target, field);
  const resolved = value === KEEP ? target[field] : value;

  const updated = updateHostField(hosts, targetName, field, resolved);
  saveHosts(path, updated, password);

  console.log(`Host '${hostLabel(target)}' updated.`);
}
