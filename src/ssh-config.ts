export type Host = {
  names: string[];
  hostname?: string;
  port?: string;
  user?: string;
  identityFile?: string;
  proxyJump?: string;
  extras: Array<{ key: string; value: string }>;
};

export type ModeledField = "hostname" | "port" | "user" | "identityFile" | "proxyJump";

const MODELED_FIELDS: Record<string, ModeledField> = {
  hostname: "hostname",
  port: "port",
  user: "user",
  identityfile: "identityFile",
  proxyjump: "proxyJump",
};

// ssh executes these as programs; a hand-edited config carrying one must not
// turn `mssh <host>` into a launcher for arbitrary binaries. Guard consumers
// use the derived REFUSED_DIRECTIVES below, not this set directly.
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

// Include pulls in an arbitrary file parse() never sees — same outcome as
// EXECUTING_DIRECTIVES, different mechanism (redirection), kept separate but
// refused on every surface via the derived union below, not a second copy.
const CONFIG_REDIRECTING_DIRECTIVES = new Set(["include"]);

export const REFUSED_DIRECTIVES: ReadonlySet<string> = new Set([
  ...EXECUTING_DIRECTIVES,
  ...CONFIG_REDIRECTING_DIRECTIVES,
]);

// Takes an already-decoded value — each caller owns its own decoding, since
// parse(), assertSerializable() and rejectedFlags() legitimately differ on it.
// Folding decoding in here would widen the argv surface this guards.
export function isPermitLocalCommandNo(lowerKey: string, decodedValue: string | undefined): boolean {
  return lowerKey === "permitlocalcommand" && decodedValue?.toLowerCase() === "no";
}

// Rest-of-line raw values: no comment-stripping, no quote/escape decoding —
// RemoteCommand needs this even though it isn't in EXECUTING_DIRECTIVES.
const REST_OF_LINE_DIRECTIVES = new Set(["proxycommand", "localcommand", "remotecommand", "knownhostscommand"]);

// Rejects a value that would let serialize() emit a directive we didn't
// intend: a newline starts a new (attacker-controlled) directive line, `\r`
// survives into the file even though our own parse() strips it back out.
export function isValidFieldValue(value: string): boolean {
  return !/[\n\r]/.test(value);
}

// OpenSSH (8.7+) escapes `\` and `"` rather than rejecting them; anything
// else needing quoting (whitespace, `#`, a literal quote) is wrapped in one
// double-quoted token. Quoting never interferes with `~`/`%h`/`%r`/`%p`.
function formatValue(value: string): string {
  if (value !== "" && !/[\s#"'\\]/.test(value)) return value;
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

export function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

// Undefined when the token can't be a real ssh_config keyword — a quoted key
// normalizes to nothing rather than slipping past the deny-list. Shared by
// parse() and rejectedFlags() so both apply identical normalization.
export function normalizeDirectiveKey(rawKey: string): string | undefined {
  const unquoted = unquote(rawKey);
  return /^[A-Za-z0-9]+$/.test(unquoted) ? unquoted : undefined;
}

// OpenSSH's own strdelim() rules, verified against the real binary: `"`/`'`
// toggle quoting, `\` escapes only \ " ' or a literal space. Returns
// undefined on an unterminated quote, keeping serialize(parse(x)) total.
function decodeTokens(rest: string): string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let inToken = false;
  let quote: '"' | "'" | undefined;

  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i] as string;

    if (quote === undefined && (ch === " " || ch === "\t")) {
      if (inToken) {
        tokens.push(token);
        token = "";
        inToken = false;
      }
      continue;
    }

    inToken = true;

    if (ch === "\\") {
      const next = rest[i + 1];
      if (next === "\\" || next === '"' || next === "'" || next === " ") {
        token += next;
        i++;
        continue;
      }
      token += ch;
      continue;
    }

    if (quote === undefined && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }
    if (quote !== undefined && ch === quote) {
      quote = undefined;
      continue;
    }

    token += ch;
  }

  if (quote !== undefined) return undefined;
  if (inToken) tokens.push(token);
  return tokens;
}

// Decodes a directive's single value token (the five modeled fields are all
// single-token in ssh) — undefined for an unterminated quote, or when the
// remainder decodes to no token at all (e.g. it was entirely a comment).
export function decodeValue(rest: string): string | undefined {
  return decodeTokens(rest)?.[0];
}

// Cuts a trailing, unquoted, token-boundary comment off a raw remainder —
// `#` starts a comment only when unquoted and preceded by whitespace (or at
// the start). Mirrors decodeTokens' escape/quote handling so both agree.
export function stripComment(rest: string): string {
  let quote: '"' | "'" | undefined;
  let boundary = true;

  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i] as string;

    if (ch === "\\") {
      const next = rest[i + 1];
      if (next === "\\" || next === '"' || next === "'" || next === " ") i++;
      boundary = false;
      continue;
    }

    if (quote === undefined && (ch === '"' || ch === "'")) {
      quote = ch;
      boundary = false;
      continue;
    }
    if (quote !== undefined && ch === quote) {
      quote = undefined;
      boundary = false;
      continue;
    }

    if (quote === undefined && ch === "#" && boundary) {
      return rest.slice(0, i);
    }

    boundary = quote === undefined && (ch === " " || ch === "\t");
  }

  return rest;
}

// The `=`-form must be tried first: `\s+` alone would also match the leading
// space of " = value" and leave a literal "=" glued onto value.
function splitDirective(line: string): { key: string; rest: string } | undefined {
  const match = /^(\S+)(?:\s*=\s*|\s+)(\S.*)$/.exec(line);
  if (!match) return undefined;
  return { key: match[1] as string, rest: match[2] as string };
}

// A name with whitespace serializes as multiple patterns; an empty name
// serializes as a bare "Host" line whose directives attach to the prior host.
export function isValidHostName(name: string): boolean {
  return name !== "" && !/\s/.test(name);
}

// Intersection of three sinks' rules (config text, ssh argv, filename) —
// matches isValidKeyFilename's class. Applied only to newly typed aliases;
// isValidHostName stays permissive for configs that already exist.
export function isValidNewHostName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name) && !name.startsWith("-");
}

// ssh rejects out-of-range ports only at connect time, after the value is
// already sealed into the config — reject here instead.
export function isValidPort(value: string): boolean {
  if (!/^[0-9]+$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

export function hostLabel(host: Host): string {
  return host.names.join(" ");
}

export function hostHasName(host: Host, name: string): boolean {
  return host.names.includes(name);
}

// Every pattern across every host, minus ones containing a glob
// metacharacter — those are never a real, pickable alias.
export function connectableNames(hosts: Host[]): string[] {
  return hosts.flatMap((h) => h.names).filter((n) => !/[*?!]/.test(n));
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

    const split = splitDirective(line);
    if (split === undefined) continue;

    // An unclassifiable key (e.g. quoted or malformed) can't be checked
    // against the deny-list, so the whole line is dropped instead.
    const key = normalizeDirectiveKey(split.key);
    if (key === undefined) continue;
    const lowerKey = key.toLowerCase();

    if (lowerKey === "host") {
      const patterns = decodeTokens(stripComment(split.rest));
      // Ends the previous block just as Match does below — an unrepresentable
      // Host line's directives must not fall through to the prior host.
      if (patterns === undefined || patterns.length === 0) {
        current = undefined;
        continue;
      }
      current = { names: patterns, extras: [] };
      hosts.push(current);
      continue;
    }

    // mssh models no conditional directives, so nothing between Match and the
    // next Host may attach to the host preceding it — stricter than ssh.
    if (lowerKey === "match") {
      current = undefined;
      continue;
    }

    if (!current) continue;

    if (REFUSED_DIRECTIVES.has(lowerKey)) {
      // The only REFUSED_DIRECTIVES member that hardens rather than executes:
      // =no disables LocalCommand outright, so it carries no more risk than
      // omitting the directive. Only that exact value is let through.
      const stripped = stripComment(split.rest);
      if (isPermitLocalCommandNo(lowerKey, decodeValue(stripped))) {
        current.extras.push({ key, value: stripped.trimEnd() });
      }
      continue; // otherwise dropped, not modeled — see REFUSED_DIRECTIVES
    }

    if (REST_OF_LINE_DIRECTIVES.has(lowerKey)) {
      current.extras.push({ key, value: split.rest.trim() });
      continue;
    }

    const modeledField = MODELED_FIELDS[lowerKey];
    if (modeledField) {
      // ssh is first-wins on a duplicate directive; the model collapses each
      // of these five into one slot, so only the first value seen may set it.
      if (current[modeledField] === undefined) {
        const value = decodeValue(stripComment(split.rest));
        if (value !== undefined) current[modeledField] = value;
      }
    } else {
      // ssh's duplicate rule for extras is per-directive (some first-wins,
      // some accumulate) — every occurrence is kept in order regardless.
      current.extras.push({ key, value: stripComment(split.rest).trimEnd() });
    }
  }

  return hosts;
}

// Load-bearing: every Host from every caller passes through here before it
// reaches disk. This is the injection guard — do not remove it or assume
// prompt-site validation covers it.
function assertSerializable(host: Host): void {
  if (host.names.length === 0) {
    throw new Error("invalid host: no name patterns");
  }
  for (const name of host.names) {
    if (!isValidHostName(name)) {
      throw new Error(`invalid host name: ${JSON.stringify(name)}`);
    }
  }
  // "Host web1 web1" is accepted by ssh (the pattern simply matches twice)
  // but there is no reason to write one, and it would defeat the cross-host
  // check below by making a host collide with itself.
  if (new Set(host.names).size !== host.names.length) {
    throw new Error(`invalid host: duplicate name pattern in "${hostLabel(host)}"`);
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
      throw new Error(`invalid value for ${label} on host "${hostLabel(host)}"`);
    }
  }
  for (const extra of host.extras) {
    if (!isValidFieldValue(extra.key) || !isValidFieldValue(extra.value)) {
      throw new Error(`invalid value for ${extra.key} on host "${hostLabel(host)}"`);
    }
    const lowerExtraKey = extra.key.toLowerCase();
    if (REFUSED_DIRECTIVES.has(lowerExtraKey) && !isPermitLocalCommandNo(lowerExtraKey, decodeValue(extra.value))) {
      throw new Error(
        `refusing to write ${extra.key} on host "${hostLabel(host)}": it would make ssh execute a program or load an untracked file`,
      );
    }
    // extras are stored raw (unparsed) — this is the only check that a
    // programmatically-built extra (not one that came through parse()) is
    // actually loadable, i.e. its quoting is balanced.
    if (decodeValue(extra.value) === undefined) {
      throw new Error(`invalid quoting in ${extra.key} on host "${hostLabel(host)}"`);
    }
  }
}

// A duplicate resolves to a host mssh cannot represent; first-wins makes the
// later block permanently unreachable. Case-sensitive, matching ssh's own
// alias matching. Each host's own names are deduped before comparing.
export function duplicateAlias(hosts: Host[]): string | undefined {
  const seen = new Set<string>();
  for (const host of hosts) {
    for (const name of new Set(host.names)) {
      if (seen.has(name)) return name;
      seen.add(name);
    }
  }
  return undefined;
}

export function serialize(hosts: Host[]): string {
  const collision = duplicateAlias(hosts);
  if (collision !== undefined) {
    throw new Error(
      `refusing to write a config where alias "${collision}" is defined by more than one host: ` +
        `ssh would silently merge them and only the first is reachable from mssh`,
    );
  }

  const blocks = hosts.map((host) => {
    assertSerializable(host);

    const lines = [`Host ${hostLabel(host)}`];
    if (host.hostname !== undefined) lines.push(`  HostName ${formatValue(host.hostname)}`);
    if (host.port !== undefined) lines.push(`  Port ${formatValue(host.port)}`);
    if (host.user !== undefined) lines.push(`  User ${formatValue(host.user)}`);
    if (host.identityFile !== undefined) lines.push(`  IdentityFile ${formatValue(host.identityFile)}`);
    // Never quoted: ssh treats a quoted ProxyJump as a hard fatal
    // ("Invalid ProxyJump"), and a plain alias/destination never contains
    // [\s#"'\\] anyway, so formatValue would never quote it regardless.
    if (host.proxyJump !== undefined) lines.push(`  ProxyJump ${host.proxyJump}`);
    for (const extra of host.extras) {
      lines.push(`  ${extra.key} ${extra.value}`);
    }
    return lines.join("\n");
  });

  return blocks.join("\n\n") + (blocks.length > 0 ? "\n" : "");
}

export function addHost(hosts: Host[], host: Host): Host[] {
  const existing = new Set(hosts.flatMap((h) => h.names));
  const collision = host.names.find((n) => existing.has(n));
  if (collision !== undefined) {
    throw new Error(`Host "${collision}" already exists`);
  }
  return [...hosts, host];
}

// Matches ssh's first-wins across blocks. value: undefined clears the field
// back to unset (omitted on serialize), same convention as Host itself.
export function updateHostField(hosts: Host[], name: string, field: ModeledField, value: string | undefined): Host[] {
  let updated = false;
  return hosts.map((h) => {
    if (updated || !hostHasName(h, name)) return h;
    updated = true;
    return { ...h, [field]: value };
  });
}

export function deleteHost(hosts: Host[], name: string): Host[] {
  let removed = false;
  return hosts.filter((h) => {
    if (!removed && hostHasName(h, name)) {
      removed = true;
      return false;
    }
    return true;
  });
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

// Each named host plus every host reachable through ProxyJump. A host whose
// name contains a glob metacharacter or negation (`!x`) is always kept — ssh
// may apply it to a target not matched by name; mssh itself never creates one.
export function hostsForTarget(hosts: Host[], targets: string[]): Host[] {
  const byName = new Map<string, Host>();
  for (const h of hosts) {
    for (const pattern of h.names) {
      if (!byName.has(pattern)) byName.set(pattern, h);
    }
  }

  const keep = new Set<Host>();
  const visit = (name: string): void => {
    const host = byName.get(name);
    if (host === undefined || keep.has(host)) return;
    keep.add(host);
    if (host.proxyJump !== undefined) {
      for (const hop of proxyJumpAliases(host.proxyJump)) visit(hop);
    }
  };

  for (const target of targets) visit(target);

  return hosts.filter((h) => keep.has(h) || h.names.some((n) => /[*?!]/.test(n)));
}

export const KEEP_ALIVE_INTERVAL = "60";

// Stops a NAT/firewall idle timeout from silently dropping a session. Skipped
// when the host already carries the directive, so it stays idempotent.
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
