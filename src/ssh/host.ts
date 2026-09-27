export type Host = {
  names: string[];
  hostname?: string;
  port?: string;
  user?: string;
  identityFile?: string;
  proxyJump?: string;
  tags?: string[];
  extras: Array<{ key: string; value: string }>;
};

export type ModeledField = "hostname" | "port" | "user" | "identityFile" | "proxyJump";

export function hostLabel(host: Host): string {
  return host.names.join(" ");
}

export function hostHasName(host: Host, name: string): boolean {
  return host.names.includes(name);
}

export function findHost(hosts: Host[], name: string): Host | undefined {
  return hosts.find((h) => hostHasName(h, name));
}

// Glob patterns aren't pickable aliases; a '-'-prefixed one would be read as
// an ssh option (defense in depth: parse() already drops those).
export function connectableNames(hosts: Host[]): string[] {
  return hosts.flatMap((h) => h.names).filter((n) => !/[*?!]/.test(n) && !n.startsWith("-"));
}

// A duplicate resolves to a host mssh cannot represent; first-wins makes the
// later block permanently unreachable. Case-sensitive, matching ssh's own
// alias matching.
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

// A host whose name contains a glob metacharacter or negation (`!x`) is
// always kept — ssh may apply it to a target not matched by name; mssh
// itself never creates one.
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

export function emptyToUndefined(value: string): string | undefined {
  return value === "" ? undefined : value;
}

// Only for in-memory hosts written to a temp config, never for what
// saveHosts seals to disk.
export function rewriteIdentityFiles(hosts: Host[], mapping: Map<string, string>): Host[] {
  return hosts.map((host) => {
    if (host.identityFile === undefined) return host;
    const tempPath = mapping.get(host.identityFile);
    if (tempPath === undefined) return host;
    return { ...host, identityFile: tempPath };
  });
}

// Pure split/normalize only — no validation. Keeping this separate from
// isValidTag means an invalid piece in a filter simply fails to match any
// stored tag (narrows to nothing) rather than being silently dropped
// (which would widen the filter to match everything).
export function splitTags(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const piece of text.split(",")) {
    const tag = piece.trim().toLowerCase();
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

// tags: [] is "no filter", not "no tags" — a host with no tags key never
// matches a non-empty filter, matching how an old-format config behaves.
export function filterByTags(hosts: Host[], tags: string[]): Host[] {
  if (tags.length === 0) return hosts;
  return hosts.filter((h) => tags.every((t) => h.tags?.includes(t)));
}

// Same first-wins/undefined-clears convention as updateHostField; an empty
// array removes the key entirely rather than storing [], mirroring how an
// old-format host has no tags key at all.
export function setHostTags(hosts: Host[], name: string, tags: string[]): Host[] {
  let updated = false;
  return hosts.map((h) => {
    if (updated || !hostHasName(h, name)) return h;
    updated = true;
    if (tags.length === 0) {
      const { tags: _tags, ...rest } = h;
      return rest;
    }
    return { ...h, tags };
  });
}
