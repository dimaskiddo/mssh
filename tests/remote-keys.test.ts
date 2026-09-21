import { test, expect, mock } from "bun:test";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { listRemoteKeys, downloadRemoteKey, localKeyName, type RemoteRunner } from "../src/remote-keys";
import { isValidKeyFilename, isValidHostName } from "../src/internal";
import { withScratchDir as scratch } from "./helpers";

const withScratchDir = (fn: (dir: string) => void): void => scratch("mssh-remote-keys-test-", fn);

test("isValidKeyFilename accepts typical key names", () => {
  expect(isValidKeyFilename("id_rsa")).toBe(true);
  expect(isValidKeyFilename("id_ed25519.bak")).toBe(true);
  expect(isValidKeyFilename("my-key_2.pem")).toBe(true);
});

test("isValidKeyFilename rejects empty string", () => {
  expect(isValidKeyFilename("")).toBe(false);
});

test("isValidKeyFilename rejects names with spaces", () => {
  expect(isValidKeyFilename("id rsa")).toBe(false);
});

test("isValidKeyFilename rejects shell metacharacters", () => {
  expect(isValidKeyFilename("id_rsa;rm -rf /")).toBe(false);
  expect(isValidKeyFilename("id_rsa`whoami`")).toBe(false);
  expect(isValidKeyFilename("id_rsa$(whoami)")).toBe(false);
  expect(isValidKeyFilename("id_rsa|cat /etc/passwd")).toBe(false);
  expect(isValidKeyFilename("id_rsa&&rm -rf /")).toBe(false);
});

test("isValidKeyFilename rejects path traversal", () => {
  expect(isValidKeyFilename("../../etc/passwd")).toBe(false);
});

test("isValidKeyFilename rejects absolute paths", () => {
  expect(isValidKeyFilename("/etc/passwd")).toBe(false);
});

test("isValidKeyFilename rejects home-relative paths", () => {
  expect(isValidKeyFilename("~/.bashrc")).toBe(false);
});

test("isValidKeyFilename rejects dot-only names that pass the character class but resolve to a directory", () => {
  expect(isValidKeyFilename(".")).toBe(false);
  expect(isValidKeyFilename("..")).toBe(false);
  expect(isValidKeyFilename("...")).toBe(false);
});

test("localKeyName maps stock key names to their type", () => {
  expect(localKeyName("bastion-1", "id_rsa")).toBe("bastion-1_rsa.pem");
  expect(localKeyName("bastion-1", "id_ed25519")).toBe("bastion-1_ed25519.pem");
  expect(localKeyName("bastion-1", "id_ecdsa")).toBe("bastion-1_ecdsa.pem");
  expect(localKeyName("bastion-1", "id_dsa")).toBe("bastion-1_dsa.pem");
});

test("localKeyName matches stock names case-insensitively", () => {
  expect(localKeyName("bastion-1", "ID_RSA")).toBe("bastion-1_rsa.pem");
});

test("localKeyName falls back to the remote basename (extension stripped) for a non-stock name", () => {
  expect(localKeyName("bastion-1", "web1.pem")).toBe("bastion-1_web1.pem");
  expect(localKeyName("bastion-1", "deploy_key")).toBe("bastion-1_deploy_key.pem");
});

test("localKeyName result never contains a path separator for any isValidKeyFilename-passing input", () => {
  const validNames = ["id_rsa", "id_rsa.pub", "my-key_2.pem", "deploy.key", "a.b.c.pem"];
  for (const name of validNames) {
    expect(isValidKeyFilename(name)).toBe(true);
    const result = localKeyName("bastion-1", name);
    expect(result).not.toContain("/");
    expect(result).not.toContain("\\");
  }
});

test("localKeyName rejects a jumpAlias that would traverse out of keysDir(), even though isValidHostName permits it", () => {
  expect(isValidHostName("../../../../tmp/evil")).toBe(true); // the Host alias this comes from allows it
  expect(() => localKeyName("../../../../tmp/evil", "id_rsa")).toThrow();
  expect(() => localKeyName("bastion/../../etc", "id_rsa")).toThrow();
});

function fakeOkRunner(stdout: string): RemoteRunner {
  return () => ({ status: 0, stdout: Buffer.from(stdout, "utf8"), stderr: "" });
}

test("listRemoteKeys filters out .pub, known_hosts*, authorized_keys, and config", () => {
  const listing = ["id_rsa", "id_rsa.pub", "known_hosts", "known_hosts.old", "authorized_keys", "config", "id_ed25519"].join(
    "\n",
  );
  const result = listRemoteKeys("jumphost", fakeOkRunner(listing));
  expect(result).toEqual(["id_rsa", "id_ed25519"]);
});

test("listRemoteKeys also filters out environment and rc", () => {
  const listing = ["id_rsa", "environment", "rc"].join("\n");
  const result = listRemoteKeys("jumphost", fakeOkRunner(listing));
  expect(result).toEqual(["id_rsa"]);
});

test("listRemoteKeys filters out names that fail isValidKeyFilename before they reach the picker", () => {
  const listing = ["id_rsa", "..", ".", "...", "id_rsa;rm -rf /"].join("\n");
  const result = listRemoteKeys("jumphost", fakeOkRunner(listing));
  expect(result).toEqual(["id_rsa"]);
});

test("listRemoteKeys throws on non-zero exit instead of returning an empty list", () => {
  const failingRunner: RemoteRunner = () => ({ status: 1, stdout: Buffer.alloc(0), stderr: "permission denied" });
  expect(() => listRemoteKeys("jumphost", failingRunner)).toThrow();
});

test("listRemoteKeys throws on spawn error", () => {
  const failingRunner: RemoteRunner = () => ({
    status: null,
    stdout: Buffer.alloc(0),
    stderr: "",
    error: new Error("spawn ssh ENOENT"),
  });
  expect(() => listRemoteKeys("jumphost", failingRunner)).toThrow();
});

test("downloadRemoteKey writes the downloaded content to localPath via writeSecure", () => {
  withScratchDir((dir) => {
    const localPath = join(dir, "id_rsa");
    const content = "-----BEGIN OPENSSH PRIVATE KEY-----\nfakekeydata\n-----END OPENSSH PRIVATE KEY-----\n";
    let capturedArgv: string[] | undefined;
    const runner: RemoteRunner = (_target, argv) => {
      capturedArgv = argv;
      return { status: 0, stdout: Buffer.from(content, "utf8"), stderr: "" };
    };

    downloadRemoteKey("jumphost", "id_rsa", localPath, runner);

    expect(capturedArgv).toEqual(["cat", "~/.ssh/id_rsa"]);
    expect(readFileSync(localPath, "utf8")).toBe(content);
  });
});

test("downloadRemoteKey rejects an invalid filename without calling the runner at all", () => {
  withScratchDir((dir) => {
    const localPath = join(dir, "evil");
    const runner = mock<RemoteRunner>(() => ({ status: 0, stdout: Buffer.alloc(0), stderr: "" }));

    expect(() => downloadRemoteKey("jumphost", "../evil", localPath, runner)).toThrow();
    expect(runner).toHaveBeenCalledTimes(0);
    expect(existsSync(localPath)).toBe(false);
  });
});

test("downloadRemoteKey throws and writes nothing when the remote command fails", () => {
  withScratchDir((dir) => {
    const localPath = join(dir, "id_rsa");
    const failingRunner: RemoteRunner = () => ({ status: 1, stdout: Buffer.alloc(0), stderr: "no such file" });

    expect(() => downloadRemoteKey("jumphost", "id_rsa", localPath, failingRunner)).toThrow();
    expect(existsSync(localPath)).toBe(false);
  });
});

test("downloadRemoteKey unlinks a partially-written key if writeSecure's lockdown step throws", () => {
  // Forces writeSecure's Windows branch on a non-Windows dev machine: the
  // real `icacls` binary is absent here, so its own default runner reports a
  // spawn error the same way a genuine lockdown failure would on Windows.
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    withScratchDir((dir) => {
      const localPath = join(dir, "id_rsa");
      const runner: RemoteRunner = () => ({
        status: 0,
        stdout: Buffer.from("fakekeydata", "utf8"),
        stderr: "",
      });

      expect(() => downloadRemoteKey("jumphost", "id_rsa", localPath, runner)).toThrow();
      expect(existsSync(localPath)).toBe(false);
    });
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
});
