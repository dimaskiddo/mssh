// Lifecycle of pulled SSH keys sealed at rest under the master password.
// A managed key keeps its original filename — sealed in place, so no config
// IdentityFile path ever changes. Only files directly inside keysDir() are
// ever read, sealed or materialized; the user's own ~/.ssh is untouched.
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { expandHome } from "./app-config";
import { openKeyFile, sealKeyFile, DecryptError } from "./store";
import { isSealedPayload } from "./crypto";
import { isValidKeyFilename } from "./remote-keys";
import { writeSecure } from "./secure-file";
import { rewriteIdentityFiles, type Host } from "./ssh-config";

export function managedKeyPath(identityFile: string | undefined, keysDir: string): string | undefined {
  if (identityFile === undefined) return undefined;
  const resolved = resolve(expandHome(identityFile));
  if (dirname(resolved) !== resolve(keysDir)) return undefined;
  return resolved;
}

// Matches connect.ts's tempConfigName() convention (see sweep.ts's KEY_NAME).
export function keyTempName(pid: number, randomSuffix: string): string {
  return `key-${pid}-${randomSuffix}`;
}

// Decrypts each distinct managed key used by `hosts` into runDir, and
// rewrites IdentityFile to point at the temp copy — for the in-memory hosts
// written to a temp config only, never for what saveHosts seals to disk.
// Cleanup of tempPaths is the caller's responsibility, registered before
// this call so a failure partway still unlinks what was written.
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
      if (!(err instanceof DecryptError)) throw err;
      unlinkSync(nextPath); // re-key never committed under this password; discard the orphaned attempt
      continue;
    }
    // Outside the catch: a rename failure here means the key IS sealed under
    // the committed password, so it must never be deleted — leave .next for
    // the next run to retry instead.
    renameSync(nextPath, target);
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

// Shared by every command that calls migratePlaintextKeys, so the message
// and the silent-when-nothing-migrated rule live in one place.
export function reportMigratedKeys(migrated: string[]): void {
  if (migrated.length > 0) {
    console.error(`Encrypted ${migrated.length} pulled key(s) in ~/.mssh/keys.`);
  }
}
