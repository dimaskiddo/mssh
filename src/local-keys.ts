// Fills the Identity File prompt's default when DEFAULT_SSH_KEY_PATH is unset.
// Filename-only, same predicates as the remote key pull — nothing is opened or read.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homeDir, keysDir } from "./app-config";
import { isValidKeyFilename, isNonKeyFile } from "./remote-keys";

// ssh's own default-identity order, so the offered key is the one ssh would
// most likely have tried anyway.
const PREFERRED_KEY_NAMES = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];

export function pickDefaultKeyName(names: string[]): string | undefined {
  const candidates = names.filter((n) => isValidKeyFilename(n) && !isNonKeyFile(n));
  const preferred = PREFERRED_KEY_NAMES.find((p) => candidates.includes(p));
  if (preferred !== undefined) return preferred;
  return [...candidates].sort()[0];
}

// Directories are excluded so ~/.ssh/sockets can never become an IdentityFile.
// An unreadable or absent ~/.ssh is not an error here — it just means no default.
export function discoverDefaultKeyPath(): string | undefined {
  const sshDir = join(homeDir(), ".ssh");

  let names: string[];
  try {
    names = readdirSync(sshDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }

  const picked = pickDefaultKeyName(names);
  return picked === undefined ? undefined : join(sshDir, picked);
}

// localKeyName() builds `<alias>_<suffix>.pem`, so the prefix is the only
// invertible part — the suffix is an arbitrary remote basename. A bastion
// alias may itself contain "_", so this can over-match; every candidate is
// shown to the user by name and never substituted silently.
export function pulledKeyNamesFor(jumpAlias: string, names: string[]): string[] {
  const prefix = `${jumpAlias}_`;
  return names.filter((n) => n.startsWith(prefix) && n.endsWith(".pem") && n.length > prefix.length + ".pem".length).sort();
}

// An absent keysDir() just means nothing has been pulled yet. Not created
// here: this is a read, and the write path already calls ensureSecureDir.
export function listPulledKeys(jumpAlias: string): string[] {
  const dir = keysDir();

  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  return pulledKeyNamesFor(jumpAlias, names).map((n) => join(dir, n));
}
