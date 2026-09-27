// Keys are sealed in place under their original filename, so no IdentityFile
// path ever changes. Only files directly in keysDir() are touched; ~/.ssh
// never is.
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { expandHome } from "../config/paths";
import { openKeyFile, sealKeyFile, DecryptError } from "../core/store";
import { isSealedPayload } from "../core/crypto";
import { isValidKeyFilename } from "./remote-keys";
import { writeSecure } from "../fs/secure-write";
import { keyTempName } from "../fs/temp-names";
import { rewriteIdentityFiles, type Host } from "../ssh/host";

export function managedKeyPath(identityFile: string | undefined, keysDir: string): string | undefined {
  if (identityFile === undefined) return undefined;
  const resolved = resolve(expandHome(identityFile));
  if (dirname(resolved) !== resolve(keysDir)) return undefined;
  return resolved;
}

// The caller owns tempPaths and must register its cleanup before this call,
// so a partial failure still unlinks what was written.
export function materializeKeys(
  hosts: Host[],
  password: string,
  keysDir: string,
  runDir: string,
  tempPaths: string[],
): Host[] {
  const mapping = new Map<string, string>();

  for (const host of hosts) {
    const managed = managedKeyPath(host.identityFile, keysDir);
    if (managed === undefined || mapping.has(managed) || !existsSync(managed)) continue;

    // Not yet sealed means auto-migration hasn't run on it — leave it for
    // ssh to read as-is rather than fail the connection.
    if (!isSealedPayload(readFileSync(managed))) continue;

    const plaintext = openKeyFile(managed, password);
    const tempPath = join(runDir, keyTempName(process.pid, randomBytes(8).toString("hex")));
    writeSecure(tempPath, plaintext, undefined, "wx");
    tempPaths.push(tempPath);
    mapping.set(managed, tempPath);
  }

  return rewriteIdentityFiles(hosts, mapping);
}

// Precondition: the caller already decrypted the config with `password`,
// proving it's the real master password before it's used to seal keys.
// Crash-safe and idempotent — a re-run finishes whatever step it interrupted.
export function migratePlaintextKeys(keysDir: string, password: string): { migrated: string[] } {
  const migrated: string[] = [];
  if (!existsSync(keysDir)) return { migrated };

  const names = readdirSync(keysDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  // Finish any change-password re-key that committed the config but crashed
  // before renaming .pem.next over .pem — must run before sealing new
  // plaintext, or a half-committed re-key looks like an untouched key.
  for (const name of names) {
    if (!name.endsWith(".pem.next")) continue;
    const nextPath = join(keysDir, name);
    const target = nextPath.slice(0, -".next".length);
    try {
      openKeyFile(nextPath, password); // proves the config re-key committed under `password`
    } catch (err) {
      // ENOENT here means a second concurrent run already finished this
      // exact .next (opened, sealed, renamed away) before we got to it —
      // already done, not an error. Anything else still throws.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (!(err instanceof DecryptError)) throw err;
      try {
        unlinkSync(nextPath); // re-key never committed under this password; discard the orphaned attempt
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkErr; // already discarded by a concurrent run
      }
      continue;
    }
    // Outside the catch: on a rename failure the key IS sealed under the
    // committed password, so never delete it; leave .next for the next run.
    // ENOENT means a concurrent run already renamed it.
    try {
      renameSync(nextPath, target);
    } catch (renameErr) {
      if ((renameErr as NodeJS.ErrnoException).code !== "ENOENT") throw renameErr;
    }
  }

  for (const name of names) {
    if (name.endsWith(".pem.next") || !name.endsWith(".pem") || !isValidKeyFilename(name)) continue;

    const path = join(keysDir, name);
    const bytes = readFileSync(path);
    if (isSealedPayload(bytes)) continue;

    sealKeyFile(path, bytes, password);
    migrated.push(path);
  }

  return { migrated };
}

export function reportMigratedKeys(migrated: string[]): void {
  if (migrated.length > 0) {
    console.error(`Encrypted ${migrated.length} pulled key(s) in ~/.mssh/keys.`);
  }
}
