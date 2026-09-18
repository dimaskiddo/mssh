// Bridges the encrypted config file on disk to Host[] in memory. Purely
// crypto+fs+parse plumbing — no CLI, prompting, or path resolution here
// (that's app-config.ts's job); callers pass explicit paths and passwords.
import { existsSync, readFileSync } from "node:fs";
import { seal, open, UnsupportedVersionError } from "./crypto";
import { parse, serialize, withKeepAlive, type Host } from "./ssh-config";
import { writeSecureAtomic } from "./secure-file";

// scryptSync can fail for reasons unrelated to the password (OOM, a rejected
// KDF parameter) — folding these into "wrong password" would send the user to
// `mssh setup`, destroying a config they were never actually locked out of.
const RESOURCE_ERROR_CODES = new Set(["ERR_CRYPTO_OUT_OF_MEMORY", "ERR_CRYPTO_INVALID_SCRYPT_PARAMS", "ENOMEM"]);

// open() doesn't distinguish wrong password from a tampered payload, and its
// message could echo internals — always throw one opaque message instead.
export function loadRaw(path: string, password: string): string {
  if (!existsSync(path)) {
    throw new Error(`no config found at ${path}`);
  }

  // Only the decrypt call is wrapped — a raw fs error here is a distinct
  // filesystem problem, not a crypto-internals leak.
  const payload = readFileSync(path);
  try {
    return open(payload, password);
  } catch (err) {
    if (err instanceof UnsupportedVersionError) throw err;

    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && RESOURCE_ERROR_CODES.has(code)) {
      throw new Error(`failed to decrypt config: resource error, not a wrong password (${(err as Error).message})`);
    }
    // A TypeError here means a refactor broke a call signature, not a mistyped password.
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
  writeSecureAtomic(path, sealed, undefined, options?.exclusive);
}
