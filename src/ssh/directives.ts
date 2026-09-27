import { unquote } from "./tokens";

// ssh executes these as programs; a hand-edited config carrying one must not
// turn `mssh <host>` into a launcher for arbitrary binaries.
export const EXECUTING_DIRECTIVES = new Set([
  "proxycommand",
  "localcommand",
  "permitlocalcommand",
  "knownhostscommand",
  "pkcs11provider",
  "smartcarddevice", // ssh's own alias for PKCS11Provider — same code-execution risk
  "securitykeyprovider",
  "xauthlocation",
  "proxyusefdpass",
  "match",
]);

// Include pulls in a file parse() never sees: same risk as executing
// directives, via redirection.
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

// Undefined when the token can't be a real ssh_config keyword, so it
// can never be matched against, or slip past, the deny-list.
export function normalizeDirectiveKey(rawKey: string): string | undefined {
  const unquoted = unquote(rawKey);
  return /^[A-Za-z0-9]+$/.test(unquoted) ? unquoted : undefined;
}
