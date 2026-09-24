// Bridges the encrypted config file on disk to Host[] in memory. Purely
// crypto+fs+parse plumbing — no CLI, prompting, or path resolution here
// (that's app-config.ts's job); callers pass explicit paths and passwords.
import { existsSync, readFileSync } from "node:fs";
import { seal, open, openBytes, UnsupportedVersionError } from "./crypto";
import { parse, serialize, withKeepAlive, type Host } from "./ssh-config";
import { writeSecureAtomic } from "./secure-file";

// scryptSync can fail for reasons unrelated to the password (OOM, a rejected
// KDF parameter) — folding these into "wrong password" would send the user to
// `mssh setup`, destroying a config they were never actually locked out of.
const RESOURCE_ERROR_CODES = new Set(["ERR_CRYPTO_OUT_OF_MEMORY", "ERR_CRYPTO_INVALID_SCRYPT_PARAMS", "ENOMEM"]);

// Shared by loadRaw (config) and openKeyFile (pulled keys) — a decrypt
// failure never distinguishes wrong password from tampering on either path,
// and neither message may echo internals.
function foldDecryptError(err: unknown, what: string): never {
  if (err instanceof UnsupportedVersionError) throw err;

  const code = (err as NodeJS.ErrnoException).code;
  if (code !== undefined && RESOURCE_ERROR_CODES.has(code)) {
    throw new Error(`failed to decrypt ${what}: resource error, not a wrong password (${(err as Error).message})`);
  }
  // A TypeError here means a refactor broke a call signature, not a mistyped password.
  if (err instanceof TypeError) {
    throw new Error(`failed to decrypt ${what}: internal error, not a wrong password (${(err as Error).message})`);
  }

  throw new Error(`failed to decrypt ${what}: wrong password or corrupted file`);
}

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
    foldDecryptError(err, "config");
  }
}

// Reads and decrypts a pulled key file sealed by sealKeyFile. The error
// names the path, never the key's own bytes.
export function openKeyFile(path: string, password: string): Buffer {
  const payload = readFileSync(path);
  try {
    return openBytes(payload, password);
  } catch (err) {
    foldDecryptError(err, `key at ${path}`);
  }
}

// Verifies the sealed copy decrypts back to the exact input before it can
// ever replace what's on disk — writeSecureAtomic then makes that replacement atomic.
export function sealKeyFile(path: string, bytes: Buffer, password: string): void {
  const sealed = seal(bytes, password);
  if (!openBytes(sealed, password).equals(bytes)) {
    throw new Error(`failed to verify sealed key before writing ${path}`);
  }
  writeSecureAtomic(path, sealed);
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
