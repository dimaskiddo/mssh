// Every password-requiring command must confirm the config exists before
// prompting: typing a password into an operation that cannot succeed teaches
// nothing and hides the real problem, which is that setup was never run.
// Takes the resolved path rather than resolving it, so a caller's own path
// resolution (and the test mocks over it) stays authoritative.
import { existsSync, statSync } from "node:fs";
import { HEADER_LENGTH } from "../crypto";

export function requireExistingConfig(path: string): void {
  if (!existsSync(path)) {
    console.error(`No config found at ${path}.`);
    console.error("Run 'mssh setup' to create one.");
    process.exit(1);
  }

  // Not a decrypt check: size alone is public, so reporting it leaks nothing
  // that open() wouldn't already report regardless of password. A wrong
  // password must still be indistinguishable from tampering — that stays
  // in store.ts's opaque message, after the prompt.
  if (statSync(path).size < HEADER_LENGTH) {
    console.error(`Config at ${path} is empty or truncated, not a usable mssh config.`);
    console.error("Restore it from a backup, or delete it and run 'mssh setup'.");
    process.exit(1);
  }
}
