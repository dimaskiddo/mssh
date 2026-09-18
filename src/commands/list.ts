// `mssh config list`: prints host aliases only. `mssh` (bare): same forced
// prompt, but the list is a picker that connects to whichever alias is
// selected — see runListConnect. Neither ever prints hostname/user/port:
// this tool exists to keep those encrypted at rest, so they must not land in
// terminal scrollback. Always forces an interactive password prompt
// (forcePrompt: true) so a stray MSSH_PASSWORD can never silently dump the
// host list; see app-config.ts's resolvePassword for the routing rule.
import { configPath, loadSettings, resolvePassword } from "../app-config";
import { loadRaw } from "../store";
import { parse, type Host } from "../ssh-config";
import { promptSelect } from "../prompt";
import { connectWithRaw, type SpawnFn } from "./connect";
import { fieldPrompt, CONNECT_TO_LABEL } from "../field-labels";

const NO_HOSTS_MESSAGE = "No hosts configured. Add one with 'mssh config add'.";

// Pure so the picker's choice list is unit-testable without fs/crypto/prompting.
export function hostChoices(hosts: Host[]): Array<{ name: string; value: string }> {
  return hosts.map((h) => ({ name: h.name, value: h.name }));
}

export async function runList(): Promise<void> {
  const { settings } = loadSettings();
  const path = configPath(settings);
  const password = await resolvePassword({ forcePrompt: true });

  const hosts = parse(loadRaw(path, password));

  if (hosts.length === 0) {
    console.log(NO_HOSTS_MESSAGE);
    return;
  }

  for (const host of hosts) {
    console.log(host.name);
  }
}

// Bare `mssh`: the one password prompt that lists hosts also drives the
// connect, so there is no second prompt and no second decrypt — the same
// raw plaintext parsed for the picker is handed straight to connectWithRaw.
export async function runListConnect(spawnFn?: SpawnFn): Promise<void> {
  const { settings } = loadSettings();
  const path = configPath(settings);
  const password = await resolvePassword({ forcePrompt: true });

  const raw = loadRaw(path, password);
  const hosts = parse(raw);

  if (hosts.length === 0) {
    console.log(NO_HOSTS_MESSAGE);
    return;
  }

  const selected = await promptSelect<string>(fieldPrompt(CONNECT_TO_LABEL), hostChoices(hosts));
  await connectWithRaw(raw, [selected], spawnFn);
}
