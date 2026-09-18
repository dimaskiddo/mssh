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

| Component | Role |
|---|---|
| **Crypto** | `src/crypto.ts` — `seal`/`open`, AES-256-GCM + scrypt at OWASP-minimum cost. Versioned payload with a fresh salt and IV per save. Pure, no I/O |
| **SSHConfig** | `src/ssh-config.ts` — `parse`/`serialize` + pure mutations (`addHost`, `updateHostField`, `deleteHost`, `hostsWithoutProxyJump`, `emptyToUndefined`). `extras[]` preserves unmodeled directives across an edit round-trip |
| **Store** | `src/store.ts` — bridges crypto ↔ fs. `loadRaw`/`loadHosts`/`saveHosts` |
| **AppConfig** | `src/app-config.ts` — `~/.mssh` path layout, `config.yaml`/`.env` loading, `resolvePassword` |
| **SecureFile** | `src/secure-file.ts` — `writeSecure`/`ensureSecureDir`. POSIX `chmod` / Windows `icacls`. The **only** module that owns permission enforcement |
| **SSHBinary** | `src/ssh-binary.ts` — `resolveSsh`/`requireSsh`, resolves `ssh` to an absolute path, per-OS install guidance |
| **RemoteKeys** | `src/remote-keys.ts` — remote `~/.ssh` listing and key download, argv-array only, filename allowlist |
| **Prompt** | `src/prompt.ts` — four thin wrappers over `@inquirer/prompts` |
| **Commands** | `src/commands/` — `setup`, `list`, `connect`, `add`, `edit`, `delete` |
| **Entry** | `index.ts` — argv dispatch only; prints `err.message`, never a stack |

## CLI

```
mssh                                # list hosts (ALWAYS prompts, ignores MSSH_PASSWORD)
mssh setup                          # create the encrypted config
mssh config list                    # list hosts (ALWAYS prompts)
mssh config add                     # add a host, optional ProxyJump, optional remote key fetch
mssh config edit [name]             # edit one modeled field
mssh config delete [name]           # delete a host, warns about dependents
mssh <host> [ssh flags...]          # connect — all flags pass through untouched
mssh change-password                # re-encrypt the config under a new password (ALWAYS prompts for current)
mssh version, --version              # print product name, version, author — no prompt, no disk write
```

---

## Critical Constraints

### Build — Bun compile
- `bun build --compile --target=bun-<os>-<arch>`; six targets defined in `package.json`. `dist/` is generated, gitignored.

### Native Implementation (no shell strings)
- Child processes only via `spawn`/`spawnSync` with an argv array. Never `exec`, `execSync`, or `` $`…` `` on user-influenced data. Each module exposes an injectable runner seam (`CommandRunner`, `WhichFn`, `RemoteRunner`) so both branches are testable off-platform. `ssh` is always spawned by the absolute path `requireSsh()` resolves — never the bare, `PATH`-searched string `"ssh"`.

### Secure Writes
- Every write of sensitive data goes through `secure-file.ts`. No raw `writeFileSync`/`mkdirSync`/`Bun.write` anywhere else in `src/`. On Windows, POSIX `mode` is silently ignored, so the `icacls` path must throw rather than leave an exposed file. Saves to the encrypted config (`saveHosts`) go through `writeSecureAtomic` — a same-directory temp file plus `renameSync`, so a write that dies mid-way never truncates or loses the only copy of the ciphertext.

### Password Routing
- `resolvePassword({forcePrompt})` is the single place the auth split lives: `true` for bare `mssh`, `config list`, and `change-password`'s current-password step; `false` everywhere else. Changing this at a call site is a security regression.

### Command-Executing Directives
- `EXECUTING_DIRECTIVES` (`src/ssh-config.ts`) is the single source of truth for `ssh_config` directives that make ssh execute a program (`ProxyCommand`, `LocalCommand`, `Match`, etc.). `parse()` drops them silently instead of carrying them into `extras[]`; `assertSerializable()` throws if one reaches `serialize()` anyway; `connect.ts`'s `rejectedFlags()` reuses the same set for the `-o`/`-F` command-line guard. Never let this list drift into a second copy.

### SSH Dependency Gating
- `requireSsh()` before any plaintext SSH config touches disk on paths that need it (`connect` unconditionally, `setup` unconditionally, `add` only inside the opt-in key-extraction branch). **Never** on pure-local-crypto paths (`list`/`edit`/`delete`) — those must work on a machine with no ssh installed.

### ProxyJump / Temp-File Lifetime
- OpenSSH re-execs itself as a child with `-F <same temp path>` for ProxyJump, and that child does not start until the connection is being established — well after `spawn()` returns. Cleanup is wired to the parent ssh `'exit'` event plus `process.on('exit')`, never to the `spawn()` call itself. `add.ts` may use `spawnSync` for its one-shot calls precisely because it blocks until the whole process tree has exited.

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
├── index.ts                 # Entry: argv dispatch only
├── src/
│   ├── app-config.ts        # ~/.mssh path layout, config.yaml/.env loading, resolvePassword
│   ├── crypto.ts            # seal/open — AES-256-GCM + scrypt
│   ├── ssh-config.ts        # parse/serialize + pure Host mutations
│   ├── store.ts             # loadRaw/loadHosts/saveHosts — bridges crypto + fs
│   ├── secure-file.ts       # writeSecure/ensureSecureDir — chmod (POSIX) / icacls (Windows)
│   ├── ssh-binary.ts        # resolveSsh/requireSsh — resolve ssh to an absolute path, per-OS install guidance
│   ├── prompt.ts            # Thin wrappers over @inquirer/prompts
│   ├── remote-keys.ts       # Remote ~/.ssh listing + key download
│   └── commands/
│       ├── setup.ts         # mssh setup
│       ├── list.ts          # mssh / mssh config list
│       ├── add.ts           # mssh config add
│       ├── edit.ts          # mssh config edit
│       ├── delete.ts        # mssh config delete
│       ├── change-password.ts # mssh change-password — re-key the encrypted config
│       └── connect.ts       # mssh <host> — ssh passthrough
├── tests/                   # bun:test unit tests, one file per src module
├── .scripts/release.ts      # GitHub release automation (build, archive, checksum, upload)
├── dist/                    # Build output (generated, gitignored)
├── .env.example             # Settings template
├── package.json             # Scripts, dependencies, six build targets
├── tsconfig.json            # Strict TypeScript config
├── bun.lock                 # Locked dependency tree
├── AGENTS.md                # Agent instructions (this file; CLAUDE.md/GEMINI.md symlink here)
├── README.md                # Project readme
├── LICENSE                  # MIT license
└── .gitignore               # Git ignore rules
```

---

## References

| File | Purpose |
|---|---|
| `.env.example` | Settings template — `MSSH_CONFIG_PATH`, `DEFAULT_SSH_KEY_PATH`, `MSSH_PASSWORD` |
| `README.md` | Threat model, usage, install instructions |
| `src/crypto.ts` | Payload format and key derivation — source of truth for the encryption scheme |
| `src/secure-file.ts` | Platform permission enforcement — source of truth for the Windows ACL approach |
| `src/commands/connect.ts` | ProxyJump / temp-file lifetime rationale, in comments |
| `package.json` | Build scripts and the six cross-compile targets |
| `.scripts/release.ts` | Release archive + checksum + GitHub upload automation |
