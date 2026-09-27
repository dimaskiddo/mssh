// openConfig({forcePrompt}) collapses loadSettings, configPath,
// requireExistingConfig and resolvePassword into one call for 7 commands.
// Same mocking pattern as commands/password-routing.test.ts, the real proof
// this wiring still routes forcePrompt correctly per call site.
import { test, expect, mock, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as realSettings from "../../src/config/settings";
import * as realPassword from "../../src/config/password";

const scratchDir = mkdtempSync(join(tmpdir(), "mssh-require-config-test-"));
const scratchConfigPath = join(scratchDir, "config");
writeFileSync(scratchConfigPath, "x".repeat(64));

mock.module("../../src/config/settings", () => ({
  ...realSettings,
  loadSettings: () => ({ settings: { MSSH_CONFIG_PATH: scratchConfigPath }, sourcePath: undefined }),
}));

mock.module("../../src/config/password", () => ({
  ...realPassword,
  resolvePassword: async (_loaded: unknown, opts: { forcePrompt: boolean }) => `password-for-${opts.forcePrompt}`,
}));

const { openConfig } = await import("../../src/core/require-config");

afterAll(() => {
  mock.module("../../src/config/settings", () => realSettings);
  mock.module("../../src/config/password", () => realPassword);
  rmSync(scratchDir, { recursive: true, force: true });
});

test("openConfig wires loadSettings, configPath, and resolvePassword together, passing forcePrompt through", async () => {
  const result = await openConfig({ forcePrompt: true });
  expect(result.path).toBe(scratchConfigPath);
  expect(result.password).toBe("password-for-true");
  expect(result.loaded.settings.MSSH_CONFIG_PATH).toBe(scratchConfigPath);
});

test("openConfig passes forcePrompt: false through unchanged", async () => {
  const result = await openConfig({ forcePrompt: false });
  expect(result.password).toBe("password-for-false");
});
