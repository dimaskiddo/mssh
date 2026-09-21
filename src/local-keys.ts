// Fills the Identity File prompt's default when DEFAULT_SSH_KEY_PATH is unset.
// Filename-only, same predicates as the remote key pull — nothing is opened or read.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./app-config";
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
