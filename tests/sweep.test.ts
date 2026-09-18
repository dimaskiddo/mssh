import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { sweepOrphanedTempFiles } from "../src/sweep";
import { isPidAlive, staleNames, cfgPid, tmpPid } from "../src/internal";
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

    sweepOrphanedTempFiles(runDir, join(dir, "config-dir"));

    expect(readdirSync(runDir).sort()).toEqual(["cfg-" + process.pid + "-bbbbbbbb", "not-a-cfg-file"].sort());
  });
});

test("sweepOrphanedTempFiles removes a config-directory .tmp- entry whose pid is dead, keeps one whose pid is live", () => {
  withScratchDir((dir) => {
    writeFileSync(join(dir, "config"), "the real config");
    writeFileSync(join(dir, `config.tmp-${DEAD_PID}-aaaaaaaa`), "orphaned sealed data");
    writeFileSync(join(dir, `config.tmp-${process.pid}-bbbbbbbb`), "in-flight sealed data");

    sweepOrphanedTempFiles(join(dir, "run"), dir);

    expect(readdirSync(dir).sort()).toEqual(["config", `config.tmp-${process.pid}-bbbbbbbb`].sort());
  });
});

test("sweepOrphanedTempFiles is a no-op when neither directory exists", () => {
  withScratchDir((dir) => {
    expect(() => sweepOrphanedTempFiles(join(dir, "run"), join(dir, "config-dir"))).not.toThrow();
  });
});
