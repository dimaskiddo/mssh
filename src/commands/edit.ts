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
  type Host,
  type ModeledField,
} from "../ssh-config";
import { promptInput, promptSelect } from "../prompt";
import { FIELD_LABELS, FIELD_PICKER_LABEL, HOST_ALIAS_LABEL, fieldPrompt } from "../field-labels";
import { requireExistingConfig } from "./require-config";

export const FIELD_CHOICES: Array<{ name: string; value: ModeledField }> = (
  Object.keys(FIELD_LABELS) as ModeledField[]
).map((value) => ({ name: FIELD_LABELS[value], value }));

export function findHost(hosts: Host[], name: string): Host | undefined {
  return hosts.find((h) => h.name === name);
}

// Shared by edit.ts and delete.ts.
export async function pickHost(hosts: Host[]): Promise<Host | undefined> {
  if (hosts.length === 0) {
    console.log("No hosts configured.");
    return undefined;
  }

  const selectedName = await promptSelect<string>(
    fieldPrompt(HOST_ALIAS_LABEL),
    hosts.map((h) => ({ name: h.name, value: h.name })),
  );
  return findHost(hosts, selectedName);
}

async function promptNewValue(hosts: Host[], target: Host, field: ModeledField): Promise<string | undefined> {
  if (field === "proxyJump") {
    // A host can't jump through itself, hence the self-exclusion before
    // filtering for jump-eligibility.
    const eligible = hostsWithoutProxyJump(hosts.filter((h) => h.name !== target.name));
    return promptSelect<string | undefined>(fieldPrompt(FIELD_LABELS.proxyJump), [
      { name: "(none)", value: undefined },
      ...eligible.map((h) => ({ name: h.name, value: h.name })),
    ]);
  }

  const label = FIELD_LABELS[field];
  const current = await promptInput(fieldPrompt(label), { default: target[field] ?? "" });
  // UX check mirroring ssh-config.ts's load-bearing one in serialize(): catch
  // an injected newline here with a clear message instead of a generic throw
  // at save time.
  if (!isValidFieldValue(current)) {
    console.error(`${label} cannot contain a newline.`);
    process.exit(1);
  }
  return emptyToUndefined(current);
}

export async function runEdit(name?: string): Promise<void> {
  const { settings } = loadSettings();
  const path = configPath(settings);
  requireExistingConfig(path);
  const password = await resolvePassword({ forcePrompt: false });

  const hosts = loadHosts(path, password);

  let target: Host | undefined;
  if (name !== undefined) {
    target = findHost(hosts, name);
    if (!target) {
      console.error(`Host "${name}" not found.`);
      process.exit(1);
      return;
    }
  } else {
    target = await pickHost(hosts);
    if (!target) return;
  }

  const field = await promptSelect<ModeledField>(fieldPrompt(FIELD_PICKER_LABEL), FIELD_CHOICES);
  const value = await promptNewValue(hosts, target, field);

  const updated = updateHostField(hosts, target.name, field, value);
  saveHosts(path, updated, password);

  console.log(`Host '${target.name}' updated.`);
}
