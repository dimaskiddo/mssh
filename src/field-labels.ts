// One source for every user-facing field label and the column they align in,
// so `config add`, `config edit` and `config delete` cannot drift apart.
import type { ModeledField } from "./ssh-config";

export const HOST_ALIAS_LABEL = "Host Alias";
export const FIELD_PICKER_LABEL = "Field";
export const KEY_PULL_LABEL = "Key to Pull";
export const PASSWORD_LABEL = "Password";
export const PASSWORD_SET_LABEL = "Set Password";
export const PASSWORD_CONFIRM_LABEL = "Confirm Password";
export const CONNECT_TO_LABEL = "Connect to";

export const FIELD_LABELS: Record<ModeledField, string> = {
  hostname: "Hostname / IP",
  port: "Port",
  user: "Username",
  identityFile: "Identity File",
  proxyJump: "Bastion / Jump Host",
};

// Every label that can appear before a ":" feeds the width, so the column fits
// the longest of them (Bastion / Jump Host) the way a web form aligns to its
// longest label. +1 keeps at least one space before the colon rather than
// letting that longest label butt against it. Exported so tests assert against
// the real list instead of a hand-maintained copy that could drift from it.
export const ALIGNED_LABELS = [
  HOST_ALIAS_LABEL,
  FIELD_PICKER_LABEL,
  KEY_PULL_LABEL,
  PASSWORD_LABEL,
  PASSWORD_SET_LABEL,
  PASSWORD_CONFIRM_LABEL,
  CONNECT_TO_LABEL,
  ...Object.values(FIELD_LABELS),
];
const FIELD_LABEL_WIDTH = Math.max(...ALIGNED_LABELS.map((l) => l.length)) + 1;

// Padding lives in the message string because prompt.ts's wrappers forward only
// `message` and `default` to @inquirer/prompts — there is no label/column option
// to reach for, and widening that seam for cosmetics is not worth it.
export function fieldPrompt(label: string): string {
  return `${label.padEnd(FIELD_LABEL_WIDTH)}:`;
}
