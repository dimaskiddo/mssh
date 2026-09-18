#!/usr/bin/env bun
// Entry point: `setup`/`config` are recognized only as the literal first arg;
// bare `mssh` lists hosts; everything else passes through to connect.
import { runSetup } from "./src/commands/setup";
import { runList, runListConnect } from "./src/commands/list";
import { runAdd } from "./src/commands/add";
import { runEdit } from "./src/commands/edit";
import { runDelete } from "./src/commands/delete";
import { runConnect } from "./src/commands/connect";
import { runChangePassword } from "./src/commands/change-password";
import {
  configPath,
  defaultEncConfigPath,
  legacyEncConfigPath,
  loadSettings,
  migrateLegacyConfigFrom,
  runDir,
  toDisplayPath,
  type Settings,
} from "./src/app-config";
import { sweepOrphanedTempFiles } from "./src/sweep";
import { fatal } from "./src/exit";
import { dirname } from "node:path";
import pkg from "./package.json";

const USAGE = `MSSH (Manager/Masked SSH) - An Encrypted SSH Config Wrapper

Usage:
  mssh                          pick a host from the list and connect (always prompts)
  mssh setup                    create the encrypted config
  mssh change-password          re-encrypt the config under a new password (always prompts)
  mssh config list              list host aliases (always prompts)
  mssh config add                add a host
  mssh config edit [name]        edit one modeled field on a host
  mssh config delete [name]      delete a host
  mssh <host> [ssh flags...]     connect to a host
  mssh version, --version        show the version
  mssh --help, -h                show this help`;

// ssh_config.enc -> config rename shim; stderr so it doesn't pollute `config list`'s output.
function migrateLegacyConfig(settings: Settings): void {
  if (settings.MSSH_CONFIG_PATH !== undefined) return;

  const current = defaultEncConfigPath();
  if (migrateLegacyConfigFrom(legacyEncConfigPath(), current)) {
    console.error(`Moved your config from ${toDisplayPath(legacyEncConfigPath())} to ${toDisplayPath(current)}.`);
  }
}

function sweepTempFiles(settings: Settings): void {
  sweepOrphanedTempFiles(runDir(), dirname(configPath(settings)));
}

// Silent trailing args (`mssh setup anything`) look like they configured
// something; only ssh passthrough (runConnect) legitimately takes extra argv.
function rejectExtraArgs(extra: string[]): void {
  if (extra.length === 0) return;
  fatal(`Unexpected argument(s): ${extra.join(" ")}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

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

  const { settings } = loadSettings();
  migrateLegacyConfig(settings);
  sweepTempFiles(settings);

  if (cmd === "setup") {
    rejectExtraArgs(rest);
    await runSetup();
    return;
  }

  if (cmd === "change-password") {
    rejectExtraArgs(rest);
    await runChangePassword();
    return;
  }

  if (cmd === "config") {
    const [sub, ...subRest] = rest;

    if (sub === "list") {
      rejectExtraArgs(subRest);
      await runList();
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

    fatal("Usage: mssh config <list|add|edit|delete>");
  }

  if (cmd === undefined) {
    await runListConnect();
    return;
  }

  await runConnect(process.argv.slice(2));
}

main().catch((err: unknown) => {
  fatal(err instanceof Error ? err.message : String(err));
});
