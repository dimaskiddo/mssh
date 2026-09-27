import { spawn } from "node:child_process";
import { keysDir } from "../config/paths";
import { loadRaw } from "../core/store";
import { migratePlaintextKeys, reportMigratedKeys } from "../keyring/key-store";
import { connectWithRaw, type SpawnFn } from "../ssh/session";
import { openConfig } from "../core/require-config";

export async function runConnect(argv: string[], spawnFn: SpawnFn = spawn): Promise<void> {
  const { path, password } = await openConfig({ forcePrompt: false });
  const raw = loadRaw(path, password);
  reportMigratedKeys(migratePlaintextKeys(keysDir(), password).migrated);

  connectWithRaw(raw, argv, password, spawnFn);
}
