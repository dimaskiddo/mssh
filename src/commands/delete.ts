// `mssh config delete [name]`: pick (or take by name) a host, warn about any
// other hosts that ProxyJump through it, confirm, then re-save without it.
import { configPath, keysDir, loadSettings, resolvePassword } from "../app-config";
import { loadHosts, saveHosts } from "../store";
import { migratePlaintextKeys, reportMigratedKeys } from "../key-store";
import { deleteHost, hostLabel, proxyJumpAliases, type Host } from "../ssh-config";
import { promptConfirm } from "../prompt";
import { findHost, pickHost } from "./edit";
import { requireExistingConfig } from "./require-config";
import { fatal } from "../exit";

// Exact string match on proxyJump misses `user@bastion:2222` and comma-chain
// forms — proxyJumpAliases is the same parser connect.ts's own jump
// resolution relies on, reused rather than re-matched here.
export function findDependents(hosts: Host[], names: string[]): Host[] {
  return hosts.filter((h) => h.proxyJump !== undefined && proxyJumpAliases(h.proxyJump).some((alias) => names.includes(alias)));
}

export async function runDelete(name?: string): Promise<void> {
  const loaded = loadSettings();
  const path = configPath(loaded.settings);
  requireExistingConfig(path);
  const password = await resolvePassword(loaded, { forcePrompt: false });

  const hosts = loadHosts(path, password);
  reportMigratedKeys(migratePlaintextKeys(keysDir(), password).migrated);

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

  if (target.names.length > 1) {
    console.error(`Warning: '${hostLabel(target)}' is one Host block with ${target.names.length} aliases — deleting it removes all of them.`);
  }

  const dependents = findDependents(hosts, target.names);
  if (dependents.length > 0) {
    const dependentNames = dependents.map((h) => hostLabel(h)).join(", ");
    console.error(
      `Warning: the following hosts jump through '${hostLabel(target)}' and will be unable to connect: ${dependentNames}`,
    );
  }

  const confirmed = await promptConfirm(`Delete host '${hostLabel(target)}'?`, { default: false });
  if (!confirmed) {
    console.log("Cancelled.");
    return;
  }

  const updated = deleteHost(hosts, targetName);
  saveHosts(path, updated, password);

  console.log(`Host '${hostLabel(target)}' deleted.`);
}
