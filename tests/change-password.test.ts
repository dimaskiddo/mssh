import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { changePassword } from "../src/commands/change-password";
import { loadHosts, loadRaw, saveHosts } from "../src/store";
import { parse } from "../src/ssh-config";

async function withScratchDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mssh-change-password-test-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SAMPLE_TEXT = `Host myserver
  HostName 1.2.3.4
  Port 2222
`;

test("changePassword with the wrong current password throws and leaves the file byte-identical", async () => {
  await withScratchDir(async (dir) => {
    const path = join(dir, "config");
    saveHosts(path, parse(SAMPLE_TEXT), "correct-horse");
    const before = readFileSync(path);

    await expect(changePassword(path, "wrong-password", "new-password")).rejects.toThrow();
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

    await expect(changePassword(path, "correct-horse", "correct-horse")).rejects.toThrow(
      "New password is the same as the current one.",
    );
    expect(readFileSync(path)).toEqual(before);
  });
});
