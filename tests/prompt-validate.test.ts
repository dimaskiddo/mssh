// Separate file from prompt.test.ts: mock.module() must run before the
// module under test is imported (see connect-spawn.test.ts), which
// prompt.test.ts's own static import of "../src/prompt" already precludes.
import { test, expect, mock, afterAll } from "bun:test";
import * as realInquirer from "@inquirer/prompts";

let captured: { validate?: unknown } | undefined;

mock.module("@inquirer/prompts", () => ({
  ...realInquirer,
  input: async (opts: { default?: string; validate?: unknown }) => {
    captured = opts;
    return opts.default ?? "";
  },
}));

const { promptInput } = await import("../src/prompt");

afterAll(() => {
  mock.module("@inquirer/prompts", () => realInquirer);
});

test("promptInput forwards validate through to @inquirer's input prompt", async () => {
  const validate = (value: string): true | string => (value === "" ? "required" : true);
  const originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  try {
    await promptInput("name?", { validate });
    expect(captured?.validate).toBe(validate);
  } finally {
    process.stdin.isTTY = originalIsTTY;
  }
});
