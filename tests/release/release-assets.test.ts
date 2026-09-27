import { test, expect } from "bun:test";
import { archiveName, binaryName, CHECKSUM_FILENAME, checksumLine, checksumFor, stripV } from "../../src/release/release-assets";

test("archiveName matches release.ts's naming for every published target", () => {
  expect(archiveName("0.1.6", "linux", "x64")).toBe("mssh_0.1.6_linux_64-bit.zip");
  expect(archiveName("0.1.6", "linux", "arm64")).toBe("mssh_0.1.6_linux_arm-64-bit.zip");
  expect(archiveName("0.1.6", "darwin", "x64")).toBe("mssh_0.1.6_macos_64-bit.zip");
  expect(archiveName("0.1.6", "darwin", "arm64")).toBe("mssh_0.1.6_macos_arm-64-bit.zip");
  expect(archiveName("0.1.6", "win32", "x64")).toBe("mssh_0.1.6_windows_64-bit.zip");
  expect(archiveName("0.1.6", "win32", "arm64")).toBe("mssh_0.1.6_windows_arm-64-bit.zip");
});

test("archiveName throws on an unsupported platform", () => {
  expect(() => archiveName("0.1.6", "freebsd", "x64")).toThrow(/unsupported platform/);
});

test("archiveName throws on an unsupported arch", () => {
  expect(() => archiveName("0.1.6", "linux", "ia32")).toThrow(/unsupported platform/);
});

test("binaryName is mssh.exe on win32 and mssh everywhere else", () => {
  expect(binaryName("win32")).toBe("mssh.exe");
  expect(binaryName("linux")).toBe("mssh");
  expect(binaryName("darwin")).toBe("mssh");
});

// release.ts writes checksum.txt with checksumLine; update.ts reads it
// back with checksumFor. Same format, one source of truth for both.
test("CHECKSUM_FILENAME is checksum.txt", () => {
  expect(CHECKSUM_FILENAME).toBe("checksum.txt");
});

test("checksumLine writes hash and archive separated by two spaces, newline-terminated", () => {
  expect(checksumLine("abc123", "mssh_0.1.6_linux_64-bit.zip")).toBe("abc123  mssh_0.1.6_linux_64-bit.zip\n");
});

test("checksumFor reads back a hash written by checksumLine", () => {
  const text = checksumLine("abc123", "mssh_0.1.6_linux_64-bit.zip") + checksumLine("def456", "mssh_0.1.6_macos_64-bit.zip");
  expect(checksumFor(text, "mssh_0.1.6_macos_64-bit.zip")).toBe("def456");
});

test("stripV removes a leading v", () => {
  expect(stripV("v0.1.6")).toBe("0.1.6");
});

test("stripV leaves a version with no leading v untouched", () => {
  expect(stripV("0.1.6")).toBe("0.1.6");
});
