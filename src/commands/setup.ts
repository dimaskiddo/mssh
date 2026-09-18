// `mssh setup`: creates the initial empty encrypted config. Refuses to
// overwrite an existing config, and confirms the password twice since a typo
// would make the config permanently unopenable.
import { existsSync } from "node:fs";
import { configPath, loadSettings, msshRootDir } from "../app-config";
import { requireSsh } from "../ssh-binary";
import { ensureSecureDir } from "../secure-file";
import { promptPassword } from "../prompt";
import { saveHosts } from "../store";
import { fieldPrompt, PASSWORD_SET_LABEL, PASSWORD_CONFIRM_LABEL } from "../field-labels";

// Pure so the "don't overwrite" and "typo protection" rules are unit-testable
// without touching fs/prompts.
export function passwordsMatch(a: string, b: string): boolean {
  return a === b;
}

export async function runSetup(): Promise<void> {
  // Unconditional, unlike add/list/edit/delete's pure-local-crypto exemption:
  // mssh is useless without ssh, and telling the user at setup beats failing
  // later on their first connect attempt.
  requireSsh();

  const { settings } = loadSettings();
  const path = configPath(settings);

  if (existsSync(path)) {
    console.error(`Config already exists at ${path}. Refusing to overwrite.`);
    process.exit(1);
    return;
  }

  const passwordFirst = await promptPassword(fieldPrompt(PASSWORD_SET_LABEL));
  const passwordConfirm = await promptPassword(fieldPrompt(PASSWORD_CONFIRM_LABEL));

  if (!passwordsMatch(passwordFirst, passwordConfirm)) {
    console.error("Passwords do not match.");
    process.exit(1);
    return;
  }

  ensureSecureDir(msshRootDir());
  saveHosts(path, [], passwordFirst);

  console.log(`Config created at ${path}. Add hosts with 'mssh config add'.`);
}
