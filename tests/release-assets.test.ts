import { test, expect } from "bun:test";
import { archiveName, binaryName } from "../src/release-assets";

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
