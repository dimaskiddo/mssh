// Prints aliases only, never hostname/user/port — keeps those encrypted at
// rest, out of terminal scrollback.
import { keysDir } from "../config/paths";
import { loadRaw } from "../core/store";
import { migratePlaintextKeys, reportMigratedKeys } from "../keyring/key-store";
import { parse } from "../ssh/ssh-config";
import { connectableNames, duplicateAlias, filterByTags, splitTags } from "../ssh/host";
import { promptSelect } from "../cli/prompt";
import { connectWithRaw, type SpawnFn } from "../ssh/session";
import { fieldPrompt, CONNECT_TO_LABEL } from "../cli/field-labels";
import { openConfig } from "../core/require-config";
import { hostChoices, sortNames, NO_HOSTS_MESSAGE, type SortOrder } from "../cli/pick-host";

const SORT_ORDERS = new Set<string>(["asc", "dsc", "cfg"]);

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

// Every --tags= occurrence accumulates (AND-combined), unlike --sort's
// last-wins — --tags=a --tags=b is the same filter as --tags=a,b.
export function parseTagsFlag(argv: string[]): { tags: string[]; rest: string[] } {
  const tags: string[] = [];
  const rest: string[] = [];

  for (const arg of argv) {
    if (!arg.startsWith("--tags=")) {
      rest.push(arg);
      continue;
    }
    tags.push(...splitTags(arg.slice("--tags=".length)));
  }

  return { tags, rest };
}

function noMatchMessage(tags: string[]): string {
  return `No hosts match tag(s): ${tags.join(", ")}.`;
}

export async function runList(order: SortOrder = "asc", tags: string[] = []): Promise<void> {
  const { path, password } = await openConfig();

  const hosts = parse(loadRaw(path, password));
  reportMigratedKeys(migratePlaintextKeys(keysDir(), password).migrated);

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

  const filtered = filterByTags(hosts, tags);
  if (filtered.length === 0 && tags.length > 0) {
    console.error(noMatchMessage(tags));
    return;
  }

  for (const name of sortNames(connectableNames(filtered), order)) {
    console.log(name);
  }
}

// Bare `mssh`: the one password prompt drives both list and connect — no second decrypt.
export async function runListConnect(order: SortOrder = "asc", tags: string[] = [], spawnFn?: SpawnFn): Promise<void> {
  const { path, password } = await openConfig();

  const raw = loadRaw(path, password);
  const hosts = parse(raw);
  reportMigratedKeys(migratePlaintextKeys(keysDir(), password).migrated);

  if (hosts.length === 0) {
    console.log(NO_HOSTS_MESSAGE);
    return;
  }

  const filtered = filterByTags(hosts, tags);
  if (filtered.length === 0 && tags.length > 0) {
    console.error(noMatchMessage(tags));
    return;
  }

  const selected = await promptSelect<string>(fieldPrompt(CONNECT_TO_LABEL), hostChoices(filtered, order));
  connectWithRaw(raw, [selected], password, spawnFn, hosts);
}
