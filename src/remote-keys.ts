// Reaches into a remote jump host's ~/.ssh directory (over an already
// established ssh connection to that host) to list and download key files.
// Every remote call is an argv array handed to spawnSync, never a shell
// string built by us — the only place shell-string risk could sneak back in
// is a downloaded filename, hence the strict allowlist below. Narrow module:
// no prompting, no UI, no path-joining beyond what's described here.
import { unlinkSync, existsSync } from "node:fs";
import { writeSecure } from "./secure-file";

export type RemoteRunner = (
  sshTarget: string,
  remoteArgv: string[],
) => { status: number | null; stdout: Buffer; stderr: string; error?: Error };

// No default runner: this module has no requireSsh() of its own (the caller
// already gated it and resolved the absolute ssh path), so a runner bound to
// that path — see add.ts's tempConfigRunner — must always be passed in
// explicitly rather than this module falling back to a bare, PATH-searched
// "ssh" spawn.

// Load-bearing security control: must be checked before `filename` reaches
// any remote command construction. Allowlist, not escaping. Bare-dot names
// are rejected explicitly rather than relying on a downstream failure.
export function isValidKeyFilename(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name);
}

// Suffix-match .pub: a public key can carry an arbitrary basename, only the
// extension is fixed. Prefix-match known_hosts: catches rotated/backup
// variants (known_hosts.old, known_hosts2), not just the exact name.
// authorized_keys/config are exact-matched: fixed, single-purpose filenames,
// so a prefix match would risk over-filtering something like config.bak.
function isNonKeyFile(name: string): boolean {
  return name.endsWith(".pub") || name === "authorized_keys" || name === "config" || name.startsWith("known_hosts");
}

const KEY_TYPE_BY_REMOTE_NAME: Record<string, string> = {
  id_rsa: "rsa",
  id_ed25519: "ed25519",
  id_ecdsa: "ecdsa",
  id_dsa: "dsa",
};

// <jump-alias>_<type>.pem keeps a pulled key traceable to the host it came
// from. remoteName is already isValidKeyFilename-checked by the caller, so
// the fallback cannot introduce a path separator; a non-stock name keeps its
// own basename rather than being labelled with a crypto type we did not
// actually verify.
export function localKeyName(jumpAlias: string, remoteName: string): string {
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

  // Safe now: filename is allowlist-validated, so no shell metacharacters
  // can reach the remote command line.
  const result = runner(sshTarget, ["cat", `~/.ssh/${filename}`]);
  if (result.error || result.status !== 0) {
    throw new Error(`failed to download remote key ${filename} from ${sshTarget}: ${remoteFailureReason(result)}`);
  }

  try {
    writeSecure(localPath, result.stdout);
  } catch (err) {
    // Remove the partially-written key if lockdown failed, rather than leaving
    // it behind.
    try {
      if (existsSync(localPath)) unlinkSync(localPath);
    } catch {
      // best-effort; the original error below is the one that matters
    }
    throw err;
  }
}
