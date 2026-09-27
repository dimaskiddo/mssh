export function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

// OpenSSH's own strdelim() rules, verified against the real binary: `"`/`'`
// toggle quoting, `\` escapes only \ " ' or a literal space. Returns
// undefined on an unterminated quote, keeping serialize(parse(x)) total.
export function decodeTokens(rest: string): string[] | undefined {
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

// Modeled fields are single-token in ssh. Undefined on an unterminated quote
// or an empty remainder (e.g. all comment).
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

// OpenSSH (8.7+) escapes `\` and `"` rather than rejecting them; anything
// else needing quoting (whitespace, `#`, a literal quote) is wrapped in one
// double-quoted token. Quoting never interferes with `~`/`%h`/`%r`/`%p`.
export function formatValue(value: string): string {
  if (value !== "" && !/[\s#"'\\]/.test(value)) return value;
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}
