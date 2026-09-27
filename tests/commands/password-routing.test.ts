// resolvePassword is the one enforcement point for the env-password split, but
// eight call sites must pass it correctly — mocking it to throw, tagged with
// the envPassword it received, checks that without a prompt, HOME, or config.
import { test, expect, mock, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as realSettings from "../../src/config/settings";
import * as realPassword from "../../src/config/password";

class HaltForTest extends Error {
  constructor(public readonly envPassword: string | undefined) {
    super("halted at resolvePassword for test inspection");
  }
}

// Every command under test runs requireExistingConfig(path) — a real,
// unmocked check — before reaching resolvePassword; a scratch file sized
// past the crypto header makes that check pass.
const scratchDir = mkdtempSync(join(tmpdir(), "mssh-password-routing-test-"));
const scratchConfigPath = join(scratchDir, "config");
writeFileSync(scratchConfigPath, "x".repeat(64));

// configPath stays real: it already reads MSSH_CONFIG_PATH from the mocked
// settings, and overriding it separately would leak; see ssh/session-spawn.test.ts.
mock.module("../../src/config/settings", () => ({
  ...realSettings,
  loadSettings: () => ({ settings: { MSSH_CONFIG_PATH: scratchConfigPath }, sourcePath: undefined, storedPassword: false }),
}));

mock.module("../../src/config/password", () => ({
  ...realPassword,
  resolvePassword: async (envPassword?: string) => {
    throw new HaltForTest(envPassword);
  },
}));

const { runList, runListConnect } = await import("../../src/commands/list");
const { runAdd } = await import("../../src/commands/add");
const { runEdit } = await import("../../src/commands/edit");
const { runDelete } = await import("../../src/commands/delete");
const { runMigrateKeys } = await import("../../src/commands/migrate-keys");
const { runConnect } = await import("../../src/commands/connect");
const { runChangePassword } = await import("../../src/commands/change-password");

// mock.module() mutates Bun's shared registry for the whole run — restore it (see ssh/session-spawn.test.ts).
afterAll(() => {
  mock.module("../../src/config/settings", () => realSettings);
  mock.module("../../src/config/password", () => realPassword);
  rmSync(scratchDir, { recursive: true, force: true });
});

async function envPasswordSeenBy(fn: () => Promise<void>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HaltForTest) return err.envPassword;
    throw err;
  }
  throw new Error("expected resolvePassword to be called (and halt), but the run completed instead");
}

// resolvePassword's real short-circuit on a given env password is covered in
// tests/index.test.ts via a real subprocess: mock.module here mutates the one
// shared, permanent module-registry object for the whole test run, so no
// in-process capture of "the real function" is safe once any file (including
// one that loads earlier, alphabetically, than this one) has mocked it.

test("runList always prompts, so a stray MSSH_PASSWORD can never silently dump the host list", async () => {
  expect(await envPasswordSeenBy(() => runList())).toBeUndefined();
});

test("runListConnect (bare mssh) always prompts, same rule as runList", async () => {
  expect(await envPasswordSeenBy(() => runListConnect())).toBeUndefined();
});

test("runConnect with no env password argument still always prompts", async () => {
  expect(await envPasswordSeenBy(() => runConnect(["somehost"]))).toBeUndefined();
});

test("runConnect passes a given env password through, so MSSH_PASSWORD works for a direct connect", async () => {
  expect(await envPasswordSeenBy(() => runConnect(["somehost"], "pw"))).toBe("pw");
});

test("runAdd always prompts", async () => {
  expect(await envPasswordSeenBy(() => runAdd())).toBeUndefined();
});

test("runEdit always prompts", async () => {
  expect(await envPasswordSeenBy(() => runEdit())).toBeUndefined();
});

test("runDelete always prompts", async () => {
  expect(await envPasswordSeenBy(() => runDelete())).toBeUndefined();
});

test("runMigrateKeys always prompts", async () => {
  expect(await envPasswordSeenBy(() => runMigrateKeys())).toBeUndefined();
});

test("runChangePassword always prompts for the current password, so a stray MSSH_PASSWORD can never re-key a config unattended", async () => {
  expect(await envPasswordSeenBy(() => runChangePassword())).toBeUndefined();
});
