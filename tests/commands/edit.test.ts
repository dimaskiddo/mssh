import { test, expect } from "bun:test";
import { findHost, type Host, type ModeledField } from "../../src/ssh/host";
import { FIELD_LABELS, TAGS_LABEL } from "../../src/cli/field-labels";
import { FIELD_CHOICES, validateFieldValue, validateTags, tagsDefault } from "../../src/commands/edit";

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

test("FIELD_CHOICES exposes every ModeledField with its shared label as the display name, plus Tags", () => {
  const fields: ModeledField[] = ["hostname", "port", "user", "identityFile", "proxyJump"];
  const modeled = FIELD_CHOICES.filter((c): c is { name: string; value: ModeledField } => c.value !== "tags");
  expect(modeled.map((c) => c.value)).toEqual(fields);
  for (const choice of modeled) {
    expect(choice.name).toBe(FIELD_LABELS[choice.value]);
  }
  expect(FIELD_CHOICES.at(-1)).toEqual({ name: TAGS_LABEL, value: "tags" });
});

test("validateTags accepts a comma-separated list of valid tags, including empty", () => {
  expect(validateTags("")).toBe(true);
  expect(validateTags("alibaba,stage")).toBe(true);
});

test("validateTags rejects a piece that fails isValidTag", () => {
  expect(validateTags("alibaba,Not Valid")).toBe(
    "Tags may only contain letters, digits, '.', '_' or '-', separated by commas.",
  );
});

test("tagsDefault gives an empty string for a host with no tags (an old-format config)", () => {
  expect(tagsDefault(host({}))).toBe("");
});

test("tagsDefault joins an existing host's tags with commas", () => {
  expect(tagsDefault(host({ tags: ["a", "b"] }))).toBe("a,b");
});
