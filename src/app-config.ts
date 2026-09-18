import { existsSync, readFileSync, linkSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { promptPassword } from "./prompt";
import { isWindows } from "./secure-file";
import { fieldPrompt, PASSWORD_LABEL } from "./field-labels";

export type Settings = {
  DEFAULT_SSH_KEY_PATH?: string;
  MSSH_CONFIG_PATH?: string;
  MSSH_PASSWORD?: string;
};

const SETTINGS_KEYS = ["DEFAULT_SSH_KEY_PATH", "MSSH_CONFIG_PATH", "MSSH_PASSWORD"] as const;
const PATH_KEYS = new Set<(typeof SETTINGS_KEYS)[number]>(["DEFAULT_SSH_KEY_PATH", "MSSH_CONFIG_PATH"]);

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

function envFilePath(): string {
  return join(msshRootDir(), ".env");
}

function yamlFilePath(): string {
  return join(msshRootDir(), "config.yaml");
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

// Compatibility shim for configs created before the default was renamed from
// `ssh_config.enc` to `config` — see migrateLegacyConfigFrom.
export function legacyEncConfigPath(): string {
  return join(msshRootDir(), "ssh_config.enc");
}

export function configPath(settings: Settings): string {
  return settings.MSSH_CONFIG_PATH ?? defaultEncConfigPath();
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

// Matches dotenv/docker-compose/direnv conventions: without quote-stripping,
// MSSH_PASSWORD="my pass" keeps the quotes and derives a key from the wrong
// 9-character string, surfacing as "wrong password" with no indication why.
export function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim().replace(/^export\s+/i, "");
    let value = line.slice(eqIndex + 1).trim();

    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const commentIndex = value.search(/\s#/);
      if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();
    }

    result[key] = value;
  }
  return result;
}

export function pickSettings(raw: unknown): Settings {
  const settings: Settings = {};
  if (raw === null || typeof raw !== "object") return settings;
  // A multi-document YAML file parses to an array, which the object check
  // above would otherwise accept and silently yield {} for every key.
  if (Array.isArray(raw)) {
    throw new Error("malformed settings: expected a single mapping, got a list — check for a stray YAML document separator");
  }

  const record = raw as Record<string, unknown>;
  for (const key of SETTINGS_KEYS) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === undefined || value === null) continue;
    // A present-but-wrong-typed value (e.g. an all-digit password parsed as
    // a YAML number) must fail loudly rather than silently discard it.
    if (typeof value !== "string") {
      throw new Error(`malformed settings: ${key} must be a string, got ${typeof value}`);
    }
    if (value === "") continue;
    const resolved = PATH_KEYS.has(key) ? expandHome(value) : value;
    if (key === "MSSH_CONFIG_PATH" && !isAbsolute(resolved)) {
      throw new Error(`MSSH_CONFIG_PATH must be an absolute path, got "${value}"`);
    }
    settings[key] = resolved;
  }
  return settings;
}

// Decides which password (if any) resolvePassword should use without prompting.
export function selectStoredPassword(settings: Settings, forcePrompt: boolean): string | undefined {
  if (forcePrompt) return undefined;
  return settings.MSSH_PASSWORD;
}

type LoadedSettings = {
  settings: Settings;
  sourcePath: string | undefined; // which file was actually read, for the permission warning
};

// config.yaml wins over .env when both exist. Takes explicit paths so this
// is testable without touching the real home directory (cached per-process).
export function loadSettingsFrom(yamlPath: string, envPath: string): LoadedSettings {
  if (existsSync(yamlPath)) {
    // readFileSync stays outside the try: an I/O error (EACCES, EISDIR) is
    // not a syntax error, and mislabeling it sends the user chasing a
    // nonexistent YAML typo instead of a permissions fix.
    const text = readFileSync(yamlPath, "utf8");
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(text);
    } catch {
      // Never surface the parser's own error: it can quote the offending source
      // line, which may contain a secret.
      throw new Error(`malformed config.yaml at ${yamlPath}`);
    }
    return { settings: pickSettings(parsed), sourcePath: yamlPath };
  }

  if (existsSync(envPath)) {
    const parsed = parseEnvText(readFileSync(envPath, "utf8"));
    return { settings: pickSettings(parsed), sourcePath: envPath };
  }

  return { settings: {}, sourcePath: undefined };
}

export function loadSettings(): LoadedSettings {
  return loadSettingsFrom(yamlFilePath(), envFilePath());
}

// linkSync+unlinkSync rather than renameSync: rename(2) replaces an existing
// destination silently, and this runs on every invocation — link() fails
// with EEXIST instead, closing the TOCTOU race against a concurrent setup.
export function migrateLegacyConfigFrom(legacyPath: string, currentPath: string): boolean {
  if (!existsSync(legacyPath) || existsSync(currentPath)) return false;
  try {
    linkSync(legacyPath, currentPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  unlinkSync(legacyPath);
  return true;
}

// group/other bits only — 0400 is stricter than 0600 and must not warn, so
// this checks what's readable/writable to others, not equality to 0600.
function warnIfWorldOrGroupAccessible(path: string, minimumMode: string): void {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      console.error(`Warning: ${toDisplayPath(path)} is accessible by others (mode ${mode.toString(8)}; should be ${minimumMode} or stricter)`);
    }
  } catch {
    // advisory only; a stat failure here is not this function's problem
  }
}

function warnIfNotPrivate(sourcePath: string): void {
  if (isWindows()) return; // POSIX mode bits are meaningless on Windows

  warnIfWorldOrGroupAccessible(sourcePath, "0600");
  warnIfWorldOrGroupAccessible(dirname(sourcePath), "0700");
}

// Single point of password routing. Takes the caller's own loadSettings()
// result rather than reloading — a second independent read could disagree
// with the first if config.yaml was edited between the two calls.
export async function resolvePassword(loaded: LoadedSettings, opts: { forcePrompt: boolean }): Promise<string> {
  const { settings, sourcePath } = loaded;
  const stored = selectStoredPassword(settings, opts.forcePrompt);

  if (stored !== undefined) {
    if (sourcePath) warnIfNotPrivate(sourcePath);
    return stored;
  }

  return promptPassword(fieldPrompt(PASSWORD_LABEL));
}
