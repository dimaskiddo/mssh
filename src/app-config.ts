import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
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

// Pure so the fallback order is unit-testable without mutating the real
// environment. Absolute-only: a relative or empty candidate silently reroots
// every ~/.mssh path onto the CWD, which is how a pulled key ends up recorded
// as a relative IdentityFile that breaks on the next connect from elsewhere.
export function pickHomeDir(candidates: Array<string | undefined>): string | undefined {
  return candidates.find((c) => c !== undefined && c !== "" && isAbsolute(c));
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

export function envFilePath(): string {
  return join(msshRootDir(), ".env");
}

export function yamlFilePath(): string {
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

// Only the leading form is special-cased, matching shell behavior.
export function expandHome(inputPath: string): string {
  if (inputPath === "~") return homeDir();
  if (inputPath.startsWith("~/")) return join(homeDir(), inputPath.slice(2));
  return inputPath;
}

// Renders an absolute path under the home directory back to `~/...` form, for
// display in warnings. Display-only and called from warnIfNotPrivate's
// best-effort path, so an unresolvable home falls back to the raw path
// instead of throwing.
export function toDisplayPath(absolutePath: string): string {
  let home: string;
  try {
    home = homeDir();
  } catch {
    return absolutePath;
  }
  if (absolutePath === home) return "~";
  if (absolutePath.startsWith(home + sep)) return "~" + absolutePath.slice(home.length);
  return absolutePath;
}

export function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

export function pickSettings(raw: unknown): Settings {
  const settings: Settings = {};
  if (!raw || typeof raw !== "object") return settings;

  const record = raw as Record<string, unknown>;
  for (const key of SETTINGS_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || value === "") continue;
    settings[key] = PATH_KEYS.has(key) ? expandHome(value) : value;
  }
  return settings;
}

// Decides which password (if any) resolvePassword should use without prompting.
// Pure so the forcePrompt routing rule is unit-testable independent of file I/O.
export function selectStoredPassword(settings: Settings, forcePrompt: boolean): string | undefined {
  if (forcePrompt) return undefined;
  return settings.MSSH_PASSWORD;
}

type LoadedSettings = {
  settings: Settings;
  sourcePath: string | undefined; // which file was actually read, for the permission warning
};

// config.yaml wins over .env when both exist. Takes explicit paths so the
// precedence rule and error handling are unit-testable without touching the
// real home directory (homedir() is cached per-process, so env-var tricks
// don't work for redirecting it in tests).
export function loadSettingsFrom(yamlPath: string, envPath: string): LoadedSettings {
  if (existsSync(yamlPath)) {
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(readFileSync(yamlPath, "utf8"));
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

// One-time move for configs created before the default was renamed to
// `config`. Refuses to touch anything when both exist: the current file is
// authoritative and the legacy one may be a deliberate backup, so clobbering
// it could destroy the only copy of a config whose password the user still
// has. A rename, not a re-encrypt — the ciphertext is never read, no password
// needed, and the existing mode carries over, which is why this bypasses
// secure-file.ts (that module owns writes of new data; there is none here).
// Returns whether a move happened, for the caller's notice.
export function migrateLegacyConfigFrom(legacyPath: string, currentPath: string): boolean {
  if (!existsSync(legacyPath) || existsSync(currentPath)) return false;
  renameSync(legacyPath, currentPath);
  return true;
}

function warnIfNotPrivate(sourcePath: string): void {
  if (isWindows()) return; // POSIX mode bits are meaningless on Windows

  try {
    const mode = statSync(sourcePath).mode & 0o777;
    if (mode !== 0o600) {
      console.error(`Warning: ${toDisplayPath(sourcePath)} is not readable-only by you (mode should be 0600)`);
    }
  } catch {
    // advisory only; a stat failure here is not this function's problem
  }
}

// Single point of password routing:
// - forcePrompt: true  -> always hidden-prompt, MSSH_PASSWORD is never read
// - forcePrompt: false -> use MSSH_PASSWORD if set, else hidden-prompt
export async function resolvePassword(opts: { forcePrompt: boolean }): Promise<string> {
  const { settings, sourcePath } = loadSettings();
  const stored = selectStoredPassword(settings, opts.forcePrompt);

  if (stored !== undefined) {
    if (sourcePath) warnIfNotPrivate(sourcePath);
    return stored;
  }

  return promptPassword(fieldPrompt(PASSWORD_LABEL));
}
