// resolvePassword is the one enforcement point for the forcePrompt split, but
// five call sites must pass it correctly — mocking it to throw, tagged with the
// forcePrompt it received, asserts that without a prompt, HOME, or real config.
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
// a real scratch file, sized past the crypto header, so that check passes.
const scratchDir = mkdtempSync(join(tmpdir(), "mssh-password-routing-test-"));
const scratchConfigPath = join(scratchDir, "config");
writeFileSync(scratchConfigPath, "x".repeat(64));

// configPath is overridden explicitly, not left to the ...realAppConfig
// spread: another file's mock.module() for this specifier may run first (all
// files' top-level code runs before any test body), contaminating a later "real" import.
mock.module("../src/app-config", () => ({
  ...realAppConfig,
  loadSettings: () => ({ settings: { MSSH_CONFIG_PATH: scratchConfigPath }, sourcePath: undefined }),
  configPath: () => scratchConfigPath,
  resolvePassword: async (_loaded: unknown, opts: { forcePrompt: boolean }) => {
    throw new HaltForTest(opts.forcePrompt);
  },
}));

const { runList, runListConnect } = await import("../src/commands/list");
const { runAdd } = await import("../src/commands/add");
const { runEdit } = await import("../src/commands/edit");
const { runDelete } = await import("../src/commands/delete");
const { runConnect } = await import("../src/commands/connect");
const { runChangePassword } = await import("../src/commands/change-password");

// mock.module() mutates Bun's shared registry for the whole run — restore it (see connect-spawn.test.ts).
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
