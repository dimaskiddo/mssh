// `mssh config migrate-keys`: pure-local-crypto, same exemption as
// list/edit/delete — verifies the password by decrypting the config, then
// seals any pulled key in keysDir still left over from an older mssh
// version. Every other command already does this automatically; this one
// exists so a user can run it explicitly and see the result.
import { configPath, keysDir, loadSettings, resolvePassword } from "../app-config";
import { loadRaw } from "../store";
import { migratePlaintextKeys } from "../key-store";
import { requireExistingConfig } from "./require-config";

export async function runMigrateKeys(): Promise<void> {
  const loaded = loadSettings();
  const path = configPath(loaded.settings);
  requireExistingConfig(path);
  const password = await resolvePassword(loaded, { forcePrompt: false });

  loadRaw(path, password); // verifies the password before it's used to seal keys

  const { migrated } = migratePlaintextKeys(keysDir(), password);
  if (migrated.length > 0) {
    console.log(`Encrypted ${migrated.length} pulled key(s) in ~/.mssh/keys.`);
  } else {
    console.log("No plaintext keys found.");
  }
}
