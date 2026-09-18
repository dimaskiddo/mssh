export type Host = {
  names: string[]; // >= 1 ssh pattern, source order — a Host line can name several
  hostname?: string;
  port?: string;
  user?: string;
  identityFile?: string;
  proxyJump?: string;
  extras: Array<{ key: string; value: string }>; // unmodeled directives, raw remainder verbatim (key spelling as written in source)
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
// launcher for arbitrary binaries. Guard consumers use the derived
// REFUSED_DIRECTIVES below, not this set directly — see there.
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

// Include pulls in an arbitrary file whose contents parse() never sees, which
// reaches the same outcome as EXECUTING_DIRECTIVES indirectly. Kept as a
// separate set (rather than folded into EXECUTING_DIRECTIVES) because its
// mechanism is different — redirection, not execution — but it must be
// refused on every surface EXECUTING_DIRECTIVES is, hence the derived union
// below rather than a second copy.
const CONFIG_REDIRECTING_DIRECTIVES = new Set(["include"]);

export const REFUSED_DIRECTIVES: ReadonlySet<string> = new Set([
  ...EXECUTING_DIRECTIVES,
  ...CONFIG_REDIRECTING_DIRECTIVES,
]);

// These take the rest of the line raw: no comment-stripping (a literal `#`
// is data, not a comment marker) and no quote/escape decoding. Three of the
// four are in EXECUTING_DIRECTIVES and never reach here; RemoteCommand is
// not, and lands in extras, so it must not be corrupted by token-mode rules
// meant for single-word values.
const REST_OF_LINE_DIRECTIVES = new Set(["proxycommand", "localcommand", "remotecommand", "knownhostscommand"]);

// Rejects a value that would let serialize() emit a directive we didn't
// intend: a newline starts a new (attacker-controlled) directive line, `\r`
// survives into the file even though our own parse() strips it back out.
export function isValidFieldValue(value: string): boolean {
  return !/[\n\r]/.test(value);
}

// OpenSSH (8.7+) escapes `\` and `"` with a backslash rather than rejecting
// them; anything else that would otherwise need quoting (whitespace, `#`,
// a literal quote character) is wrapped in one double-quoted token. Verified
// against the real binary: `a b` -> `"a b"`, `/a"b` -> `"/a\"b"`, `#x` ->
// `"#x"`, `a#b` -> `"a#b"` (unquoted `#` is only a comment at a token
// boundary, so a bare value never needs quoting just for containing one),
// `~/.ssh/k` stays bare. Quoting never interferes with `~` or `%h`/`%r`/`%p`
// expansion.
function formatValue(value: string): string {
  if (value !== "" && !/[\s#"'\\]/.test(value)) return value;
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

export function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

// A directive keyword, unquoted and un-lowercased; undefined when the token
// cannot be a real ssh_config keyword (every real one is alphanumeric), so a
// line like `Pro"xy"Command` normalizes to nothing rather than to a string
// that happens to miss the deny-list. Shared by parse() (a config-file key)
// and connect.ts's rejectedFlags() (an -o option name) so both surfaces the
// deny-list guards apply the exact same normalization.
export function normalizeDirectiveKey(rawKey: string): string | undefined {
  const unquoted = unquote(rawKey);
  return /^[A-Za-z0-9]+$/.test(unquoted) ? unquoted : undefined;
}

// Splits a decoded, comment-stripped directive value into its
// whitespace-separated tokens, each individually unquoted and unescaped —
// OpenSSH's own strdelim() rules, confirmed against the real binary:
// - `"` and `'` both toggle quoting and are never emitted themselves.
// - `\` escapes the very next character only when it is one of \ " ' or a
//   literal space (`a\b` -> `a\b`, `a\\b` -> `a\b`, `a\"b` -> `a"b`,
//   `a\ b` -> `a b`, `a\tb` -> `a\tb` unchanged); otherwise the backslash is
//   emitted literally and the next character is processed normally.
// Returns undefined when a quote is never closed — ssh fatals on the whole
// file for that; dropping just this line/value is strictly more
// conservative and keeps serialize(parse(x)) total.
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

// Cuts a trailing, unquoted, token-boundary comment off a directive's raw
// remainder. `#` starts a comment only when unquoted AND immediately
// preceded by whitespace (or at the very start) — confirmed against the
// real binary: `bob # c` -> `bob`, `bob#c` -> `bob#c` (no boundary),
// `"bob"#c` -> `bob#c` (a closing quote is not whitespace, so the two
// segments glue into one token), `"#x"` -> `#x` (quoted, never a comment).
// Mirrors decodeTokens' own backslash/quote handling so the two agree on
// what is escaped.
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

// OpenSSH accepts space, tab, or `=` (with optional surrounding whitespace)
// between a directive's key and value. The `=`-form alternative must be
// tried first: `\s+` alone would also match the leading space of " = value"
// and leave a literal "=" glued onto value.
export function splitDirective(line: string): { key: string; rest: string } | undefined {
  const match = /^(\S+)(?:\s*=\s*|\s+)(\S.*)$/.exec(line);
  if (!match) return undefined;
  return { key: match[1] as string, rest: match[2] as string };
}

// Host aliases are ssh patterns matched on their own line; a name containing
// whitespace serializes as multiple space-separated patterns (silently
// claiming extra aliases), and an empty name serializes as a bare "Host"
// line that fails to reparse as a Host line at all — its directives then
// attach to whichever host precedes it in the file.
export function isValidHostName(name: string): boolean {
  return name !== "" && !/\s/.test(name);
}

// The alias reaches three sinks with three different rules: config text
// (unquoted), an ssh argv element (add.ts's jump-host spawns), and a
// filename component (remote-keys.ts). This is the intersection of all
// three, matching isValidKeyFilename's class deliberately — a leading "-" is
// a flag to ssh, "*"/"?"/"!" silently claim other hosts' config, and "#" or a
// quote does not survive its own round-trip. Applied only to newly typed
// aliases; isValidHostName above stays the permissive rule for loading and
// serializing configs that already exist.
export function isValidNewHostName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name) && !name.startsWith("-");
}

// ssh rejects anything outside 1-65535 at connect time, by which point the
// value is already sealed into the encrypted config. Leading/trailing
// whitespace and non-ASCII digits both reach ssh as "Bad port"; reject them
// here instead of at connect time.
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

    // A key that isn't a syntactically valid ssh_config keyword (e.g. a
    // quoted or otherwise malformed token) can't be classified against any
    // list below — including the deny-list — so the whole line is dropped
    // rather than kept under a name nothing recognizes.
    const key = normalizeDirectiveKey(split.key);
    if (key === undefined) continue;
    const lowerKey = key.toLowerCase();

    if (lowerKey === "host") {
      const patterns = decodeTokens(stripComment(split.rest));
      // A Host line we can't represent ends the previous block just as Match
      // does below: its directives belong to a host that no longer exists,
      // so they must not fall through onto whichever host happened to
      // precede it in the file.
      if (patterns === undefined || patterns.length === 0) {
        current = undefined;
        continue;
      }
      current = { names: patterns, extras: [] };
      hosts.push(current);
      continue;
    }

    // Nothing mssh models is a conditional directive, so nothing between a
    // Match and the next Host may attach to the unconditional host that
    // precedes it — stricter than ssh (which evaluates the condition), but
    // ssh's own behavior here is not representable in this data model.
    if (lowerKey === "match") {
      current = undefined;
      continue;
    }

    if (!current) continue;

    if (REFUSED_DIRECTIVES.has(lowerKey)) {
      // The only REFUSED_DIRECTIVES member that hardens rather than executes:
      // =no disables LocalCommand outright, so it carries no more risk than
      // omitting the directive. Only that exact value is let through.
      if (lowerKey === "permitlocalcommand" && decodeValue(stripComment(split.rest))?.toLowerCase() === "no") {
        current.extras.push({ key, value: stripComment(split.rest).trimEnd() });
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
      // Unlike the five modeled fields, ssh's duplicate rule for extras is
      // per-directive (some first-wins, some accumulate, e.g. IdentityFile)
      // — so every occurrence is kept in source order and neither this
      // parser nor serialize() needs to know which rule applies to which.
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
    const isPermitLocalCommandNo = lowerExtraKey === "permitlocalcommand" && decodeValue(extra.value)?.toLowerCase() === "no";
    if (REFUSED_DIRECTIVES.has(lowerExtraKey) && !isPermitLocalCommandNo) {
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

// The first alias claimed by more than one Host block, or undefined when
// every alias is unique. ssh merges same-named blocks per directive, so a
// duplicate resolves to a host mssh cannot represent and never displays;
// every mutation here is first-wins, making the later block permanently
// unreachable. Exact, case-sensitive comparison deliberately: ssh's own
// alias matching is case-sensitive, so "web1" and "WEB1" are distinct hosts.
// Each host's own names are deduped before comparing — a repeated pattern
// within one host (e.g. "Host web1 web1") is assertSerializable's check to
// make, not this one's.
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
      lines.push(`  ${extra.key} ${extra.value}`); // raw remainder, emitted verbatim — see Host.extras
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

// Matches ssh's first-wins across blocks: if a hand-edited config has the
// same pattern on two Host lines, only the first is addressable here.
// value: undefined clears the field back to unset (omitted on serialize),
// same convention as Host itself.
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

// The subset of the config ssh actually needs to reach `targets`: each named
// host plus every host reachable from it through ProxyJump. Order is
// preserved so the serialized output stays diff-stable.
//
// A host whose name contains a glob metacharacter (or a negation, `!x`) is
// always kept: ssh may apply it to a target we did not match by name, and
// dropping it would break a working connection, or silently drop a
// negation with no siblings left to explain it. mssh itself never creates
// one.
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
