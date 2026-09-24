// `mssh change-password`: re-encrypts the existing config under a new
// password. Pure-local-crypto, same exemption as list/edit/delete — must
// work on a machine with no ssh installed.
import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { configPath, keysDir, loadSettings, resolvePassword, toDisplayPath } from "../app-config";
import { loadRaw, openKeyFile, saveHosts, sealKeyFile } from "../store";
import { isSealedPayload } from "../crypto";
import { parse } from "../ssh-config";
import { isValidKeyFilename } from "../remote-keys";
import { migratePlaintextKeys, reportMigratedKeys } from "../key-store";
import { promptPassword } from "../prompt";
import { fieldPrompt, PASSWORD_SET_LABEL, PASSWORD_CONFIRM_LABEL } from "../field-labels";
import { passwordsMatch, isValidPassword } from "./setup";
import { requireExistingConfig } from "./require-config";
import { fatal } from "../exit";

// Re-seals already-decrypted plaintext under newPassword, and re-keys every
// already-sealed key in keysDir the same way. Split from changePassword so
// runChangePassword's verification-step loadRaw is reused instead of
// decrypting twice — scrypt is the dominant cost of this command.
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

// Verifies currentPassword against disk, then re-seals under newPassword. No
// prompting, no process.exit — testable with real scratch files the same way
// store.ts's saveHosts/loadRaw are. loadRaw's opaque error surfaces as-is.
export function changePassword(path: string, currentPassword: string, newPassword: string, keysDir: string): void {
  reseal(path, loadRaw(path, currentPassword), currentPassword, newPassword, keysDir);
}

export async function runChangePassword(): Promise<void> {
  const loaded = loadSettings();
  const { settings, sourcePath } = loaded;
  const path = configPath(settings);
  requireExistingConfig(path);

  console.error(`Re-keying ${path}.`);

  // forcePrompt: true — a stray MSSH_PASSWORD in the environment must not let
  // someone at your terminal re-key your config without entering it.
  const current = await resolvePassword(loaded, { forcePrompt: true });

  // Verify current before collecting the new password twice, or a wrong
  // current password is only discovered after two more prompts. Plaintext is
  // kept (not re-derived), so reseal() below is the only other scrypt cost.
  let raw: string;
  try {
    raw = loadRaw(path, current);
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err));
  }

  // Runs before re-keying so reseal() only ever finds already-sealed keys to
  // re-key — a key still plaintext from an older mssh version gets sealed
  // under the (about to be superseded) current password first, then re-keyed
  // to the new one in the same run as everything else.
  reportMigratedKeys(migratePlaintextKeys(keysDir(), current).migrated);

  const next = await promptPassword(fieldPrompt(PASSWORD_SET_LABEL), {
    validate: (value) => (isValidPassword(value) ? true : "Password must not be empty."),
  });

  const confirm = await promptPassword(fieldPrompt(PASSWORD_CONFIRM_LABEL));

  if (!passwordsMatch(next, confirm)) {
    fatal("Passwords do not match.");
  }

  try {
    reseal(path, raw, current, next, keysDir());
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err));
  }

  console.log(`Config re-keyed at ${path}.`);

  if (sourcePath && settings.MSSH_PASSWORD !== undefined) {
    console.error(
      `Warning: MSSH_PASSWORD in ${toDisplayPath(sourcePath)} is now stale. Update or remove it, ` +
        `or every command that uses it will fail to decrypt.`,
    );
  }
}
