import { test, expect } from "bun:test";
import { passwordsMatch, isValidPassword, installTarget, isDirOnPath, pathHint, installAction } from "../src/commands/setup";

test("passwordsMatch returns true when both entries are identical", () => {
  expect(passwordsMatch("hunter2", "hunter2")).toBe(true);
});

test("passwordsMatch returns false when entries differ (typo protection)", () => {
  expect(passwordsMatch("hunter2", "hunter3")).toBe(false);
});

test("passwordsMatch is case-sensitive", () => {
  expect(passwordsMatch("Hunter2", "hunter2")).toBe(false);
});

test("isValidPassword rejects the empty string", () => {
  expect(isValidPassword("")).toBe(false);
});

test("isValidPassword accepts any non-empty string", () => {
  expect(isValidPassword("a")).toBe(true);
  expect(isValidPassword("hunter2")).toBe(true);
});

test("isValidPassword accepts a single space, since passwords are never trimmed", () => {
  expect(isValidPassword(" ")).toBe(true);
});

test("installTarget on linux is ~/.local/bin/mssh", () => {
  expect(installTarget("linux", "/home/alice")).toBe("/home/alice/.local/bin/mssh");
});

test("installTarget on darwin is ~/.local/bin/mssh", () => {
  expect(installTarget("darwin", "/Users/alice")).toBe("/Users/alice/.local/bin/mssh");
});

test("installTarget on win32 uses LOCALAPPDATA when given", () => {
  expect(installTarget("win32", "C:\\Users\\alice", "C:\\Users\\alice\\AppData\\Local")).toBe(
    "C:\\Users\\alice\\AppData\\Local\\Programs\\mssh\\mssh.exe",
  );
});

test("installTarget on win32 falls back to home\\AppData\\Local when LOCALAPPDATA is unset", () => {
  expect(installTarget("win32", "C:\\Users\\alice")).toBe(
    "C:\\Users\\alice\\AppData\\Local\\Programs\\mssh\\mssh.exe",
  );
});

test("isDirOnPath finds an exact match on a POSIX PATH", () => {
  expect(isDirOnPath("/home/alice/.local/bin", "/usr/bin:/home/alice/.local/bin:/bin", "linux")).toBe(true);
});

test("isDirOnPath returns false when the directory is absent", () => {
  expect(isDirOnPath("/home/alice/.local/bin", "/usr/bin:/bin", "linux")).toBe(false);
});

test("isDirOnPath ignores a trailing slash on either side", () => {
  expect(isDirOnPath("/home/alice/.local/bin/", "/usr/bin:/home/alice/.local/bin", "linux")).toBe(true);
});

test("isDirOnPath ignores empty PATH entries (a leading/trailing/double colon)", () => {
  expect(isDirOnPath("/home/alice/.local/bin", ":/usr/bin::/home/alice/.local/bin:", "linux")).toBe(true);
});

test("isDirOnPath matches case-insensitively on win32", () => {
  expect(isDirOnPath("C:\\Users\\alice\\AppData\\Local\\Programs\\mssh", "C:\\Windows;c:\\users\\alice\\appdata\\local\\programs\\mssh", "win32")).toBe(true);
});

test("isDirOnPath splits on ';' on win32, not ':'", () => {
  expect(isDirOnPath("C:\\bin", "C:\\Windows;C:\\bin", "win32")).toBe(true);
  expect(isDirOnPath("C:\\bin", "C:\\Windows:C:\\bin", "win32")).toBe(false);
});

test("pathHint on POSIX is an export line naming the directory", () => {
  expect(pathHint("/home/alice/.local/bin", "linux")).toBe('export PATH="/home/alice/.local/bin:$PATH"');
});

test("pathHint on win32 is a PowerShell User PATH update naming the directory", () => {
  const hint = pathHint("C:\\Users\\alice\\AppData\\Local\\Programs\\mssh", "win32");
  expect(hint).toContain("C:\\Users\\alice\\AppData\\Local\\Programs\\mssh");
  expect(hint).toContain("User");
  expect(hint).toContain("[Environment]::SetEnvironmentVariable");
});

test("installAction: running binary is itself the target", () => {
  expect(installAction({ self: "/home/alice/.local/bin/mssh", target: "/home/alice/.local/bin/mssh", targetExists: true, onPath: undefined })).toBe(
    "already-installed",
  );
});

test("installAction: an already-installed copy is on PATH under a different path than the running binary", () => {
  expect(
    installAction({ self: "/tmp/dist/mssh", target: "/home/alice/.local/bin/mssh", targetExists: false, onPath: "/tmp/dist/mssh" }),
  ).toBe("already-installed");
});

test("installAction: no target file yet, and not already on PATH, offers a fresh install", () => {
  expect(
    installAction({ self: "/tmp/dist/mssh", target: "/home/alice/.local/bin/mssh", targetExists: false, onPath: undefined }),
  ).toBe("install");
});

test("installAction: a target file already exists (from a prior install) offers a replace", () => {
  expect(
    installAction({ self: "/tmp/dist/mssh", target: "/home/alice/.local/bin/mssh", targetExists: true, onPath: undefined }),
  ).toBe("replace");
});
