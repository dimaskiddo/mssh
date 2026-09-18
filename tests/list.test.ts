import { test, expect } from "bun:test";
import type { Host } from "../src/ssh-config";
import { hostChoices, sortNames, parseSortFlag } from "../src/internal";

function host(overrides: Partial<Host>): Host {
  return { names: ["web1"], extras: [], ...overrides };
}

test("hostChoices maps each host to its alias only, both as name and value", () => {
  expect(hostChoices([host({ names: ["web1"] }), host({ names: ["web2"] })])).toEqual([
    { name: "web1", value: "web1" },
    { name: "web2", value: "web2" },
  ]);
});

test("hostChoices lists one entry per pattern for a multi-pattern host", () => {
  expect(hostChoices([host({ names: ["a", "b"] })])).toEqual([
    { name: "a", value: "a" },
    { name: "b", value: "b" },
  ]);
});

test("hostChoices excludes glob and negation patterns from the pickable list", () => {
  expect(hostChoices([host({ names: ["*", "!x", "real"] })])).toEqual([{ name: "real", value: "real" }]);
});

test("hostChoices preserves input order", () => {
  const hosts = [host({ names: ["c"] }), host({ names: ["a"] }), host({ names: ["b"] })];
  expect(hostChoices(hosts).map((c) => c.value)).toEqual(["c", "a", "b"]);
});

test("hostChoices returns empty array for no hosts", () => {
  expect(hostChoices([])).toEqual([]);
});

test("hostChoices never leaks hostname, user, or port for a fully-populated host", () => {
  const fullyPopulated = host({
    names: ["web1"],
    hostname: "10.0.0.5",
    port: "2222",
    user: "deploy",
    proxyJump: "bastion",
  });
  const serialized = JSON.stringify(hostChoices([fullyPopulated]));
  expect(serialized).not.toContain("10.0.0.5");
  expect(serialized).not.toContain("deploy");
  expect(serialized).not.toContain("2222");
  expect(serialized).not.toContain("bastion");
});

test("hostChoices applies the given sort order instead of config order", () => {
  const hosts = [host({ names: ["c"] }), host({ names: ["a"] }), host({ names: ["b"] })];
  expect(hostChoices(hosts, "asc").map((c) => c.value)).toEqual(["a", "b", "c"]);
});

test("sortNames asc sorts ascending, dsc sorts descending, cfg leaves input order untouched", () => {
  const names = ["c", "a", "b"];
  expect(sortNames(names, "asc")).toEqual(["a", "b", "c"]);
  expect(sortNames(names, "dsc")).toEqual(["c", "b", "a"]);
  expect(sortNames(names, "cfg")).toEqual(["c", "a", "b"]);
});

test("sortNames is case-sensitive ASCII: uppercase sorts before lowercase", () => {
  expect(sortNames(["beta", "Alpha", "Gamma"], "asc")).toEqual(["Alpha", "Gamma", "beta"]);
});

test("sortNames does not mutate its input array", () => {
  const names = ["c", "a", "b"];
  sortNames(names, "asc");
  expect(names).toEqual(["c", "a", "b"]);
});

test("sortNames returns an empty array for all three orders given no names", () => {
  expect(sortNames([], "asc")).toEqual([]);
  expect(sortNames([], "dsc")).toEqual([]);
  expect(sortNames([], "cfg")).toEqual([]);
});

test("parseSortFlag with no args defaults to ascending with nothing left over", () => {
  expect(parseSortFlag([])).toEqual({ order: "asc", rest: [], invalid: undefined });
});

test("parseSortFlag reads a valid --sort= value and leaves an empty rest", () => {
  expect(parseSortFlag(["--sort=dsc"])).toEqual({ order: "dsc", rest: [], invalid: undefined });
});

test("parseSortFlag falls back to ascending and reports the value when it is not asc/dsc/cfg", () => {
  expect(parseSortFlag(["--sort=bogus"])).toEqual({ order: "asc", rest: [], invalid: "bogus" });
});

test("parseSortFlag treats a bare --sort= with no value as invalid", () => {
  expect(parseSortFlag(["--sort="])).toEqual({ order: "asc", rest: [], invalid: "" });
});

test("parseSortFlag leaves non-flag arguments in rest for the caller's own rejection", () => {
  expect(parseSortFlag(["junk", "--sort=cfg"])).toEqual({ order: "cfg", rest: ["junk"], invalid: undefined });
});

test("parseSortFlag lets the last --sort= flag win when it is repeated", () => {
  expect(parseSortFlag(["--sort=dsc", "--sort=cfg"])).toEqual({ order: "cfg", rest: [], invalid: undefined });
});

test("parseSortFlag falls back to asc when the last repeated --sort= flag is invalid", () => {
  expect(parseSortFlag(["--sort=cfg", "--sort=bogus"])).toEqual({ order: "asc", rest: [], invalid: "bogus" });
});

test("parseSortFlag keeps a host name in rest so bare mssh won't mistake it for a sort-only invocation", () => {
  expect(parseSortFlag(["web1", "--sort=asc"])).toEqual({ order: "asc", rest: ["web1"], invalid: undefined });
});
