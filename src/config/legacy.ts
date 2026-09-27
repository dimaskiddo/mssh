import { existsSync, linkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { msshRootDir } from "./paths";

// Compatibility shim for configs created before the default was renamed from
// `ssh_config.enc` to `config`.
export function legacyEncConfigPath(): string {
  return join(msshRootDir(), "ssh_config.enc");
}

// linkSync+unlinkSync rather than renameSync: rename(2) replaces an existing
// destination silently, and this runs on every invocation — link() fails
// with EEXIST instead, closing the TOCTOU race against a concurrent setup.
export function migrateLegacyConfigFrom(legacyPath: string, currentPath: string): boolean {
  if (!existsSync(legacyPath) || existsSync(currentPath)) return false;
  try {
    linkSync(legacyPath, currentPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  unlinkSync(legacyPath);
  return true;
}
