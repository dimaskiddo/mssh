import { test, expect } from "bun:test";
import { passwordsMatch, isValidPassword, takeEnvPassword } from "../../src/config/password";

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

test("takeEnvPassword returns MSSH_PASSWORD and removes it from the passed env object", () => {
  const env: NodeJS.ProcessEnv = { MSSH_PASSWORD: "hunter2" };
  expect(takeEnvPassword(env)).toBe("hunter2");
  expect(env.MSSH_PASSWORD).toBeUndefined();
  expect("MSSH_PASSWORD" in env).toBe(false);
});

test("takeEnvPassword returns undefined for an empty string, and still removes the key", () => {
  const env: NodeJS.ProcessEnv = { MSSH_PASSWORD: "" };
  expect(takeEnvPassword(env)).toBeUndefined();
  expect("MSSH_PASSWORD" in env).toBe(false);
});

test("takeEnvPassword returns undefined when the key is absent", () => {
  const env: NodeJS.ProcessEnv = {};
  expect(takeEnvPassword(env)).toBeUndefined();
});

// resolvePassword's no-prompt-when-envPassword-given behavior is covered in
// tests/index.test.ts via a real subprocess — several files in this suite
// mock.module this same module, which mutates one shared, permanent
// module-registry object for the whole test run, so no in-process import
// here is safe from racing those mocks.
