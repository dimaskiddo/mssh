import { test, expect } from "bun:test";
import { findDependents } from "../src/commands/delete";
import type { Host } from "../src/ssh-config";

function host(overrides: Partial<Host>): Host {
  return { name: "web1", extras: [], ...overrides };
}

test("findDependents finds hosts that jump through the named host", () => {
  const hosts = [
    host({ name: "bastion" }),
    host({ name: "web1", proxyJump: "bastion" }),
    host({ name: "web2", proxyJump: "bastion" }),
    host({ name: "db1" }),
  ];
  expect(findDependents(hosts, "bastion").map((h) => h.name)).toEqual(["web1", "web2"]);
});

test("findDependents returns empty array when no host has that ProxyJump", () => {
  const hosts = [host({ name: "web1" }), host({ name: "web2", proxyJump: "other" })];
  expect(findDependents(hosts, "bastion")).toEqual([]);
});

test("findDependents matches by proxyJump value alone, no self-exclusion", () => {
  const hosts = [host({ name: "bastion", proxyJump: "bastion" })];
  expect(findDependents(hosts, "bastion").map((h) => h.name)).toEqual(["bastion"]);
});
