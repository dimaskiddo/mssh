import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { win32, posix } from "node:path";
import { homeDir } from "../config/paths";
import { isCompiledBinary } from "../core/platform";
import { installExecutable } from "../fs/executable";
import { promptConfirm } from "../cli/prompt";
import { binaryName } from "./release-assets";

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

// A user who already ran `sudo mv mssh /usr/local/bin` themselves shouldn't
// be offered a redundant second copy under ~/.local/bin.
export function installAction(args: { self: string; target: string; targetExists: boolean; onPath: string | undefined }): InstallOutcome {
  if (args.self === args.target || args.onPath === args.self) return "already-installed";
  return args.targetExists ? "replace" : "install";
}

type InstallPlan = { action: InstallOutcome; self: string; target: string };

// undefined under `bun index.ts` — process.execPath is bun itself there, not
// a copy of mssh worth installing anywhere.
export function computeInstallPlan(): InstallPlan | undefined {
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

export async function offerInstall(plan: InstallPlan | undefined): Promise<void> {
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
