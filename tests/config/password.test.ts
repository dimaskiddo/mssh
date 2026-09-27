import { test, expect } from "bun:test";
import { passwordsMatch, isValidPassword, selectStoredPassword } from "../../src/config/password";

test("passwordsMatch returns true when both entries are identical", () => {
  expect(passwordsMatch("hunter2", "hunter2")).toBe(true);
});

test("passwordsMatch returns false when entries differ (typo protection)", () => {
  expect(passwordsMatch("hunter2", "hunter3")).toBe(false);
});

test("passwordsMatch is case-sensitive", () => {
  expect(passwordsMatch("Hunter2", "hunter2")).toBe(false);
});

test("isValidPassword rejects the empty string", () => {
  expect(isValidPassword("")).toBe(false);
});

test("isValidPassword accepts any non-empty string", () => {
  expect(isValidPassword("a")).toBe(true);
  expect(isValidPassword("hunter2")).toBe(true);
});

test("isValidPassword accepts a single space, since passwords are never trimmed", () => {
  expect(isValidPassword(" ")).toBe(true);
});

test("selectStoredPassword ignores MSSH_PASSWORD entirely when forcePrompt is true", () => {
  expect(selectStoredPassword({ MSSH_PASSWORD: "hunter2" }, true)).toBeUndefined();
});

test("selectStoredPassword returns MSSH_PASSWORD when set and forcePrompt is false", () => {
  expect(selectStoredPassword({ MSSH_PASSWORD: "hunter2" }, false)).toBe("hunter2");
});

test("selectStoredPassword returns undefined when unset and forcePrompt is false", () => {
  expect(selectStoredPassword({}, false)).toBeUndefined();
});
