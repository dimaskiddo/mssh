import { input, password, select, confirm } from "@inquirer/prompts";

// Without stdin as a TTY (cron, systemd, `mssh host < /dev/null`), @inquirer
// prompts don't error — they wait, invisibly, until whatever launched mssh
// times out. Checked once per call rather than at module load so it reflects
// stdin at the moment of the actual prompt.
function requireTTY(): void {
  if (!process.stdin.isTTY) {
    throw new Error("no terminal available; set MSSH_PASSWORD in ~/.mssh/config.yaml");
  }
}

// @inquirer's own SIGINT message ("User force closed the prompt with SIGINT")
// is not something a Ctrl-C should print — matched by name, not an import,
// since @inquirer/core is a transitive dependency and its export surface
// isn't a contract mssh should assume from `@inquirer/prompts` directly.
function isExitPrompt(err: unknown): boolean {
  return err instanceof Error && err.name === "ExitPromptError";
}

async function runPrompt<T>(fn: () => Promise<T>): Promise<T> {
  requireTTY();
  try {
    return await fn();
  } catch (err) {
    if (isExitPrompt(err)) process.exit(130); // 128 + SIGINT, the shell convention
    throw err;
  }
}

// @inquirer's own contract: return true when valid, or a string message to
// show inline and re-prompt without losing any other answer already given.
export type Validator = (value: string) => true | string;

export function promptInput(message: string, opts?: { default?: string; validate?: Validator }): Promise<string> {
  return runPrompt(() => input({ message, default: opts?.default, validate: opts?.validate }));
}

export function promptPassword(message: string, opts?: { validate?: Validator }): Promise<string> {
  return runPrompt(() => password({ message, mask: true, validate: opts?.validate }));
}

export function promptSelect<T>(message: string, choices: Array<{ name: string; value: T }>): Promise<T> {
  return runPrompt(() => select({ message, choices }));
}

export function promptConfirm(message: string, opts?: { default?: boolean }): Promise<boolean> {
  return runPrompt(() => confirm({ message, default: opts?.default }));
}
