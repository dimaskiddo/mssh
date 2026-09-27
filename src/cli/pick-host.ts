// The pattern picked (not necessarily the host's first name) is what callers
// need to identify this specific alias.
import { connectableNames, findHost, type Host } from "../ssh/host";
import { promptSelect } from "./prompt";
import { fieldPrompt, HOST_ALIAS_LABEL } from "./field-labels";
import { fatal } from "../core/exit";

export const NO_HOSTS_MESSAGE = "No hosts configured. Add one with 'mssh config add'.";

export type SortOrder = "asc" | "dsc" | "cfg";

// Case-sensitive ASCII, not bare .sort()'s UTF-16 order — copies first, since .sort() mutates.
export function sortNames(names: string[], order: SortOrder): string[] {
  if (order === "cfg") return names;
  const sorted = [...names].sort();
  return order === "dsc" ? sorted.reverse() : sorted;
}

// One entry per pattern (a "Host a b" block is two picks), filtered through
// connectableNames so a glob or negation pattern is never itself pickable.
// Default "cfg" so every other connectableNames-based picker keeps config order.
export function hostChoices(hosts: Host[], order: SortOrder = "cfg"): Array<{ name: string; value: string }> {
  return sortNames(connectableNames(hosts), order).map((name) => ({ name, value: name }));
}

export async function pickHost(hosts: Host[]): Promise<{ host: Host; pattern: string } | undefined> {
  if (hosts.length === 0) {
    console.log(NO_HOSTS_MESSAGE);
    return undefined;
  }

  const pattern = await promptSelect<string>(fieldPrompt(HOST_ALIAS_LABEL), hostChoices(hosts));
  // pattern came from connectableNames' glob-filter; findHost uses hostHasName's
  // exact includes — two independent rules nothing forces to agree, hence this
  // guard against a crash on picked.host if they diverge.
  const host = findHost(hosts, pattern);
  return host === undefined ? undefined : { host, pattern };
}

export async function resolveTarget(hosts: Host[], name?: string): Promise<{ host: Host; targetName: string } | undefined> {
  if (name !== undefined) {
    const host = findHost(hosts, name);
    if (!host) {
      fatal(`Host "${name}" not found.`);
    }
    return { host, targetName: name };
  }

  const picked = await pickHost(hosts);
  if (!picked) return undefined;
  return { host: picked.host, targetName: picked.pattern };
}
