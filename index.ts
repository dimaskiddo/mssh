#!/usr/bin/env bun
// Entry point: `setup` and `config` are recognized only as the literal first
// arg; bare `mssh` (no args) shows a selectable host list and connects;
// everything else is a connect passthrough that injects the decrypted
// config (see src/commands/connect.ts).
import { runSetup } from "./src/commands/setup";
import { runList, runListConnect } from "./src/commands/list";
import { runAdd } from "./src/commands/add";
import { runEdit } from "./src/commands/edit";
import { runDelete } from "./src/commands/delete";
import { runConnect } from "./src/commands/connect";
import { runChangePassword } from "./src/commands/change-password";
import {
  defaultEncConfigPath,
  legacyEncConfigPath,
  loadSettings,
  migrateLegacyConfigFrom,
  toDisplayPath,
} from "./src/app-config";
import pkg from "./package.json";

const USAGE = `mssh — encrypted SSH config wrapper

Usage:
  mssh                          pick a host from the list and connect (always prompts)
  mssh setup                    create the encrypted config
  mssh change-password          re-encrypt the config under a new password (always prompts)
  mssh config list              list host aliases (always prompts)
  mssh config add                add a host
  mssh config edit [name]        edit one modeled field on a host
  mssh config delete [name]      delete a host
  mssh <host> [ssh flags...]     connect
  mssh version, --version        show the version
  mssh --help, -h                show this help`;

// Compatibility shim for the ssh_config.enc -> config rename. Only for the
// default location: a custom MSSH_CONFIG_PATH was never affected by that
// rename. Notice goes to stderr so it can't contaminate `config list`'s
// machine-readable host listing. Remove a release or two after this ships.
function migrateLegacyConfig(): void {
  const { settings } = loadSettings();
  if (settings.MSSH_CONFIG_PATH !== undefined) return;

  const current = defaultEncConfigPath();
  if (migrateLegacyConfigFrom(legacyEncConfigPath(), current)) {
    console.error(`Moved your config from ${toDisplayPath(legacyEncConfigPath())} to ${toDisplayPath(current)}.`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  // Handled before any other dispatch: neither prompts for a password nor
  // touches disk, unlike falling through to runConnect would.
  if (cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }

  if (cmd === "--version" || cmd === "version") {
    console.log(`${pkg.displayName} v${pkg.version}`);
    console.log(`By ${pkg.author}`);
    return;
  }

  migrateLegacyConfig();

  if (cmd === "setup") {
    await runSetup();
    return;
  }

  if (cmd === "change-password") {
    await runChangePassword();
    return;
  }

  if (cmd === "config") {
    if (rest[0] === "list") {
      await runList();
      return;
    }

    if (rest[0] === "add") {
      await runAdd();
      return;
    }

    if (rest[0] === "edit") {
      await runEdit(rest[1]);
      return;
    }

    if (rest[0] === "delete") {
      await runDelete(rest[1]);
      return;
    }

    console.error("Usage: mssh config <list|add|edit|delete>");
    process.exit(1);
  }

  if (cmd === undefined) {
    await runListConnect();
    return;
  }

  await runConnect(process.argv.slice(2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
