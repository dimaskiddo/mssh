# MSSH — Agent Instructions

MSSH is a drop-in `ssh` wrapper around an AES-256-GCM encrypted SSH config. Never weaken a security control to make a test pass — ask.

---

## Workflow Rules

1. Read `TASKS.md` and project docs before every session to orient to current state.
2. Never rework items marked `[x]` in `TASKS.md` unless explicitly instructed.
3. Update `TASKS.md` immediately after completing a task.
4. Never attempt to write the entire codebase in a single response.

## Skills

- **GLOBAL:** All prompts processed as if `"Use caveman mode full"` is injected.
- Before ANY coding task, invoke and read: `using-superpowers`, `karpathy-guidelines`, `caveman`.
- Use `using-superpowers` to route to other relevant skills per task.

---

## Architecture

`src/` is grouped into domain folders: `core/`, `config/`, `fs/`, `ssh/`, `keyring/`, `release/`, `cli/`, `commands/`. No barrel/`index.ts` files under `src/`.

| Component | Role |
|---|---|
| **Crypto** | `src/core/crypto.ts` — `seal`/`open`, AES-256-GCM + scrypt at OWASP-minimum cost. Versioned payload with a fresh salt and IV per save. Pure, no I/O |
| **Store** | `src/core/store.ts` — bridges crypto ↔ fs. `loadRaw`/`loadHosts`/`saveHosts`, `sealKeyFile`/`openKeyFile` for pulled keys |
| **Platform** | `src/core/platform.ts` — `isWindows`, `isCompiledBinary` |
| **RequireConfig / Exit** | `src/core/require-config.ts` — `requireExistingConfig()` and `openConfig({forcePrompt})`, the shared `loadSettings`→`configPath`→`requireExistingConfig`→`resolvePassword` preamble. `src/core/exit.ts` — `fatal()` and `spawnFailureReason()`, the shared spawn-failure-to-message fallback (control-character-stripped) used by `acl.ts`/`remote-keys.ts` |
| **Settings** | `src/config/settings.ts` — `~/.mssh` path layout, `config.yaml`/`.env` loading, `loadSettings`/`configPath` |
| **Paths** | `src/config/paths.ts` — `homeDir`/`msshRootDir`/`runDir`/`keysDir`/`defaultEncConfigPath`/`expandHome` |
| **Password** | `src/config/password.ts` — `resolvePassword`, the single place the auth-prompt split lives. `promptNewPassword()` is the set-password + confirm + match check shared by `setup`/`change-password` |
| **Legacy** | `src/config/legacy.ts` — one-time migration from a pre-`~/.mssh` config location |
| **SSHConfig** | `src/ssh/ssh-config.ts` — `parse`/`serialize`. Directive guards live in `ssh/directives.ts` (`REFUSED_DIRECTIVES`, `normalizeDirectiveKey`), tokenizing in `ssh/tokens.ts`, field validation in `ssh/validate.ts`, and pure `Host` mutations (`addHost`, `updateHostField`, `deleteHost`, `hostsWithoutProxyJump`, `emptyToUndefined`, `findHost`) in `ssh/host.ts`. `extras[]` preserves unmodeled directives across an edit round-trip |
| **Argv / Session** | `src/ssh/argv.ts` — `rejectedFlags`/`firstPositional`, the ssh-flag guard. `src/ssh/session.ts` — `connectWithRaw` + the ProxyJump/temp-file lifetime rationale |
| **SSHBinary** | `src/ssh/ssh-binary.ts` — `resolveSsh`/`requireSsh`, resolves `ssh` to an absolute path, per-OS install guidance |
| **KeyStore** | `src/keyring/key-store.ts` — lifecycle of pulled keys: `materializeKeys` decrypts to `run/key-*` for a connection's lifetime, `migratePlaintextKeys` seals any key an older mssh version left plaintext (crash-safe, idempotent, also finishes an interrupted `change-password` re-key) |
| **RemoteKeys / LocalKeys** | `src/keyring/remote-keys.ts` — remote `~/.ssh` listing and key download, argv-array only, filename allowlist. `src/keyring/local-keys.ts` — local key discovery by filename, reusing that allowlist |
| **JumpKeyPull** | `src/keyring/jump-key-pull.ts` — `add`'s remote key-pull handshake through a ProxyJump bastion |
| **SecureWrite / ACL / Executable** | `src/fs/secure-write.ts` — `writeSecure`/`writeSecureAtomic`/`ensureSecureDir`, plus `tryUnlink()`, the shared best-effort delete used across `session.ts`/`jump-key-pull.ts`/`executable.ts`. `src/fs/acl.ts` — Windows `icacls` lockdown. `src/fs/executable.ts` — `installExecutable`/`replaceExecutable`. Together the **only** modules that own permission enforcement |
| **TempNames / Sweep** | `src/fs/temp-names.ts` — the `run/` filename producers (`tempConfigName`, `controlPathName`, `keyTempName`), the in-place suffix producers (`tmpSuffix`, `newSuffix`, `oldSuffix`) used by `secure-write.ts`/`executable.ts`, and their PID regexes. `src/fs/sweep.ts` — orphaned temp-file and stale-binary sweeping |
| **ReleaseAssets / Zip** | `src/release/release-assets.ts` — `archiveName`/`binaryName`, plus `CHECKSUM_FILENAME`/`checksumLine`/`checksumFor`/`stripV`, the checksum-format naming table shared by `.scripts/release.ts` (builds archives) and `commands/update.ts` (downloads them). `src/release/zip.ts` — `extractZipEntry`, a minimal zip central-directory reader (stored + deflate only, no ZIP64) |
| **Install** | `src/release/install.ts` — `setup`'s offer to install the running binary onto PATH |
| **Prompt / FieldLabels / PickHost** | `src/cli/prompt.ts` — four thin wrappers over `@inquirer/prompts`. `src/cli/field-labels.ts` — prompt label text. `src/cli/pick-host.ts` — `resolveTarget` (the name-or-pick block shared by `edit`/`delete`), and `hostChoices`/`sortNames`/`NO_HOSTS_MESSAGE`, shared by `list`/`add`/`edit` |
| **Commands** | `src/commands/` — `setup`, `list`, `connect`, `add`, `edit`, `delete`, `migrate-keys`, `change-password`, `update` |
| **Entry** | `index.ts` — argv dispatch only; prints `err.message`, never a stack |

## CLI

```
mssh                                # list hosts (ALWAYS prompts, ignores MSSH_PASSWORD)
mssh setup                          # create the encrypted config
mssh config list                    # list hosts (ALWAYS prompts)
mssh config add                     # add a host, optional ProxyJump, optional remote key fetch
mssh config edit [name]             # edit one modeled field
mssh config delete [name]           # delete a host, warns about dependents
mssh config migrate-keys            # encrypt any pulled key still left plaintext
mssh <host> [ssh flags...]          # connect — all flags pass through untouched
mssh change-password                # re-encrypt the config under a new password (ALWAYS prompts for current)
mssh update                         # replace the running binary with the latest GitHub release — no prompt, no ~/.mssh
mssh version, --version             # print product name, version, author — no prompt, no disk write
```

---

## Critical Constraints

### Build — Bun compile
- `bun build --compile --target=bun-<os>-<arch>`; six targets defined in `package.json`. `dist/` is generated, gitignored.

### Native Implementation (no shell strings)
- Child processes only via `spawn`/`spawnSync` with an argv array. Never `exec`, `execSync`, or `` $`…` `` on user-influenced data. Each module exposes an injectable runner seam (`CommandRunner`, `WhichFn`, `RemoteRunner`) so both branches are testable off-platform. `ssh` is always spawned by the absolute path `requireSsh()` resolves — never the bare, `PATH`-searched string `"ssh"`.

### Secure Writes
- Every write of sensitive data goes through `src/fs/secure-write.ts` (and `src/fs/executable.ts` for the executable-swap path). No raw `writeFileSync`/`mkdirSync`/`Bun.write` anywhere else in `src/`. On Windows, POSIX `mode` is silently ignored, so the `icacls` path (`src/fs/acl.ts`) must throw rather than leave an exposed file. Saves to the encrypted config (`saveHosts`) go through `writeSecureAtomic` — a same-directory temp file plus `renameSync`, so a write that dies mid-way never truncates or loses the only copy of the ciphertext. `replaceExecutable` (`src/fs/executable.ts`) swaps the running `mssh` binary the same way for `commands/update.ts` — sibling temp file, `fsync`, atomic rename on POSIX / rename-aside on Windows — but preserves the original file's mode/ACL instead of `icacls`-locking it, since a shared install's permissions must not narrow to whichever user ran `mssh update`.

### Password Routing
- `resolvePassword({forcePrompt})` is the single place the auth split lives: `true` for bare `mssh`, `config list`, and `change-password`'s current-password step; `false` everywhere else, including `config migrate-keys`. Changing this at a call site is a security regression.

### Command-Executing Directives
- `EXECUTING_DIRECTIVES` (`src/ssh/directives.ts`) is the single source of truth for `ssh_config` directives that make ssh execute a program (`ProxyCommand`, `LocalCommand`, `Match`, etc.). `CONFIG_REDIRECTING_DIRECTIVES` (currently just `Include`) covers the other way a directive can reach the same outcome indirectly. `REFUSED_DIRECTIVES` is a derived union of both, exported as the single guard set — `parse()` and `assertSerializable()` (`src/ssh/ssh-config.ts`) and `rejectedFlags()` (`src/ssh/argv.ts`) all consume `REFUSED_DIRECTIVES`, never `EXECUTING_DIRECTIVES` directly. Add a directive to one of the two source sets, never to `REFUSED_DIRECTIVES` itself — that is the one derivation point and it must never drift into a second copy.
- A directive key is normalized with `normalizeDirectiveKey()` before it is classified against any list, including the deny-list — a quoted or otherwise malformed key (`"ProxyCommand" id`) would otherwise slip past every guard undetected. `rejectedFlags()`'s `-o` option name goes through the same function, so both surfaces apply identical normalization.
- `Match` terminates the current host block on parse: `mssh` models no conditional directives, so a directive between a `Match` line and the next `Host` line must not attach to the host preceding the `Match` — it is discarded instead, which is stricter than ssh (which evaluates the condition) but is the only representable behavior in this data model.

### SSH Dependency Gating
- `requireSsh()` before any plaintext SSH config touches disk on paths that need it (`connect` unconditionally, `setup` unconditionally, `add` only inside the opt-in key-extraction branch). **Never** on pure-local-crypto paths (`list`/`edit`/`delete`) — those must work on a machine with no ssh installed. `update` needs none of `requireSsh()`/`~/.mssh`/password — it's a pure GitHub-to-binary download, dispatched in `index.ts` before `loadSettings()` for the same reason `version` is.

### ProxyJump / Temp-File Lifetime
- OpenSSH re-execs itself as a child with `-F <same temp path>` for ProxyJump, and that child does not start until the connection is being established — well after `spawn()` returns. Cleanup is wired to the parent ssh `'exit'` event plus `process.on('exit')`, never to the `spawn()` call itself. `add.ts`/`jump-key-pull.ts` may use `spawnSync` for their one-shot calls precisely because it blocks until the whole process tree has exited.
- On POSIX, `connectWithRaw` (`src/ssh/session.ts`) purges the temp config and any decrypted keys as soon as ssh has authenticated, not only at exit: it passes `-o ControlMaster=yes -o ControlPath=<run/cm-*>` before the user's argv (so a later `-o` can't override it — `-o` is first-value-wins), and polls for that socket's appearance. OpenSSH only opens `ControlPath` after `ssh_login()` returns, and ProxyJump's own proxy command never forwards `-o` to the jump child, so this can't fire before the real target has authenticated. Exit/error stay as the fallback — for auth failure, `-G`, a user-supplied `-S`, an overlong/unsafe run-dir path, or Windows, where `ssh.exe` has no ControlMaster support and the whole feature is skipped (`earlyPurgeUsable`). `src/keyring/jump-key-pull.ts`'s key-pull handshake applies the same idea directly: it deletes the decrypted jump-host key as soon as its own preflight handshake authenticates, reusing the ControlPersist master for the ls/cat calls that follow.

### Cross-Platform Paths
- `node:path` `join()` and `os.homedir()` throughout. No hardcoded `/tmp` or `~`. `expandHome()` handles the leading-`~` form.

### Signals
- `SIGINT` forwarded on all platforms; `SIGTERM`/`SIGHUP` forwarded on POSIX only — `SIGTERM` is unsupported on Windows and `SIGHUP` kills the process ~10s later regardless of handlers there.

### Error Handling
- Opaque at security boundaries — decrypt failure never distinguishes wrong password from tampering, and a YAML parse error never echoes the offending source line (it may contain `MSSH_PASSWORD`). `index.ts` prints `err.message` only, never a stack trace.

### TypeScript Strictness
- `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` are on. `tsconfig.json` covers `index.ts`, `src/**`, `tests/**`, `.scripts/**`. No `any`, no `@ts-ignore`.

### Testing
- `bun:test`. Pure logic is extracted into exported pure functions specifically so it is testable without fs/crypto/prompting — keep that seam when adding code.

### Dependencies
- Stdlib/Bun-builtin first (`Bun.YAML`, `node:crypto`). `@inquirer/prompts` is the only runtime dependency; adding another needs justification.

### No Stubbing
- Every function must be complete and production-ready. No `// TODO`, `// rest of code`, or placeholder logic.

---

## Non-Negotiable Rules

1. **No stubs.** Every file complete, production-ready.
2. **No guessing** on crypto, permissions, or ProxyJump semantics. Pause, state the ambiguity, ask.
3. **Never auto-commit.** Provide the diff; the user commits manually.
4. **Never auto-run pipeline.** Provide exact command + expected output, wait for user.
5. **No system temp dirs.** Runtime files live in `~/.mssh/run/` only.
6. **Minimal comments.** Comments describe WHY, never WHAT or HOW.
   - No step-by-step process descriptions or inline restatements (`// increment counter` on `counter++`).
   - No section separator comments (`// --- Section ---`).
   - If a comment would help an attacker bypass a security control, delete it.

---

## Directory Tree

```
mssh/
├── index.ts                   # Entry: argv dispatch only
├── src/
│   ├── core/
│   │   ├── crypto.ts          # seal/open — AES-256-GCM + scrypt
│   │   ├── store.ts           # loadRaw/loadHosts/saveHosts — bridges crypto + fs
│   │   ├── platform.ts        # isWindows, isCompiledBinary
│   │   ├── exit.ts            # fatal(), spawnFailureReason()
│   │   └── require-config.ts  # requireExistingConfig(), openConfig({forcePrompt})
│   ├── config/
│   │   ├── settings.ts        # ~/.mssh path layout, config.yaml/.env loading, loadSettings/configPath
│   │   ├── paths.ts           # homeDir/msshRootDir/runDir/keysDir/defaultEncConfigPath/expandHome
│   │   ├── password.ts        # resolvePassword — the single auth-prompt split; promptNewPassword()
│   │   └── legacy.ts          # migration from a pre-~/.mssh config location
│   ├── fs/
│   │   ├── secure-write.ts    # writeSecure/writeSecureAtomic/ensureSecureDir/tryUnlink — chmod (POSIX) / icacls (Windows)
│   │   ├── acl.ts             # Windows icacls lockdown
│   │   ├── executable.ts      # installExecutable/replaceExecutable
│   │   ├── temp-names.ts      # run/ filename producers, .tmp-/.new-/.old- suffix producers + their PID regexes
│   │   └── sweep.ts           # orphaned temp-file + stale-binary sweeping
│   ├── ssh/
│   │   ├── directives.ts      # REFUSED_DIRECTIVES, normalizeDirectiveKey
│   │   ├── tokens.ts          # ssh_config tokenizer
│   │   ├── validate.ts        # field validators
│   │   ├── host.ts            # Host type + pure mutations (addHost, updateHostField, deleteHost, findHost, ...)
│   │   ├── ssh-config.ts      # parse/serialize
│   │   ├── argv.ts            # rejectedFlags/firstPositional — the ssh-flag guard
│   │   ├── session.ts         # connectWithRaw — ProxyJump/temp-file lifetime
│   │   └── ssh-binary.ts      # resolveSsh/requireSsh — resolve ssh to an absolute path, per-OS install guidance
│   ├── keyring/
│   │   ├── key-store.ts       # materializeKeys/migratePlaintextKeys
│   │   ├── local-keys.ts      # Local key discovery: Identity File default + already-pulled keysDir() keys
│   │   ├── remote-keys.ts     # Remote ~/.ssh listing + key download
│   │   └── jump-key-pull.ts   # add's remote key-pull handshake through a ProxyJump bastion
│   ├── release/
│   │   ├── release-assets.ts  # archiveName/binaryName, CHECKSUM_FILENAME/checksumLine/checksumFor/stripV — shared with .scripts/release.ts
│   │   ├── zip.ts             # extractZipEntry — minimal zip reader (stored + deflate, no ZIP64)
│   │   └── install.ts         # setup's offer to install the running binary onto PATH
│   ├── cli/
│   │   ├── prompt.ts          # Thin wrappers over @inquirer/prompts
│   │   ├── field-labels.ts    # Prompt label text
│   │   └── pick-host.ts       # resolveTarget (edit/delete); hostChoices/sortNames/NO_HOSTS_MESSAGE (list/add/edit)
│   └── commands/
│       ├── setup.ts           # mssh setup
│       ├── list.ts            # mssh / mssh config list
│       ├── add.ts             # mssh config add
│       ├── edit.ts            # mssh config edit
│       ├── delete.ts          # mssh config delete
│       ├── migrate-keys.ts    # mssh config migrate-keys
│       ├── change-password.ts # mssh change-password — re-key the encrypted config
│       ├── update.ts          # mssh update — self-update from the latest GitHub release
│       └── connect.ts         # mssh <host> — ssh passthrough
├── tests/                     # bun:test unit tests, mirrors src/
├── .scripts/release.ts        # GitHub release automation (build, archive, checksum, upload)
├── dist/                      # Build output (generated, gitignored)
├── .env.example               # Settings template
├── package.json               # Scripts, dependencies, six build targets
├── tsconfig.json              # Strict TypeScript config
├── bun.lock                   # Locked dependency tree
├── AGENTS.md                  # Agent instructions (this file; CLAUDE.md/GEMINI.md symlink here)
├── README.md                  # Project readme
├── LICENSE                    # MIT license
└── .gitignore                 # Git ignore rules
```

---

## References

| File | Purpose |
|---|---|
| `.env.example` | Settings template — `MSSH_CONFIG_PATH`, `DEFAULT_SSH_KEY_PATH`, `MSSH_PASSWORD` |
| `README.md` | Threat model, usage, install instructions |
| `src/core/crypto.ts` | Payload format and key derivation — source of truth for the encryption scheme |
| `src/fs/secure-write.ts`, `src/fs/acl.ts` | Platform permission enforcement — source of truth for the Windows ACL approach |
| `src/ssh/session.ts` | ProxyJump / temp-file lifetime rationale, in comments |
| `package.json` | Build scripts and the six cross-compile targets |
| `.scripts/release.ts` | Release archive + checksum + GitHub upload automation |
