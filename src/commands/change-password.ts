// Pure-local-crypto, same exemption as list/edit/delete — must work on a
// machine with no ssh installed.
import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadSettings } from "../config/settings";
import { keysDir, toDisplayPath } from "../config/paths";
import { resolvePassword, promptNewPassword } from "../config/password";
import { loadRaw, openKeyFile, saveHosts, sealKeyFile } from "../core/store";
import { isSealedPayload } from "../core/crypto";
import { parse } from "../ssh/ssh-config";
import { isValidKeyFilename } from "../keyring/remote-keys";
import { migratePlaintextKeys, reportMigratedKeys } from "../keyring/key-store";
import { requireExistingConfig } from "../core/require-config";

// Split from changePassword so runChangePassword's verification-step loadRaw
// is reused instead of decrypting twice — scrypt is the dominant cost here.
//
// Key re-key is a 3-step protocol with no split-password window: (1) stage
// each key re-sealed under newPassword as `<name>.pem.next`, alongside its
// still-current-password original; (2) saveHosts under newPassword — the
// commit point; (3) rename each `.next` over its `.pem`. A crash between (2)
// and (3) is repaired by migratePlaintextKeys's own .pem.next recovery pass
// the next time any command runs: only the new password now opens the
// config, and a `.next` that opens with it proves the re-key committed.
export function reseal(path: string, raw: string, currentPassword: string, newPassword: string, keysDir: string): void {
  if (newPassword === currentPassword) {
    throw new Error("New password is the same as the current one.");
  }

  const staged: string[] = [];
  if (existsSync(keysDir)) {
    const names = readdirSync(keysDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".pem") && isValidKeyFilename(name));

    for (const name of names) {
      const keyPath = join(keysDir, name);
      const bytes = readFileSync(keyPath);
      // Not yet sealed: migratePlaintextKeys seals it under newPassword on
      // the next command that runs, once the config decrypts under it.
      if (!isSealedPayload(bytes)) continue;

      const plaintext = openKeyFile(keyPath, currentPassword);
      sealKeyFile(`${keyPath}.next`, plaintext, newPassword);
      staged.push(keyPath);
    }
  }

  saveHosts(path, parse(raw), newPassword); // commit point

  for (const keyPath of staged) {
    renameSync(`${keyPath}.next`, keyPath);
  }
}

export function changePassword(path: string, currentPassword: string, newPassword: string, keysDir: string): void {
  reseal(path, loadRaw(path, currentPassword), currentPassword, newPassword, keysDir);
}

export async function runChangePassword(envPasswordSet: boolean = false): Promise<void> {
  const { settings } = loadSettings();
  const path = configPath(settings);
  requireExistingConfig(path);

  console.error(`Re-keying ${path}.`);

  const current = await resolvePassword();

  // Verify current before collecting the new password twice, or a wrong
  // current password only surfaces after two more prompts. A decrypt failure
  // here just propagates — index.ts already prints err.message.
  const raw = loadRaw(path, current);

  // Runs before re-keying so reseal() only ever finds already-sealed keys to
  // re-key — a key still plaintext from an older mssh version gets sealed
  // under the (about to be superseded) current password first, then re-keyed
  // to the new one in the same run as everything else.
  reportMigratedKeys(migratePlaintextKeys(keysDir(), current).migrated);

  const next = await promptNewPassword();

  reseal(path, raw, current, next, keysDir());

  console.log(`Config re-keyed at ${path}.`);

  if (envPasswordSet) {
    console.error("Warning: MSSH_PASSWORD in your environment is now stale; update it or unattended connects will fail to decrypt.");
  }
}
