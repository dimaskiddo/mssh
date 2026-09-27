import { test, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { configPath, parseEnvText, pickSettings, hasStoredPassword, loadSettingsFrom } from "../../src/config/settings";
import { defaultEncConfigPath } from "../../src/config/paths";
import { withScratchDir as scratch } from "../helpers";

const withScratchDir = (fn: (dir: string) => void): void => scratch("mssh-app-config-test-", fn);

test("parseEnvText parses KEY=value lines, ignoring blanks and comments", () => {
  const text = `
# a comment
MSSH_PASSWORD=hunter2

DEFAULT_SSH_KEY_PATH=~/.ssh/id_rsa
# MSSH_CONFIG_PATH=disabled
`;
  expect(parseEnvText(text)).toEqual({
    MSSH_PASSWORD: "hunter2",
    DEFAULT_SSH_KEY_PATH: "~/.ssh/id_rsa",
  });
});

test("parseEnvText trims surrounding whitespace around key and value", () => {
  expect(parseEnvText("  MSSH_PASSWORD =  hunter2  \n")).toEqual({ MSSH_PASSWORD: "hunter2" });
});

test("parseEnvText ignores lines with no = separator", () => {
  expect(parseEnvText("not-a-directive\nMSSH_PASSWORD=hunter2")).toEqual({ MSSH_PASSWORD: "hunter2" });
});

test("parseEnvText strips surrounding double or single quotes from the value", () => {
  expect(parseEnvText('MSSH_PASSWORD="my pass"')).toEqual({ MSSH_PASSWORD: "my pass" });
  expect(parseEnvText("MSSH_PASSWORD='my pass'")).toEqual({ MSSH_PASSWORD: "my pass" });
});

test("parseEnvText handles an export prefix on the key", () => {
  expect(parseEnvText("export MSSH_PASSWORD=hunter2")).toEqual({ MSSH_PASSWORD: "hunter2" });
});

test("parseEnvText strips an inline comment on an unquoted value", () => {
  expect(parseEnvText("MSSH_PASSWORD=hunter2 # inline note")).toEqual({ MSSH_PASSWORD: "hunter2" });
});

test("parseEnvText does not treat a quoted value's internal # as a comment", () => {
  expect(parseEnvText('MSSH_PASSWORD="hunter2 # not a comment"')).toEqual({
    MSSH_PASSWORD: "hunter2 # not a comment",
  });
});

test("pickSettings keeps only known keys and drops empty values", () => {
  const raw = {
    DEFAULT_SSH_KEY_PATH: "/opt/keys/id_rsa",
    MSSH_CONFIG_PATH: "",
    UNKNOWN_KEY: "nope",
  };
  expect(pickSettings(raw)).toEqual({ DEFAULT_SSH_KEY_PATH: "/opt/keys/id_rsa" });
});

test("pickSettings expands ~ in path-valued keys", () => {
  const raw = {
    DEFAULT_SSH_KEY_PATH: "~/.ssh/id_rsa",
    MSSH_CONFIG_PATH: "~/elsewhere/ssh_config.enc",
  };
  expect(pickSettings(raw)).toEqual({
    DEFAULT_SSH_KEY_PATH: join(homedir(), ".ssh/id_rsa"),
    MSSH_CONFIG_PATH: join(homedir(), "elsewhere/ssh_config.enc"),
  });
});

test("pickSettings returns an empty object for non-object input", () => {
  expect(pickSettings(null)).toEqual({});
  expect(pickSettings("not an object")).toEqual({});
  expect(pickSettings(undefined)).toEqual({});
});

test("pickSettings throws loudly on a non-string value instead of silently discarding it", () => {
  expect(() => pickSettings({ DEFAULT_SSH_KEY_PATH: 12345 })).toThrow(/DEFAULT_SSH_KEY_PATH must be a string/);
});

test("pickSettings throws loudly on array-shaped input (a stray multi-document YAML)", () => {
  expect(() => pickSettings([{ DEFAULT_SSH_KEY_PATH: "~/.ssh/id_rsa" }])).toThrow(/expected a single mapping/);
});

test("pickSettings rejects a relative MSSH_CONFIG_PATH", () => {
  expect(() => pickSettings({ MSSH_CONFIG_PATH: "relative/config" })).toThrow(/must be an absolute path/);
});

test("pickSettings accepts a ~-relative MSSH_CONFIG_PATH since expandHome resolves it to absolute", () => {
  expect(pickSettings({ MSSH_CONFIG_PATH: "~/elsewhere/ssh_config.enc" })).toEqual({
    MSSH_CONFIG_PATH: join(homedir(), "elsewhere/ssh_config.enc"),
  });
});

test("configPath uses the override when MSSH_CONFIG_PATH is set", () => {
  expect(configPath({ MSSH_CONFIG_PATH: "/custom/ssh_config.enc" })).toBe("/custom/ssh_config.enc");
});

test("configPath falls back to the default location under ~/.mssh", () => {
  expect(configPath({})).toBe(defaultEncConfigPath());
});

test("hasStoredPassword is true when MSSH_PASSWORD is a non-empty string", () => {
  expect(hasStoredPassword({ MSSH_PASSWORD: "hunter2" })).toBe(true);
});

test("hasStoredPassword is true even for a non-string value, since a numeric YAML password still leaks", () => {
  expect(hasStoredPassword({ MSSH_PASSWORD: 12345 })).toBe(true);
});

test("hasStoredPassword is false for an empty string", () => {
  expect(hasStoredPassword({ MSSH_PASSWORD: "" })).toBe(false);
});

test("hasStoredPassword is false for null", () => {
  expect(hasStoredPassword({ MSSH_PASSWORD: null })).toBe(false);
});

test("hasStoredPassword is false when the key is absent", () => {
  expect(hasStoredPassword({})).toBe(false);
});

test("hasStoredPassword is false for array-shaped input", () => {
  expect(hasStoredPassword([{ MSSH_PASSWORD: "hunter2" }])).toBe(false);
});

test("hasStoredPassword is false for non-object input", () => {
  expect(hasStoredPassword(null)).toBe(false);
  expect(hasStoredPassword("not an object")).toBe(false);
  expect(hasStoredPassword(undefined)).toBe(false);
});

test("loadSettingsFrom prefers config.yaml over .env when both exist", () => {
  withScratchDir((dir) => {
    const yamlPath = join(dir, "config.yaml");
    const envPath = join(dir, ".env");
    writeFileSync(yamlPath, "DEFAULT_SSH_KEY_PATH: /from/yaml\n");
    writeFileSync(envPath, "DEFAULT_SSH_KEY_PATH=/from/env\n");

    const { settings, sourcePath, storedPassword } = loadSettingsFrom(yamlPath, envPath);
    expect(settings.DEFAULT_SSH_KEY_PATH).toBe("/from/yaml");
    expect(sourcePath).toBe(yamlPath);
    expect(storedPassword).toBe(false);
  });
});

test("loadSettingsFrom falls back to .env when config.yaml is absent", () => {
  withScratchDir((dir) => {
    const yamlPath = join(dir, "config.yaml");
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "DEFAULT_SSH_KEY_PATH=/from/env\n");

    const { settings, sourcePath, storedPassword } = loadSettingsFrom(yamlPath, envPath);
    expect(settings.DEFAULT_SSH_KEY_PATH).toBe("/from/env");
    expect(sourcePath).toBe(envPath);
    expect(storedPassword).toBe(false);
  });
});

test("loadSettingsFrom returns empty settings when neither file exists", () => {
  withScratchDir((dir) => {
    const yamlPath = join(dir, "config.yaml");
    const envPath = join(dir, ".env");
    expect(loadSettingsFrom(yamlPath, envPath)).toEqual({ settings: {}, sourcePath: undefined, storedPassword: false });
  });
});

test("loadSettingsFrom reports storedPassword: true when config.yaml carries MSSH_PASSWORD, without keeping it in settings", () => {
  withScratchDir((dir) => {
    const yamlPath = join(dir, "config.yaml");
    const envPath = join(dir, ".env");
    writeFileSync(yamlPath, "MSSH_PASSWORD: hunter2\n");

    const { settings, storedPassword } = loadSettingsFrom(yamlPath, envPath);
    expect(storedPassword).toBe(true);
    expect(settings).not.toHaveProperty("MSSH_PASSWORD");
  });
});

test("loadSettingsFrom throws a sanitized error on malformed config.yaml, never the raw parser message", () => {
  withScratchDir((dir) => {
    const yamlPath = join(dir, "config.yaml");
    const envPath = join(dir, ".env");
    // Invalid YAML, with a plaintext-looking password on the same line.
    writeFileSync(yamlPath, "MSSH_PASSWORD: [hunter2\n");

    let thrown: unknown;
    try {
      loadSettingsFrom(yamlPath, envPath);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("malformed config.yaml");
    expect(message).not.toContain("hunter2");
  });
});

test("loadSettingsFrom propagates a raw I/O error on config.yaml distinctly from a YAML syntax error", () => {
  withScratchDir((dir) => {
    // A directory at the yaml path: existsSync is true, but readFileSync
    // throws EISDIR — must not be relabeled "malformed config.yaml".
    const yamlPath = join(dir, "config.yaml");
    const envPath = join(dir, ".env");
    mkdirSync(yamlPath);

    let thrown: unknown;
    try {
      loadSettingsFrom(yamlPath, envPath);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as NodeJS.ErrnoException).code).toBe("EISDIR");
    expect((thrown as Error).message).not.toContain("malformed config.yaml");
  });
});
