// Bridges the encrypted config file on disk to Host[] in memory. Purely
// crypto+fs+parse plumbing — no CLI, prompting, or path resolution here
// (that's app-config.ts's job); callers pass explicit paths and passwords.
import { existsSync, readFileSync } from "node:fs";
import { seal, open, UnsupportedVersionError } from "./crypto";
import { parse, serialize, withKeepAlive, type Host } from "./ssh-config";
import { writeSecureAtomic } from "./secure-file";

// scryptSync (open()'s key derivation) allocates 128 MiB per call and can
// fail for reasons that have nothing to do with the password: out of memory,
// or a KDF parameter the current Node/OpenSSL rejects. Folding these into
// "wrong password" sends the user to `mssh setup`, which destroys the config
// they were never actually locked out of. Named explicitly rather than
// caught by a broader check, so a genuine auth-tag failure (wrong password
// or tampering) still folds into the opaque message below, unchanged.
const RESOURCE_ERROR_CODES = new Set(["ERR_CRYPTO_OUT_OF_MEMORY", "ERR_CRYPTO_INVALID_SCRYPT_PARAMS", "ENOMEM"]);

// Never let the raw crypto error propagate: open() doesn't distinguish wrong
// password from a corrupted/tampered payload, and its message could echo
// internals. Always throw this one opaque message instead, whichever failed
// — except the resource/parameter failures classified above, which are not
// a decrypt failure at all and must say so.
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
    // opaque message, unless it's classified below as a resource error.
    if (err instanceof UnsupportedVersionError) throw err;

    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && RESOURCE_ERROR_CODES.has(code)) {
      throw new Error(`failed to decrypt config: resource error, not a wrong password (${(err as Error).message})`);
    }
    // A TypeError here means a refactor broke a call signature, not that the
    // user mistyped their password — the opaque message would send them to
    // `mssh setup` to "fix" a bug that has nothing to do with their config.
    if (err instanceof TypeError) {
      throw new Error(`failed to decrypt config: internal error, not a wrong password (${(err as Error).message})`);
    }

    throw new Error("failed to decrypt config: wrong password or corrupted file");
  }
}

export function loadHosts(path: string, password: string): Host[] {
  return parse(loadRaw(path, password));
}

// exclusive: true is setup.ts's atomic create-only path — see
// writeSecureAtomic's own comment for why existsSync alone isn't enough.
export function saveHosts(path: string, hosts: Host[], password: string, options?: { exclusive?: boolean }): void {
  const sealed = seal(serialize(withKeepAlive(hosts)), password);
  writeSecureAtomic(path, sealed, undefined, options?.exclusive ?? false);
}
