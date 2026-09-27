import { test, expect } from "bun:test";
import { resolveTarget, hostChoices, sortNames, tagGroups, UNTAGGED_LABEL } from "../../src/cli/pick-host";
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

test("tagGroups with no filter groups by every tag found, sorted, with untagged hosts last", () => {
  const hosts: Host[] = [
    host({ names: ["web2"], tags: ["alibaba"] }),
    host({ names: ["db1"], tags: ["stage"] }),
    host({ names: ["web1"], tags: ["stage", "alibaba"] }),
    host({ names: ["bastion"] }),
  ];
  expect(tagGroups(hosts, [])).toEqual([
    { label: "[ALIBABA]", names: ["web1", "web2"] },
    { label: "[STAGE]", names: ["db1", "web1"] },
    { label: UNTAGGED_LABEL, names: ["bastion"] },
  ]);
});

test("tagGroups puts a multi-tagged host in every one of its groups", () => {
  const hosts: Host[] = [host({ names: ["web1"], tags: ["a", "b"] })];
  expect(tagGroups(hosts, [])).toEqual([
    { label: "[A]", names: ["web1"] },
    { label: "[B]", names: ["web1"] },
  ]);
});

test("tagGroups with a filter groups only by the given tags, not every tag on the matches", () => {
  const hosts: Host[] = [host({ names: ["web1"], tags: ["alibaba", "stage"] })];
  expect(tagGroups(hosts, ["alibaba"])).toEqual([{ label: "[ALIBABA]", names: ["web1"] }]);
});

test("tagGroups with a filter never adds an [Others] group", () => {
  const hosts: Host[] = [host({ names: ["web1"], tags: ["alibaba"] }), host({ names: ["bastion"] })];
  expect(tagGroups(hosts, ["alibaba"])).toEqual([{ label: "[ALIBABA]", names: ["web1"] }]);
});

test("tagGroups drops a group with no names, including a glob-only tagged host", () => {
  const hosts: Host[] = [host({ names: ["*"], tags: ["alibaba"] })];
  expect(tagGroups(hosts, [])).toEqual([]);
});

test("tagGroups omits [Others] when every host is tagged", () => {
  const hosts: Host[] = [host({ names: ["web1"], tags: ["a"] })];
  expect(tagGroups(hosts, [])).toEqual([{ label: "[A]", names: ["web1"] }]);
});

test("tagGroups uppercases tag labels but keeps [Others] distinct from a tag literally named others", () => {
  const hosts: Host[] = [host({ names: ["web1"], tags: ["others"] }), host({ names: ["bastion"] })];
  expect(tagGroups(hosts, [])).toEqual([
    { label: "[OTHERS]", names: ["web1"] },
    { label: UNTAGGED_LABEL, names: ["bastion"] },
  ]);
});

test("tagGroups returns an empty array for no hosts", () => {
  expect(tagGroups([], [])).toEqual([]);
});
