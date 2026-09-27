#!/usr/bin/env bun
import { runSetup } from "./src/commands/setup";
import { runList, runListConnect, parseSortFlag, parseTagsFlag } from "./src/commands/list";
import { runAdd } from "./src/commands/add";
import { runEdit } from "./src/commands/edit";
import { runDelete } from "./src/commands/delete";
import { runMigrateKeys } from "./src/commands/migrate-keys";
import { runConnect } from "./src/commands/connect";
import { runChangePassword } from "./src/commands/change-password";
import { runUpdate } from "./src/commands/update";
import { configPath, loadSettings, type Settings } from "./src/config/settings";
import { defaultEncConfigPath, keysDir, runDir, toDisplayPath } from "./src/config/paths";
import { takeEnvPassword } from "./src/config/password";
import { legacyEncConfigPath, migrateLegacyConfigFrom } from "./src/config/legacy";
import { sweepOrphanedTempFiles, sweepBinaryLeftovers } from "./src/fs/sweep";
import { isCompiledBinary } from "./src/core/platform";
import { fatal } from "./src/core/exit";
import pkg from "./package.json";

const USAGE = `MSSH (Manager/Masked SSH) - An Encrypted SSH Config Wrapper

Usage:
  mssh [--sort=asc|dsc|cfg] [--tags=a,b]  pick a host from the list and connect
  mssh setup                            create the encrypted config and install mssh to PATH
  mssh change-password                  re-encrypt the config under a new password
  mssh config list [--sort=asc|dsc|cfg] [--tags=a,b]  list host aliases
  mssh config add                         add a host
  mssh config edit [name]                 edit one modeled field on a host
  mssh config delete [name]               delete a host
  mssh config migrate-keys                encrypt any pulled key still left plaintext
  mssh <host> [ssh flags...]            connect to a host
  mssh update                           update mssh to the latest release
  mssh version, --version               show the version
  mssh --help, -h                       show this help`;

// stderr so this doesn't pollute `config list`'s output.
function migrateLegacyConfig(settings: Settings): void {
  if (settings.MSSH_CONFIG_PATH !== undefined) return;

  const current = defaultEncConfigPath();
  if (migrateLegacyConfigFrom(legacyEncConfigPath(), current)) {
    console.error(`Moved your config from ${toDisplayPath(legacyEncConfigPath())} to ${toDisplayPath(current)}.`);
  }
}

function sweepTempFiles(settings: Settings): void {
  sweepOrphanedTempFiles(runDir(), configPath(settings), keysDir());
}

// Silent trailing args (`mssh setup anything`) look like they configured
// something; only ssh passthrough (runConnect) legitimately takes extra argv.
function rejectExtraArgs(extra: string[]): void {
  if (extra.length === 0) return;
  fatal(`Unexpected argument(s): ${extra.join(" ")}`);
}

// Non-fatal, unlike rejectExtraArgs: a bad sort value still has an obvious
// intended listing, and failing would hide it behind a usage error.
function warnInvalidSort(invalid: string | undefined): void {
  if (invalid === undefined) return;
  console.error(`Warning: unknown --sort value "${invalid}"; expected asc, dsc, or cfg. Listing ascending.`);
}

async function main(): Promise<void> {
  // First line, before any spawn (including update/version dispatch): ssh and
  // its ProxyJump re-exec child inherit process.env, so this must be gone
  // before either can start.
  const envPassword = takeEnvPassword(process.env);

  const [cmd, ...rest] = process.argv.slice(2);

  // Best-effort, independent of any command: a previous `update` on POSIX
  // leaves a hard-link backup a running process can't remove, and on
  // Windows can't touch the locked .exe at all — cleaned up here instead.
  if (isCompiledBinary(Bun.main)) {
    sweepBinaryLeftovers(process.execPath);
  }

  if (cmd === "--help" || cmd === "-h") {
    rejectExtraArgs(rest);
    console.log(USAGE);
    return;
  }

  if (cmd === "--version" || cmd === "version") {
    rejectExtraArgs(rest);
    console.log(`${pkg.displayName} v${pkg.version}`);
    console.log(`By ${pkg.author}`);
    return;
  }

  // Network-only, like version: no ~/.mssh access, no password, no ssh.
  if (cmd === "update") {
    rejectExtraArgs(rest);
    await runUpdate();
    return;
  }

  const { settings, sourcePath, storedPassword } = loadSettings();
  migrateLegacyConfig(settings);
  sweepTempFiles(settings);

  if (storedPassword && sourcePath !== undefined) {
    console.error(
      `Warning: MSSH_PASSWORD in ${toDisplayPath(sourcePath)} is ignored and stored in plaintext — remove it. ` +
        "For unattended `mssh <host>`, export it in the environment instead.",
    );
  }

  if (cmd === "setup") {
    rejectExtraArgs(rest);
    await runSetup();
    return;
  }

  if (cmd === "change-password") {
    rejectExtraArgs(rest);
    await runChangePassword(envPassword !== undefined);
    return;
  }

  if (cmd === "config") {
    const [sub, ...subRest] = rest;

    if (sub === "list") {
      const { order, rest: sorted, invalid } = parseSortFlag(subRest);
      const { tags, rest: extra } = parseTagsFlag(sorted);
      rejectExtraArgs(extra);
      warnInvalidSort(invalid);
      await runList(order, tags);
      return;
    }

    if (sub === "add") {
      rejectExtraArgs(subRest);
      await runAdd();
      return;
    }

    if (sub === "edit") {
      rejectExtraArgs(subRest.slice(1));
      await runEdit(subRest[0]);
      return;
    }

    if (sub === "delete") {
      rejectExtraArgs(subRest.slice(1));
      await runDelete(subRest[0]);
      return;
    }

    if (sub === "migrate-keys") {
      rejectExtraArgs(subRest);
      await runMigrateKeys();
      return;
    }

    fatal("Usage: mssh config <list|add|edit|delete|migrate-keys>");
  }

  const argv = process.argv.slice(2);
  const bare = parseSortFlag(argv);
  const tagged = parseTagsFlag(bare.rest);
  if (tagged.rest.length === 0) {
    warnInvalidSort(bare.invalid);
    await runListConnect(bare.order, tagged.tags);
    return;
  }

  await runConnect(argv, envPassword);
}

main().catch((err: unknown) => {
  fatal(err instanceof Error ? err.message : String(err));
});
