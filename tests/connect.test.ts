import { test, expect } from "bun:test";
import { tempConfigName, controlPathName, earlyPurgeUsable } from "../src/commands/connect";
import { forwardsTermAndHup, rejectedFlags, childExitCode, firstPositional } from "../src/internal";

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

test("controlPathName embeds the pid and the given random suffix", () => {
  expect(controlPathName(123, "abc123")).toBe("cm-123-abc123");
  expect(controlPathName(123, "abc123")).not.toBe(controlPathName(123, "def456"));
  expect(controlPathName(123, "abc123")).not.toBe(controlPathName(124, "abc123"));
});

test("earlyPurgeUsable is false on win32 regardless of the path", () => {
  expect(earlyPurgeUsable("/home/user/.mssh/run/cm-1-aaaa", "win32")).toBe(false);
});

test("earlyPurgeUsable is false for a path too long for a unix socket", () => {
  const long = "/home/user/.mssh/run/" + "a".repeat(90);
  expect(earlyPurgeUsable(long, "linux")).toBe(false);
});

test("earlyPurgeUsable is false for a path containing %, $ or a space", () => {
  expect(earlyPurgeUsable("/home/user %2/.mssh/run/cm-1-aaaa", "linux")).toBe(false);
  expect(earlyPurgeUsable("/home/user$HOME/.mssh/run/cm-1-aaaa", "linux")).toBe(false);
  expect(earlyPurgeUsable("/home/user%h/.mssh/run/cm-1-aaaa", "linux")).toBe(false);
});

test("earlyPurgeUsable is true for a normal POSIX path", () => {
  expect(earlyPurgeUsable("/home/user/.mssh/run/cm-1234-abcdef01", "linux")).toBe(true);
  expect(earlyPurgeUsable("/home/user/.mssh/run/cm-1234-abcdef01", "darwin")).toBe(true);
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

test("rejectedFlags passes through -p and -J, whose values are never inspected", () => {
  expect(rejectedFlags(["myhost", "-p", "2222"])).toBeUndefined();
  expect(rejectedFlags(["myhost", "-J", "bastion"])).toBeUndefined();
});

test("rejectedFlags rejects a bundled short flag ending in F", () => {
  expect(rejectedFlags(["myhost", "-4F", "/tmp/other"])).toBe("-4F");
});

test("rejectedFlags rejects a bundled short flag carrying -o", () => {
  expect(rejectedFlags(["myhost", "-4oProxyCommand=id"])).toBe("-4oProxyCommand=id");
});

test("rejectedFlags rejects a whitespace-separated -o value, not just the =-form", () => {
  expect(rejectedFlags(["myhost", "-o", "ProxyCommand id"])).toBe("-o");
});

test("rejectedFlags rejects a tab-separated -o value", () => {
  expect(rejectedFlags(["myhost", "-o", "ProxyCommand\tid"])).toBe("-o");
});

test("rejectedFlags rejects a quoted directive name inside -o's value", () => {
  expect(rejectedFlags(["myhost", "-o", '"ProxyCommand"=id'])).toBe("-o");
});

test("rejectedFlags rejects -o Include, which redirects into an arbitrary file", () => {
  expect(rejectedFlags(["myhost", "-o", "Include=/tmp/evil"])).toBe("-o");
});

test("rejectedFlags passes through -o PermitLocalCommand=no, a hardening flag", () => {
  expect(rejectedFlags(["myhost", "-o", "PermitLocalCommand=no"])).toBeUndefined();
  expect(rejectedFlags(["myhost", "-opermitlocalcommand=NO"])).toBeUndefined();
});

test("rejectedFlags still rejects -o PermitLocalCommand=yes, which enables LocalCommand", () => {
  expect(rejectedFlags(["myhost", "-o", "PermitLocalCommand=yes"])).toBe("-o");
});

test("rejectedFlags still rejects a bare -o PermitLocalCommand with no value", () => {
  expect(rejectedFlags(["myhost", "-o", "PermitLocalCommand"])).toBe("-o");
});

test("rejectedFlags refuses a quoted PermitLocalCommand value — the argv surface does not decode quotes, unlike parse()", () => {
  expect(rejectedFlags(["myhost", '-oPermitLocalCommand="no"'])).toBe('-oPermitLocalCommand="no"');
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

test("firstPositional skips a flag's separate-token value", () => {
  expect(firstPositional(["-p", "22", "web"])).toBe("web");
});

test("firstPositional skips a separate-token value through a clustered flag", () => {
  expect(firstPositional(["-vp", "22", "x"])).toBe("x");
});

test("firstPositional treats an attached value as part of the flag, not the target", () => {
  expect(firstPositional(["-p22", "x"])).toBe("x");
});

test("firstPositional returns undefined when the argv is only a flag and its value", () => {
  expect(firstPositional(["-p", "22"])).toBeUndefined();
});
