import { test, expect } from "bun:test";
import { parseSortFlag } from "../../src/commands/list";

test("parseSortFlag with no args defaults to ascending with nothing left over", () => {
  expect(parseSortFlag([])).toEqual({ order: "asc", rest: [], invalid: undefined });
});

test("parseSortFlag reads a valid --sort= value and leaves an empty rest", () => {
  expect(parseSortFlag(["--sort=dsc"])).toEqual({ order: "dsc", rest: [], invalid: undefined });
});

test("parseSortFlag falls back to ascending and reports the value when it is not asc/dsc/cfg", () => {
  expect(parseSortFlag(["--sort=bogus"])).toEqual({ order: "asc", rest: [], invalid: "bogus" });
});

test("parseSortFlag treats a bare --sort= with no value as invalid", () => {
  expect(parseSortFlag(["--sort="])).toEqual({ order: "asc", rest: [], invalid: "" });
});

test("parseSortFlag leaves non-flag arguments in rest for the caller's own rejection", () => {
  expect(parseSortFlag(["junk", "--sort=cfg"])).toEqual({ order: "cfg", rest: ["junk"], invalid: undefined });
});

test("parseSortFlag lets the last --sort= flag win when it is repeated", () => {
  expect(parseSortFlag(["--sort=dsc", "--sort=cfg"])).toEqual({ order: "cfg", rest: [], invalid: undefined });
});

test("parseSortFlag falls back to asc when the last repeated --sort= flag is invalid", () => {
  expect(parseSortFlag(["--sort=cfg", "--sort=bogus"])).toEqual({ order: "asc", rest: [], invalid: "bogus" });
});

test("parseSortFlag keeps a host name in rest so bare mssh won't mistake it for a sort-only invocation", () => {
  expect(parseSortFlag(["web1", "--sort=asc"])).toEqual({ order: "asc", rest: ["web1"], invalid: undefined });
});
