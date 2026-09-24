// Test-facing barrel: one greppable index of the pure-logic export seam.
// Never imported by production code, so it is absent from the compiled binary.
// NEVER pass "../src/internal" to mock.module() — it is a write-through alias
// that rewrites the symbol inside the underlying module for the whole run.

export { pickHomeDir, msshRootDir, expandHome, parseEnvText, pickSettings, selectStoredPassword, loadSettingsFrom } from "./app-config";
export { unquote, decodeValue, stripComment, isValidHostName, EXECUTING_DIRECTIVES, KEEP_ALIVE_INTERVAL, rewriteIdentityFiles } from "./ssh-config";
export { isSealedPayload } from "./crypto";
export { managedKeyPath, keyTempName, migratePlaintextKeys, reportMigratedKeys } from "./key-store";
export { ALIGNED_LABELS } from "./field-labels";
export { isValidKeyFilename } from "./remote-keys";
export { pickDefaultKeyName, pulledKeyNamesFor } from "./local-keys";
export { resolveSsh, installGuidance } from "./ssh-binary";
export { isPidAlive, staleNames, cfgPid, keyPid, cmPid, tmpPid } from "./sweep";
export { defaultUsername, buildNewHost, tempConfigRunner, preflightArgv, validateNewAlias } from "./commands/add";
export { reseal, changePassword } from "./commands/change-password";
export { forwardsTermAndHup, rejectedFlags, childExitCode } from "./commands/connect";
export { findDependents } from "./commands/delete";
export { FIELD_CHOICES, validateFieldValue } from "./commands/edit";
export { hostChoices, sortNames, parseSortFlag } from "./commands/list";
