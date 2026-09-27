import { test, expect } from "bun:test";
import { resolveTarget, hostChoices, sortNames } from "../../src/cli/pick-host";
import type { Host } from "../../src/ssh/host";

const hosts: Host[] = [
  { names: ["web1"], extras: [] },
  { names: ["a", "b"], extras: [] },
];

test("resolveTarget with a name finds the host and echoes the name back as targetName", async () => {
  const result = await resolveTarget(hosts, "web1");
  expect(result?.targetName).toBe("web1");
  expect(result?.host).toBe(hosts[0]);
});

test("resolveTarget with a name matches any one of a multi-pattern host's aliases", async () => {
  const result = await resolveTarget(hosts, "b");
  expect(result?.host).toBe(hosts[1]);
  expect(result?.targetName).toBe("b");
});

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
