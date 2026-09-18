import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";

const VERSION = 1;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ALGORITHM = "aes-256-gcm";

// Exported: a shorter-than-this file can never decrypt regardless of
// password, so callers may use it to reject one before ever prompting.
export const HEADER_LENGTH = 1 + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;

// OWASP-minimum scrypt cost. maxmem must exceed the working set (128*r*N
// bytes) — verified the Node/Bun check is strict '>', so 128*r*N exactly
// still throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS; the *2 keeps clear margin.
const KDF = { N: 131072, r: 8, p: 1, maxmem: 128 * 8 * 131072 * 2 } as const;

// The version byte is public plaintext, not secret-derived, so this one
// distinction is safe to surface. Every other failure folds into the
// opaque message.
export class UnsupportedVersionError extends Error {}

function deriveKey(passwordText: string, salt: Buffer): Buffer {
  return scryptSync(passwordText, salt, KEY_LENGTH, KDF);
}

export function seal(plaintext: string, passwordText: string): Buffer {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passwordText, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([VERSION]), salt, iv, tag, ciphertext]);
}

export function open(payload: Buffer, passwordText: string): string {
  if (payload.length < HEADER_LENGTH) {
    throw new Error("Invalid payload: too short");
  }
  if (payload[0] !== VERSION) {
    throw new UnsupportedVersionError("unsupported config format version; re-run 'mssh setup'");
  }

  let offset = 1;
  const salt = payload.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = payload.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const tag = payload.subarray(offset, offset + TAG_LENGTH);
  offset += TAG_LENGTH;
  const ciphertext = payload.subarray(offset);

  const key = deriveKey(passwordText, salt);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
