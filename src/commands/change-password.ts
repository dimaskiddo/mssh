// `mssh change-password`: re-encrypts the existing config under a new
// password. Pure-local-crypto, same exemption as list/edit/delete — must
// work on a machine with no ssh installed.
import { existsSync } from "node:fs";
import { configPath, loadSettings, resolvePassword, toDisplayPath } from "../app-config";
import { loadRaw, saveHosts } from "../store";
import { parse } from "../ssh-config";
import { promptPassword } from "../prompt";
import { fieldPrompt, PASSWORD_SET_LABEL, PASSWORD_CONFIRM_LABEL } from "../field-labels";
import { passwordsMatch } from "./setup";

// Verifies currentPassword against the file on disk, then re-seals it under
// newPassword. No prompting, no process.exit — the fs/crypto core, testable
// the same way store.ts's own saveHosts/loadRaw are, with real scratch files.
// loadRaw's opaque error (wrong password vs. corrupted file) surfaces as-is.
export async function changePassword(path: string, currentPassword: string, newPassword: string): Promise<void> {
  const raw = loadRaw(path, currentPassword);
  if (newPassword === currentPassword) {
    throw new Error("New password is the same as the current one.");
  }
  saveHosts(path, parse(raw), newPassword);
}

export async function runChangePassword(): Promise<void> {
  const { settings, sourcePath } = loadSettings();
  const path = configPath(settings);

  if (!existsSync(path)) {
    console.error(`No config found at ${path}. Run 'mssh setup' first.`);
    process.exit(1);
    return;
  }

  console.error(`Re-keying ${path}.`);

  // forcePrompt: true — a stray MSSH_PASSWORD in the environment must not let
  // someone at your terminal re-key your config without entering it.
  const current = await resolvePassword({ forcePrompt: true });

  const next = await promptPassword(fieldPrompt(PASSWORD_SET_LABEL));
  const confirm = await promptPassword(fieldPrompt(PASSWORD_CONFIRM_LABEL));

  if (!passwordsMatch(next, confirm)) {
    console.error("Passwords do not match.");
    process.exit(1);
    return;
  }

  try {
    await changePassword(path, current, next);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  console.log(`Config re-keyed at ${path}.`);

  if (sourcePath && settings.MSSH_PASSWORD !== undefined) {
    console.error(
      `Warning: MSSH_PASSWORD in ${toDisplayPath(sourcePath)} is now stale. Update or remove it, ` +
        `or every command that uses it will fail to decrypt.`,
    );
  }
}
