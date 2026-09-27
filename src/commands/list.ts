// Prints aliases only, never hostname/user/port — keeps those encrypted at
// rest, out of terminal scrollback.
import { keysDir } from "../config/paths";
import { loadRaw } from "../core/store";
import { migratePlaintextKeys, reportMigratedKeys } from "../keyring/key-store";
import { parse } from "../ssh/ssh-config";
import { connectableNames, duplicateAlias, filterByTags, splitTags } from "../ssh/host";
import { promptSelect, type SelectItem } from "../cli/prompt";
import { connectWithRaw, type SpawnFn } from "../ssh/session";
import { fieldPrompt, CONNECT_TO_LABEL } from "../cli/field-labels";
import { openConfig } from "../core/require-config";
import { hostChoices, sortNames, tagGroups, NO_HOSTS_MESSAGE, type SortOrder } from "../cli/pick-host";

export type ListOrder = SortOrder | "tags";

const SORT_ORDERS = new Set<string>(["asc", "dsc", "cfg", "tags"]);

export function parseSortFlag(argv: string[]): { order: ListOrder; rest: string[]; invalid?: string } {
  let order: ListOrder = "asc";
  let invalid: string | undefined;
  const rest: string[] = [];

  for (const arg of argv) {
    if (!arg.startsWith("--sort=")) {
      rest.push(arg);
      continue;
    }
    const value = arg.slice("--sort=".length);
    if (SORT_ORDERS.has(value)) {
      order = value as ListOrder;
      invalid = undefined;
    } else {
      order = "asc";
      invalid = value;
    }
  }

  return { order, rest, invalid };
}

// One blank separator between groups, none leading/trailing — mirrors runList's console.log("").
export function groupSelectItems(groups: Array<{ label: string; names: string[] }>): SelectItem<string>[] {
  return groups.flatMap((group, i) => [
    ...(i > 0 ? [{ separator: " " }] : []),
    { separator: group.label },
    ...group.names.map((name) => ({ name, value: name })),
  ]);
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

export async function runList(order: ListOrder = "asc", tags: string[] = []): Promise<void> {
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

  if (order === "tags") {
    tagGroups(filtered, tags).forEach((group, i) => {
      if (i > 0) console.log("");
      console.log(group.label);
      group.names.forEach((name) => console.log(name));
    });
    return;
  }

  for (const name of sortNames(connectableNames(filtered), order)) {
    console.log(name);
  }
}

// Bare `mssh`: the one password prompt drives both list and connect — no second decrypt.
export async function runListConnect(order: ListOrder = "asc", tags: string[] = [], spawnFn?: SpawnFn): Promise<void> {
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

  const choices = order === "tags" ? groupSelectItems(tagGroups(filtered, tags)) : hostChoices(filtered, order);
  const selected = await promptSelect<string>(fieldPrompt(CONNECT_TO_LABEL), choices);
  connectWithRaw(raw, [selected], password, spawnFn, hosts);
}
