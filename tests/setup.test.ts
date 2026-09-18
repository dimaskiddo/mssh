import { test, expect } from "bun:test";
import { passwordsMatch, isValidPassword } from "../src/commands/setup";

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
