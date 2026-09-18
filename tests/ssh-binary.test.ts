import { test, expect, spyOn } from "bun:test";
import { resolveSsh, requireSsh, installGuidance, type WhichFn } from "../src/ssh-binary";

function fakeWhich(result: string | null): WhichFn {
  return () => result;
}

test("resolveSsh returns the absolute path the which seam reports", () => {
  expect(resolveSsh(fakeWhich("/usr/bin/ssh"))).toBe("/usr/bin/ssh");
});

test("resolveSsh returns undefined when which finds nothing", () => {
  expect(resolveSsh(fakeWhich(null))).toBeUndefined();
});

test("resolveSsh returns undefined for a non-absolute result, refusing to trust a relative/cwd-derived path", () => {
  expect(resolveSsh(fakeWhich("ssh"))).toBeUndefined();
  expect(resolveSsh(fakeWhich("./ssh"))).toBeUndefined();
});

test("requireSsh returns the absolute path without exiting when ssh is found", () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(((() => undefined) as unknown) as typeof process.exit);
  try {
    expect(requireSsh(fakeWhich("/usr/bin/ssh"))).toBe("/usr/bin/ssh");
    expect(exitSpy).not.toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
  }
});

test("requireSsh prints guidance and exits(1) when ssh is missing", () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(((() => undefined) as unknown) as typeof process.exit);
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    requireSsh(fakeWhich(null));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  }
});

test("installGuidance for win32 mentions Add-WindowsCapability and Git for Windows", () => {
  const msg = installGuidance("win32");
  expect(msg).toContain("Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0");
  expect(msg).toContain("Git for Windows");
});

test("installGuidance for darwin mentions brew install openssh", () => {
  const msg = installGuidance("darwin");
  expect(msg).toContain("brew install openssh");
});

test("installGuidance for linux (and other POSIX) mentions apt/dnf/pacman packages", () => {
  const msg = installGuidance("linux");
  expect(msg).toContain("apt install openssh-client");
  expect(msg).toContain("dnf install openssh-clients");
  expect(msg).toContain("pacman -S openssh");
});

test("installGuidance falls back to Linux-style guidance for other POSIX platforms", () => {
  const msg = installGuidance("freebsd" as NodeJS.Platform);
  expect(msg).toContain("apt install openssh-client");
});
