import { test, expect } from "bun:test";
import { EXECUTING_DIRECTIVES, REFUSED_DIRECTIVES, normalizeDirectiveKey } from "../../src/ssh/directives";

test("EXECUTING_DIRECTIVES matches lowercase keys only, as parse/serialize both lowercase before checking", () => {
  for (const key of EXECUTING_DIRECTIVES) {
    expect(key).toBe(key.toLowerCase());
  }
});

test("normalizeDirectiveKey unquotes a wrapped key and rejects a malformed one", () => {
  expect(normalizeDirectiveKey("ProxyCommand")).toBe("ProxyCommand");
  expect(normalizeDirectiveKey('"ProxyCommand"')).toBe("ProxyCommand");
  expect(normalizeDirectiveKey('Pro"xy"Command')).toBeUndefined();
  expect(normalizeDirectiveKey("Proxy\\Command")).toBeUndefined();
});

test("REFUSED_DIRECTIVES is a superset of EXECUTING_DIRECTIVES plus Include", () => {
  for (const key of EXECUTING_DIRECTIVES) {
    expect(REFUSED_DIRECTIVES.has(key)).toBe(true);
  }
  expect(REFUSED_DIRECTIVES.has("include")).toBe(true);
});
