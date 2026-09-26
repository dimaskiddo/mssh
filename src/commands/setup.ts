// `mssh setup`: creates the initial empty encrypted config, then offers to
// install the running binary onto PATH. Confirms the password twice since a
// typo would make the config permanently unopenable.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { win32, posix } from "node:path";
import { configPath, loadSettings, homeDir } from "../app-config";
import { requireSsh } from "../ssh-binary";
import { ensureSecureDir, installExecutable } from "../secure-file";
import { isCompiledBinary } from "../sweep";
import { promptPassword, promptConfirm } from "../prompt";
import { saveHosts } from "../store";
import { binaryName } from "../release-assets";
import { fieldPrompt, PASSWORD_SET_LABEL, PASSWORD_CONFIRM_LABEL } from "../field-labels";
import { fatal } from "../exit";

export function passwordsMatch(a: string, b: string): boolean {
  return a === b;
}

// seal/open round-trips fine on "" and pickSettings discards an empty
// MSSH_PASSWORD, so Enter-Enter would create a config keyed on "" that can
// never be reopened via a stored password. Existing empty-password configs still open.
export function isValidPassword(password: string): boolean {
  return password.length > 0;
}

// path.win32/path.posix, not the OS-dependent `join` — platform is a
// parameter here (also exercised from non-matching host OSes in tests), so
// the separator must follow the platform argument, not process.platform.
export function installTarget(platform: string, home: string, localAppData?: string): string {
  if (platform === "win32") {
    const base = localAppData ?? win32.join(home, "AppData", "Local");
    return win32.join(base, "Programs", "mssh", binaryName(platform));
  }
  return posix.join(home, ".local", "bin", binaryName(platform));
}

function stripTrailingSep(p: string, sep: string): string {
  return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
}

export function isDirOnPath(dir: string, pathEnv: string, platform: string): boolean {
  const isWin = platform === "win32";
  const sep = isWin ? "\\" : "/";
  const target = stripTrailingSep(dir, sep);
  const normalizedTarget = isWin ? target.toLowerCase() : target;

  return pathEnv
    .split(isWin ? ";" : ":")
    .filter((entry) => entry !== "")
    .map((entry) => stripTrailingSep(entry, sep))
    .some((entry) => (isWin ? entry.toLowerCase() : entry) === normalizedTarget);
}

// mssh never writes to ~/.bashrc/~/.zshrc or the registry — this line is
// printed for the user to run/add themselves.
export function pathHint(dir: string, platform: string): string {
  if (platform === "win32") {
    return `[Environment]::SetEnvironmentVariable("Path", "${dir};" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")`;
  }
  return `export PATH="${dir}:$PATH"`;
}

export type InstallOutcome = "already-installed" | "install" | "replace";

// onPath: realpath of Bun.which("mssh"), if any — a user who already ran
// `sudo mv mssh /usr/local/bin` themselves shouldn't be offered a redundant
// second copy under ~/.local/bin.
export function installAction(args: { self: string; target: string; targetExists: boolean; onPath: string | undefined }): InstallOutcome {
  if (args.self === args.target || args.onPath === args.self) return "already-installed";
  return args.targetExists ? "replace" : "install";
}

type InstallPlan = { action: InstallOutcome; self: string; target: string };

// undefined under `bun index.ts` — process.execPath is bun itself there, not
// a copy of mssh worth installing anywhere.
function computeInstallPlan(): InstallPlan | undefined {
  if (!isCompiledBinary(Bun.main)) return undefined;

  const self = realpathSync(process.execPath);
  const target = installTarget(process.platform, homeDir(), process.env.LOCALAPPDATA);

  let onPath: string | undefined;
  const found = Bun.which("mssh");
  if (found !== null) {
    try {
      onPath = realpathSync(found);
    } catch {
      // a dangling PATH entry just means nothing to compare against
    }
  }

  const action = installAction({ self, target, targetExists: existsSync(target), onPath });
  return { action, self, target };
}

async function offerInstall(plan: InstallPlan | undefined): Promise<void> {
  if (plan === undefined || plan.action === "already-installed") return;

  const suffix = plan.action === "replace" ? " (replaces the existing copy)" : "";
  const confirmed = await promptConfirm(`Install mssh to ${plan.target} so it runs as 'mssh'?${suffix}`, { default: true });
  if (!confirmed) return;

  installExecutable(plan.target, readFileSync(plan.self));
  console.log(`Installed to ${plan.target}.`);

  const dir = dirname(plan.target);
  if (!isDirOnPath(dir, process.env.PATH ?? "", process.platform)) {
    console.log(`${dir} is not on your PATH. Add it with:`);
    console.log(`  ${pathHint(dir, process.platform)}`);
  }
}

export async function runSetup(): Promise<void> {
  // Unconditional, unlike add/list/edit/delete's pure-local-crypto exemption:
  // mssh is useless without ssh, and telling the user at setup beats failing
  // later on their first connect attempt.
  requireSsh();

  const { settings } = loadSettings();
  const path = configPath(settings);

  if (existsSync(path)) {
    const plan = computeInstallPlan();
    if (plan === undefined || plan.action === "already-installed") {
      fatal(`Config already exists at ${path}. Refusing to overwrite.`);
    }
    console.log(`Config already exists at ${path}; leaving it untouched.`);
    await offerInstall(plan);
    return;
  }

  const passwordFirst = await promptPassword(fieldPrompt(PASSWORD_SET_LABEL), {
    validate: (value) => (isValidPassword(value) ? true : "Password must not be empty."),
  });

  const passwordConfirm = await promptPassword(fieldPrompt(PASSWORD_CONFIRM_LABEL));

  if (!passwordsMatch(passwordFirst, passwordConfirm)) {
    fatal("Passwords do not match.");
  }

  // dirname(path), not msshRootDir(): a custom MSSH_CONFIG_PATH outside
  // ~/.mssh would otherwise leave the config's actual directory unlocked-down,
  // and saveHosts below would fail with a bare ENOENT after two password prompts.
  ensureSecureDir(dirname(path));

  try {
    // exclusive: true — the existsSync check above sits before two password
    // prompts, so a concurrent `mssh setup` is a real TOCTOU; this is the
    // atomic guard, the earlier check just the fast, friendly common-case path.
    saveHosts(path, [], passwordFirst, { exclusive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      fatal(`Config already exists at ${path}. Refusing to overwrite.`);
    }
    throw err;
  }

  console.log(`Config created at ${path}. Add hosts with 'mssh config add'.`);
  await offerInstall(computeInstallPlan());
}
