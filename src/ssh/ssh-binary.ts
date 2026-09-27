import { isAbsolute } from "node:path";
import { fatal } from "../core/exit";

export type WhichFn = (cmd: string) => string | null;

// Rejects a cwd-relative result (e.g. from a "." PATH entry); every spawn
// site uses this absolute path verbatim, so ssh is resolved exactly once.
export function resolveSsh(which: WhichFn = Bun.which): string | undefined {
  const found = which("ssh");
  return found !== null && isAbsolute(found) ? found : undefined;
}

export function installGuidance(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return [
      "ssh was not found on PATH.",
      "Install OpenSSH Client (PowerShell, run as Administrator):",
      "  Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0",
      "Or install Git for Windows, which bundles an ssh client.",
    ].join("\n");
  }
  if (platform === "darwin") {
    return [
      "ssh was not found on PATH.",
      "macOS ships with OpenSSH; if it's missing, reinstall it with:",
      "  brew install openssh",
    ].join("\n");
  }
  return [
    "ssh was not found on PATH.",
    "Install an OpenSSH client package for your distro, e.g.:",
    "  apt install openssh-client",
    "  dnf install openssh-clients",
    "  pacman -S openssh",
  ].join("\n");
}

export function requireSsh(which: WhichFn = Bun.which): string {
  const path = resolveSsh(which);
  if (path !== undefined) return path;
  fatal(installGuidance(process.platform));
}
