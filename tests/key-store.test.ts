import { test, expect, spyOn } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  managedKeyPath,
  keyTempName,
  materializeKeys,
  migratePlaintextKeys,
  reportMigratedKeys,
} from "../src/key-store";
import { sealKeyFile, openKeyFile } from "../src/store";
import { isSealedPayload } from "../src/crypto";
import { ensureSecureDir } from "../src/secure-file";
import type { Host } from "../src/ssh-config";
import { withScratchDir as scratch } from "./helpers";

const withScratchDir = (fn: (dir: string) => void): void => scratch("mssh-key-store-test-", fn);

const KEY_BYTES = Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----\n");

test("managedKeyPath resolves an absolute IdentityFile directly inside keysDir", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    const path = join(keysDir, "jump_ed25519.pem");
    expect(managedKeyPath(path, keysDir)).toBe(path);
  });
});

test("managedKeyPath returns undefined for a ~-form path outside keysDir", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    expect(managedKeyPath("~/.ssh/id_rsa", keysDir)).toBeUndefined();
    expect(managedKeyPath("~/.ssh/id_rsa", keysDir)).not.toBe(join(homedir(), ".ssh/id_rsa"));
  });
});

test("managedKeyPath returns undefined for a file in a subdirectory of keysDir", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    expect(managedKeyPath(join(keysDir, "sub", "a.pem"), keysDir)).toBeUndefined();
  });
});

test("managedKeyPath returns undefined when IdentityFile is unset", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    expect(managedKeyPath(undefined, keysDir)).toBeUndefined();
  });
});

test("keyTempName mirrors the cfg-<pid>-<hex> convention with a key- prefix", () => {
  expect(keyTempName(4242, "deadbeef")).toBe("key-4242-deadbeef");
});

test("migratePlaintextKeys seals a plaintext key in place under the same filename", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    ensureSecureDir(keysDir);
    const path = join(keysDir, "jump_ed25519.pem");
    writeFileSync(path, KEY_BYTES, { mode: 0o600 });

    const { migrated } = migratePlaintextKeys(keysDir, "correct-horse");

    expect(migrated).toEqual([path]);
    expect(existsSync(path)).toBe(true);
    expect(isSealedPayload(readFileSync(path))).toBe(true);
    expect(openKeyFile(path, "correct-horse").equals(KEY_BYTES)).toBe(true);
  });
});

test("migratePlaintextKeys is a no-op on a second run", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    ensureSecureDir(keysDir);
    const path = join(keysDir, "jump_ed25519.pem");
    writeFileSync(path, KEY_BYTES, { mode: 0o600 });

    migratePlaintextKeys(keysDir, "correct-horse");
    const { migrated } = migratePlaintextKeys(keysDir, "correct-horse");

    expect(migrated).toEqual([]);
  });
});

test("migratePlaintextKeys skips a nonexistent keysDir without throwing", () => {
  withScratchDir((dir) => {
    const { migrated } = migratePlaintextKeys(join(dir, "keys"), "correct-horse");
    expect(migrated).toEqual([]);
  });
});

test("migratePlaintextKeys skips a file whose name fails the key-filename allowlist", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    ensureSecureDir(keysDir);
    const path = join(keysDir, "not valid!.pem");
    writeFileSync(path, KEY_BYTES, { mode: 0o600 });

    const { migrated } = migratePlaintextKeys(keysDir, "correct-horse");

    expect(migrated).toEqual([]);
    expect(readFileSync(path).equals(KEY_BYTES)).toBe(true);
  });
});

test("migratePlaintextKeys commits an interrupted re-key's .pem.next when it opens under the new password", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    ensureSecureDir(keysDir);
    const path = join(keysDir, "jump_ed25519.pem");
    // Simulates change-password having committed the config under the new
    // password, then crashing before renaming .pem.next over .pem.
    sealKeyFile(path, KEY_BYTES, "old-password");
    sealKeyFile(`${path}.next`, KEY_BYTES, "new-password");

    const { migrated } = migratePlaintextKeys(keysDir, "new-password");

    expect(migrated).toEqual([]);
    expect(existsSync(`${path}.next`)).toBe(false);
    expect(openKeyFile(path, "new-password").equals(KEY_BYTES)).toBe(true);
  });
});

test("migratePlaintextKeys discards an interrupted .pem.next that does not open under the current password", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    ensureSecureDir(keysDir);
    const path = join(keysDir, "jump_ed25519.pem");
    sealKeyFile(path, KEY_BYTES, "current-password");
    sealKeyFile(`${path}.next`, KEY_BYTES, "some-other-password");

    const { migrated } = migratePlaintextKeys(keysDir, "current-password");

    expect(migrated).toEqual([]);
    expect(existsSync(`${path}.next`)).toBe(false);
    expect(openKeyFile(path, "current-password").equals(KEY_BYTES)).toBe(true);
  });
});

test("migratePlaintextKeys does not delete a committed .pem.next when the rename fails", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    ensureSecureDir(keysDir);
    const path = join(keysDir, "jump_ed25519.pem");
    // A directory in place of the rename target makes renameSync fail
    // (EISDIR) even though openKeyFile already proved the new password committed.
    mkdirSync(path);
    sealKeyFile(`${path}.next`, KEY_BYTES, "new-password");

    expect(() => migratePlaintextKeys(keysDir, "new-password")).toThrow();

    expect(existsSync(`${path}.next`)).toBe(true);
    expect(openKeyFile(`${path}.next`, "new-password").equals(KEY_BYTES)).toBe(true);
  });
});

test("materializeKeys decrypts a managed key to runDir and rewrites IdentityFile to point at it", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    const runDir = join(dir, "run");
    ensureSecureDir(keysDir);
    ensureSecureDir(runDir);
    const keyPath = join(keysDir, "jump_ed25519.pem");
    sealKeyFile(keyPath, KEY_BYTES, "correct-horse");

    const hosts: Host[] = [{ names: ["jump"], identityFile: keyPath, extras: [] }];
    const tempPaths: string[] = [];
    const materialized = materializeKeys(hosts, "correct-horse", keysDir, runDir, tempPaths);

    expect(tempPaths).toHaveLength(1);
    const tempPath = tempPaths[0] as string;
    expect(materialized[0]?.identityFile).toBe(tempPath);
    expect(readFileSync(tempPath).equals(KEY_BYTES)).toBe(true);
  });
});

test("materializeKeys leaves a host's IdentityFile untouched when it isn't a managed key", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    const runDir = join(dir, "run");
    ensureSecureDir(keysDir);
    ensureSecureDir(runDir);

    const hosts: Host[] = [{ names: ["web1"], identityFile: "~/.ssh/id_rsa", extras: [] }];
    const tempPaths: string[] = [];
    const materialized = materializeKeys(hosts, "correct-horse", keysDir, runDir, tempPaths);

    expect(tempPaths).toEqual([]);
    expect(materialized[0]?.identityFile).toBe("~/.ssh/id_rsa");
  });
});

test("reportMigratedKeys prints a count when keys were migrated", () => {
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    reportMigratedKeys(["/home/user/.mssh/keys/jump_ed25519.pem"]);
    expect(errorSpy).toHaveBeenCalledWith("Encrypted 1 pulled key(s) in ~/.mssh/keys.");
  } finally {
    errorSpy.mockRestore();
  }
});

test("reportMigratedKeys prints nothing when nothing was migrated", () => {
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    reportMigratedKeys([]);
    expect(errorSpy).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});

test("materializeKeys decrypts a key used by two hosts only once", () => {
  withScratchDir((dir) => {
    const keysDir = join(dir, "keys");
    const runDir = join(dir, "run");
    ensureSecureDir(keysDir);
    ensureSecureDir(runDir);
    const keyPath = join(keysDir, "jump_ed25519.pem");
    sealKeyFile(keyPath, KEY_BYTES, "correct-horse");

    const hosts: Host[] = [
      { names: ["web1"], identityFile: keyPath, extras: [] },
      { names: ["web2"], identityFile: keyPath, extras: [] },
    ];
    const tempPaths: string[] = [];
    const materialized = materializeKeys(hosts, "correct-horse", keysDir, runDir, tempPaths);

    expect(tempPaths).toHaveLength(1);
    expect(materialized[0]?.identityFile).toBe(materialized[1]?.identityFile);
  });
});
