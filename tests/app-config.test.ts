import { test, expect, spyOn } from "bun:test";
import { homedir } from "node:os";
import * as nodeOs from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { toDisplayPath, configPath, runDir, keysDir, defaultEncConfigPath, migrateLegacyConfigFrom } from "../src/app-config";
import { expandHome, parseEnvText, pickSettings, selectStoredPassword, loadSettingsFrom, msshRootDir, pickHomeDir } from "../src/internal";
import { withScratchDir as scratch } from "./helpers";

const withScratchDir = (fn: (dir: string) => void): void => scratch("mssh-app-config-test-", fn);

test("expandHome expands a bare ~ to the home directory", () => {
  expect(expandHome("~")).toBe(homedir());
});

test("expandHome expands a leading ~/ to a path under the home directory", () => {
  expect(expandHome("~/.ssh/id_rsa")).toBe(join(homedir(), ".ssh/id_rsa"));
});

test("expandHome leaves absolute and relative paths without a leading ~ untouched", () => {
  expect(expandHome("/etc/ssh/config")).toBe("/etc/ssh/config");
  expect(expandHome("relative/path")).toBe("relative/path");
});

test("expandHome does not expand ~ that isn't at the start of the path", () => {
  expect(expandHome("/foo/~/bar")).toBe("/foo/~/bar");
});

test("expandHome expands a leading ~\\ (Windows-style) to a path under the home directory", () => {
  expect(expandHome("~\\.ssh\\id_rsa")).toBe(join(homedir(), ".ssh\\id_rsa"));
});

test("toDisplayPath renders a home-relative absolute path back to ~ form", () => {
  expect(toDisplayPath(join(homedir(), ".mssh/.env"))).toBe("~/.mssh/.env");
  expect(toDisplayPath(homedir())).toBe("~");
});

test("toDisplayPath leaves a path outside the home directory untouched", () => {
  expect(toDisplayPath("/etc/ssh/config")).toBe("/etc/ssh/config");
});

// homeDir() (app-config.ts) tries os.homedir() before process.env.HOME, and
// Bun's homedir() does not honor a HOME set after startup — so redirecting it
// means spying on the node:os module namespace, exploiting the same
// live-binding behavior used for node:fs's writeSync in ssh-binary.test.ts.
function withHome(home: string, fn: () => void): void {
  const spy = spyOn(nodeOs, "homedir").mockReturnValue(home);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
}

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

test("toDisplayPath does not double the separator when home is the filesystem root", () => {
  withHome("/", () => {
    expect(toDisplayPath("/etc/ssh/config")).toBe("~/etc/ssh/config");
    expect(toDisplayPath("/")).toBe("~");
  });
});

test("toDisplayPath compares case-insensitively on Windows, where paths are case-insensitive", () => {
  withHome("/Users/Bob", () => {
    withPlatform("win32", () => {
      expect(toDisplayPath("/users/bob/.mssh/.env")).toBe("~/.mssh/.env");
    });
  });
});

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
    MSSH_PASSWORD: "hunter2",
    MSSH_CONFIG_PATH: "",
    UNKNOWN_KEY: "nope",
  };
  expect(pickSettings(raw)).toEqual({ MSSH_PASSWORD: "hunter2" });
});

test("pickSettings expands ~ in path-valued keys but not in MSSH_PASSWORD", () => {
  const raw = {
    DEFAULT_SSH_KEY_PATH: "~/.ssh/id_rsa",
    MSSH_CONFIG_PATH: "~/elsewhere/ssh_config.enc",
    MSSH_PASSWORD: "~not-a-path",
  };
  expect(pickSettings(raw)).toEqual({
    DEFAULT_SSH_KEY_PATH: join(homedir(), ".ssh/id_rsa"),
    MSSH_CONFIG_PATH: join(homedir(), "elsewhere/ssh_config.enc"),
    MSSH_PASSWORD: "~not-a-path",
  });
});

test("pickSettings returns an empty object for non-object input", () => {
  expect(pickSettings(null)).toEqual({});
  expect(pickSettings("not an object")).toEqual({});
  expect(pickSettings(undefined)).toEqual({});
});

test("pickSettings throws loudly on a non-string value instead of silently discarding it", () => {
  expect(() => pickSettings({ MSSH_PASSWORD: 12345 })).toThrow(/MSSH_PASSWORD must be a string/);
});

test("pickSettings throws loudly on array-shaped input (a stray multi-document YAML)", () => {
  expect(() => pickSettings([{ MSSH_PASSWORD: "hunter2" }])).toThrow(/expected a single mapping/);
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

test("selectStoredPassword ignores MSSH_PASSWORD entirely when forcePrompt is true", () => {
  expect(selectStoredPassword({ MSSH_PASSWORD: "hunter2" }, true)).toBeUndefined();
});

test("selectStoredPassword returns MSSH_PASSWORD when set and forcePrompt is false", () => {
  expect(selectStoredPassword({ MSSH_PASSWORD: "hunter2" }, false)).toBe("hunter2");
});

test("selectStoredPassword returns undefined when unset and forcePrompt is false", () => {
  expect(selectStoredPassword({}, false)).toBeUndefined();
});

test("loadSettingsFrom prefers config.yaml over .env when both exist", () => {
  withScratchDir((dir) => {
    const yamlPath = join(dir, "config.yaml");
    const envPath = join(dir, ".env");
    writeFileSync(yamlPath, "MSSH_PASSWORD: from-yaml\n");
    writeFileSync(envPath, "MSSH_PASSWORD=from-env\n");

    const { settings, sourcePath } = loadSettingsFrom(yamlPath, envPath);
    expect(settings.MSSH_PASSWORD).toBe("from-yaml");
    expect(sourcePath).toBe(yamlPath);
  });
});

test("loadSettingsFrom falls back to .env when config.yaml is absent", () => {
  withScratchDir((dir) => {
    const yamlPath = join(dir, "config.yaml");
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "MSSH_PASSWORD=from-env\n");

    const { settings, sourcePath } = loadSettingsFrom(yamlPath, envPath);
    expect(settings.MSSH_PASSWORD).toBe("from-env");
    expect(sourcePath).toBe(envPath);
  });
});

test("loadSettingsFrom returns empty settings when neither file exists", () => {
  withScratchDir((dir) => {
    const yamlPath = join(dir, "config.yaml");
    const envPath = join(dir, ".env");
    expect(loadSettingsFrom(yamlPath, envPath)).toEqual({ settings: {}, sourcePath: undefined });
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

test("path helpers are all rooted under ~/.mssh", () => {
  const root = msshRootDir();
  expect(root).toBe(join(homedir(), ".mssh"));
  expect(runDir()).toBe(join(root, "run"));
  expect(keysDir()).toBe(join(root, "keys"));
  expect(defaultEncConfigPath()).toBe(join(root, "config"));
});

test("pickHomeDir returns the first absolute candidate", () => {
  expect(pickHomeDir(["/home/alice"])).toBe("/home/alice");
  expect(pickHomeDir([undefined, "relative/path", "/home/bob"])).toBe("/home/bob");
});

test("pickHomeDir skips empty, undefined and relative candidates", () => {
  expect(pickHomeDir([undefined, "", "relative/path"])).toBeUndefined();
});

test("pickHomeDir returns undefined when no candidate qualifies", () => {
  expect(pickHomeDir([])).toBeUndefined();
});

test("migrateLegacyConfigFrom moves the legacy file to the current path and returns true", () => {
  withScratchDir((dir) => {
    const legacyPath = join(dir, "ssh_config.enc");
    const currentPath = join(dir, "config");
    writeFileSync(legacyPath, "legacy-ciphertext-bytes");

    expect(migrateLegacyConfigFrom(legacyPath, currentPath)).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
    expect(readFileSync(currentPath, "utf8")).toBe("legacy-ciphertext-bytes");
  });
});

test("migrateLegacyConfigFrom does nothing when the current path already exists", () => {
  withScratchDir((dir) => {
    const legacyPath = join(dir, "ssh_config.enc");
    const currentPath = join(dir, "config");
    writeFileSync(legacyPath, "legacy-bytes");
    writeFileSync(currentPath, "current-bytes");

    expect(migrateLegacyConfigFrom(legacyPath, currentPath)).toBe(false);
    expect(readFileSync(legacyPath, "utf8")).toBe("legacy-bytes");
    expect(readFileSync(currentPath, "utf8")).toBe("current-bytes");
  });
});

test("migrateLegacyConfigFrom does nothing when neither file exists", () => {
  withScratchDir((dir) => {
    const legacyPath = join(dir, "ssh_config.enc");
    const currentPath = join(dir, "config");

    expect(migrateLegacyConfigFrom(legacyPath, currentPath)).toBe(false);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(currentPath)).toBe(false);
  });
});
