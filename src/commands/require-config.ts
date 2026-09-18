// Confirms the config exists before any command prompts for a password —
// typing one into an operation that can't succeed just hides that setup was never run.
import { existsSync, statSync } from "node:fs";
import { HEADER_LENGTH } from "../crypto";
import { fatal } from "../exit";

export function requireExistingConfig(path: string): void {
  if (!existsSync(path)) {
    fatal(`No config found at ${path}.`, "Run 'mssh setup' to create one.");
  }

  // Not a decrypt check: size alone is public and leaks nothing beyond what
  // open() would already report — a wrong password stays indistinguishable from tampering.
  const stat = statSync(path);
  if (!stat.isFile()) {
    fatal(`${path} is not a file (it may be a directory).`);
  }

  if (stat.size < HEADER_LENGTH) {
    fatal(`Config at ${path} is empty or truncated, not a usable mssh config.`, "Restore it from a backup, or delete it and run 'mssh setup'.");
  }
}
