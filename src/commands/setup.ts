// `mssh setup`: creates the initial empty encrypted config. Refuses to
// overwrite an existing config, and confirms the password twice since a typo
// would make the config permanently unopenable.
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, loadSettings } from "../app-config";
import { requireSsh } from "../ssh-binary";
import { ensureSecureDir } from "../secure-file";
import { promptPassword } from "../prompt";
import { saveHosts } from "../store";
import { fieldPrompt, PASSWORD_SET_LABEL, PASSWORD_CONFIRM_LABEL } from "../field-labels";
import { fatal } from "../exit";

export function passwordsMatch(a: string, b: string): boolean {
  return a === b;
}

// seal/open round-trips fine on "" and pickSettings discards an empty
// MSSH_PASSWORD, so Enter-Enter would create a config keyed on "" that can
// never be reopened via a stored password. Existing empty-password configs still open.
export function isValidPassword(password: string): boolean {
  return password.length > 0;
}

export async function runSetup(): Promise<void> {
  // Unconditional, unlike add/list/edit/delete's pure-local-crypto exemption:
  // mssh is useless without ssh, and telling the user at setup beats failing
  // later on their first connect attempt.
  requireSsh();

  const { settings } = loadSettings();
  const path = configPath(settings);

  if (existsSync(path)) {
    fatal(`Config already exists at ${path}. Refusing to overwrite.`);
  }

  const passwordFirst = await promptPassword(fieldPrompt(PASSWORD_SET_LABEL), {
    validate: (value) => (isValidPassword(value) ? true : "Password must not be empty."),
  });

  const passwordConfirm = await promptPassword(fieldPrompt(PASSWORD_CONFIRM_LABEL));

  if (!passwordsMatch(passwordFirst, passwordConfirm)) {
    fatal("Passwords do not match.");
  }

  // dirname(path), not msshRootDir(): a custom MSSH_CONFIG_PATH outside
  // ~/.mssh would otherwise leave the config's actual directory unlocked-down,
  // and saveHosts below would fail with a bare ENOENT after two password prompts.
  ensureSecureDir(dirname(path));

  try {
    // exclusive: true — the existsSync check above sits before two password
    // prompts, so a concurrent `mssh setup` is a real TOCTOU; this is the
    // atomic guard, the earlier check just the fast, friendly common-case path.
    saveHosts(path, [], passwordFirst, { exclusive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      fatal(`Config already exists at ${path}. Refusing to overwrite.`);
    }
    throw err;
  }

  console.log(`Config created at ${path}. Add hosts with 'mssh config add'.`);
}
