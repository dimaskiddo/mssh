export function isWindows(): boolean {
  return process.platform === "win32";
}

// Compiled Bun executables mount their bundled files under this virtual FS
// (verified against a real `bun build --compile` output); Windows compiled
// binaries use a "~BUN" marker instead. False under `bun index.ts`, where
// process.execPath is the bun binary itself, not mssh.
export function isCompiledBinary(main: string): boolean {
  return main.startsWith("/$bunfs/") || main.includes("~BUN");
}
