import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { withScratchDirAsync } from "../helpers";
import {
  forwardsTermAndHup,
  earlyPurgeUsable,
  controlPathUsable,
  childExitCode,
  earlySignals,
  socketDirUsable,
  pickControlSocketDir,
} from "../../src/ssh/session";

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

test("socketDirUsable is true for a real directory that supports unix sockets, and leaves it empty afterward", async () => {
  await withScratchDirAsync("mssh-socket-usable-", async (dir) => {
    expect(await socketDirUsable(dir)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir)).toEqual([]);
  });
});

test("socketDirUsable is false for a directory that does not exist", async () => {
  expect(await socketDirUsable("/nonexistent/mssh-socket-test-dir")).toBe(false);
});

test("pickControlSocketDir returns runDir when its probe passes", async () => {
  const probe = async (dir: string) => dir === "/run-dir";
  const ensureDir = () => {
    throw new Error("must not be called when runDir already works");
  };
  expect(await pickControlSocketDir("/run-dir", "/fallback-dir", probe, ensureDir)).toBe("/run-dir");
});

test("pickControlSocketDir returns the fallback when runDir's probe fails but the fallback's passes", async () => {
  const probe = async (dir: string) => dir === "/fallback-dir";
  const ensured: string[] = [];
  expect(await pickControlSocketDir("/run-dir", "/fallback-dir", probe, (d) => ensured.push(d))).toBe("/fallback-dir");
  expect(ensured).toEqual(["/fallback-dir"]);
});

test("pickControlSocketDir throws guidance when both runDir and the fallback fail", async () => {
  const probe = async () => false;
  await expect(pickControlSocketDir("/run-dir", "/fallback-dir", probe, () => {})).rejects.toThrow(
    /control sockets don't work in ~\/.mssh\/run/,
  );
});

test("pickControlSocketDir throws when runDir fails and there is no fallback", async () => {
  const probe = async () => false;
  await expect(pickControlSocketDir("/run-dir", undefined, probe, () => {})).rejects.toThrow(
    /control sockets don't work in ~\/.mssh\/run/,
  );
});
