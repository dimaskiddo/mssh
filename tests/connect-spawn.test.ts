// Exercises connectWithRaw (shared by runConnect and list.ts's picker) with a
// fake ChildProcess, mocking only app-config — store.ts stays real, fed a real
// seal()'d file — since mock.module() mutates Bun's shared module registry.
import { test, expect, mock, spyOn, afterAll } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { SpawnFn } from "../src/commands/connect";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal } from "../src/crypto";
import { sealKeyFile } from "../src/store";
import { ensureSecureDir } from "../src/secure-file";
import * as realAppConfig from "../src/app-config";

const scratchRoot = mkdtempSync(join(tmpdir(), "mssh-connect-spawn-test-"));
const scratchRunDir = join(scratchRoot, "run");
// keysDir() is left to app-config's real implementation (homeDir()-derived) —
// overriding it directly in the mock below, like runDir, would get baked
// into other test files' own `...realAppConfig` spreads at collection time
// (mock.module mutates the shared registry immediately, not per-file) and
// leak into files that never asked for a fake keysDir. Spying on os.homedir()
// instead only affects calls made while this file's tests are running, and
// is restored in afterAll before any other file's tests run.
const scratchHomeDir = join(scratchRoot, "home");
const scratchKeysDir = join(scratchHomeDir, ".mssh", "keys");
const configFilePath = join(scratchRoot, "ssh_config.enc");
const TEST_PASSWORD = "fixed-test-password";
const sealedRaw = "Host web1\n  HostName 10.0.0.1\n";

writeFileSync(configFilePath, seal(sealedRaw, TEST_PASSWORD));
ensureSecureDir(scratchKeysDir);
const homedirSpy = spyOn(nodeOs, "homedir").mockReturnValue(scratchHomeDir);

mock.module("../src/app-config", () => ({
  ...realAppConfig,
  loadSettings: () => ({ settings: {}, sourcePath: undefined }),
  configPath: () => configFilePath,
  runDir: () => scratchRunDir,
  resolvePassword: async () => TEST_PASSWORD,
}));

const { runConnect, connectWithRaw } = await import("../src/commands/connect");

afterAll(() => {
  mock.module("../src/app-config", () => realAppConfig);
  homedirSpy.mockRestore();
  rmSync(scratchRoot, { recursive: true, force: true });
});

class FakeChild extends EventEmitter {
  kill(): boolean {
    return true;
  }
}

const fakeSpawn = (fake: FakeChild): SpawnFn => () => fake as unknown as ChildProcess;

const fakeSpawnCapturing = (fake: FakeChild, captured: { args?: string[] }): SpawnFn => (_cmd, args) => {
  captured.args = args;
  return fake as unknown as ChildProcess;
};

function tempFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

test("temp config is written, then removed once ssh exits", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  try {
    const fake = new FakeChild();
    await connectWithRaw(sealedRaw, ["web1"], TEST_PASSWORD, fakeSpawn(fake));

    expect(tempFilesIn(scratchRunDir).length).toBe(1);

    fake.emit("exit", 0, null);

    expect(tempFilesIn(scratchRunDir).length).toBe(0);
    expect(exitSpy).toHaveBeenCalledWith(0);
  } finally {
    exitSpy.mockRestore();
  }
});

test("the temp file is cleaned up by a process-exit handler, independent of the child's own exit/error events", async () => {
  // Distinct from the two tests above: this isolates process.on("exit", cleanup)
  // itself, registered before writeSecure() runs so a lockdown failure there
  // still gets cleaned up. Capturing the registered listener and invoking it
  // directly stands in for the process actually exiting, which a unit test
  // can't trigger for real.
  const onSpy = spyOn(process, "on");
  try {
    const fake = new FakeChild();
    await connectWithRaw(sealedRaw, ["web1"], TEST_PASSWORD, fakeSpawn(fake));

    expect(tempFilesIn(scratchRunDir).length).toBe(1);

    const exitCall = (onSpy.mock.calls as unknown as [event: string, handler: () => void][]).find(
      ([event]) => event === "exit",
    );
    expect(exitCall).toBeDefined();
    exitCall?.[1]();

    expect(tempFilesIn(scratchRunDir).length).toBe(0);
  } finally {
    onSpy.mockRestore();
  }
});

test("temp config is removed even when spawning ssh itself fails", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const fake = new FakeChild();
    await connectWithRaw(sealedRaw, ["web1"], TEST_PASSWORD, fakeSpawn(fake));

    expect(tempFilesIn(scratchRunDir).length).toBe(1);

    fake.emit("error", new Error("ENOENT"));

    expect(tempFilesIn(scratchRunDir).length).toBe(0);
    expect(exitSpy).toHaveBeenCalledWith(1);
  } finally {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  }
});

test("connectWithRaw rejects -F itself, so no caller (runConnect or the bare-mssh picker) can bypass the guard", async () => {
  expect(() => connectWithRaw(sealedRaw, ["web1", "-F", "/tmp/other"], TEST_PASSWORD)).toThrow(/refusing to pass -F/);
  expect(tempFilesIn(scratchRunDir).length).toBe(0);
});

test("connectWithRaw refuses a target matching no configured alias, instead of silently dropping its ProxyJump", async () => {
  expect(() => connectWithRaw(sealedRaw, ["typo-host"], TEST_PASSWORD)).toThrow(
    /"typo-host" is not a configured host alias/,
  );
  expect(tempFilesIn(scratchRunDir).length).toBe(0);
});

test("temp config contains only the target host, not other unrelated hosts", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  try {
    const multiHostRaw = "Host web1\n  HostName 10.0.0.1\n\nHost web2\n  HostName 10.0.0.2\n  User admin\n";
    const fake = new FakeChild();
    await connectWithRaw(multiHostRaw, ["web1"], TEST_PASSWORD, fakeSpawn(fake));

    const [tempName] = tempFilesIn(scratchRunDir);
    expect(tempName).toBeDefined();
    const contents = readFileSync(join(scratchRunDir, tempName as string), "utf8");
    expect(contents).toContain("Host web1");
    expect(contents).toContain("10.0.0.1");
    expect(contents).not.toContain("web2");
    expect(contents).not.toContain("10.0.0.2");

    fake.emit("exit", 0, null);
  } finally {
    exitSpy.mockRestore();
  }
});

test("temp config includes the target's ProxyJump chain but not unrelated hosts", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  try {
    const chainedRaw =
      "Host target\n  HostName 10.0.0.1\n  ProxyJump bastion\n\nHost bastion\n  HostName 10.0.0.2\n\nHost unrelated\n  HostName 10.0.0.3\n";
    const fake = new FakeChild();
    await connectWithRaw(chainedRaw, ["target"], TEST_PASSWORD, fakeSpawn(fake));

    const [tempName] = tempFilesIn(scratchRunDir);
    expect(tempName).toBeDefined();
    const contents = readFileSync(join(scratchRunDir, tempName as string), "utf8");
    expect(contents).toContain("Host target");
    expect(contents).toContain("Host bastion");
    expect(contents).not.toContain("unrelated");

    fake.emit("exit", 0, null);
  } finally {
    exitSpy.mockRestore();
  }
});

test("a sealed managed key is decrypted into run/key-* and its temp file removed on exit", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  try {
    const keyBytes = Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nsecretbytes\n-----END OPENSSH PRIVATE KEY-----\n");
    const keyPath = join(scratchKeysDir, "web1_ed25519.pem");
    sealKeyFile(keyPath, keyBytes, TEST_PASSWORD);

    const rawWithKey = `Host web1\n  HostName 10.0.0.1\n  IdentityFile ${keyPath}\n`;
    const fake = new FakeChild();
    connectWithRaw(rawWithKey, ["web1"], TEST_PASSWORD, fakeSpawn(fake));

    const runFiles = tempFilesIn(scratchRunDir);
    const keyTempName = runFiles.find((name) => name.startsWith("key-"));
    expect(keyTempName).toBeDefined();
    const keyTempPath = join(scratchRunDir, keyTempName as string);
    expect(readFileSync(keyTempPath).equals(keyBytes)).toBe(true);

    const cfgName = runFiles.find((name) => name.startsWith("cfg-"));
    const cfgContents = readFileSync(join(scratchRunDir, cfgName as string), "utf8");
    expect(cfgContents).toContain(keyTempPath);
    expect(cfgContents).not.toContain(keyPath);

    fake.emit("exit", 0, null);

    expect(tempFilesIn(scratchRunDir).length).toBe(0);
  } finally {
    exitSpy.mockRestore();
  }
});

test("only the target host's managed key is decrypted, not an unrelated host's", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  try {
    const targetKeyBytes = Buffer.from("target-key-bytes");
    const targetKeyPath = join(scratchKeysDir, "web1_target.pem");
    sealKeyFile(targetKeyPath, targetKeyBytes, TEST_PASSWORD);

    const otherKeyBytes = Buffer.from("other-key-bytes");
    const otherKeyPath = join(scratchKeysDir, "web2_other.pem");
    sealKeyFile(otherKeyPath, otherKeyBytes, TEST_PASSWORD);

    const rawTwoHosts =
      `Host web1\n  HostName 10.0.0.1\n  IdentityFile ${targetKeyPath}\n\n` +
      `Host web2\n  HostName 10.0.0.2\n  IdentityFile ${otherKeyPath}\n`;
    const fake = new FakeChild();
    connectWithRaw(rawTwoHosts, ["web1"], TEST_PASSWORD, fakeSpawn(fake));

    const runFiles = tempFilesIn(scratchRunDir);
    const keyTempNames = runFiles.filter((name) => name.startsWith("key-"));
    expect(keyTempNames.length).toBe(1);

    fake.emit("exit", 0, null);
  } finally {
    exitSpy.mockRestore();
  }
});

test("the sealed config on disk is unchanged by a connect that materializes a key", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  try {
    const before = readFileSync(configFilePath);
    const keyBytes = Buffer.from("unrelated-connect-key");
    const keyPath = join(scratchKeysDir, "web1_unchanged.pem");
    sealKeyFile(keyPath, keyBytes, TEST_PASSWORD);

    const rawWithKey = `Host web1\n  HostName 10.0.0.1\n  IdentityFile ${keyPath}\n`;
    const fake = new FakeChild();
    connectWithRaw(rawWithKey, ["web1"], TEST_PASSWORD, fakeSpawn(fake));

    expect(readFileSync(configFilePath).equals(before)).toBe(true);

    fake.emit("exit", 0, null);
  } finally {
    exitSpy.mockRestore();
  }
});

test("ssh is spawned with ControlMaster/ControlPath before the user's argv", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  try {
    const fake = new FakeChild();
    const captured: { args?: string[] } = {};
    await connectWithRaw(sealedRaw, ["web1"], TEST_PASSWORD, fakeSpawnCapturing(fake, captured));

    const args = captured.args ?? [];
    const cmIndex = args.indexOf("ControlMaster=yes");
    const cpIndex = args.findIndex((a) => a.startsWith("ControlPath="));
    const webIndex = args.indexOf("web1");
    expect(cmIndex).toBeGreaterThan(-1);
    expect(cpIndex).toBeGreaterThan(-1);
    expect(cmIndex).toBeLessThan(webIndex);
    expect(cpIndex).toBeLessThan(webIndex);

    fake.emit("exit", 0, null);
  } finally {
    exitSpy.mockRestore();
  }
});

test("temp files are purged as soon as the control socket appears, before ssh exits", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  try {
    const fake = new FakeChild();
    const captured: { args?: string[] } = {};
    await connectWithRaw(sealedRaw, ["web1"], TEST_PASSWORD, fakeSpawnCapturing(fake, captured));

    expect(tempFilesIn(scratchRunDir).length).toBe(1);

    const cpArg = (captured.args ?? []).find((a) => a.startsWith("ControlPath="));
    expect(cpArg).toBeDefined();
    const controlPath = (cpArg as string).slice("ControlPath=".length);

    writeFileSync(controlPath, ""); // stands in for ssh creating the socket post-auth

    await Bun.sleep(250);

    expect(tempFilesIn(scratchRunDir).length).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();

    fake.emit("exit", 0, null); // idempotent cleanup must not double-fail or double-exit
    expect(exitSpy).toHaveBeenCalledWith(0);
  } finally {
    exitSpy.mockRestore();
  }
});

test("runConnect still decrypts and delegates to connectWithRaw end to end", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  try {
    const fake = new FakeChild();
    await runConnect(["web1"], fakeSpawn(fake));

    expect(tempFilesIn(scratchRunDir).length).toBe(1);

    fake.emit("exit", 0, null);

    expect(tempFilesIn(scratchRunDir).length).toBe(0);
    expect(exitSpy).toHaveBeenCalledWith(0);
  } finally {
    exitSpy.mockRestore();
  }
});
