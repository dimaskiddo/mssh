// Bridges the encrypted config file on disk to Host[] in memory. Purely
// crypto+fs+parse plumbing — no CLI, prompting, or path resolution here
// (that's app-config.ts's job); callers pass explicit paths and passwords.
import { existsSync, readFileSync } from "node:fs";
import { seal, open, UnsupportedVersionError } from "./crypto";
import { parse, serialize, withKeepAlive, type Host } from "./ssh-config";
import { writeSecureAtomic } from "./secure-file";

// Never let the raw crypto error propagate: open() doesn't distinguish wrong
// password from a corrupted/tampered payload, and its message could echo
// internals. Always throw this one opaque message instead, whichever failed.
export function loadRaw(path: string, password: string): string {
  if (!existsSync(path)) {
    throw new Error(`no config found at ${path}`);
  }

  // Only the decrypt call is wrapped: a raw fs error here (permission denied,
  // TOCTOU unlink) is a distinct filesystem problem, not a crypto-internals
  // leak, so it's fine to surface as-is rather than folding into either
  // message above.
  const payload = readFileSync(path);
  try {
    return open(payload, password);
  } catch (err) {
    // The version byte is public plaintext, not secret-derived, so this one
    // distinction is safe to surface. Every other failure folds into the
    // opaque message.
    if (err instanceof UnsupportedVersionError) throw err;
    throw new Error("failed to decrypt config: wrong password or corrupted file");
  }
}

export function loadHosts(path: string, password: string): Host[] {
  return parse(loadRaw(path, password));
}

export function saveHosts(path: string, hosts: Host[], password: string): void {
  const sealed = seal(serialize(withKeepAlive(hosts)), password);
  writeSecureAtomic(path, sealed);
}
