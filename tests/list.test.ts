import { test, expect } from "bun:test";
import { hostChoices } from "../src/commands/list";
import type { Host } from "../src/ssh-config";

function host(overrides: Partial<Host>): Host {
  return { name: "web1", extras: [], ...overrides };
}

test("hostChoices maps each host to its alias only, both as name and value", () => {
  expect(hostChoices([host({ name: "web1" }), host({ name: "web2" })])).toEqual([
    { name: "web1", value: "web1" },
    { name: "web2", value: "web2" },
  ]);
});

test("hostChoices preserves input order", () => {
  const hosts = [host({ name: "c" }), host({ name: "a" }), host({ name: "b" })];
  expect(hostChoices(hosts).map((c) => c.value)).toEqual(["c", "a", "b"]);
});

test("hostChoices returns empty array for no hosts", () => {
  expect(hostChoices([])).toEqual([]);
});

test("hostChoices never leaks hostname, user, or port for a fully-populated host", () => {
  const fullyPopulated = host({
    name: "web1",
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
