// index.ts's argv dispatch (--help/--version short-circuiting before any
// prompt or disk write, and the config usage-error path) can only be
// exercised faithfully as a real process: it's the entry point itself, not a
// function anything imports. A hung stdin prompt would otherwise hang the
// test forever, so a timeout plus asserting result.signal === null (proves
// it exited on its own, not killed by the timeout) is the safety net.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import pkg from "../package.json";

const entry = join(import.meta.dir, "..", "index.ts");

function runCli(args: string[]) {
  return spawnSync("bun", [entry, ...args], { encoding: "utf8", timeout: 5000, input: "" });
}

test("--help prints usage and exits 0 without prompting", () => {
  const result = runCli(["--help"]);
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("mssh — encrypted SSH config wrapper");
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
