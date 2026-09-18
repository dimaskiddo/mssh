// `mssh config delete [name]`: pick (or take by name) a host, warn about any
// other hosts that ProxyJump through it, confirm, then re-save without it.
import { configPath, loadSettings, resolvePassword } from "../app-config";
import { loadHosts, saveHosts } from "../store";
import { deleteHost, type Host } from "../ssh-config";
import { promptConfirm } from "../prompt";
import { findHost, pickHost } from "./edit";
import { requireExistingConfig } from "./require-config";

export function findDependents(hosts: Host[], name: string): Host[] {
  return hosts.filter((h) => h.proxyJump === name);
}

export async function runDelete(name?: string): Promise<void> {
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

  const dependents = findDependents(hosts, target.name);
  if (dependents.length > 0) {
    const names = dependents.map((h) => h.name).join(", ");
    console.error(`Warning: the following hosts jump through '${target.name}' and will be unable to connect: ${names}`);
  }

  const confirmed = await promptConfirm(`Delete host '${target.name}'?`, { default: false });
  if (!confirmed) {
    console.log("Cancelled.");
    return;
  }

  const updated = deleteHost(hosts, target.name);
  saveHosts(path, updated, password);

  console.log(`Host '${target.name}' deleted.`);
}
