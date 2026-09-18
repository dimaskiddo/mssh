import { test, expect } from "bun:test";
import { forwardsTermAndHup, tempConfigName, rejectedFlags, childExitCode } from "../src/commands/connect";

test("forwardsTermAndHup is true on POSIX platforms", () => {
  expect(forwardsTermAndHup("linux")).toBe(true);
  expect(forwardsTermAndHup("darwin")).toBe(true);
});

test("forwardsTermAndHup is false on win32", () => {
  expect(forwardsTermAndHup("win32")).toBe(false);
});

test("tempConfigName embeds the pid and the given random suffix", () => {
  expect(tempConfigName(123, "abc123")).toBe("cfg-123-abc123");
  expect(tempConfigName(123, "abc123")).not.toBe(tempConfigName(123, "def456"));
  expect(tempConfigName(123, "abc123")).not.toBe(tempConfigName(124, "abc123"));
});

test("rejectedFlags passes through an argv with no dangerous flags", () => {
  expect(rejectedFlags(["myhost", "-L", "8080:localhost:80"])).toBeUndefined();
});

test("rejectedFlags rejects a separate -F flag", () => {
  expect(rejectedFlags(["myhost", "-F", "/tmp/other"])).toBe("-F");
});

test("rejectedFlags rejects an attached -Fpath flag", () => {
  expect(rejectedFlags(["myhost", "-F/tmp/other"])).toBe("-F/tmp/other");
});

test("rejectedFlags rejects -o ProxyCommand=... as a separate argument", () => {
  expect(rejectedFlags(["myhost", "-o", "ProxyCommand=id"])).toBe("-o");
});

test("rejectedFlags rejects -oProxyCommand=... attached, case-insensitively", () => {
  expect(rejectedFlags(["myhost", "-oproxycommand=id"])).toBe("-oproxycommand=id");
});

test("rejectedFlags does not reject an unrelated -o option", () => {
  expect(rejectedFlags(["myhost", "-o", "StrictHostKeyChecking=no"])).toBeUndefined();
});

test("rejectedFlags rejects -o LocalCommand=... as a separate argument", () => {
  expect(rejectedFlags(["myhost", "-o", "LocalCommand=id"])).toBe("-o");
});

test("rejectedFlags rejects -oKnownHostsCommand=... attached, case-insensitively", () => {
  expect(rejectedFlags(["myhost", "-oKnownHostsCommand=/tmp/evil"])).toBe("-oKnownHostsCommand=/tmp/evil");
});

test("rejectedFlags passes through a harmless -o ServerAliveInterval", () => {
  expect(rejectedFlags(["myhost", "-o", "ServerAliveInterval=30"])).toBeUndefined();
});

test("childExitCode returns the child's exit code when it exited normally", () => {
  expect(childExitCode(0, null)).toBe(0);
  expect(childExitCode(3, null)).toBe(3);
});

test("childExitCode maps a signal death to 128 + signal number", () => {
  expect(childExitCode(null, "SIGINT")).toBe(130);
  expect(childExitCode(null, "SIGTERM")).toBe(143);
});

test("childExitCode falls back to 1 when neither code nor a mappable signal is present", () => {
  expect(childExitCode(null, null)).toBe(1);
});
