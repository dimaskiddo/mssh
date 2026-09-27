// Every other command already does this automatically; this one exists so a
// user can run it explicitly and see the result.
import { keysDir } from "../config/paths";
import { loadRaw } from "../core/store";
import { migratePlaintextKeys } from "../keyring/key-store";
import { openConfig } from "../core/require-config";

export async function runMigrateKeys(): Promise<void> {
  const { path, password } = await openConfig({ forcePrompt: false });

  loadRaw(path, password); // verifies the password before it's used to seal keys

  const { migrated } = migratePlaintextKeys(keysDir(), password);
  if (migrated.length > 0) {
    console.log(`Encrypted ${migrated.length} pulled key(s) in ~/.mssh/keys.`);
  } else {
    console.log("No plaintext keys found.");
  }
}
