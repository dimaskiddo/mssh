import { test, expect } from "bun:test";
import { spawnFailureReason } from "../../src/core/exit";

test("spawnFailureReason returns the error message when the spawn itself failed", () => {
  expect(spawnFailureReason({ status: null, error: new Error("spawn ssh ENOENT") })).toBe("spawn ssh ENOENT");
});

test("spawnFailureReason returns stderr when present and there is no spawn error", () => {
  expect(spawnFailureReason({ status: 1, stderr: "permission denied" })).toBe("permission denied");
});

test("spawnFailureReason falls back to the exit code when neither error nor stderr is present", () => {
  expect(spawnFailureReason({ status: 127 })).toBe("exit code 127");
});

test("spawnFailureReason prefers the spawn error even when stderr is also present", () => {
  expect(spawnFailureReason({ status: null, error: new Error("spawn ENOENT"), stderr: "ignored" })).toBe(
    "spawn ENOENT",
  );
});

// A hostile remote (or a compromised icacls-equivalent) can put terminal
// escape sequences into stderr — strip C0/C1 control chars before this
// reaches a message that gets printed, keeping \n and \t.
test("spawnFailureReason strips C0/C1 control chars from stderr but keeps \\n and \\t", () => {
  const stderr = "before\x1b[2Jafter\twith-tab\nwith-newline\x07bell";
  const result = spawnFailureReason({ status: 1, stderr });
  expect(result).not.toContain("\x1b");
  expect(result).not.toContain("\x07");
  expect(result).toContain("\t");
  expect(result).toContain("\n");
  expect(result).toBe("before[2Jafter\twith-tab\nwith-newlinebell");
});
