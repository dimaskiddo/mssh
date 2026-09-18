import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { hostsWithoutProxyJump, type Host } from "../src/ssh-config";
import {
  buildNewHost,
  tempConfigRunner,
  preflightArgv,
  defaultUsername,
  validateNewAlias,
  resolveSsh,
} from "../src/internal";

test("buildNewHost keeps required name and treats blank optional fields as undefined", () => {
  const host = buildNewHost({
    name: "web1",
    hostname: "",
    port: "",
    user: "",
    identityFile: "",
    proxyJump: undefined,
  });

  expect(host).toEqual({
    names: ["web1"],
    hostname: undefined,
    port: undefined,
    user: undefined,
    identityFile: undefined,
    proxyJump: undefined,
    extras: [],
  });
});

test("buildNewHost fills in all provided fields", () => {
  const host = buildNewHost({
    name: "web1",
    hostname: "10.0.0.5",
    port: "2222",
    user: "deploy",
    identityFile: "~/.ssh/id_rsa",
    proxyJump: "bastion",
  });

  expect(host).toEqual({
    names: ["web1"],
    hostname: "10.0.0.5",
    port: "2222",
    user: "deploy",
    identityFile: "~/.ssh/id_rsa",
    proxyJump: "bastion",
    extras: [],
  });
});

test("buildNewHost does not store empty strings for optional fields", () => {
  const host = buildNewHost({
    name: "web1",
    hostname: "10.0.0.5",
    port: "",
    user: "",
    identityFile: "",
    proxyJump: undefined,
  });

  expect(host.port).toBeUndefined();
  expect(host.user).toBeUndefined();
  expect(host.identityFile).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(host, "port")).toBe(true); // present as undefined, not omitted
});

test("hostsWithoutProxyJump returns empty when every host is already proxied, which is runAdd's exit-1 precondition", () => {
  const hosts: Host[] = [
    { names: ["web1"], proxyJump: "bastion", extras: [] },
    { names: ["web2"], proxyJump: "bastion", extras: [] },
  ];
  expect(hostsWithoutProxyJump(hosts)).toEqual([]);
});

test("defaultUsername returns userInfo().username when available, else the root fallback", () => {
  let expected: string;
  try {
    const name = userInfo().username;
    expected = name === "" ? "root" : name;
  } catch {
    expected = "root";
  }
  expect(defaultUsername()).toBe(expected);
  expect(defaultUsername().length).toBeGreaterThan(0);
});

test("validateNewAlias rejects a reserved name", () => {
  expect(validateNewAlias("setup", [])).toBe('"setup" is reserved by mssh itself and would be unreachable.');
});

test("validateNewAlias rejects a duplicate of an existing host's name", () => {
  const existing: Host[] = [{ names: ["web1"], extras: [] }];
  expect(validateNewAlias("web1", existing)).toBe('Host "web1" already exists.');
});

test("validateNewAlias rejects a glob/invalid name before checking reserved or duplicate", () => {
  expect(validateNewAlias("*", [])).toBe("Use letters, digits, dot, dash or underscore only.");
});

test("validateNewAlias accepts a valid, non-reserved, non-duplicate name", () => {
  expect(validateNewAlias("web2", [])).toBe(true);
});

test("tempConfigRunner threads -F at the given temp config path through to the real ssh binary", () => {
  // No network involved: ProxyCommand false makes ssh fail immediately and
  // deterministically, but only if it actually read -F's config — proving
  // the runner wires the path through rather than ignoring it.
  const dir = mkdtempSync(join(tmpdir(), "mssh-tempconfigrunner-test-"));
  try {
    const cfgPath = join(dir, "cfg");
    writeFileSync(cfgPath, "Host *\n  ProxyCommand false\n");

    const sshPath = resolveSsh();
    if (sshPath === undefined) throw new Error("ssh not found on PATH — required for this test");
    const runner = tempConfigRunner(cfgPath, sshPath);
    const result = runner("anytarget", ["true"]);

    expect(result.status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflightArgv puts -F and the temp path first, so the bastion's own block is what ssh reads", () => {
  expect(preflightArgv("/tmp/cfg", "bastion1").slice(0, 2)).toEqual(["-F", "/tmp/cfg"]);
});

test("preflightArgv sets StrictHostKeyChecking=accept-new as a separate -o token pair", () => {
  const argv = preflightArgv("/tmp/cfg", "bastion1");
  const idx = argv.indexOf("-o");
  expect(idx).toBeGreaterThan(-1);
  expect(argv[idx + 1]).toBe("StrictHostKeyChecking=accept-new");
});

test("preflightArgv ends with the alias then true, so the alias is never parsed as a flag value", () => {
  expect(preflightArgv("/tmp/cfg", "bastion1").slice(-2)).toEqual(["bastion1", "true"]);
});

test("preflightArgv emits the alias exactly once", () => {
  const argv = preflightArgv("/tmp/cfg", "bastion1");
  expect(argv.filter((a) => a === "bastion1")).toHaveLength(1);
});
