// connectWithRaw owns connect.ts's temp-config lifetime (see the header
// comment there): the plaintext file must survive until ssh has actually
// exited, then be gone. It's shared by runConnect and the bare-`mssh`
// picker (list.ts's runListConnect), so it's exercised directly here rather
// than through either caller. Exercising this without spawning a real ssh
// process needs a fake ChildProcess and app-config redirected into a scratch
// directory, wired through the SpawnFn seam.
//
// Only app-config is mocked (paths + password) — store.ts is left real,
// fed a real seal()'d file, deliberately. mock.module() replaces a module in
// Bun's shared registry for the whole test run, not just this file: an
// earlier version of this test also mocked store and it broke store.test.ts,
// whose own static import bound to the mock before this file's afterAll
// could restore it (test files load before any test runs). Fewer mocked
// modules is the actual fix, not a restore hook.
import { test, expect, mock, spyOn, afterAll } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { SpawnFn } from "../src/commands/connect";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal } from "../src/crypto";
import * as realAppConfig from "../src/app-config";

const scratchRoot = mkdtempSync(join(tmpdir(), "mssh-connect-spawn-test-"));
const scratchRunDir = join(scratchRoot, "run");
const configFilePath = join(scratchRoot, "ssh_config.enc");
const TEST_PASSWORD = "fixed-test-password";
const sealedRaw = "Host web1\n  HostName 10.0.0.1\n";

writeFileSync(configFilePath, seal(sealedRaw, TEST_PASSWORD));

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
  rmSync(scratchRoot, { recursive: true, force: true });
});

class FakeChild extends EventEmitter {
  kill(): boolean {
    return true;
  }
}

const fakeSpawn = (fake: FakeChild): SpawnFn => () => fake as unknown as ChildProcess;

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
    await connectWithRaw(sealedRaw, ["web1"], fakeSpawn(fake));

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
    await connectWithRaw(sealedRaw, ["web1"], fakeSpawn(fake));

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
    await connectWithRaw(sealedRaw, ["web1"], fakeSpawn(fake));

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
  await expect(connectWithRaw(sealedRaw, ["web1", "-F", "/tmp/other"])).rejects.toThrow(/refusing to pass -F/);
  expect(tempFilesIn(scratchRunDir).length).toBe(0);
});

test("connectWithRaw refuses a target matching no configured alias, instead of silently dropping its ProxyJump", async () => {
  await expect(connectWithRaw(sealedRaw, ["typo-host"])).rejects.toThrow(
    /"typo-host" is not a configured host alias/,
  );
  expect(tempFilesIn(scratchRunDir).length).toBe(0);
});

test("temp config contains only the target host, not other unrelated hosts", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  try {
    const multiHostRaw = "Host web1\n  HostName 10.0.0.1\n\nHost web2\n  HostName 10.0.0.2\n  User admin\n";
    const fake = new FakeChild();
    await connectWithRaw(multiHostRaw, ["web1"], fakeSpawn(fake));

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
    await connectWithRaw(chainedRaw, ["target"], fakeSpawn(fake));

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
