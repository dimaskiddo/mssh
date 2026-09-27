import { statSync } from "node:fs";
import { dirname } from "node:path";
import { promptPassword } from "../cli/prompt";
import { fieldPrompt, PASSWORD_LABEL, PASSWORD_SET_LABEL, PASSWORD_CONFIRM_LABEL } from "../cli/field-labels";
import { isWindows } from "../core/platform";
import { fatal } from "../core/exit";
import { toDisplayPath } from "./paths";
import type { Settings, LoadedSettings } from "./settings";

export function passwordsMatch(a: string, b: string): boolean {
  return a === b;
}

// seal/open round-trips fine on "" and pickSettings discards an empty
// MSSH_PASSWORD, so Enter-Enter would create a config keyed on "" that can
// never be reopened via a stored password. Existing empty-password configs still open.
export function isValidPassword(password: string): boolean {
  return password.length > 0;
}

// Prompted twice: a typo would make a config permanently unopenable. Fatal
// on mismatch rather than returning it — both callers would just fatal anyway.
export async function promptNewPassword(): Promise<string> {
  const first = await promptPassword(fieldPrompt(PASSWORD_SET_LABEL), {
    validate: (value) => (isValidPassword(value) ? true : "Password must not be empty."),
  });
  const confirm = await promptPassword(fieldPrompt(PASSWORD_CONFIRM_LABEL));
  if (!passwordsMatch(first, confirm)) {
    fatal("Passwords do not match.");
  }
  return first;
}

export function selectStoredPassword(settings: Settings, forcePrompt: boolean): string | undefined {
  if (forcePrompt) return undefined;
  return settings.MSSH_PASSWORD;
}

// group/other bits only — 0400 is stricter than 0600 and must not warn, so
// this checks what's readable/writable to others, not equality to 0600.
function warnIfWorldOrGroupAccessible(path: string, minimumMode: string): void {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      console.error(`Warning: ${toDisplayPath(path)} is accessible by others (mode ${mode.toString(8)}; should be ${minimumMode} or stricter)`);
    }
  } catch {
    // advisory only; a stat failure here is not this function's problem
  }
}

function warnIfNotPrivate(sourcePath: string): void {
  if (isWindows()) return; // POSIX mode bits are meaningless on Windows

  warnIfWorldOrGroupAccessible(sourcePath, "0600");
  warnIfWorldOrGroupAccessible(dirname(sourcePath), "0700");
}

// Takes the caller's own loadSettings() result rather than reloading — a
// second independent read could disagree if config.yaml was edited between
// the two calls.
export async function resolvePassword(loaded: LoadedSettings, opts: { forcePrompt: boolean }): Promise<string> {
  const { settings, sourcePath } = loaded;
  const stored = selectStoredPassword(settings, opts.forcePrompt);

  if (stored !== undefined) {
    if (sourcePath) warnIfNotPrivate(sourcePath);
    return stored;
  }

  return promptPassword(fieldPrompt(PASSWORD_LABEL));
}
