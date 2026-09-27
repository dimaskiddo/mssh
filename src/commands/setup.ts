import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, loadSettings } from "../config/settings";
import { promptNewPassword } from "../config/password";
import { requireSsh } from "../ssh/ssh-binary";
import { ensureSecureDir } from "../fs/secure-write";
import { saveHosts } from "../core/store";
import { computeInstallPlan, offerInstall } from "../release/install";
import { fatal } from "../core/exit";

export async function runSetup(): Promise<void> {
  // Unconditional, unlike add/list/edit/delete's pure-local-crypto exemption:
  // mssh is useless without ssh, and telling the user at setup beats failing
  // later on their first connect attempt.
  requireSsh();

  const { settings } = loadSettings();
  const path = configPath(settings);

  if (existsSync(path)) {
    const plan = computeInstallPlan();
    if (plan === undefined || plan.action === "already-installed") {
      fatal(`Config already exists at ${path}. Refusing to overwrite.`);
    }
    console.log(`Config already exists at ${path}; leaving it untouched.`);
    await offerInstall(plan);
    return;
  }

  const passwordFirst = await promptNewPassword();

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
  await offerInstall(computeInstallPlan());
}
