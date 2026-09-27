// Separate file from list.test.ts: mock.module() must run before list.ts is
// imported (see ssh/session-spawn.test.ts), which list.test.ts's own static
// import already precludes. Only config/settings and config/password are
// mocked; store.ts stays real.
import { test, expect, mock, spyOn, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal } from "../../src/core/crypto";
import * as realSettings from "../../src/config/settings";
import * as realPassword from "../../src/config/password";

const scratchDir = mkdtempSync(join(tmpdir(), "mssh-list-duplicate-test-"));
const configFilePath = join(scratchDir, "ssh_config.enc");
const TEST_PASSWORD = "fixed-test-password";
const dupText = "Host web1\n  HostName first.example\n\nHost web1\n  HostName second.example\n";

writeFileSync(configFilePath, seal(dupText, TEST_PASSWORD));

// configPath stays real: it already reads MSSH_CONFIG_PATH from the mocked
// settings, and overriding it separately would leak; see ssh/session-spawn.test.ts.
mock.module("../../src/config/settings", () => ({
  ...realSettings,
  loadSettings: () => ({ settings: { MSSH_CONFIG_PATH: configFilePath }, sourcePath: undefined }),
}));

mock.module("../../src/config/password", () => ({
  ...realPassword,
  resolvePassword: async () => TEST_PASSWORD,
}));

const { runList } = await import("../../src/commands/list");

afterAll(() => {
  mock.module("../../src/config/settings", () => realSettings);
  mock.module("../../src/config/password", () => realPassword);
  rmSync(scratchDir, { recursive: true, force: true });
});

test("runList warns on stderr about a duplicate alias, and stdout still lists it", async () => {
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runList();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('alias "web1" is defined by more than one host'));
    expect(logSpy.mock.calls.flat()).toContain("web1");
  } finally {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  }
});
