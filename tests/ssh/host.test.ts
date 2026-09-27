import { test, expect } from "bun:test";
import { parse } from "../../src/ssh/ssh-config";
import {
  addHost,
  updateHostField,
  deleteHost,
  hostsWithoutProxyJump,
  proxyJumpAliases,
  hostsForTarget,
  withKeepAlive,
  hostLabel,
  hostHasName,
  connectableNames,
  duplicateAlias,
  rewriteIdentityFiles,
  splitTags,
  filterByTags,
  setHostTags,
  KEEP_ALIVE_INTERVAL,
  type Host,
} from "../../src/ssh/host";

const SAMPLE = `Host myserver
  HostName 1.2.3.4
  Port 2222
  User root
  IdentityFile ~/.ssh/id_rsa
  ProxyJump jumpbox

Host jumpbox
  HostName 5.6.7.8
  User admin
`;

test("addHost appends a new host and returns a new array", () => {
  const hosts = parse(SAMPLE);
  const newHost: Host = { names: ["newone"], extras: [] };
  const result = addHost(hosts, newHost);

  expect(result).not.toBe(hosts);
  expect(result).toHaveLength(3);
  expect(hosts).toHaveLength(2);
  expect(result.find((h) => hostHasName(h, "newone"))).toEqual(newHost);
});

test("addHost throws when the host name already exists", () => {
  const hosts = parse(SAMPLE);
  expect(() => addHost(hosts, { names: ["myserver"], extras: [] })).toThrow();
});

test("addHost throws when a new pattern collides with any existing pattern, not just an exact whole-name match", () => {
  const hosts: Host[] = [{ names: ["web1", "web2"], extras: [] }];
  expect(() => addHost(hosts, { names: ["web3", "web2"], extras: [] })).toThrow(/web2/);
});

test("updateHostField changes one field on the named host without touching others", () => {
  const hosts = parse(SAMPLE);
  const result = updateHostField(hosts, "myserver", "hostname", "9.9.9.9");

  expect(result).not.toBe(hosts);
  const updated = result.find((h) => hostHasName(h, "myserver"));
  expect(updated?.hostname).toBe("9.9.9.9");
  expect(updated?.port).toBe("2222");
  expect(updated?.user).toBe("root");

  const original = hosts.find((h) => hostHasName(h, "myserver"));
  expect(original?.hostname).toBe("1.2.3.4");

  const jumpbox = result.find((h) => hostHasName(h, "jumpbox"));
  expect(jumpbox).toEqual(hosts.find((h) => hostHasName(h, "jumpbox")));
});

test("updateHostField matches a host by any of its patterns", () => {
  const hosts: Host[] = [{ names: ["a", "b"], extras: [] }];
  const result = updateHostField(hosts, "b", "hostname", "1.1.1.1");
  expect(result[0]?.hostname).toBe("1.1.1.1");
});

test("deleteHost removes the named host and returns a new array with one fewer entry", () => {
  const hosts = parse(SAMPLE);
  const result = deleteHost(hosts, "jumpbox");

  expect(result).not.toBe(hosts);
  expect(result).toHaveLength(1);
  expect(hosts).toHaveLength(2);
  expect(result.find((h) => hostHasName(h, "jumpbox"))).toBeUndefined();
  expect(result.find((h) => hostHasName(h, "myserver"))).toBeDefined();
});

test("deleteHost removes a whole multi-pattern block when matched by any one of its patterns", () => {
  const hosts: Host[] = [{ names: ["a", "b"], extras: [] }, { names: ["c"], extras: [] }];
  const result = deleteHost(hosts, "b");
  expect(result).toHaveLength(1);
  expect(result[0]?.names).toEqual(["c"]);
});

test("hostsWithoutProxyJump returns only hosts whose proxyJump field is unset", () => {
  const hosts = parse(SAMPLE);
  const result = hostsWithoutProxyJump(hosts);

  expect(result).toHaveLength(1);
  expect(result[0]?.names).toEqual(["jumpbox"]);
});

test("proxyJumpAliases strips user@ and :port from each hop", () => {
  expect(proxyJumpAliases("bastion")).toEqual(["bastion"]);
  expect(proxyJumpAliases("admin@bastion:2222")).toEqual(["bastion"]);
});

test("proxyJumpAliases splits a comma-separated chain, trimming whitespace", () => {
  expect(proxyJumpAliases("hop1, admin@hop2:22 ,hop3")).toEqual(["hop1", "hop2", "hop3"]);
});

test("hostsForTarget returns only the target when it has no ProxyJump", () => {
  const hosts = parse(SAMPLE);
  const result = hostsForTarget(hosts, ["jumpbox"]);
  expect(result.flatMap((h) => h.names)).toEqual(["jumpbox"]);
});

test("hostsForTarget pulls in a one-hop ProxyJump chain", () => {
  const hosts = parse(SAMPLE);
  const result = hostsForTarget(hosts, ["myserver"]);
  expect(result.flatMap((h) => h.names).sort()).toEqual(["jumpbox", "myserver"]);
});

test("hostsForTarget pulls in a two-hop ProxyJump chain", () => {
  const hosts: Host[] = [
    { names: ["target"], proxyJump: "mid", extras: [] },
    { names: ["mid"], proxyJump: "edge", extras: [] },
    { names: ["edge"], extras: [] },
    { names: ["unrelated"], extras: [] },
  ];
  const result = hostsForTarget(hosts, ["target"]);
  expect(result.flatMap((h) => h.names)).toEqual(["target", "mid", "edge"]);
});

test("hostsForTarget terminates on a ProxyJump cycle instead of looping forever", () => {
  const hosts: Host[] = [
    { names: ["a"], proxyJump: "b", extras: [] },
    { names: ["b"], proxyJump: "a", extras: [] },
  ];
  const result = hostsForTarget(hosts, ["a"]);
  expect(result.flatMap((h) => h.names).sort()).toEqual(["a", "b"]);
});

test("hostsForTarget preserves source order and keeps a glob-named host", () => {
  const hosts: Host[] = [
    { names: ["web*"], extras: [] },
    { names: ["target"], extras: [] },
    { names: ["other"], extras: [] },
  ];
  const result = hostsForTarget(hosts, ["target"]);
  expect(result.flatMap((h) => h.names)).toEqual(["web*", "target"]);
});

test("hostsForTarget also always keeps a negation-patterned host, since it's meaningless without its siblings", () => {
  const hosts: Host[] = [
    { names: ["*", "!excluded"], extras: [] },
    { names: ["target"], extras: [] },
  ];
  const result = hostsForTarget(hosts, ["target"]);
  expect(result.flatMap((h) => h.names)).toEqual(["*", "!excluded", "target"]);
});

test("hostsForTarget visits a multi-pattern host once, not once per pattern", () => {
  const hosts: Host[] = [
    { names: ["target"], proxyJump: "a,b", extras: [] },
    { names: ["a", "b"], extras: [] },
  ];
  const result = hostsForTarget(hosts, ["target"]);
  expect(result).toHaveLength(2);
});

test("hostsForTarget returns an empty array for an unknown target", () => {
  const hosts = parse(SAMPLE);
  expect(hostsForTarget(hosts, ["nope"])).toEqual([]);
});

test("withKeepAlive appends ServerAliveInterval to a host with no extras", () => {
  const hosts: Host[] = [{ names: ["web1"], extras: [] }];
  expect(withKeepAlive(hosts)[0]?.extras).toEqual([{ key: "ServerAliveInterval", value: KEEP_ALIVE_INTERVAL }]);
});

test("withKeepAlive is idempotent across repeated applications", () => {
  const hosts: Host[] = [{ names: ["web1"], extras: [] }];
  const once = withKeepAlive(hosts);
  const twice = withKeepAlive(once);
  expect(twice).toEqual(once);
});

test("withKeepAlive leaves an existing ServerAliveInterval (any case) untouched", () => {
  const hosts: Host[] = [{ names: ["web1"], extras: [{ key: "serveraliveinterval", value: "30" }] }];
  expect(withKeepAlive(hosts)[0]?.extras).toEqual([{ key: "serveraliveinterval", value: "30" }]);
});

test("hostLabel joins a multi-pattern host's names for display", () => {
  expect(hostLabel({ names: ["a", "b"], extras: [] })).toBe("a b");
});

test("hostHasName matches any one of a host's patterns", () => {
  const host: Host = { names: ["a", "b"], extras: [] };
  expect(hostHasName(host, "a")).toBe(true);
  expect(hostHasName(host, "b")).toBe(true);
  expect(hostHasName(host, "c")).toBe(false);
});

test("connectableNames flattens every host's patterns and excludes glob/negation metacharacters", () => {
  const hosts: Host[] = [
    { names: ["a", "b"], extras: [] },
    { names: ["*", "!c"], extras: [] },
  ];
  expect(connectableNames(hosts)).toEqual(["a", "b"]);
});

// Defense in depth: parse() already drops a '-'-prefixed pattern, but a
// Host built programmatically (tests, or any future code path) must not
// surface one through the picker either — it would be read as an ssh option.
test("connectableNames excludes a '-'-prefixed name, in case one reaches this in memory without going through parse()", () => {
  const hosts: Host[] = [{ names: ["-oProxyCommand=x", "ok"], extras: [] }];
  expect(connectableNames(hosts)).toEqual(["ok"]);
});

test("duplicateAlias returns undefined when every alias is distinct", () => {
  const hosts: Host[] = [{ names: ["web1"], extras: [] }, { names: ["web2"], extras: [] }];
  expect(duplicateAlias(hosts)).toBeUndefined();
});

test("duplicateAlias returns undefined for an empty list", () => {
  expect(duplicateAlias([])).toBeUndefined();
});

test("duplicateAlias returns the shared alias when two hosts claim it", () => {
  const hosts: Host[] = [{ names: ["web1"], extras: [] }, { names: ["web1"], extras: [] }];
  expect(duplicateAlias(hosts)).toBe("web1");
});

test("duplicateAlias detects overlap between a multi-pattern host and a later single-pattern host", () => {
  const hosts: Host[] = [{ names: ["alpha", "beta"], extras: [] }, { names: ["beta"], extras: [] }];
  expect(duplicateAlias(hosts)).toBe("beta");
});

test("duplicateAlias returns the first collision when several exist", () => {
  const hosts: Host[] = [
    { names: ["web1"], extras: [] },
    { names: ["web2"], extras: [] },
    { names: ["web1"], extras: [] },
    { names: ["web2"], extras: [] },
  ];
  expect(duplicateAlias(hosts)).toBe("web1");
});

test("duplicateAlias is case-sensitive: web1 and WEB1 are distinct hosts, matching ssh's own alias matching", () => {
  const hosts: Host[] = [{ names: ["web1"], extras: [] }, { names: ["WEB1"], extras: [] }];
  expect(duplicateAlias(hosts)).toBeUndefined();
});

test("duplicateAlias ignores a repeated pattern within one host — that is assertSerializable's check to make", () => {
  const hosts: Host[] = [{ names: ["web1", "web1"], extras: [] }];
  expect(duplicateAlias(hosts)).toBeUndefined();
});

test("rewriteIdentityFiles points a mapped host's IdentityFile at the temp path", () => {
  const hosts: Host[] = [{ names: ["web1"], identityFile: "/home/user/.mssh/keys/jump_ed25519.pem", extras: [] }];
  const mapping = new Map([["/home/user/.mssh/keys/jump_ed25519.pem", "/home/user/.mssh/run/key-123-abc"]]);
  const rewritten = rewriteIdentityFiles(hosts, mapping);
  expect(rewritten[0]?.identityFile).toBe("/home/user/.mssh/run/key-123-abc");
});

test("rewriteIdentityFiles leaves a host with no matching entry in the mapping unchanged", () => {
  const hosts: Host[] = [{ names: ["web1"], identityFile: "~/.ssh/id_rsa", extras: [] }];
  const rewritten = rewriteIdentityFiles(hosts, new Map());
  expect(rewritten[0]?.identityFile).toBe("~/.ssh/id_rsa");
});

test("rewriteIdentityFiles leaves a host with no IdentityFile at all unchanged", () => {
  const hosts: Host[] = [{ names: ["web1"], extras: [] }];
  const rewritten = rewriteIdentityFiles(hosts, new Map([["/anything", "/other"]]));
  expect(rewritten[0]?.identityFile).toBeUndefined();
});

test("rewriteIdentityFiles does not mutate the input hosts array", () => {
  const original: Host[] = [{ names: ["web1"], identityFile: "/k/a.pem", extras: [] }];
  rewriteIdentityFiles(original, new Map([["/k/a.pem", "/tmp/x"]]));
  expect(original[0]?.identityFile).toBe("/k/a.pem");
});

test("splitTags trims, lowercases, drops empty entries and dedupes while keeping order", () => {
  expect(splitTags(" Alibaba, stage,,alibaba ")).toEqual(["alibaba", "stage"]);
});

test("filterByTags returns every host when the filter is empty", () => {
  const hosts: Host[] = [{ names: ["a"], tags: ["x"], extras: [] }, { names: ["b"], extras: [] }];
  expect(filterByTags(hosts, [])).toEqual(hosts);
});

test("filterByTags applies AND semantics across multiple tags", () => {
  const hosts: Host[] = [
    { names: ["a"], tags: ["alibaba", "stage"], extras: [] },
    { names: ["b"], tags: ["alibaba"], extras: [] },
  ];
  expect(filterByTags(hosts, ["alibaba", "stage"]).map((h) => h.names[0])).toEqual(["a"]);
});

test("filterByTags never matches a host with no tags against a non-empty filter", () => {
  const hosts: Host[] = [{ names: ["a"], extras: [] }];
  expect(filterByTags(hosts, ["stage"])).toEqual([]);
});

// filterByTags does not itself normalize its `tags` argument — an
// unnormalized filter value simply fails to equal any stored (lowercase,
// validated) tag, so it narrows to nothing rather than widening to everything.
test("filterByTags matches nothing for an unnormalized filter tag", () => {
  const hosts: Host[] = [{ names: ["a"], tags: ["stage"], extras: [] }];
  expect(filterByTags(hosts, ["Not Valid"])).toEqual([]);
});

test("setHostTags replaces the first matching host's tags without mutating the input array", () => {
  const hosts: Host[] = [{ names: ["a"], tags: ["old"], extras: [] }];
  const result = setHostTags(hosts, "a", ["new"]);
  expect(result).not.toBe(hosts);
  expect(result[0]?.tags).toEqual(["new"]);
  expect(hosts[0]?.tags).toEqual(["old"]);
});

test("setHostTags with an empty array removes the tags key entirely", () => {
  const hosts: Host[] = [{ names: ["a"], tags: ["old"], extras: [] }];
  const result = setHostTags(hosts, "a", []);
  expect(Object.prototype.hasOwnProperty.call(result[0], "tags")).toBe(false);
});
