import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expandHome, defaultEncConfigPath, msshRootDir } from "./paths";

export type Settings = {
  DEFAULT_SSH_KEY_PATH?: string;
  MSSH_CONFIG_PATH?: string;
  MSSH_PASSWORD?: string;
};

const SETTINGS_KEYS = ["DEFAULT_SSH_KEY_PATH", "MSSH_CONFIG_PATH", "MSSH_PASSWORD"] as const;
const PATH_KEYS = new Set<(typeof SETTINGS_KEYS)[number]>(["DEFAULT_SSH_KEY_PATH", "MSSH_CONFIG_PATH"]);

function envFilePath(): string {
  return join(msshRootDir(), ".env");
}

function yamlFilePath(): string {
  return join(msshRootDir(), "config.yaml");
}

export function configPath(settings: Settings): string {
  return settings.MSSH_CONFIG_PATH ?? defaultEncConfigPath();
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

export type LoadedSettings = {
  settings: Settings;
  sourcePath: string | undefined; // which file was actually read, for the permission warning
};

// config.yaml wins over .env when both exist.
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
