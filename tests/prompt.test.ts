// Real @inquirer prompts read the actual terminal, so these tests exercise
// only the TTY guard — the one part of prompt.ts that runs before @inquirer
// ever touches stdin, and the one part safe to assert without a live TTY.
import { test, expect } from "bun:test";
import { promptInput, promptPassword, promptSelect, promptConfirm } from "../src/prompt";

test("promptInput rejects immediately when stdin is not a TTY, instead of hanging", async () => {
  expect(process.stdin.isTTY).toBeFalsy(); // bun test's stdin is never a TTY
  await expect(promptInput("name?")).rejects.toThrow(/no terminal available/);
});

test("promptPassword rejects immediately when stdin is not a TTY", async () => {
  await expect(promptPassword("password?")).rejects.toThrow(/no terminal available/);
});

test("promptSelect rejects immediately when stdin is not a TTY", async () => {
  await expect(promptSelect("pick", [{ name: "a", value: "a" }])).rejects.toThrow(/no terminal available/);
});

test("promptConfirm rejects immediately when stdin is not a TTY", async () => {
  await expect(promptConfirm("ok?")).rejects.toThrow(/no terminal available/);
});
