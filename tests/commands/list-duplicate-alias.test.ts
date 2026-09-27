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
  loadSettings: () => ({ settings: { MSSH_CONFIG_PATH: configFilePath }, sourcePath: undefined, storedPassword: false }),
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

const tagText = "Host web1\n  ## Tags stage\n  HostName 1.2.3.4\n\nHost web2\n  HostName 5.6.7.8\n";

test("runList with a --tags filter lists only the tagged alias", async () => {
  writeFileSync(configFilePath, seal(tagText, TEST_PASSWORD));
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runList("asc", ["stage"]);
    expect(logSpy.mock.calls.flat()).toEqual(["web1"]);
  } finally {
    logSpy.mockRestore();
  }
});

test("runList with a --tags filter matching nothing prints the no-match message to stderr", async () => {
  writeFileSync(configFilePath, seal(tagText, TEST_PASSWORD));
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runList("asc", ["stage", "prod"]);
    expect(errorSpy).toHaveBeenCalledWith("No hosts match tag(s): stage, prod.");
    expect(logSpy).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  }
});

test("runList('tags', []) prints group headers and names, blank between groups, Others last", async () => {
  writeFileSync(configFilePath, seal(tagText, TEST_PASSWORD));
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runList("tags", []);
    expect(logSpy.mock.calls.flat()).toEqual(["[STAGE]", "web1", "", "[Others]", "web2"]);
  } finally {
    logSpy.mockRestore();
  }
});

test("runList('tags', ['stage']) prints only the matching group", async () => {
  writeFileSync(configFilePath, seal(tagText, TEST_PASSWORD));
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runList("tags", ["stage"]);
    expect(logSpy.mock.calls.flat()).toEqual(["[STAGE]", "web1"]);
  } finally {
    logSpy.mockRestore();
  }
});

test("runList('tags', ['nope']) gives the no-match stderr message and no stdout", async () => {
  writeFileSync(configFilePath, seal(tagText, TEST_PASSWORD));
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runList("tags", ["nope"]);
    expect(errorSpy).toHaveBeenCalledWith("No hosts match tag(s): nope.");
    expect(logSpy).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  }
});
