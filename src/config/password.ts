import { promptPassword } from "../cli/prompt";
import { fieldPrompt, PASSWORD_LABEL, PASSWORD_SET_LABEL, PASSWORD_CONFIRM_LABEL } from "../cli/field-labels";
import { fatal } from "../core/exit";

export function passwordsMatch(a: string, b: string): boolean {
  return a === b;
}

// seal/open round-trips fine on "" and takeEnvPassword discards an empty
// MSSH_PASSWORD, so Enter-Enter would create a config keyed on "" that can
// never be reopened via the env var. Existing empty-password configs still open.
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

// Reads MSSH_PASSWORD from the given env and always deletes it — ssh (and its
// ProxyJump re-exec child) inherits process.env, so leaving it there would
// hand it to every spawned child, and to the remote server via SendEnv.
export function takeEnvPassword(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.MSSH_PASSWORD;
  delete env.MSSH_PASSWORD;
  return value === undefined || value === "" ? undefined : value;
}

// Only runConnect ever passes envPassword — every other command calls this
// with no argument, so it always prompts. That structural split is what
// replaces the old forcePrompt flag.
export async function resolvePassword(envPassword?: string): Promise<string> {
  if (envPassword !== undefined) return envPassword;
  return promptPassword(fieldPrompt(PASSWORD_LABEL));
}
