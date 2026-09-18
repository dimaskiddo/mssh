import { test, expect } from "bun:test";
import { findHost } from "../src/commands/edit";
import { FIELD_LABELS } from "../src/field-labels";
import type { Host, ModeledField } from "../src/ssh-config";
import { FIELD_CHOICES, validateFieldValue } from "../src/internal";

function host(overrides: Partial<Host>): Host {
  return { names: ["web1"], extras: [], ...overrides };
}

test("findHost returns the host with a matching name", () => {
  const hosts = [host({ names: ["web1"] }), host({ names: ["web2"] })];
  expect(findHost(hosts, "web2")).toEqual(host({ names: ["web2"] }));
});

test("findHost matches any one of a multi-pattern host's names", () => {
  const hosts = [host({ names: ["a", "b"] })];
  expect(findHost(hosts, "b")).toEqual(host({ names: ["a", "b"] }));
});

test("findHost returns undefined when no host matches", () => {
  const hosts = [host({ names: ["web1"] })];
  expect(findHost(hosts, "missing")).toBeUndefined();
});

test("findHost returns undefined for an empty list", () => {
  expect(findHost([], "web1")).toBeUndefined();
});

test("validateFieldValue rejects a non-numeric port", () => {
  expect(validateFieldValue("port", "abc")).toBe("Port must be a number between 1 and 65535.");
});

test("validateFieldValue accepts the same non-numeric text for a non-port field", () => {
  expect(validateFieldValue("user", "abc")).toBe(true);
});

test("validateFieldValue rejects a newline for both port and non-port fields", () => {
  expect(validateFieldValue("port", "22\nrest")).toBe("Port cannot contain a newline.");
  expect(validateFieldValue("user", "bob\nrest")).toBe("Username cannot contain a newline.");
});

test("FIELD_CHOICES exposes every ModeledField with its shared label as the display name", () => {
  const fields: ModeledField[] = ["hostname", "port", "user", "identityFile", "proxyJump"];
  expect(FIELD_CHOICES.map((c) => c.value)).toEqual(fields);
  for (const choice of FIELD_CHOICES) {
    expect(choice.name).toBe(FIELD_LABELS[choice.value]);
  }
});
