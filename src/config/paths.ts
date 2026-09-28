import { homedir } from "node:os";
import { statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { isWindows } from "../core/platform";

// Absolute-only: a relative or empty candidate silently reroots every
// ~/.mssh path onto the CWD, breaking a pulled key's IdentityFile elsewhere.
export function pickHomeDir(candidates: Array<string | undefined>): string | undefined {
  return candidates.find((c) => c !== undefined && isAbsolute(c));
}

// os.homedir() returns "" when it cannot resolve a home (no HOME/USERPROFILE
// and no passwd entry — sudo -E, slim containers, service accounts). Failing
// loudly here beats scattering half-written state across the CWD.
export function homeDir(): string {
  const home = pickHomeDir([homedir(), process.env.HOME, process.env.USERPROFILE]);
  if (home === undefined) {
    throw new Error("cannot determine your home directory: set HOME (or USERPROFILE on Windows) to an absolute path");
  }
  return home;
}

export function msshRootDir(): string {
  return join(homeDir(), ".mssh");
}

export function runDir(): string {
  return join(msshRootDir(), "run");
}

export function keysDir(): string {
  return join(msshRootDir(), "keys");
}

export function defaultEncConfigPath(): string {
  return join(msshRootDir(), "config");
}

export function expandHome(inputPath: string): string {
  if (inputPath === "~") return homeDir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) return join(homeDir(), inputPath.slice(2));
  return inputPath;
}

// Renders an absolute path back to `~/...` form for display; falls back to
// the raw path on an unresolvable home rather than throwing.
export function toDisplayPath(absolutePath: string): string {
  let home: string;
  try {
    home = homeDir();
  } catch {
    return absolutePath;
  }

  // Windows paths are case-insensitive; comparing case-sensitively can miss
  // a home directory reported in different casing than the path being shown.
  const a = isWindows() ? absolutePath.toLowerCase() : absolutePath;
  const h = isWindows() ? home.toLowerCase() : home;

  if (a === h) return "~";

  // home may already end in sep (root, "/"); appending an unconditional sep
  // there doubles it and the prefix check below never matches.
  const homeWithSep = h.endsWith(sep) ? h : h + sep;
  if (a.startsWith(homeWithSep)) return "~" + sep + absolutePath.slice(homeWithSep.length);
  return absolutePath;
}

// Where a jump-key-pull ControlPath socket goes when ~/.mssh/run can't host
// unix sockets (e.g. a WSL /mnt drive). Only ever a socket, never plaintext,
// but still owner- and mode-checked: a dir some other user/process controls
// is refused rather than trusted.
export type DirOwnership = { uid: number; mode: number };

export function socketFallbackDir(
  env: NodeJS.ProcessEnv = process.env,
  stat: (path: string) => DirOwnership = statSync,
  uid: number | undefined = process.getuid?.(),
): string | undefined {
  if (uid === undefined) return undefined;

  const xdg = env.XDG_RUNTIME_DIR;
  let base: string;
  if (xdg !== undefined) {
    if (!isAbsolute(xdg)) return undefined;
    base = xdg;
  } else {
    // A shell that never exported XDG_RUNTIME_DIR (su, some WSL setups) still
    // usually has the systemd-logind per-user runtime dir on disk.
    base = `/run/user/${uid}`;
  }

  let stats: DirOwnership;
  try {
    stats = stat(base);
  } catch {
    return undefined;
  }

  if (stats.uid !== uid) return undefined;
  if ((stats.mode & 0o077) !== 0) return undefined;

  return join(base, "mssh");
}
