import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadHosts, loadRaw, saveHosts } from "../src/store";
import { parse } from "../src/ssh-config";
import { changePassword, reseal } from "../src/internal";
import { withScratchDirAsync as scratch } from "./helpers";

const withScratchDir = (fn: (dir: string) => Promise<void>): Promise<void> => scratch("mssh-change-password-test-", fn);

const SAMPLE_TEXT = `Host myserver
  HostName 1.2.3.4
  Port 2222
`;

test("changePassword with the wrong current password throws and leaves the file byte-identical", async () => {
  await withScratchDir(async (dir) => {
    const path = join(dir, "config");
    saveHosts(path, parse(SAMPLE_TEXT), "correct-horse");
    const before = readFileSync(path);

    expect(() => changePassword(path, "wrong-password", "new-password")).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });
});

test("changePassword re-keys the file: old password fails after, new password succeeds", async () => {
  await withScratchDir(async (dir) => {
    const path = join(dir, "config");
    const hosts = parse(SAMPLE_TEXT);
    saveHosts(path, hosts, "correct-horse");

    await changePassword(path, "correct-horse", "new-password");

    expect(() => loadRaw(path, "correct-horse")).toThrow();
    expect(loadHosts(path, "new-password").map((h) => h.names)).toEqual(hosts.map((h) => h.names));
  });
});

test("changePassword refuses to re-key when the new password equals the current one, without writing", async () => {
  await withScratchDir(async (dir) => {
    const path = join(dir, "config");
    saveHosts(path, parse(SAMPLE_TEXT), "correct-horse");
    const before = readFileSync(path);

    expect(() => changePassword(path, "correct-horse", "correct-horse")).toThrow(
      "New password is the same as the current one.",
    );
    expect(readFileSync(path)).toEqual(before);
  });
});

test("reseal refuses to re-key when the new password equals the current one, without writing", async () => {
  await withScratchDir(async (dir) => {
    const path = join(dir, "config");
    saveHosts(path, parse(SAMPLE_TEXT), "correct-horse");
    const before = readFileSync(path);

    expect(() => reseal(path, SAMPLE_TEXT, "correct-horse", "correct-horse")).toThrow(
      "New password is the same as the current one.",
    );
    expect(readFileSync(path)).toEqual(before);
  });
});
