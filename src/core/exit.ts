import { writeSync } from "node:fs";

// stderr writes are not guaranteed flushed before process.exit(); writeSync(2,…) always is.
export function fatal(...lines: string[]): never {
  writeSync(2, lines.join("\n") + "\n");
  process.exit(1);
}

// C0/C1 control chars minus \t/\n — a hostile remote or a failing external
// binary can put terminal escape sequences into stderr before it's embedded
// in a thrown message.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function spawnFailureReason(result: { status: number | null; error?: Error; stderr?: string }): string {
  if (result.error) return result.error.message;
  if (result.stderr) return result.stderr.replace(CONTROL_CHARS, "");
  return `exit code ${result.status}`;
}
