import { REFUSED_DIRECTIVES, normalizeDirectiveKey, isPermitLocalCommandNo } from "./directives";
import { decodeTokens, decodeValue, stripComment, formatValue } from "./tokens";
import { isValidFieldValue, isValidHostName, isValidTag } from "./validate";
import { hostLabel, duplicateAlias, splitTags, type Host, type ModeledField } from "./host";

// Matches "## Tags a,b" (any amount of whitespace after the ##, case-insensitive).
const TAGS_COMMENT = /^##\s*Tags\s+(\S.*)$/i;

const MODELED_FIELDS: Record<string, ModeledField> = {
  hostname: "hostname",
  port: "port",
  user: "user",
  identityfile: "identityFile",
  proxyjump: "proxyJump",
};

// ssh reads these as raw rest-of-line; decoding would corrupt the command.
const REST_OF_LINE_DIRECTIVES = new Set(["proxycommand", "localcommand", "remotecommand", "knownhostscommand"]);

// The `=`-form must be tried first: `\s+` alone would also match the leading
// space of " = value" and leave a literal "=" glued onto value.
function splitDirective(line: string): { key: string; rest: string } | undefined {
  const match = /^(\S+)(?:\s*=\s*|\s+)(\S.*)$/.exec(line);
  if (!match) return undefined;
  return { key: match[1] as string, rest: match[2] as string };
}

// A global preamble before the first Host is discarded: mssh owns and fully
// regenerates this file.
export function parse(text: string): Host[] {
  const hosts: Host[] = [];
  let current: Host | undefined;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    // A comment ssh itself ignores, so it's inert to the real client. Checked
    // before the generic '#'-skip so it can be read; before the first Host or
    // after Match, current is undefined and it's dropped like any other
    // comment. First one wins, like the modeled fields below.
    if (current !== undefined && current.tags === undefined) {
      const tagsMatch = TAGS_COMMENT.exec(line);
      if (tagsMatch !== null) {
        const tags = splitTags(tagsMatch[1] as string).filter(isValidTag);
        if (tags.length > 0) current.tags = tags;
        continue;
      }
    }

    if (line === "" || line.startsWith("#")) continue;

    const split = splitDirective(line);
    if (split === undefined) continue;

    // A key that can't be classified can't be checked against the
    // deny-list, so the line is dropped.
    const key = normalizeDirectiveKey(split.key);
    if (key === undefined) continue;
    const lowerKey = key.toLowerCase();

    if (lowerKey === "host") {
      const decoded = decodeTokens(stripComment(split.rest));
      // ssh reads a '-'-prefixed pattern as an option; drop it here rather
      // than fail serialize later.
      const patterns = decoded?.filter((name) => !name.startsWith("-"));
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
      continue;
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
  if (host.tags !== undefined) {
    for (const tag of host.tags) {
      if (!isValidTag(tag)) {
        throw new Error(`invalid tag ${JSON.stringify(tag)} on host "${hostLabel(host)}"`);
      }
    }
  }
  for (const extra of host.extras) {
    if (!isValidFieldValue(extra.key) || !isValidFieldValue(extra.value)) {
      throw new Error(`invalid value for ${extra.key} on host "${hostLabel(host)}"`);
    }
    // Same normalization as parse(), so the deny-list sees the keyword ssh will.
    const normalizedExtraKey = normalizeDirectiveKey(extra.key);
    if (normalizedExtraKey === undefined) {
      throw new Error(`invalid directive name ${JSON.stringify(extra.key)} on host "${hostLabel(host)}"`);
    }
    const lowerExtraKey = normalizedExtraKey.toLowerCase();
    if (REFUSED_DIRECTIVES.has(lowerExtraKey) && !isPermitLocalCommandNo(lowerExtraKey, decodeValue(extra.value))) {
      throw new Error(
        `refusing to write ${extra.key} on host "${hostLabel(host)}": it would make ssh execute a program or load an untracked file`,
      );
    }
    // Extras built in code skip parse(); unbalanced quoting would make the config unloadable.
    if (decodeValue(extra.value) === undefined) {
      throw new Error(`invalid quoting in ${extra.key} on host "${hostLabel(host)}"`);
    }
  }
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
    if (host.tags !== undefined && host.tags.length > 0) lines.push(`  ## Tags ${host.tags.join(",")}`);
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
