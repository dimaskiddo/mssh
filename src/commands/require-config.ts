// Every password-requiring command must confirm the config exists before
// prompting: typing a password into an operation that cannot succeed teaches
// nothing and hides the real problem, which is that setup was never run.
// Takes the resolved path rather than resolving it, so a caller's own path
// resolution (and the test mocks over it) stays authoritative.
import { existsSync, statSync } from "node:fs";
import { HEADER_LENGTH } from "../crypto";
import { fatal } from "../exit";

export function requireExistingConfig(path: string): void {
  if (!existsSync(path)) {
    fatal(`No config found at ${path}.`, "Run 'mssh setup' to create one.");
  }

  // Not a decrypt check: size alone is public, so reporting it leaks nothing
  // that open() wouldn't already report regardless of password. A wrong
  // password must still be indistinguishable from tampering — that stays
  // in store.ts's opaque message, after the prompt.
  const stat = statSync(path);
  if (!stat.isFile()) {
    fatal(`${path} is not a file (it may be a directory).`);
  }

  if (stat.size < HEADER_LENGTH) {
    fatal(`Config at ${path} is empty or truncated, not a usable mssh config.`, "Restore it from a backup, or delete it and run 'mssh setup'.");
  }
}
