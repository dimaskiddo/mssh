import { test, expect } from "bun:test";
import {
  tempConfigName,
  controlPathName,
  keyTempName,
  tmpSuffix,
  newSuffix,
  oldSuffix,
  cfgPid,
  tmpPid,
  keyPid,
  cmPid,
  binLeftoverPid,
} from "../../src/fs/temp-names";

test("tempConfigName embeds the pid and the given random suffix", () => {
  expect(tempConfigName(123, "abc123")).toBe("cfg-123-abc123");
  expect(tempConfigName(123, "abc123")).not.toBe(tempConfigName(123, "def456"));
  expect(tempConfigName(123, "abc123")).not.toBe(tempConfigName(124, "abc123"));
});

test("controlPathName embeds the pid and the given random suffix", () => {
  expect(controlPathName(123, "abc123")).toBe("cm-123-abc123");
  expect(controlPathName(123, "abc123")).not.toBe(controlPathName(123, "def456"));
  expect(controlPathName(123, "abc123")).not.toBe(controlPathName(124, "abc123"));
});

test("keyTempName mirrors the cfg-<pid>-<hex> convention with a key- prefix", () => {
  expect(keyTempName(4242, "deadbeef")).toBe("key-4242-deadbeef");
});

// secure-write.ts/executable.ts built these inline; matching TMP_NAME/BIN_LEFTOVER_NAME.
test("tmpSuffix embeds the pid and the given random suffix with a .tmp- prefix", () => {
  expect(tmpSuffix(1234, "abcdef01")).toBe(".tmp-1234-abcdef01");
});

test("newSuffix embeds the pid and the given random suffix with a .new- prefix", () => {
  expect(newSuffix(1234, "abcdef01")).toBe(".new-1234-abcdef01");
});

test("oldSuffix embeds the pid and the given random suffix with a .old- prefix", () => {
  expect(oldSuffix(1234, "abcdef01")).toBe(".old-1234-abcdef01");
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

test("binLeftoverPid extracts the pid from replaceExecutable's .old-/.new- convention", () => {
  expect(binLeftoverPid("mssh.old-1234-abcdef01")).toBe(1234);
  expect(binLeftoverPid("mssh.exe.new-5678-00ff00ff")).toBe(5678);
  expect(binLeftoverPid("mssh")).toBeUndefined();
});
