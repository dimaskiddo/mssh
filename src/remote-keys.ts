// Reaches a remote jump host's ~/.ssh over an existing ssh connection to list
// and download key files. Every remote call is an argv array, never a shell string.
import { writeSecureAtomic } from "./secure-file";

export type RemoteRunner = (
  sshTarget: string,
  remoteArgv: string[],
) => { status: number | null; stdout: Buffer; stderr: string; error?: Error };

// No default runner: this module has no requireSsh() of its own, so a runner
// bound to the caller's resolved ssh path (see add.ts's tempConfigRunner) must always be passed in.

// Load-bearing security control: must be checked before `filename` reaches
// any remote command construction. Allowlist, not escaping. Bare-dot names
// are rejected explicitly rather than relying on a downstream failure.
export function isValidKeyFilename(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name);
}

// Suffix-match .pub and prefix-match known_hosts (rotated/backup variants);
// the rest are exact-matched to avoid over-filtering something like config.bak.
export function isNonKeyFile(name: string): boolean {
  return (
    name.endsWith(".pub") ||
    name === "authorized_keys" ||
    name === "config" ||
    name === "environment" ||
    name === "rc" ||
    name.startsWith("known_hosts")
  );
}

const KEY_TYPE_BY_REMOTE_NAME: Record<string, string> = {
  id_rsa: "rsa",
  id_ed25519: "ed25519",
  id_ecdsa: "ecdsa",
  id_dsa: "dsa",
};

// <jump-alias>_<type>.pem keeps a pulled key traceable to its host. jumpAlias
// comes from the user's own config and isValidHostName permits path-like
// values through, so it's re-checked here with the same allowlist as remoteName.
export function localKeyName(jumpAlias: string, remoteName: string): string {
  if (!isValidKeyFilename(jumpAlias)) {
    throw new Error(`invalid jump host alias for a local key filename: ${jumpAlias}`);
  }
  const suffix = KEY_TYPE_BY_REMOTE_NAME[remoteName.toLowerCase()] ?? remoteName.replace(/\.[^.]*$/, "");
  return `${jumpAlias}_${suffix}.pem`;
}

function remoteFailureReason(result: { status: number | null; stderr: string; error?: Error }): string {
  if (result.error) return result.error.message;
  if (result.stderr) return result.stderr;
  return `exit code ${result.status}`;
}

// `-1A`: one filename per line (no `-l` bits/dates to parse), "almost all"
// dotfiles without the `.`/`..` entries `-a` would also include.
export function listRemoteKeys(sshTarget: string, runner: RemoteRunner): string[] {
  const result = runner(sshTarget, ["ls", "-1A", "~/.ssh"]);
  if (result.error || result.status !== 0) {
    throw new Error(`failed to list remote keys from ${sshTarget}: ${remoteFailureReason(result)}`);
  }

  const names = result.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  // A hostile remote `ls` puts attacker-controlled strings in front of the
  // picker; isValidKeyFilename is the same allowlist downloadRemoteKey enforces,
  // so nothing reaches the UI that couldn't also be downloaded.
  return names.filter((name) => isValidKeyFilename(name) && !isNonKeyFile(name));
}

export function downloadRemoteKey(
  sshTarget: string,
  filename: string,
  localPath: string,
  runner: RemoteRunner,
): void {
  if (!isValidKeyFilename(filename)) {
    throw new Error(`invalid key filename: ${filename}`);
  }

  const result = runner(sshTarget, ["cat", `~/.ssh/${filename}`]);
  if (result.error || result.status !== 0) {
    throw new Error(`failed to download remote key ${filename} from ${sshTarget}: ${remoteFailureReason(result)}`);
  }

  // Atomic: on an overwrite, a failure mid-write must leave the existing key
  // intact rather than truncating it. The unlink-on-failure this replaces
  // deleted the very file the user had just chosen to keep.
  writeSecureAtomic(localPath, result.stdout);
}
