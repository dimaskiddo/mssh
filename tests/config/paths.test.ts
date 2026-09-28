import { test, expect, spyOn } from "bun:test";
import { homedir } from "node:os";
import * as nodeOs from "node:os";
import { join } from "node:path";
import {
  expandHome,
  toDisplayPath,
  msshRootDir,
  runDir,
  keysDir,
  defaultEncConfigPath,
  pickHomeDir,
  socketFallbackDir,
  type DirOwnership,
} from "../../src/config/paths";

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

// homeDir() (config/paths.ts) tries os.homedir() before process.env.HOME, and
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

function fakeStat(uid: number, mode: number): (path: string) => DirOwnership {
  return () => ({ uid, mode });
}

test("socketFallbackDir returns undefined when XDG_RUNTIME_DIR is unset", () => {
  expect(socketFallbackDir({}, fakeStat(1000, 0o700), 1000)).toBeUndefined();
});

test("socketFallbackDir returns undefined when XDG_RUNTIME_DIR is relative", () => {
  expect(socketFallbackDir({ XDG_RUNTIME_DIR: "run/user/1000" }, fakeStat(1000, 0o700), 1000)).toBeUndefined();
});

test("socketFallbackDir returns undefined when the directory is owned by another uid", () => {
  expect(socketFallbackDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, fakeStat(1001, 0o700), 1000)).toBeUndefined();
});

test("socketFallbackDir returns undefined when the directory's mode grants group or other access", () => {
  expect(socketFallbackDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, fakeStat(1000, 0o755), 1000)).toBeUndefined();
});

test("socketFallbackDir returns undefined when stat throws (directory missing)", () => {
  const throwing = () => {
    throw new Error("ENOENT");
  };
  expect(socketFallbackDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, throwing, 1000)).toBeUndefined();
});

test("socketFallbackDir returns <xdg>/mssh when the directory is 0700 and owned by us", () => {
  expect(socketFallbackDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, fakeStat(1000, 0o700), 1000)).toBe("/run/user/1000/mssh");
});

test("socketFallbackDir returns undefined when process.getuid is unavailable (e.g. Windows), using the real default parameter", () => {
  const original = process.getuid;
  process.getuid = undefined;
  try {
    expect(socketFallbackDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, fakeStat(1000, 0o700))).toBeUndefined();
  } finally {
    process.getuid = original;
  }
});
