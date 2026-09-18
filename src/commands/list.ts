// `mssh config list`: prints host aliases only, never hostname/user/port —
// this tool exists to keep those encrypted at rest, out of terminal scrollback.
// `mssh` (bare) is the same list as a picker that connects — see runListConnect.
import { configPath, loadSettings, resolvePassword } from "../app-config";
import { loadRaw } from "../store";
import { parse, connectableNames, duplicateAlias, type Host } from "../ssh-config";
import { promptSelect } from "../prompt";
import { connectWithRaw, type SpawnFn } from "./connect";
import { fieldPrompt, CONNECT_TO_LABEL } from "../field-labels";
import { requireExistingConfig } from "./require-config";

const NO_HOSTS_MESSAGE = "No hosts configured. Add one with 'mssh config add'.";

export type SortOrder = "asc" | "dsc" | "cfg";

const SORT_ORDERS = new Set<string>(["asc", "dsc", "cfg"]);

// Case-sensitive ASCII (bare .sort() is UTF-16 code-unit order) so results
// are stable across platforms and locales. Copies first — .sort() mutates.
export function sortNames(names: string[], order: SortOrder): string[] {
  if (order === "cfg") return names;
  const sorted = [...names].sort();
  return order === "dsc" ? sorted.reverse() : sorted;
}

// Splits mssh's own --sort= out of argv, leaving the rest for the caller's
// own argument handling. Last flag wins; an invalid value is reported
// instead of thrown, so the caller can warn and still list.
export function parseSortFlag(argv: string[]): { order: SortOrder; rest: string[]; invalid?: string } {
  let order: SortOrder = "asc";
  let invalid: string | undefined;
  const rest: string[] = [];

  for (const arg of argv) {
    if (!arg.startsWith("--sort=")) {
      rest.push(arg);
      continue;
    }
    const value = arg.slice("--sort=".length);
    if (SORT_ORDERS.has(value)) {
      order = value as SortOrder;
      invalid = undefined;
    } else {
      order = "asc";
      invalid = value;
    }
  }

  return { order, rest, invalid };
}

// One entry per pattern (a "Host a b" block is two picks), filtered through
// connectableNames so a glob or negation pattern is never itself pickable.
// Default "cfg" so every other connectableNames-based picker keeps config order.
export function hostChoices(hosts: Host[], order: SortOrder = "cfg"): Array<{ name: string; value: string }> {
  return sortNames(connectableNames(hosts), order).map((name) => ({ name, value: name }));
}

export async function runList(order: SortOrder = "asc"): Promise<void> {
  const loaded = loadSettings();
  const path = configPath(loaded.settings);
  requireExistingConfig(path);
  const password = await resolvePassword(loaded, { forcePrompt: true });

  const hosts = parse(loadRaw(path, password));

  if (hosts.length === 0) {
    console.log(NO_HOSTS_MESSAGE);
    return;
  }

  const collision = duplicateAlias(hosts);
  if (collision !== undefined) {
    console.error(
      `Warning: alias "${collision}" is defined by more than one host; only the first is reachable. ` +
        `Remove the extra with 'mssh config delete ${collision}'.`,
    );
  }

  for (const name of sortNames(connectableNames(hosts), order)) {
    console.log(name);
  }
}

// Bare `mssh`: the one password prompt that lists hosts also drives the
// connect, so there is no second prompt, decrypt, or parse — the hosts
// already parsed for the picker are handed straight to connectWithRaw.
export async function runListConnect(order: SortOrder = "asc", spawnFn?: SpawnFn): Promise<void> {
  const loaded = loadSettings();
  const path = configPath(loaded.settings);
  requireExistingConfig(path);
  const password = await resolvePassword(loaded, { forcePrompt: true });

  const raw = loadRaw(path, password);
  const hosts = parse(raw);

  if (hosts.length === 0) {
    console.log(NO_HOSTS_MESSAGE);
    return;
  }

  const selected = await promptSelect<string>(fieldPrompt(CONNECT_TO_LABEL), hostChoices(hosts, order));
  await connectWithRaw(raw, [selected], spawnFn, hosts);
}
