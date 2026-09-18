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
  isValidNewHostName,
  isValidPort,
  proxyJumpAliases,
  hostsForTarget,
  withKeepAlive,
  KEEP_ALIVE_INTERVAL,
  unquote,
  normalizeDirectiveKey,
  decodeValue,
  stripComment,
  hostLabel,
  hostHasName,
  connectableNames,
  duplicateAlias,
  EXECUTING_DIRECTIVES,
  REFUSED_DIRECTIVES,
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

  const myserver = hosts.find((h) => hostHasName(h, "myserver"));
  expect(myserver).toBeDefined();
  expect(myserver?.hostname).toBe("1.2.3.4");
  expect(myserver?.port).toBe("2222");
  expect(myserver?.user).toBe("root");
  expect(myserver?.identityFile).toBe("~/.ssh/id_rsa");
  expect(myserver?.proxyJump).toBe("jumpbox");

  const jumpbox = hosts.find((h) => hostHasName(h, "jumpbox"));
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
  // The audit gap this test used to miss: asserting only length/extras let a
  // Match block's directives silently attach to the PRECEDING host's fields
  // pass undetected, since HostName isn't stored in extras at all.
  expect(hosts[0]?.hostname).toBe("1.2.3.4");
  expect(hosts[0]?.extras).toEqual([]);
});

test("directives after a Match block do not attach to the host preceding it, even without a Host line to end the block", () => {
  const text = `Host myserver
  HostName 1.2.3.4

Match host foo
  ProxyJump should-not-attach
  ServerAliveCountMax 99
`;
  const hosts = parse(text);
  expect(hosts).toHaveLength(1);
  expect(hosts[0]?.proxyJump).toBeUndefined();
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
    names: ["myserver"],
    extras: [{ key: "ProxyCommand", value: "id" }],
  };
  expect(() => serialize([host])).toThrow(/refusing to write/i);
});

test("EXECUTING_DIRECTIVES matches lowercase keys only, as parse/serialize both lowercase before checking", () => {
  for (const key of EXECUTING_DIRECTIVES) {
    expect(key).toBe(key.toLowerCase());
  }
});

test("normalizeDirectiveKey unquotes a wrapped key and rejects a malformed one", () => {
  expect(normalizeDirectiveKey("ProxyCommand")).toBe("ProxyCommand");
  expect(normalizeDirectiveKey('"ProxyCommand"')).toBe("ProxyCommand");
  expect(normalizeDirectiveKey('Pro"xy"Command')).toBeUndefined();
  expect(normalizeDirectiveKey("Proxy\\Command")).toBeUndefined();
});

test("parse drops a directive whose key is quoted, instead of letting it dodge the deny-list", () => {
  const text = `Host myserver
  HostName 1.2.3.4
  "ProxyCommand" id
`;
  const hosts = parse(text);
  expect(hosts[0]?.extras).toEqual([]);
  expect(hosts[0]?.hostname).toBe("1.2.3.4");
});

test("parse drops a directive whose key is not a syntactically valid ssh_config keyword", () => {
  const text = `Host myserver
  HostName 1.2.3.4
  Pro"xy"Command id
`;
  const hosts = parse(text);
  expect(hosts[0]?.extras).toEqual([]);
});

test("parse drops Include, the same as any other refused directive", () => {
  const text = `Host myserver
  HostName 1.2.3.4
  Include /tmp/evil
`;
  const hosts = parse(text);
  expect(hosts[0]?.extras).toEqual([]);
  expect(hosts[0]?.hostname).toBe("1.2.3.4");
});

test("REFUSED_DIRECTIVES is a superset of EXECUTING_DIRECTIVES plus Include", () => {
  for (const key of EXECUTING_DIRECTIVES) {
    expect(REFUSED_DIRECTIVES.has(key)).toBe(true);
  }
  expect(REFUSED_DIRECTIVES.has("include")).toBe(true);
});

test("serialize throws when a Host's extras carry Include, not just an executing directive", () => {
  const host: Host = {
    names: ["myserver"],
    extras: [{ key: "Include", value: "/tmp/evil" }],
  };
  expect(() => serialize([host])).toThrow(/refusing to write/i);
});

test("parse keeps PermitLocalCommand=no, the one deny-listed directive that hardens rather than executes", () => {
  const text = `Host myserver
  HostName 1.2.3.4
  PermitLocalCommand no
`;
  const hosts = parse(text);
  expect(hosts[0]?.extras).toEqual([{ key: "PermitLocalCommand", value: "no" }]);
});

test("parse still drops PermitLocalCommand=yes, which enables LocalCommand", () => {
  const text = `Host myserver
  HostName 1.2.3.4
  PermitLocalCommand yes
`;
  const hosts = parse(text);
  expect(hosts[0]?.extras).toEqual([]);
});

test("serialize round-trips a Host carrying PermitLocalCommand=no instead of throwing", () => {
  const host: Host = {
    names: ["myserver"],
    extras: [{ key: "PermitLocalCommand", value: "no" }],
  };
  expect(serialize([host])).toContain("PermitLocalCommand no");
});

test("serialize still throws when a Host's extras carry PermitLocalCommand=yes", () => {
  const host: Host = {
    names: ["myserver"],
    extras: [{ key: "PermitLocalCommand", value: "yes" }],
  };
  expect(() => serialize([host])).toThrow(/refusing to write/i);
});

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
  const hosts: Host[] = [{ names: ["web1"], hostname: "h\n  ProxyCommand touch /tmp/pwned", extras: [] }];
  expect(() => serialize(hosts)).toThrow();
});

test("serialize throws on an invalid host pattern rather than emitting a corrupt Host line", () => {
  const hosts: Host[] = [{ names: [""], extras: [] }];
  expect(() => serialize(hosts)).toThrow();
});

test("serialize throws when a Host has no name patterns at all", () => {
  const hosts: Host[] = [{ names: [], extras: [] }];
  expect(() => serialize(hosts)).toThrow();
});

test("serialize throws when an extras directive carries an injected newline", () => {
  const hosts: Host[] = [{ names: ["web1"], extras: [{ key: "ServerAliveInterval", value: "60\nProxyCommand id" }] }];
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

  const myserver = hosts.find((h) => hostHasName(h, "myserver"));
  expect(myserver?.hostname).toBe("1.2.3.4");
  expect(myserver?.user).toBe("root");
  expect(myserver?.extras).toEqual([]);

  const jumpbox = hosts.find((h) => hostHasName(h, "jumpbox"));
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

test("serialize double-quotes a modeled field's value containing a space", () => {
  const hosts: Host[] = [{ names: ["jump"], identityFile: "/home/My User/.mssh/keys/jump.pem", extras: [] }];
  const text = serialize(hosts);
  expect(text).toContain('IdentityFile "/home/My User/.mssh/keys/jump.pem"');
});

test("serialize emits an extra's raw value verbatim, with no quoting added", () => {
  const hosts: Host[] = [{ names: ["jump"], extras: [{ key: "RemoteCommand", value: "some command" }] }];
  const text = serialize(hosts);
  expect(text).toContain("RemoteCommand some command");
  expect(text).not.toContain('"');
});

test("SendEnv with two names round-trips verbatim instead of merging into one quoted value", () => {
  const text = "Host web1\n  SendEnv LANG LC_ALL\n";
  const hosts = parse(text);
  expect(hosts[0]?.extras).toEqual([{ key: "SendEnv", value: "LANG LC_ALL" }]);
  expect(serialize(hosts)).toContain("SendEnv LANG LC_ALL");
  expect(serialize(hosts)).not.toContain('"');
});

test("a duplicate extras directive accumulates instead of collapsing to one, since ssh's own duplicate rule is per-directive", () => {
  const text = "Host web1\n  IdentityFile ~/.ssh/id_a\n  CertificateFile ~/.ssh/id_a.pem\n  CertificateFile ~/.ssh/id_b.pem\n";
  const hosts = parse(text);
  expect(hosts[0]?.extras).toEqual([
    { key: "CertificateFile", value: "~/.ssh/id_a.pem" },
    { key: "CertificateFile", value: "~/.ssh/id_b.pem" },
  ]);
});

test("serialize leaves a space-free value unquoted", () => {
  const hosts: Host[] = [{ names: ["web1"], identityFile: "/home/user/.ssh/id_rsa", extras: [] }];
  expect(serialize(hosts)).toContain("IdentityFile /home/user/.ssh/id_rsa");
});

test("parse strips surrounding double quotes from a value", () => {
  const hosts = parse('Host web1\n  IdentityFile "/a b/k.pem"\n');
  expect(hosts[0]?.identityFile).toBe("/a b/k.pem");
});

test("a space-bearing path survives serialize -> parse -> serialize without accumulating quotes", () => {
  const hosts: Host[] = [{ names: ["web1"], identityFile: "/a b/k.pem", extras: [] }];
  const first = serialize(hosts);
  const second = serialize(parse(first));
  expect(second).toBe(first);
  expect(second.match(/"/g)?.length).toBe(2);
});

test("formatValue escapes a literal quote inside a value instead of dropping it", () => {
  const hosts: Host[] = [{ names: ["web1"], identityFile: '/a"b/k.pem', extras: [] }];
  const text = serialize(hosts);
  expect(text).toContain('IdentityFile "/a\\"b/k.pem"');
  // The old, lossy behavior made /a"b/k.pem and /ab/k.pem indistinguishable
  // on disk, silently repointing IdentityFile at a different file.
  expect(parse(text)[0]?.identityFile).toBe('/a"b/k.pem');
});

test("formatValue round-trip table, validated against real OpenSSH's IdentityFile parsing", () => {
  const rows: Array<[string, string]> = [
    ["a b", '"a b"'],
    ["C:\\keys\\", '"C:\\\\keys\\\\"'],
    ['/a"b', '"/a\\"b"'],
    ["#x", '"#x"'],
    // Any '#' triggers quoting, not just a boundary one — over-quoting a
    // mid-token '#' is safe (it still round-trips) and simpler than
    // tracking token-boundary position just to decide when to quote.
    ["a#b", '"a#b"'],
    ["~/.ssh/k", "~/.ssh/k"],
  ];
  for (const [value, expected] of rows) {
    const text = serialize([{ names: ["h"], identityFile: value, extras: [] }]);
    expect(text).toContain(`IdentityFile ${expected}`);
    expect(parse(text)[0]?.identityFile).toBe(value);
  }
});

test("ProxyJump is never quoted, even though it is never a value that would otherwise be safe to quote", () => {
  // A quoted ProxyJump ("user@a:22") is a hard fatal in real ssh
  // ("Invalid ProxyJump"). A plain alias never contains [\s#"'\\] so
  // formatValue would never quote it anyway, but this pins the guarantee.
  const text = serialize([{ names: ["h"], proxyJump: "bastion", extras: [] }]);
  expect(text).toContain("ProxyJump bastion");
  expect(text).not.toContain('"');
});

test("a trailing backslash in a path does not corrupt into an invalid-quotes value that bricks every later parse", () => {
  const hosts: Host[] = [{ names: ["h"], identityFile: "C:\\keys\\", extras: [] }];
  const text = serialize(hosts);
  expect(() => parse(text)).not.toThrow();
  expect(parse(text)[0]?.identityFile).toBe("C:\\keys\\");
});

test("unquote leaves an unquoted value untouched", () => {
  expect(unquote("plain")).toBe("plain");
  expect(unquote('"')).toBe('"');
});

test("stripComment cuts an unquoted, token-boundary comment", () => {
  expect(stripComment("bob # c")).toBe("bob ");
  expect(stripComment("bob#c")).toBe("bob#c");
  expect(stripComment('"bob"#c')).toBe('"bob"#c');
  expect(stripComment('"#x"')).toBe('"#x"');
});

test("decodeValue applies OpenSSH's escape rules", () => {
  expect(decodeValue("a\\b")).toBe("a\\b");
  expect(decodeValue("a\\\\b")).toBe("a\\b");
  expect(decodeValue('a\\"b')).toBe('a"b');
  expect(decodeValue("a\\ b")).toBe("a b");
  expect(decodeValue("a\\tb")).toBe("a\\tb");
});

test("decodeValue returns undefined for an unterminated quote", () => {
  expect(decodeValue('"unterminated')).toBeUndefined();
});

test("a directive with an unterminated quote is dropped rather than corrupting the host", () => {
  const text = 'Host web1\n  HostName "1.2.3.4\n  User root\n';
  const hosts = parse(text);
  expect(hosts[0]?.hostname).toBeUndefined();
  expect(hosts[0]?.user).toBe("root");
});

test("duplicate modeled-field directives are first-wins, matching ssh's own behavior", () => {
  const text = "Host web1\n  HostName first\n  HostName second\n";
  expect(parse(text)[0]?.hostname).toBe("first");
});

test("Host with multiple space-separated patterns parses into one Host with all of them, in source order", () => {
  const hosts = parse("Host web1 web2\n  HostName 1.2.3.4\n");
  expect(hosts).toHaveLength(1);
  expect(hosts[0]?.names).toEqual(["web1", "web2"]);
});

test("Host web1 web2 previously write-locked the config; it now round-trips and re-saves cleanly", () => {
  const hosts = parse("Host web1 web2\n  HostName 1.2.3.4\n");
  expect(() => serialize(hosts)).not.toThrow();
  expect(serialize(hosts)).toContain("Host web1 web2");
});

test("Host * !b (a wildcard with a negation) round-trips losslessly", () => {
  const hosts = parse("Host * !b\n  Compression yes\n");
  expect(hosts[0]?.names).toEqual(["*", "!b"]);
  const reparsed = parse(serialize(hosts));
  expect(reparsed).toEqual(hosts);
});

test("a bare Host line with no pattern is dropped rather than producing an empty-named host", () => {
  const hosts = parse("Host\n  HostName 1.2.3.4\n");
  expect(hosts).toHaveLength(0);
});

test("serialize(parse(x)) never throws, for host patterns ssh itself would also reject", () => {
  const inputs = [
    'Host a"b\n  HostName 1.2.3.4\n',
    "Host a\\b\n  HostName 1.2.3.4\n",
    "Host\n  HostName 1.2.3.4\n",
    "Host web1 web2\n  HostName 1.2.3.4\n",
    "Host * !b\n  Compression yes\n",
  ];
  for (const input of inputs) {
    expect(() => serialize(parse(input))).not.toThrow();
  }
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

test("isValidNewHostName accepts the ASCII allowlist", () => {
  expect(isValidNewHostName("web1")).toBe(true);
  expect(isValidNewHostName("web1.internal")).toBe(true);
  expect(isValidNewHostName("jump-box_2")).toBe(true);
});

test("isValidNewHostName rejects anything outside the allowlist, including glob/argv/path metacharacters", () => {
  expect(isValidNewHostName("")).toBe(false);
  expect(isValidNewHostName("#x")).toBe(false);
  expect(isValidNewHostName('a"b')).toBe(false);
  expect(isValidNewHostName("*")).toBe(false);
  expect(isValidNewHostName("!x")).toBe(false);
  expect(isValidNewHostName("we b")).toBe(false);
  expect(isValidNewHostName("-oProxyCommand=id")).toBe(false);
  expect(isValidNewHostName("-F")).toBe(false);
  expect(isValidNewHostName("../evil")).toBe(false);
  expect(isValidNewHostName(".")).toBe(false);
  expect(isValidNewHostName("..")).toBe(false);
  expect(isValidNewHostName("user@host")).toBe(false);
  expect(isValidNewHostName("café")).toBe(false);
});

test("isValidPort accepts in-range integers", () => {
  expect(isValidPort("1")).toBe(true);
  expect(isValidPort("22")).toBe(true);
  expect(isValidPort("2222")).toBe(true);
  expect(isValidPort("65535")).toBe(true);
});

test("isValidPort rejects out-of-range, non-numeric, and malformed values", () => {
  expect(isValidPort("")).toBe(false);
  expect(isValidPort("0")).toBe(false);
  expect(isValidPort("-1")).toBe(false);
  expect(isValidPort("65536")).toBe(false);
  expect(isValidPort("99999")).toBe(false);
  expect(isValidPort("abc")).toBe(false);
  expect(isValidPort("22 ")).toBe(false);
  expect(isValidPort("2.2")).toBe(false);
  expect(isValidPort("０２２")).toBe(false); // full-width digits — Number() would otherwise coerce these
});

test("parse does not leak a dropped Host's directives into the preceding host", () => {
  const hosts = parse("Host web1\n  HostName web1.internal\nHost #x\n  SendEnv LEAKED\n");
  expect(hosts).toEqual([{ names: ["web1"], hostname: "web1.internal", extras: [] }]);
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

test("serialize throws when two hosts share an alias, and names it", () => {
  const hosts: Host[] = [{ names: ["web1"], extras: [] }, { names: ["web1"], extras: [] }];
  expect(() => serialize(hosts)).toThrow(/alias "web1" is defined by more than one host/);
});

test("serialize throws when a single host repeats a name pattern", () => {
  const hosts: Host[] = [{ names: ["web1", "web1"], extras: [] }];
  expect(() => serialize(hosts)).toThrow(/duplicate name pattern/);
});

test("serialize still accepts a legitimate multi-pattern host with distinct names", () => {
  const hosts: Host[] = [{ names: ["web1", "web1-alt"], extras: [] }];
  expect(() => serialize(hosts)).not.toThrow();
});

test("serialize accepts the result of deleteHost repairing a duplicate-bearing config — delete stays a working escape hatch", () => {
  const dup = parse("Host web1\n  HostName first.example\n\nHost web1\n  HostName second.example\n");
  const repaired = deleteHost(dup, "web1");
  expect(repaired).toHaveLength(1);
  expect(() => serialize(repaired)).not.toThrow();
});

test("parse stays permissive: it returns both blocks for a duplicate-alias config, unlike the strict serialize", () => {
  const dup = parse("Host web1\n  HostName first.example\n\nHost web1\n  HostName second.example\n");
  expect(dup).toHaveLength(2);
});
