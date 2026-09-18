export type Host = {
  name: string;
  hostname?: string;
  port?: string;
  user?: string;
  identityFile?: string;
  proxyJump?: string;
  extras: Array<{ key: string; value: string }>; // unmodeled directives, verbatim (key spelling as written in source)
};

export type ModeledField = "hostname" | "port" | "user" | "identityFile" | "proxyJump";

// Keyed by lowercase for case-insensitive matching on parse.
const MODELED_FIELDS: Record<string, ModeledField> = {
  hostname: "hostname",
  port: "port",
  user: "user",
  identityfile: "identityFile",
  proxyjump: "proxyJump",
};

// ssh executes these as programs. A config that arrives carrying one (hand
// imported, hand edited) must not be able to turn `mssh <host>` into a
// launcher for arbitrary binaries. Exported so connect.ts's -o flag guard
// checks the same list rather than keeping a second copy that could drift.
export const EXECUTING_DIRECTIVES = new Set([
  "proxycommand",
  "localcommand",
  "permitlocalcommand",
  "knownhostscommand",
  "pkcs11provider",
  "securitykeyprovider",
  "xauthlocation",
  "proxyusefdpass",
  "match",
]);

// Rejects a value that would let serialize() emit a directive we didn't
// intend: a newline starts a new (attacker-controlled) directive line, `\r`
// survives into the file even though our own parse() strips it back out.
export function isValidFieldValue(value: string): boolean {
  return !/[\n\r]/.test(value);
}

// OpenSSH splits a directive value on whitespace unless it is double-quoted,
// and provides no escape for a `"` inside one — a value containing both cannot
// be represented, so the quote is dropped rather than emitting a directive ssh
// rejects as fatal at parse time.
function formatValue(value: string): string {
  const bare = value.replace(/"/g, "");
  return /\s/.test(bare) ? `"${bare}"` : bare;
}

export function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

// Host aliases are ssh patterns matched on their own line; a name containing
// whitespace serializes as multiple space-separated patterns (silently
// claiming extra aliases), and an empty name serializes as a bare "Host"
// line that fails to reparse as a Host line at all — its directives then
// attach to whichever host precedes it in the file.
export function isValidHostName(name: string): boolean {
  return name !== "" && !/\s/.test(name);
}

// Note: directives appearing before the first `Host` line (global config, e.g. `Include`,
// `ServerAliveInterval`) are not modeled and are discarded on parse — this tool owns and
// fully regenerates the config file, so it does not support a global preamble.
export function parse(text: string): Host[] {
  const hosts: Host[] = [];
  let current: Host | undefined;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    // OpenSSH accepts space, tab, or `=` (with optional surrounding
    // whitespace) between a directive's key and value. The `=`-form
    // alternative must be tried first: `\s+` alone would also match the
    // leading space of " = value" and leave a literal "=" glued onto value.
    const match = /^(\S+)(?:\s*=\s*|\s+)(\S.*)$/.exec(line);
    if (!match) continue;

    const key = match[1] as string;
    const value = unquote((match[2] as string).trim());

    if (key.toLowerCase() === "host") {
      current = { name: value, extras: [] };
      hosts.push(current);
      continue;
    }

    if (!current) continue;

    const lowerKey = key.toLowerCase();
    if (EXECUTING_DIRECTIVES.has(lowerKey)) continue; // dropped, not modeled — see EXECUTING_DIRECTIVES

    const modeledField = MODELED_FIELDS[lowerKey];
    if (modeledField) {
      current[modeledField] = value;
    } else {
      current.extras.push({ key, value });
    }
  }

  return hosts;
}

// Load-bearing: every Host from every caller passes through here before it
// reaches disk. This is the injection guard — do not remove it or assume
// prompt-site validation covers it.
function assertSerializable(host: Host): void {
  if (!isValidHostName(host.name)) {
    throw new Error(`invalid host name: ${JSON.stringify(host.name)}`);
  }
  const fields: Array<[string, string | undefined]> = [
    ["HostName", host.hostname],
    ["Port", host.port],
    ["User", host.user],
    ["IdentityFile", host.identityFile],
    ["ProxyJump", host.proxyJump],
  ];
  for (const [label, value] of fields) {
    if (value !== undefined && !isValidFieldValue(value)) {
      throw new Error(`invalid value for ${label} on host "${host.name}"`);
    }
  }
  for (const extra of host.extras) {
    if (!isValidFieldValue(extra.key) || !isValidFieldValue(extra.value)) {
      throw new Error(`invalid value for ${extra.key} on host "${host.name}"`);
    }
    if (EXECUTING_DIRECTIVES.has(extra.key.toLowerCase())) {
      throw new Error(`refusing to write ${extra.key} on host "${host.name}": it would make ssh execute a program`);
    }
  }
}

export function serialize(hosts: Host[]): string {
  const blocks = hosts.map((host) => {
    assertSerializable(host);

    const lines = [`Host ${host.name}`];
    if (host.hostname !== undefined) lines.push(`  HostName ${formatValue(host.hostname)}`);
    if (host.port !== undefined) lines.push(`  Port ${formatValue(host.port)}`);
    if (host.user !== undefined) lines.push(`  User ${formatValue(host.user)}`);
    if (host.identityFile !== undefined) lines.push(`  IdentityFile ${formatValue(host.identityFile)}`);
    if (host.proxyJump !== undefined) lines.push(`  ProxyJump ${formatValue(host.proxyJump)}`);
    for (const extra of host.extras) {
      lines.push(`  ${extra.key} ${formatValue(extra.value)}`);
    }
    return lines.join("\n");
  });

  return blocks.join("\n\n") + (blocks.length > 0 ? "\n" : "");
}

export function addHost(hosts: Host[], host: Host): Host[] {
  if (hosts.some((h) => h.name === host.name)) {
    throw new Error(`Host "${host.name}" already exists`);
  }
  return [...hosts, host];
}

// value: undefined clears the field back to unset (omitted on serialize),
// same convention as Host itself.
export function updateHostField(hosts: Host[], name: string, field: ModeledField, value: string | undefined): Host[] {
  return hosts.map((h) => (h.name === name ? { ...h, [field]: value } : h));
}

export function deleteHost(hosts: Host[], name: string): Host[] {
  return hosts.filter((h) => h.name !== name);
}

export function hostsWithoutProxyJump(hosts: Host[]): Host[] {
  return hosts.filter((h) => h.proxyJump === undefined);
}

// A ProxyJump value is an ssh destination, not necessarily a bare alias:
// `user@bastion:2222` and comma-separated chains are both legal. mssh only
// ever writes a plain alias, but a hand-imported config may carry either.
export function proxyJumpAliases(value: string): string[] {
  return value
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "")
    .map((hop) => {
      const afterUser = hop.slice(hop.lastIndexOf("@") + 1);
      const colon = afterUser.lastIndexOf(":");
      return colon === -1 ? afterUser : afterUser.slice(0, colon);
    });
}

// The subset of the config ssh actually needs to reach `targets`: each named
// host plus every host reachable from it through ProxyJump. Order is
// preserved so the serialized output stays diff-stable.
//
// A host whose name contains a glob metacharacter is always kept: ssh may
// apply it to a target we did not match by name, and dropping it would break
// a working connection. mssh itself never creates one.
export function hostsForTarget(hosts: Host[], targets: string[]): Host[] {
  const byName = new Map(hosts.map((h) => [h.name, h]));
  const keep = new Set<string>();

  const visit = (name: string): void => {
    if (keep.has(name)) return;
    const host = byName.get(name);
    if (host === undefined) return;
    keep.add(name);
    if (host.proxyJump !== undefined) {
      for (const hop of proxyJumpAliases(host.proxyJump)) visit(hop);
    }
  };

  for (const target of targets) visit(target);

  return hosts.filter((h) => keep.has(h.name) || /[*?]/.test(h.name));
}

export const KEEP_ALIVE_INTERVAL = "60";

// Stops a NAT/firewall idle timeout from silently dropping a session. Skipped
// when the host already carries the directive, so a value set by hand (or by
// an earlier save) is never overwritten and never duplicated — this runs on
// every save and every connect, so it must be idempotent.
export function withKeepAlive(hosts: Host[]): Host[] {
  return hosts.map((host) => {
    if (host.extras.some((e) => e.key.toLowerCase() === "serveraliveinterval")) return host;
    return { ...host, extras: [...host.extras, { key: "ServerAliveInterval", value: KEEP_ALIVE_INTERVAL }] };
  });
}

// Shared by add/edit prompt flows: blank prompt input means "leave this
// optional field unset" rather than storing an empty string directive.
export function emptyToUndefined(value: string): string | undefined {
  return value === "" ? undefined : value;
}
