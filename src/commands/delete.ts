import { keysDir } from "../config/paths";
import { loadHosts, saveHosts } from "../core/store";
import { migratePlaintextKeys, reportMigratedKeys } from "../keyring/key-store";
import { deleteHost, hostLabel, proxyJumpAliases, type Host } from "../ssh/host";
import { promptConfirm } from "../cli/prompt";
import { resolveTarget } from "../cli/pick-host";
import { openConfig } from "../core/require-config";

// proxyJumpAliases handles `user@bastion:2222`/comma-chain forms that an
// exact string match on proxyJump would miss.
export function findDependents(hosts: Host[], names: string[]): Host[] {
  return hosts.filter((h) => h.proxyJump !== undefined && proxyJumpAliases(h.proxyJump).some((alias) => names.includes(alias)));
}

export async function runDelete(name?: string): Promise<void> {
  const { path, password } = await openConfig({ forcePrompt: false });

  const hosts = loadHosts(path, password);
  reportMigratedKeys(migratePlaintextKeys(keysDir(), password).migrated);

  const resolved = await resolveTarget(hosts, name);
  if (!resolved) return;
  const { host: target, targetName } = resolved;

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
