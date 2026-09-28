import { normalizeDirectiveKey, REFUSED_DIRECTIVES, isPermitLocalCommandNo } from "./directives";
import type { Host } from "./host";

// ssh's argv mixes flags and the target in any order; matching every token
// against configured aliases avoids reimplementing ssh's own getopt.
//
// this also matches a flag's *value* if it happens to equal a
// configured alias (e.g. `-l web1 db` treats "web1" as a target too, scoping
// its keys alongside db's). Over-includes, never under-includes. A precise
// fix means parsing -J/ProxyJump-style flags to tell target from value, which
// crosses into ProxyJump semantics this codebase won't guess at — deferred.
export function argvTargets(argv: string[], hosts: Host[]): string[] {
  const names = new Set(hosts.flatMap((h) => h.names));
  return argv.filter((arg) => names.has(arg));
}

// OpenSSH's getopt string for ssh(1): these flags always take a value, so
// the value is never mistaken for a target.
const ARG_TAKING_FLAGS = new Set("bceilmopBDEFIJLOPQRSwW".split(""));

// ssh's getopt treats the rest of a bundled token after the first arg-taking
// flag as that flag's value, so only one can appear per token.
function firstArgTakingChar(arg: string): number | undefined {
  for (let j = 1; j < arg.length; j++) {
    if (ARG_TAKING_FLAGS.has(arg[j] as string)) return j;
  }
  return undefined;
}

// Best-effort positional-arg scan for an error message only — argvTargets
// above remains the source of truth for which argv tokens are real targets.
export function firstPositional(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") return argv[i + 1];
    if (!arg.startsWith("-") || arg === "-") return arg;

    const j = firstArgTakingChar(arg);
    if (j !== undefined && j === arg.length - 1) i++;
  }
  return undefined;
}

// ssh's getopt permutes flags anywhere before "--" (verified with ssh -G),
// so every token is scanned. -F/-I redirect ssh whatever their value. An -o
// that can't be classified still resolves to something in ssh, so it fails
// closed.
export function rejectedFlags(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg === "-") continue;

    const j = firstArgTakingChar(arg);
    if (j === undefined) continue;

    const ch = arg[j] as string;
    const attached = arg.slice(j + 1);
    const consumesNext = attached === "";
    if (ch === "F" || ch === "I") return arg;
    if (ch === "o" && isRefusedOption(consumesNext ? argv[i + 1] : attached)) return arg;
    if (consumesNext) i++;
  }
  return undefined;
}

// Mirrors ssh's own -o keyword parsing so the deny-list sees the keyword ssh
// will. The value is left undecoded on purpose (see isPermitLocalCommandNo).
function isRefusedOption(optionValue: string | undefined): boolean {
  if (optionValue === undefined) return true; // -o with nothing after it — fail closed
  const stripped = optionValue.replace(/^[\s=]+/, "");
  const parts = stripped.split(/[\s=]/);
  const rawName = parts[0] ?? "";
  const name = normalizeDirectiveKey(rawName.replace(/"/g, ""));
  if (name === undefined) return true; // unclassifiable keyword — fail closed, not open
  const lowerName = name.toLowerCase();
  if (!REFUSED_DIRECTIVES.has(lowerName)) return false;
  return !isPermitLocalCommandNo(lowerName, parts[1]);
}
