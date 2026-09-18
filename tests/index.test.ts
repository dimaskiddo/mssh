// index.ts's argv dispatch can only be exercised as a real process — it's the
// entry point, not a function anything imports. Timeout + signal===null guards against a hung stdin prompt.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import pkg from "../package.json";

const entry = join(import.meta.dir, "..", "index.ts");

function runCli(args: string[], env?: Record<string, string>) {
  return spawnSync("bun", [entry, ...args], {
    encoding: "utf8",
    timeout: 5000,
    input: "",
    env: { ...process.env, ...env },
  });
}

// A fresh HOME with no ~/.mssh/config: every password-requiring command must
// refuse before ever prompting, since setup was never run there.
function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), "mssh-index-test-"));
}

test("--help prints usage and exits 0 without prompting", () => {
  const result = runCli(["--help"]);
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("MSSH (Manager/Masked SSH) - An Encrypted SSH Config Wrapper");
});

test("-h prints usage and exits 0", () => {
  const result = runCli(["-h"]);
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Usage:");
});

test("--version prints the product banner and exits 0", () => {
  const result = runCli(["--version"]);
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${pkg.displayName} v${pkg.version}\nBy ${pkg.author}\n`);
});

test("version subcommand prints the same banner as --version", () => {
  const result = runCli(["version"]);
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${pkg.displayName} v${pkg.version}\nBy ${pkg.author}\n`);
});

test("--help with a trailing argument is rejected instead of printing usage", () => {
  const result = runCli(["--help", "junk"]);
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unexpected argument(s)");
  expect(result.stdout).toBe("");
});

test("setup with a trailing argument is rejected", () => {
  const result = runCli(["setup", "anything"], { HOME: emptyHome() });
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unexpected argument(s): anything");
});

test("config list with a trailing argument is rejected before prompting", () => {
  const result = runCli(["config", "list", "junk"], { HOME: emptyHome() });
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unexpected argument(s): junk");
});

test("config edit with two names is rejected", () => {
  const result = runCli(["config", "edit", "host1", "host2"], { HOME: emptyHome() });
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unexpected argument(s): host2");
});

test("config with an unknown subcommand prints usage and exits 1", () => {
  const result = runCli(["config", "bogus"]);
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage: mssh config <list|add|edit|delete>");
});

test("config with no subcommand prints usage and exits 1", () => {
  const result = runCli(["config"]);
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage: mssh config <list|add|edit|delete>");
});

const NO_CONFIG_CASES: Array<[string, string[]]> = [
  ["config list", ["config", "list"]],
  ["bare mssh", []],
  ["bare mssh with --sort", ["--sort=dsc"]],
  ["config add", ["config", "add"]],
  ["config edit", ["config", "edit"]],
  ["config delete", ["config", "delete"]],
  ["connect to a host", ["somehost"]],
  ["change-password", ["change-password"]],
];

for (const [label, args] of NO_CONFIG_CASES) {
  test(`${label} with no config directs to 'mssh setup' instead of prompting for a password`, () => {
    const result = runCli(args, { HOME: emptyHome() });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Run 'mssh setup'");
    expect(result.stdout).not.toContain("Password");
  });
}

test("config list with an unknown --sort= value warns and still reaches the no-config path", () => {
  const result = runCli(["config", "list", "--sort=bogus"], { HOME: emptyHome() });
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('unknown --sort value "bogus"');
  expect(result.stderr).toContain("Run 'mssh setup'");
});

test("mssh <host> --sort=asc reaches the connect path, not the listing", () => {
  const result = runCli(["somehost", "--sort=asc"], { HOME: emptyHome() });
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain("--sort");
  expect(result.stderr).toContain("Run 'mssh setup'");
});

test("a truncated config is rejected before any password prompt", () => {
  const home = emptyHome();
  const msshDir = join(home, ".mssh");
  mkdirSync(msshDir);
  writeFileSync(join(msshDir, "config"), "xx");

  const result = runCli(["config", "list"], { HOME: home });
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("empty or truncated");
  expect(result.stdout).not.toContain("Password");
});

test("a config path that is a directory is rejected before any password prompt", () => {
  const home = emptyHome();
  const msshDir = join(home, ".mssh");
  mkdirSync(msshDir);
  mkdirSync(join(msshDir, "config"));

  const result = runCli(["config", "list"], { HOME: home });
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("is not a file (it may be a directory)");
  expect(result.stdout).not.toContain("Password");
});
