// No plaintext file ever hits disk — load, mutate in memory, re-encrypt.
import { keysDir } from "../config/paths";
import { loadHosts, saveHosts } from "../core/store";
import { migratePlaintextKeys, reportMigratedKeys } from "../keyring/key-store";
import {
  updateHostField,
  hostsWithoutProxyJump,
  emptyToUndefined,
  hostLabel,
  type Host,
  type ModeledField,
} from "../ssh/host";
import { isValidFieldValue, isValidPort } from "../ssh/validate";
import { promptInput, promptSelect } from "../cli/prompt";
import { FIELD_LABELS, FIELD_PICKER_LABEL, fieldPrompt } from "../cli/field-labels";
import { resolveTarget, hostChoices } from "../cli/pick-host";
import { openConfig } from "../core/require-config";

export const FIELD_CHOICES: Array<{ name: string; value: ModeledField }> = (
  Object.keys(FIELD_LABELS) as ModeledField[]
).map((value) => ({ name: FIELD_LABELS[value], value }));

// proxyJump's picker has no default-prefill like the text prompts below, so
// KEEP distinguishes "leave as-is" from "(none)" — both would otherwise
// resolve to the same undefined.
const KEEP = Symbol("keep");

export function validateFieldValue(field: ModeledField, value: string): true | string {
  const label = FIELD_LABELS[field];
  if (!isValidFieldValue(value)) return `${label} cannot contain a newline.`;
  if (field === "port" && value.trim() !== "" && !isValidPort(value.trim())) {
    return "Port must be a number between 1 and 65535.";
  }
  return true;
}

async function promptNewValue(hosts: Host[], target: Host, field: ModeledField): Promise<string | undefined | typeof KEEP> {
  if (field === "proxyJump") {
    // Self-excluded by identity, not name (a multi-pattern host is one
    // object) — a host can't jump through itself.
    const eligible = hostsWithoutProxyJump(hosts.filter((h) => h !== target));
    return promptSelect<string | undefined | typeof KEEP>(fieldPrompt(FIELD_LABELS.proxyJump), [
      { name: "(keep)", value: KEEP },
      { name: "(none)", value: undefined },
      ...hostChoices(eligible),
    ]);
  }

  const label = FIELD_LABELS[field];
  const current = await promptInput(fieldPrompt(label), {
    default: target[field] ?? "",
    validate: (value) => validateFieldValue(field, value),
  });
  return emptyToUndefined(current.trim());
}

export async function runEdit(name?: string): Promise<void> {
  const { path, password } = await openConfig();

  const hosts = loadHosts(path, password);
  reportMigratedKeys(migratePlaintextKeys(keysDir(), password).migrated);

  const picked = await resolveTarget(hosts, name);
  if (!picked) return;
  const { host: target, targetName } = picked;

  const field = await promptSelect<ModeledField>(fieldPrompt(FIELD_PICKER_LABEL), FIELD_CHOICES);
  const value = await promptNewValue(hosts, target, field);
  const resolved = value === KEEP ? target[field] : value;

  const updated = updateHostField(hosts, targetName, field, resolved);
  saveHosts(path, updated, password);

  console.log(`Host '${hostLabel(target)}' updated.`);
}
