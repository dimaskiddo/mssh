import { test, expect } from "bun:test";
import {
  parse,
  serialize,
  addHost,
  updateHostField,
  deleteHost,
  hostsWithoutProxyJump,
  isValidFieldValue,
  isValidHostName,
  proxyJumpAliases,
  hostsForTarget,
  withKeepAlive,
  KEEP_ALIVE_INTERVAL,
  unquote,
  EXECUTING_DIRECTIVES,
  type Host,
} from "../src/ssh-config";

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

test("parse extracts fields from a multi-host config text", () => {
  const hosts = parse(SAMPLE);
  expect(hosts).toHaveLength(2);

  const myserver = hosts.find((h) => h.name === "myserver");
  expect(myserver).toBeDefined();
  expect(myserver?.hostname).toBe("1.2.3.4");
  expect(myserver?.port).toBe("2222");
  expect(myserver?.user).toBe("root");
  expect(myserver?.identityFile).toBe("~/.ssh/id_rsa");
  expect(myserver?.proxyJump).toBe("jumpbox");

  const jumpbox = hosts.find((h) => h.name === "jumpbox");
  expect(jumpbox).toBeDefined();
  expect(jumpbox?.hostname).toBe("5.6.7.8");
  expect(jumpbox?.user).toBe("admin");
  expect(jumpbox?.port).toBeUndefined();
  expect(jumpbox?.proxyJump).toBeUndefined();
});

test("serialize(parse(text)) round-trip is stable for known fields", () => {
  const hosts = parse(SAMPLE);
  const reparsed = parse(serialize(hosts));
  expect(reparsed).toEqual(hosts);
});

test("extras (unmodeled directive) survives a parse -> serialize -> parse round-trip", () => {
  const text = `Host myserver
  HostName 1.2.3.4
  IdentitiesOnly yes
  ServerAliveInterval 60
`;
  const hosts = parse(text);
  const host = hosts[0];
  expect(host).toBeDefined();
  expect(host?.extras).toEqual([
    { key: "IdentitiesOnly", value: "yes" },
    { key: "ServerAliveInterval", value: "60" },
  ]);

  const reparsed = parse(serialize(hosts));
  expect(reparsed).toEqual(hosts);
});

test("parse drops ProxyCommand instead of carrying it into extras", () => {
  const text = `Host myserver
  HostName 1.2.3.4
  ProxyCommand ssh -W %h:%p bastion
`;
  const hosts = parse(text);
  expect(hosts[0]?.extras).toEqual([]);
  expect(hosts[0]?.hostname).toBe("1.2.3.4");
});

test("parse drops Match case-insensitively, since mssh models no Match support at all", () => {
  const text = `Host myserver
  HostName 1.2.3.4

match exec "id"
  HostName should-not-attach-here
`;
  const hosts = parse(text);
  expect(hosts).toHaveLength(1);
  expect(hosts[0]?.extras).toEqual([]);
});

test("parse keeps a safe extra alongside a dropped command-executing directive", () => {
  const text = `Host myserver
  HostName 1.2.3.4
  LocalCommand id
  Compression yes
`;
  const hosts = parse(text);
  expect(hosts[0]?.extras).toEqual([{ key: "Compression", value: "yes" }]);
});

test("serialize throws when a Host's extras carry a deny-listed directive", () => {
  const host: Host = {
    name: "myserver",
    extras: [{ key: "ProxyCommand", value: "id" }],
  };
  expect(() => serialize([host])).toThrow(/refusing to write/i);
});

test("EXECUTING_DIRECTIVES matches lowercase keys only, as parse/serialize both lowercase before checking", () => {
  for (const key of EXECUTING_DIRECTIVES) {
    expect(key).toBe(key.toLowerCase());
  }
});

test("addHost appends a new host and returns a new array", () => {
  const hosts = parse(SAMPLE);
  const newHost: Host = { name: "newone", extras: [] };
  const result = addHost(hosts, newHost);

  expect(result).not.toBe(hosts);
  expect(result).toHaveLength(3);
  expect(hosts).toHaveLength(2);
  expect(result.find((h) => h.name === "newone")).toEqual(newHost);
});

test("addHost throws when the host name already exists", () => {
  const hosts = parse(SAMPLE);
  expect(() => addHost(hosts, { name: "myserver", extras: [] })).toThrow();
});

test("updateHostField changes one field on the named host without touching others", () => {
  const hosts = parse(SAMPLE);
  const result = updateHostField(hosts, "myserver", "hostname", "9.9.9.9");

  expect(result).not.toBe(hosts);
  const updated = result.find((h) => h.name === "myserver");
  expect(updated?.hostname).toBe("9.9.9.9");
  expect(updated?.port).toBe("2222");
  expect(updated?.user).toBe("root");

  const original = hosts.find((h) => h.name === "myserver");
  expect(original?.hostname).toBe("1.2.3.4");

  const jumpbox = result.find((h) => h.name === "jumpbox");
  expect(jumpbox).toEqual(hosts.find((h) => h.name === "jumpbox"));
});

test("deleteHost removes the named host and returns a new array with one fewer entry", () => {
  const hosts = parse(SAMPLE);
  const result = deleteHost(hosts, "jumpbox");

  expect(result).not.toBe(hosts);
  expect(result).toHaveLength(1);
  expect(hosts).toHaveLength(2);
  expect(result.find((h) => h.name === "jumpbox")).toBeUndefined();
  expect(result.find((h) => h.name === "myserver")).toBeDefined();
});

test("hostsWithoutProxyJump returns only hosts whose proxyJump field is unset", () => {
  const hosts = parse(SAMPLE);
  const result = hostsWithoutProxyJump(hosts);

  expect(result).toHaveLength(1);
  expect(result[0]?.name).toBe("jumpbox");
});

test("parse accepts tab- and =-separated directives, matching OpenSSH", () => {
  const text = "Host myserver\n\tHostName 1.2.3.4\n  Port=2222\n  User = admin\n";
  const hosts = parse(text);
  expect(hosts).toHaveLength(1);
  expect(hosts[0]?.hostname).toBe("1.2.3.4");
  expect(hosts[0]?.port).toBe("2222");
  expect(hosts[0]?.user).toBe("admin");
});

test("isValidFieldValue rejects newlines and carriage returns", () => {
  expect(isValidFieldValue("plain-value")).toBe(true);
  expect(isValidFieldValue("h\n  ProxyCommand touch /tmp/pwned")).toBe(false);
  expect(isValidFieldValue("value\rwith-cr")).toBe(false);
});

test("isValidHostName rejects empty and whitespace-containing names", () => {
  expect(isValidHostName("web1")).toBe(true);
  expect(isValidHostName("")).toBe(false);
  expect(isValidHostName("web 1")).toBe(false);
  expect(isValidHostName("web\t1")).toBe(false);
});

test("serialize throws instead of emitting a newline-injected value as a real directive", () => {
  const hosts: Host[] = [{ name: "web1", hostname: "h\n  ProxyCommand touch /tmp/pwned", extras: [] }];
  expect(() => serialize(hosts)).toThrow();
});

test("serialize throws on an invalid host name rather than emitting a corrupt Host line", () => {
  const hosts: Host[] = [{ name: "", extras: [] }];
  expect(() => serialize(hosts)).toThrow();
});

test("serialize throws when an extras directive carries an injected newline", () => {
  const hosts: Host[] = [{ name: "web1", extras: [{ key: "ServerAliveInterval", value: "60\nProxyCommand id" }] }];
  expect(() => serialize(hosts)).toThrow();
});

test("comment lines and blank lines in the input text are ignored by parse", () => {
  const text = `# this is a top-level comment

Host myserver
  # a comment inside a host block
  HostName 1.2.3.4

  # another comment
  User root

Host jumpbox
  HostName 5.6.7.8
`;
  const hosts = parse(text);
  expect(hosts).toHaveLength(2);

  const myserver = hosts.find((h) => h.name === "myserver");
  expect(myserver?.hostname).toBe("1.2.3.4");
  expect(myserver?.user).toBe("root");
  expect(myserver?.extras).toEqual([]);

  const jumpbox = hosts.find((h) => h.name === "jumpbox");
  expect(jumpbox?.hostname).toBe("5.6.7.8");
  expect(jumpbox?.extras).toEqual([]);
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
  expect(result.map((h) => h.name)).toEqual(["jumpbox"]);
});

test("hostsForTarget pulls in a one-hop ProxyJump chain", () => {
  const hosts = parse(SAMPLE);
  const result = hostsForTarget(hosts, ["myserver"]);
  expect(result.map((h) => h.name).sort()).toEqual(["jumpbox", "myserver"]);
});

test("hostsForTarget pulls in a two-hop ProxyJump chain", () => {
  const hosts: Host[] = [
    { name: "target", proxyJump: "mid", extras: [] },
    { name: "mid", proxyJump: "edge", extras: [] },
    { name: "edge", extras: [] },
    { name: "unrelated", extras: [] },
  ];
  const result = hostsForTarget(hosts, ["target"]);
  expect(result.map((h) => h.name)).toEqual(["target", "mid", "edge"]);
});

test("hostsForTarget terminates on a ProxyJump cycle instead of looping forever", () => {
  const hosts: Host[] = [
    { name: "a", proxyJump: "b", extras: [] },
    { name: "b", proxyJump: "a", extras: [] },
  ];
  const result = hostsForTarget(hosts, ["a"]);
  expect(result.map((h) => h.name).sort()).toEqual(["a", "b"]);
});

test("hostsForTarget preserves source order and keeps a glob-named host", () => {
  const hosts: Host[] = [
    { name: "web*", extras: [] },
    { name: "target", extras: [] },
    { name: "other", extras: [] },
  ];
  const result = hostsForTarget(hosts, ["target"]);
  expect(result.map((h) => h.name)).toEqual(["web*", "target"]);
});

test("hostsForTarget returns an empty array for an unknown target", () => {
  const hosts = parse(SAMPLE);
  expect(hostsForTarget(hosts, ["nope"])).toEqual([]);
});

test("withKeepAlive appends ServerAliveInterval to a host with no extras", () => {
  const hosts: Host[] = [{ name: "web1", extras: [] }];
  expect(withKeepAlive(hosts)[0]?.extras).toEqual([{ key: "ServerAliveInterval", value: KEEP_ALIVE_INTERVAL }]);
});

test("withKeepAlive is idempotent across repeated applications", () => {
  const hosts: Host[] = [{ name: "web1", extras: [] }];
  const once = withKeepAlive(hosts);
  const twice = withKeepAlive(once);
  expect(twice).toEqual(once);
});

test("withKeepAlive leaves an existing ServerAliveInterval (any case) untouched", () => {
  const hosts: Host[] = [{ name: "web1", extras: [{ key: "serveraliveinterval", value: "30" }] }];
  expect(withKeepAlive(hosts)[0]?.extras).toEqual([{ key: "serveraliveinterval", value: "30" }]);
});

test("serialize double-quotes a value containing a space", () => {
  const hosts: Host[] = [
    {
      name: "jump",
      identityFile: "/home/My User/.mssh/keys/jump.pem",
      extras: [{ key: "RemoteCommand", value: "some command" }],
    },
  ];
  const text = serialize(hosts);
  expect(text).toContain('IdentityFile "/home/My User/.mssh/keys/jump.pem"');
  expect(text).toContain('RemoteCommand "some command"');
});

test("serialize leaves a space-free value unquoted", () => {
  const hosts: Host[] = [{ name: "web1", identityFile: "/home/user/.ssh/id_rsa", extras: [] }];
  expect(serialize(hosts)).toContain("IdentityFile /home/user/.ssh/id_rsa");
});

test("parse strips surrounding double quotes from a value", () => {
  const hosts = parse('Host web1\n  IdentityFile "/a b/k.pem"\n');
  expect(hosts[0]?.identityFile).toBe("/a b/k.pem");
});

test("a space-bearing path survives serialize -> parse -> serialize without accumulating quotes", () => {
  const hosts: Host[] = [{ name: "web1", identityFile: "/a b/k.pem", extras: [] }];
  const first = serialize(hosts);
  const second = serialize(parse(first));
  expect(second).toBe(first);
  expect(second.match(/"/g)?.length).toBe(2);
});

test("serialize drops a literal quote character from a value", () => {
  const hosts: Host[] = [{ name: "web1", identityFile: '/a"b/k.pem', extras: [] }];
  expect(serialize(hosts)).toContain("IdentityFile /ab/k.pem");
});

test("unquote leaves an unquoted value untouched", () => {
  expect(unquote("plain")).toBe("plain");
  expect(unquote('"')).toBe('"');
});
