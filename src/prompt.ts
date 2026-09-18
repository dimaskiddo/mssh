import { input, password, select, confirm } from "@inquirer/prompts";

export function promptInput(message: string, opts?: { default?: string }): Promise<string> {
  return input({ message, default: opts?.default });
}

export function promptPassword(message: string): Promise<string> {
  return password({ message, mask: true });
}

export function promptSelect<T>(message: string, choices: Array<{ name: string; value: T }>): Promise<T> {
  return select({ message, choices });
}

export function promptConfirm(message: string, opts?: { default?: boolean }): Promise<boolean> {
  return confirm({ message, default: opts?.default });
}
