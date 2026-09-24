import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { sweepOrphanedTempFiles } from "../src/sweep";
import { isPidAlive, staleNames, cfgPid, tmpPid, keyPid, cmPid } from "../src/internal";
import { withScratchDir as scratch } from "./helpers";

const withScratchDir = (fn: (dir: string) => void): void => scratch("mssh-sweep-test-", fn);

// A pid guaranteed not to exist: max pid space is far below this on every
// real OS, and it will never collide with a live process.
const DEAD_PID = 999999999;

test("isPidAlive is true for the current process", () => {
  expect(isPidAlive(process.pid)).toBe(true);
});

test("isPidAlive is false for a pid that does not exist", () => {
  expect(isPidAlive(DEAD_PID)).toBe(false);
});

test("cfgPid extracts the pid from connect.ts's tempConfigName convention", () => {
  expect(cfgPid("cfg-1234-abcdef01")).toBe(1234);
  expect(cfgPid("not-a-cfg-file")).toBeUndefined();
  expect(cfgPid("cfg-abc-abcdef01")).toBeUndefined();
});

test("tmpPid extracts the pid from writeSecureAtomic's tmp-file convention", () => {
  expect(tmpPid("config.tmp-1234-abcdef01")).toBe(1234);
  expect(tmpPid("ssh_config.enc.tmp-5678-00ff00ff")).toBe(5678);
  expect(tmpPid("config")).toBeUndefined();
});

test("keyPid extracts the pid from key-store.ts's keyTempName convention", () => {
  expect(keyPid("key-1234-abcdef01")).toBe(1234);
  expect(keyPid("not-a-key-file")).toBeUndefined();
  expect(keyPid("key-abc-abcdef01")).toBeUndefined();
});

test("cmPid extracts the pid from connect.ts's controlPathName convention", () => {
  expect(cmPid("cm-1234-abcdef01")).toBe(1234);
  expect(cmPid("not-a-cm-file")).toBeUndefined();
  expect(cmPid("cm-abc-abcdef01")).toBeUndefined();
});

test("staleNames keeps a name whose pid is live and drops one whose pid is dead", () => {
  const alive = (pid: number) => pid === 111;
  const result = staleNames(["cfg-111-aaaa", "cfg-222-bbbb"], cfgPid, alive);
  expect(result).toEqual(["cfg-222-bbbb"]);
});

test("staleNames always keeps names with no extractable pid", () => {
  const result = staleNames(["config.tmp-nopid"], () => undefined, () => true);
  expect(result).toEqual(["config.tmp-nopid"]);
});

test("sweepOrphanedTempFiles removes a cfg-* entry whose pid is dead, keeps one whose pid is live", () => {
  withScratchDir((dir) => {
    const runDir = join(dir, "run");
    mkdirSync(runDir);
    writeFileSync(join(runDir, `cfg-${DEAD_PID}-aaaaaaaa`), "stale plaintext");
    writeFileSync(join(runDir, `cfg-${process.pid}-bbbbbbbb`), "live plaintext");
    writeFileSync(join(runDir, "not-a-cfg-file"), "unrelated");

    sweepOrphanedTempFiles(runDir, join(dir, "config-dir"), join(dir, "keys-dir"));

    expect(readdirSync(runDir).sort()).toEqual(["cfg-" + process.pid + "-bbbbbbbb", "not-a-cfg-file"].sort());
  });
});

test("sweepOrphanedTempFiles removes a key-* entry whose pid is dead, keeps one whose pid is live", () => {
  withScratchDir((dir) => {
    const runDir = join(dir, "run");
    mkdirSync(runDir);
    writeFileSync(join(runDir, `key-${DEAD_PID}-aaaaaaaa`), "stale decrypted key");
    writeFileSync(join(runDir, `key-${process.pid}-bbbbbbbb`), "live decrypted key");

    sweepOrphanedTempFiles(runDir, join(dir, "config-dir"), join(dir, "keys-dir"));

    expect(readdirSync(runDir).sort()).toEqual([`key-${process.pid}-bbbbbbbb`].sort());
  });
});

test("sweepOrphanedTempFiles removes a cm-* entry whose pid is dead, keeps one whose pid is live", () => {
  withScratchDir((dir) => {
    const runDir = join(dir, "run");
    mkdirSync(runDir);
    writeFileSync(join(runDir, `cm-${DEAD_PID}-aaaaaaaa`), "stale control socket");
    writeFileSync(join(runDir, `cm-${process.pid}-bbbbbbbb`), "live control socket");

    sweepOrphanedTempFiles(runDir, join(dir, "config-dir"), join(dir, "keys-dir"));

    expect(readdirSync(runDir).sort()).toEqual([`cm-${process.pid}-bbbbbbbb`].sort());
  });
});

test("sweepOrphanedTempFiles removes a config-directory .tmp- entry whose pid is dead, keeps one whose pid is live", () => {
  withScratchDir((dir) => {
    writeFileSync(join(dir, "config"), "the real config");
    writeFileSync(join(dir, `config.tmp-${DEAD_PID}-aaaaaaaa`), "orphaned sealed data");
    writeFileSync(join(dir, `config.tmp-${process.pid}-bbbbbbbb`), "in-flight sealed data");

    sweepOrphanedTempFiles(join(dir, "run"), dir, join(dir, "keys-dir"));

    expect(readdirSync(dir).sort()).toEqual(["config", `config.tmp-${process.pid}-bbbbbbbb`].sort());
  });
});

test("sweepOrphanedTempFiles removes a keysDir .tmp- entry whose pid is dead, keeps one whose pid is live", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    mkdirSync(keysDir);
    writeFileSync(join(keysDir, "jump_ed25519.pem"), "sealed key bytes");
    writeFileSync(join(keysDir, `jump_ed25519.pem.tmp-${DEAD_PID}-aaaaaaaa`), "orphaned sealed key");
    writeFileSync(join(keysDir, `jump_ed25519.pem.tmp-${process.pid}-bbbbbbbb`), "in-flight sealed key");

    sweepOrphanedTempFiles(join(dir, "run"), join(dir, "config-dir"), keysDir);

    expect(readdirSync(keysDir).sort()).toEqual(
      ["jump_ed25519.pem", `jump_ed25519.pem.tmp-${process.pid}-bbbbbbbb`].sort(),
    );
  });
});

test("sweepOrphanedTempFiles is a no-op when none of the three directories exist", () => {
  withScratchDir((dir) => {
    expect(() =>
      sweepOrphanedTempFiles(join(dir, "run"), join(dir, "config-dir"), join(dir, "keys-dir")),
    ).not.toThrow();
  });
});
