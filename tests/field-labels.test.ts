import { test, expect } from "bun:test";
import {
  FIELD_LABELS,
  HOST_ALIAS_LABEL,
  FIELD_PICKER_LABEL,
  KEY_PULL_LABEL,
  PASSWORD_LABEL,
  PASSWORD_SET_LABEL,
  PASSWORD_CONFIRM_LABEL,
  CONNECT_TO_LABEL,
  fieldPrompt,
} from "../src/field-labels";
import type { ModeledField } from "../src/ssh-config";
import { ALIGNED_LABELS } from "../src/internal";

test("fieldPrompt puts the colon at the same column for every aligned label", () => {
  const columns = new Set(ALIGNED_LABELS.map((label) => fieldPrompt(label).indexOf(":")));
  expect(columns.size).toBe(1);
});

test("fieldPrompt never lets a label touch the colon, even the widest one", () => {
  for (const label of ALIGNED_LABELS) {
    const prompt = fieldPrompt(label);
    expect(prompt.indexOf(":")).toBeGreaterThan(label.length);
  }
});

test("every exported prompt label participates in the shared width", () => {
  const exported = [
    HOST_ALIAS_LABEL,
    FIELD_PICKER_LABEL,
    KEY_PULL_LABEL,
    PASSWORD_LABEL,
    PASSWORD_SET_LABEL,
    PASSWORD_CONFIRM_LABEL,
    CONNECT_TO_LABEL,
    ...Object.values(FIELD_LABELS),
  ];
  for (const label of exported) expect(ALIGNED_LABELS).toContain(label);
});

test("the column is still set by the widest label, Bastion / Jump Host", () => {
  expect(fieldPrompt(FIELD_LABELS.proxyJump)).toBe("Bastion / Jump Host :");
});

test("fieldPrompt pads rather than truncates a label longer than the widest known one", () => {
  const longLabel = "X".repeat(200);
  expect(fieldPrompt(longLabel)).toBe(`${longLabel}:`);
});

test("FIELD_LABELS has a non-empty label for every ModeledField", () => {
  const fields: ModeledField[] = ["hostname", "port", "user", "identityFile", "proxyJump"];
  for (const field of fields) {
    expect(FIELD_LABELS[field].length).toBeGreaterThan(0);
  }
});

test("fieldPrompt is referentially transparent, so add and edit render the same column", () => {
  expect(fieldPrompt(FIELD_LABELS.hostname)).toBe(fieldPrompt(FIELD_LABELS.hostname));
});
