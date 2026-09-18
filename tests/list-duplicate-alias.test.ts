// Separate file from list.test.ts: mock.module() must run before list.ts is
// imported (see connect-spawn.test.ts), which list.test.ts's own static
// import already precludes. Only app-config is mocked; store.ts stays real.
import { test, expect, mock, spyOn, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal } from "../src/crypto";
import * as realAppConfig from "../src/app-config";

const scratchDir = mkdtempSync(join(tmpdir(), "mssh-list-duplicate-test-"));
const configFilePath = join(scratchDir, "ssh_config.enc");
const TEST_PASSWORD = "fixed-test-password";
const dupText = "Host web1\n  HostName first.example\n\nHost web1\n  HostName second.example\n";

writeFileSync(configFilePath, seal(dupText, TEST_PASSWORD));

mock.module("../src/app-config", () => ({
  ...realAppConfig,
  loadSettings: () => ({ settings: {}, sourcePath: undefined }),
  configPath: () => configFilePath,
  resolvePassword: async () => TEST_PASSWORD,
}));

const { runList } = await import("../src/commands/list");

afterAll(() => {
  mock.module("../src/app-config", () => realAppConfig);
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
