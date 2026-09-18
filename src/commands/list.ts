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

// One entry per pattern (a "Host a b" block is two picks), filtered through
// connectableNames so a glob or negation pattern is never itself pickable.
export function hostChoices(hosts: Host[]): Array<{ name: string; value: string }> {
  return connectableNames(hosts).map((name) => ({ name, value: name }));
}

export async function runList(): Promise<void> {
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

  for (const name of connectableNames(hosts)) {
    console.log(name);
  }
}

// Bare `mssh`: the one password prompt that lists hosts also drives the
// connect, so there is no second prompt, decrypt, or parse — the hosts
// already parsed for the picker are handed straight to connectWithRaw.
export async function runListConnect(spawnFn?: SpawnFn): Promise<void> {
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

  const selected = await promptSelect<string>(fieldPrompt(CONNECT_TO_LABEL), hostChoices(hosts));
  await connectWithRaw(raw, [selected], spawnFn, hosts);
}
