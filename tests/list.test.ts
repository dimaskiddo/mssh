import { test, expect } from "bun:test";
import type { Host } from "../src/ssh-config";
import { hostChoices } from "../src/internal";

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
