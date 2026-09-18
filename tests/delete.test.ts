import { test, expect } from "bun:test";
import type { Host } from "../src/ssh-config";
import { findDependents } from "../src/internal";

function host(overrides: Partial<Host>): Host {
  return { names: ["web1"], extras: [], ...overrides };
}

test("findDependents finds hosts that jump through the named host", () => {
  const hosts = [
    host({ names: ["bastion"] }),
    host({ names: ["web1"], proxyJump: "bastion" }),
    host({ names: ["web2"], proxyJump: "bastion" }),
    host({ names: ["db1"] }),
  ];
  expect(findDependents(hosts, ["bastion"]).map((h) => h.names)).toEqual([["web1"], ["web2"]]);
});

test("findDependents returns empty array when no host has that ProxyJump", () => {
  const hosts = [host({ names: ["web1"] }), host({ names: ["web2"], proxyJump: "other" })];
  expect(findDependents(hosts, ["bastion"])).toEqual([]);
});

test("findDependents matches by proxyJump value alone, no self-exclusion", () => {
  const hosts = [host({ names: ["bastion"], proxyJump: "bastion" })];
  expect(findDependents(hosts, ["bastion"]).map((h) => h.names)).toEqual([["bastion"]]);
});

test("findDependents matches when the dependent's ProxyJump is any one of the target's several patterns", () => {
  const hosts = [host({ names: ["web1"], proxyJump: "b" })];
  expect(findDependents(hosts, ["a", "b"]).map((h) => h.names)).toEqual([["web1"]]);
});

test("findDependents matches a ProxyJump written as user@host:port, not just the bare alias", () => {
  const hosts = [host({ names: ["web1"], proxyJump: "deploy@bastion:2222" })];
  expect(findDependents(hosts, ["bastion"]).map((h) => h.names)).toEqual([["web1"]]);
});

test("findDependents matches a ProxyJump written as a comma-separated chain", () => {
  const hosts = [host({ names: ["web1"], proxyJump: "hop1,hop2" })];
  expect(findDependents(hosts, ["hop2"]).map((h) => h.names)).toEqual([["web1"]]);
});
