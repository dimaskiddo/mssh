// Resolves the system `ssh` binary to an absolute path and, if absent,
// prints per-OS install guidance and exits. No knowledge of SSH config,
// crypto, or anything else.
import { isAbsolute } from "node:path";
import { fatal } from "./exit";

export type WhichFn = (cmd: string) => string | null;

// PATH-based resolution alone is not enough: a shadowing `ssh` earlier on
// PATH would run instead of the real one. isAbsolute is the load-bearing
// check — every spawn site uses this return value verbatim, so a relative
// or unresolved result must never reach a spawn call.
export function resolveSsh(which: WhichFn = Bun.which): string | undefined {
  const found = which("ssh");
  return found !== null && isAbsolute(found) ? found : undefined;
}

// Pure and platform-injectable purely for testability; requireSsh itself
// reads the real process.platform.
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
