import { writeSync } from "node:fs";

// console.error's write to stderr is not guaranteed synchronous before
// process.exit() runs — notably when stderr is a piped/redirected on
// Windows — so the error message can be truncated or dropped on the very
// tick it's printed, right before the process dies. writeSync(2, ...) is a
// raw fd write, always synchronous regardless of what fd 2 is connected to.
export function fatal(...lines: string[]): never {
  writeSync(2, lines.join("\n") + "\n");
  process.exit(1);
}
