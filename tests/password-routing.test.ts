// The password-routing rule (AGENTS.md: forcePrompt true only for bare mssh
// and `config list`, false everywhere else) has exactly one enforcement
// point, resolvePassword, but five call sites that must invoke it correctly.
// Mocking app-config's resolvePassword to throw immediately, tagged with the
// forcePrompt it was given, turns "did this call site get it right" into an
// assertion without needing a real password prompt, home directory, or
// encrypted config on disk.
import { test, expect, mock, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as realAppConfig from "../src/app-config";

class HaltForTest extends Error {
  constructor(public readonly forcePrompt: boolean) {
    super("halted at resolvePassword for test inspection");
  }
}

// Every command under test now runs requireExistingConfig(path) — a real,
// unmocked node:fs check — before ever reaching resolvePassword. Point it at
// a real scratch file, sized past the crypto header (content otherwise
// irrelevant), so that check passes instead of hitting the sandbox's
// nonexistent ~/.mssh/config and process.exit(1)-ing for real.
const scratchDir = mkdtempSync(join(tmpdir(), "mssh-password-routing-test-"));
const scratchConfigPath = join(scratchDir, "config");
writeFileSync(scratchConfigPath, "x".repeat(64));

// configPath is overridden explicitly, not left to the ...realAppConfig
// spread: another test file's mock.module() for this same specifier may run
// first (Bun evaluates all files' top-level code before any test body runs)
// and mutate the shared module record in place, so a "real" import captured
// after that point is already contaminated with the other file's overrides.
mock.module("../src/app-config", () => ({
  ...realAppConfig,
  loadSettings: () => ({ settings: { MSSH_CONFIG_PATH: scratchConfigPath }, sourcePath: undefined }),
  configPath: () => scratchConfigPath,
  resolvePassword: async (opts: { forcePrompt: boolean }) => {
    throw new HaltForTest(opts.forcePrompt);
  },
}));

const { runList, runListConnect } = await import("../src/commands/list");
const { runAdd } = await import("../src/commands/add");
const { runEdit } = await import("../src/commands/edit");
const { runDelete } = await import("../src/commands/delete");
const { runConnect } = await import("../src/commands/connect");
const { runChangePassword } = await import("../src/commands/change-password");

// mock.module() replaces the module in Bun's registry for the rest of the
// test run, not just this file — must be undone or later files that import
// the real app-config would see this fake instead.
afterAll(() => {
  mock.module("../src/app-config", () => realAppConfig);
  rmSync(scratchDir, { recursive: true, force: true });
});

async function forcePromptSeenBy(fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HaltForTest) return err.forcePrompt;
    throw err;
  }
  throw new Error("expected resolvePassword to be called (and halt), but the run completed instead");
}

test("runList forces an interactive prompt, so a stray MSSH_PASSWORD can never silently dump the host list", async () => {
  expect(await forcePromptSeenBy(() => runList())).toBe(true);
});

test("runListConnect (bare mssh) also forces an interactive prompt, same rule as runList", async () => {
  expect(await forcePromptSeenBy(() => runListConnect())).toBe(true);
});

test("runConnect does not force a prompt, so MSSH_PASSWORD works for a plain connect", async () => {
  expect(await forcePromptSeenBy(() => runConnect(["somehost"]))).toBe(false);
});

test("runAdd does not force a prompt", async () => {
  expect(await forcePromptSeenBy(() => runAdd())).toBe(false);
});

test("runEdit does not force a prompt", async () => {
  expect(await forcePromptSeenBy(() => runEdit())).toBe(false);
});

test("runDelete does not force a prompt", async () => {
  expect(await forcePromptSeenBy(() => runDelete())).toBe(false);
});

test("runChangePassword forces an interactive prompt for the current password, so a stray MSSH_PASSWORD can never re-key a config unattended", async () => {
  expect(await forcePromptSeenBy(() => runChangePassword())).toBe(true);
});
