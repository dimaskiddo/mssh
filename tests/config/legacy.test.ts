import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { migrateLegacyConfigFrom } from "../../src/config/legacy";
import { withScratchDir as scratch } from "../helpers";

const withScratchDir = (fn: (dir: string) => void): void => scratch("mssh-app-config-test-", fn);

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
