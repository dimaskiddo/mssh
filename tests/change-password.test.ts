import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadHosts, loadRaw, saveHosts, sealKeyFile, openKeyFile } from "../src/store";
import { parse } from "../src/ssh-config";
import { changePassword, reseal } from "../src/internal";
import { withScratchDirAsync as scratch } from "./helpers";

const withScratchDir = (fn: (dir: string) => Promise<void>): Promise<void> => scratch("mssh-change-password-test-", fn);

const SAMPLE_TEXT = `Host myserver
  HostName 1.2.3.4
  Port 2222
`;

// None of the tests below exercise keys in keysDir, so a path that is never
// created is fine — reseal()/changePassword() must no-op when it's absent.
const noKeysDir = (dir: string): string => join(dir, "keys");

test("changePassword with the wrong current password throws and leaves the file byte-identical", async () => {
  await withScratchDir(async (dir) => {
    const path = join(dir, "config");
    saveHosts(path, parse(SAMPLE_TEXT), "correct-horse");
    const before = readFileSync(path);

    expect(() => changePassword(path, "wrong-password", "new-password", noKeysDir(dir))).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });
});

test("changePassword re-keys the file: old password fails after, new password succeeds", async () => {
  await withScratchDir(async (dir) => {
    const path = join(dir, "config");
    const hosts = parse(SAMPLE_TEXT);
    saveHosts(path, hosts, "correct-horse");

    await changePassword(path, "correct-horse", "new-password", noKeysDir(dir));

    expect(() => loadRaw(path, "correct-horse")).toThrow();
    expect(loadHosts(path, "new-password").map((h) => h.names)).toEqual(hosts.map((h) => h.names));
  });
});

test("changePassword refuses to re-key when the new password equals the current one, without writing", async () => {
  await withScratchDir(async (dir) => {
    const path = join(dir, "config");
    saveHosts(path, parse(SAMPLE_TEXT), "correct-horse");
    const before = readFileSync(path);

    expect(() => changePassword(path, "correct-horse", "correct-horse", noKeysDir(dir))).toThrow(
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

    expect(() => reseal(path, SAMPLE_TEXT, "correct-horse", "correct-horse", noKeysDir(dir))).toThrow(
      "New password is the same as the current one.",
    );
    expect(readFileSync(path)).toEqual(before);
  });
});

test("changePassword re-keys sealed keys in keysDir: new password opens them, old password fails, no .pem.next left behind", async () => {
  await withScratchDir(async (dir) => {
    const path = join(dir, "config");
    const keysDir = join(dir, "keys");
    mkdirSync(keysDir, { recursive: true });
    saveHosts(path, parse(SAMPLE_TEXT), "correct-horse");

    const keyPath = join(keysDir, "bastion_ed25519.pem");
    const keyBytes = Buffer.from("secret-key-bytes");
    sealKeyFile(keyPath, keyBytes, "correct-horse");

    await changePassword(path, "correct-horse", "new-password", keysDir);

    expect(openKeyFile(keyPath, "new-password").equals(keyBytes)).toBe(true);
    expect(() => openKeyFile(keyPath, "correct-horse")).toThrow();
    expect(existsSync(`${keyPath}.next`)).toBe(false);
  });
});

test("changePassword leaves an already-plaintext key in keysDir untouched — migratePlaintextKeys handles that separately", async () => {
  await withScratchDir(async (dir) => {
    const path = join(dir, "config");
    const keysDir = join(dir, "keys");
    mkdirSync(keysDir, { recursive: true });
    saveHosts(path, parse(SAMPLE_TEXT), "correct-horse");

    const keyPath = join(keysDir, "bastion_rsa.pem");
    writeFileSync(keyPath, "-----BEGIN OPENSSH PRIVATE KEY-----\nplaintext\n-----END OPENSSH PRIVATE KEY-----\n");
    const before = readFileSync(keyPath);

    await changePassword(path, "correct-horse", "new-password", keysDir);

    expect(readFileSync(keyPath)).toEqual(before);
    expect(existsSync(`${keyPath}.next`)).toBe(false);
  });
});
