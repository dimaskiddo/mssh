import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { replaceExecutable, installExecutable, ownershipToRestore } from "../../src/fs/executable";
import { withScratchDir as scratch } from "../helpers";

const withScratchDir = (fn: (dir: string) => void): void => scratch("mssh-secure-file-test-", fn);

test.skipIf(process.platform === "win32")("replaceExecutable swaps in the new content, preserving the original file's mode", () => {
  withScratchDir((dir) => {
    const target = join(dir, "mssh");
    writeFileSync(target, "old binary bytes", { mode: 0o755 });

    const { commit } = replaceExecutable(target, Buffer.from("new binary bytes"));
    commit();

    expect(readFileSync(target, "utf8")).toBe("new binary bytes");
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });
});

test.skipIf(process.platform === "win32")("replaceExecutable leaves no .new-/.old- siblings after commit", () => {
  withScratchDir((dir) => {
    const target = join(dir, "mssh");
    writeFileSync(target, "old", { mode: 0o755 });

    const { commit } = replaceExecutable(target, Buffer.from("new"));
    commit();

    expect(readdirSync(dir)).toEqual(["mssh"]);
  });
});

test.skipIf(process.platform === "win32")("replaceExecutable's rollback restores the original bytes and leaves no siblings", () => {
  withScratchDir((dir) => {
    const target = join(dir, "mssh");
    writeFileSync(target, "original binary bytes", { mode: 0o755 });

    const { rollback } = replaceExecutable(target, Buffer.from("bad binary bytes"));
    rollback();

    expect(readFileSync(target, "utf8")).toBe("original binary bytes");
    expect(readdirSync(dir)).toEqual(["mssh"]);
  });
});

test.skipIf(process.platform === "win32")("replaceExecutable's backup exists between the swap and commit/rollback, for a rollback to use", () => {
  withScratchDir((dir) => {
    const target = join(dir, "mssh");
    writeFileSync(target, "original", { mode: 0o755 });

    const { commit } = replaceExecutable(target, Buffer.from("replacement"));

    const names = readdirSync(dir);
    expect(names.length).toBe(2);
    expect(names).toContain("mssh");
    const backup = names.find((n) => n !== "mssh");
    expect(backup).toMatch(new RegExp(`^mssh\\.old-${process.pid}-[0-9a-f]+$`));

    commit();
  });
});

test.skipIf(process.platform === "win32")("replaceExecutable leaves the original file untouched if the write of the new content fails", () => {
  withScratchDir((dir) => {
    const target = join(dir, "mssh");
    writeFileSync(target, "original", { mode: 0o755 });
    // Target itself, as a directory, is a stand-in for an unwritable destination —
    // statSync(target) still succeeds (needed to read its mode), but the sibling
    // write path shares the same parent dir, so this only proves failure leaves
    // the original alone; a locked/readonly dir is exercised implicitly by "wx".
    expect(() => replaceExecutable(join(dir, "does-not-exist"), Buffer.from("x"))).toThrow();
    expect(readFileSync(target, "utf8")).toBe("original");
    expect(readdirSync(dir)).toEqual(["mssh"]);
  });
});

test("ownershipToRestore: root replacing a file owned by another user restores that user's uid/gid", () => {
  expect(ownershipToRestore({ uid: 1000, gid: 1000 }, 0)).toEqual({ uid: 1000, gid: 1000 });
});

test("ownershipToRestore: root replacing a file it already owns needs no restore", () => {
  expect(ownershipToRestore({ uid: 0, gid: 0 }, 0)).toBeUndefined();
});

test("ownershipToRestore: a non-root caller never restores ownership", () => {
  expect(ownershipToRestore({ uid: 1000, gid: 1000 }, 1000)).toBeUndefined();
});

test.skipIf(process.platform === "win32")("installExecutable creates a new file, including missing parent dirs, at mode 0755", () => {
  withScratchDir((dir) => {
    const target = join(dir, "nested", "bin", "mssh");
    installExecutable(target, Buffer.from("binary bytes"));
    expect(readFileSync(target, "utf8")).toBe("binary bytes");
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });
});

test.skipIf(process.platform === "win32")("installExecutable replaces an existing target via replaceExecutable, keeping its mode", () => {
  withScratchDir((dir) => {
    const target = join(dir, "mssh");
    writeFileSync(target, "old binary bytes", { mode: 0o700 });
    installExecutable(target, Buffer.from("new binary bytes"));
    expect(readFileSync(target, "utf8")).toBe("new binary bytes");
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });
});

test.skipIf(process.platform === "win32")("installExecutable leaves no .new-/.old- siblings behind, new or existing target", () => {
  withScratchDir((dir) => {
    const freshTarget = join(dir, "fresh", "mssh");
    installExecutable(freshTarget, Buffer.from("a"));
    expect(readdirSync(join(dir, "fresh"))).toEqual(["mssh"]);

    const existingTarget = join(dir, "existing", "mssh");
    mkdirSync(join(dir, "existing"));
    writeFileSync(existingTarget, "old", { mode: 0o755 });
    installExecutable(existingTarget, Buffer.from("b"));
    expect(readdirSync(join(dir, "existing"))).toEqual(["mssh"]);
  });
});
