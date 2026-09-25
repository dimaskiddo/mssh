// Single source of truth for release archive/binary naming, shared by
// .scripts/release.ts (which builds them) and commands/update.ts (which
// downloads them) — a rename on one side can't silently break the other.
const PLATFORM_LABELS: Record<string, string> = { linux: "linux", darwin: "macos", win32: "windows" };
const ARCH_LABELS: Record<string, string> = { x64: "64-bit", arm64: "arm-64-bit" };

export function archiveName(version: string, platform: string, arch: string): string {
  const platformLabel = PLATFORM_LABELS[platform];
  const archLabel = ARCH_LABELS[arch];
  if (platformLabel === undefined || archLabel === undefined) {
    throw new Error(`unsupported platform ${platform}/${arch}`);
  }
  return `mssh_${version}_${platformLabel}_${archLabel}.zip`;
}

export function binaryName(platform: string): string {
  return platform === "win32" ? "mssh.exe" : "mssh";
}
