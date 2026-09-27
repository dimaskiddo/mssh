import { test, expect } from "bun:test";
import { forwardsTermAndHup, earlyPurgeUsable, controlPathUsable, childExitCode, earlySignals } from "../../src/ssh/session";

test("forwardsTermAndHup is true on POSIX platforms", () => {
  expect(forwardsTermAndHup("linux")).toBe(true);
  expect(forwardsTermAndHup("darwin")).toBe(true);
});

test("forwardsTermAndHup is false on win32", () => {
  expect(forwardsTermAndHup("win32")).toBe(false);
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

// jump-key-pull.ts's ControlPath is checked the same way as connectWithRaw's,
// but platform-independent (it has no early-purge fallback to disable) —
// controlPathUsable is the length+charset rule earlyPurgeUsable is built on.
test("controlPathUsable is false for a path too long for a unix socket, regardless of platform", () => {
  const long = "/home/user/.mssh/run/" + "a".repeat(90);
  expect(controlPathUsable(long)).toBe(false);
});

test("controlPathUsable is false for a path containing %, $ or a space", () => {
  expect(controlPathUsable("/home/user %2/.mssh/run/cm-aaaa")).toBe(false);
  expect(controlPathUsable("/home/user$HOME/.mssh/run/cm-aaaa")).toBe(false);
});

test("controlPathUsable is true for a normal POSIX path", () => {
  expect(controlPathUsable("/home/user/.mssh/run/cm-abcdef01")).toBe(true);
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

// Same POSIX/Windows split as forwardsTermAndHup, but this is which signals
// get an early "cleanup, then die" handler before ssh has spawned — same
// set, since Windows can't act on SIGTERM/SIGHUP either way.
test("earlySignals is SIGINT, SIGTERM, SIGHUP on POSIX", () => {
  expect(earlySignals("linux")).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  expect(earlySignals("darwin")).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
});

test("earlySignals is SIGINT only on win32", () => {
  expect(earlySignals("win32")).toEqual(["SIGINT"]);
});
