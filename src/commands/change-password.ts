// `mssh change-password`: re-encrypts the existing config under a new
// password. Pure-local-crypto, same exemption as list/edit/delete — must
// work on a machine with no ssh installed.
import { configPath, loadSettings, resolvePassword, toDisplayPath } from "../app-config";
import { loadRaw, saveHosts } from "../store";
import { parse } from "../ssh-config";
import { promptPassword } from "../prompt";
import { fieldPrompt, PASSWORD_SET_LABEL, PASSWORD_CONFIRM_LABEL } from "../field-labels";
import { passwordsMatch, isValidPassword } from "./setup";
import { requireExistingConfig } from "./require-config";
import { fatal } from "../exit";

// Re-seals already-decrypted plaintext under newPassword. Split from
// changePassword so runChangePassword's verification-step loadRaw is reused
// instead of decrypting twice — scrypt is the dominant cost of this command.
export function reseal(path: string, raw: string, currentPassword: string, newPassword: string): void {
  if (newPassword === currentPassword) {
    throw new Error("New password is the same as the current one.");
  }
  saveHosts(path, parse(raw), newPassword);
}

// Verifies currentPassword against disk, then re-seals under newPassword. No
// prompting, no process.exit — testable with real scratch files the same way
// store.ts's saveHosts/loadRaw are. loadRaw's opaque error surfaces as-is.
export function changePassword(path: string, currentPassword: string, newPassword: string): void {
  reseal(path, loadRaw(path, currentPassword), currentPassword, newPassword);
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

  const next = await promptPassword(fieldPrompt(PASSWORD_SET_LABEL), {
    validate: (value) => (isValidPassword(value) ? true : "Password must not be empty."),
  });

  const confirm = await promptPassword(fieldPrompt(PASSWORD_CONFIRM_LABEL));

  if (!passwordsMatch(next, confirm)) {
    fatal("Passwords do not match.");
  }

  try {
    reseal(path, raw, current, next);
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
