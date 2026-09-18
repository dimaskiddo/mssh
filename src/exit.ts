import { writeSync } from "node:fs";

// stderr writes are not guaranteed flushed before process.exit(); writeSync(2,…) always is.
export function fatal(...lines: string[]): never {
  writeSync(2, lines.join("\n") + "\n");
  process.exit(1);
}
