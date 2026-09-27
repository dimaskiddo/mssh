import { test, expect } from "bun:test";
import { parseSortFlag, parseTagsFlag, groupSelectItems } from "../../src/commands/list";

test("parseSortFlag with no args defaults to ascending with nothing left over", () => {
  expect(parseSortFlag([])).toEqual({ order: "asc", rest: [], invalid: undefined });
});

test("parseSortFlag reads a valid --sort= value and leaves an empty rest", () => {
  expect(parseSortFlag(["--sort=dsc"])).toEqual({ order: "dsc", rest: [], invalid: undefined });
});

test("parseSortFlag accepts --sort=tags as a valid order", () => {
  expect(parseSortFlag(["--sort=tags"])).toEqual({ order: "tags", rest: [], invalid: undefined });
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

test("parseTagsFlag with no args returns an empty tags array and rest", () => {
  expect(parseTagsFlag([])).toEqual({ tags: [], rest: [] });
});

test("parseTagsFlag splits a comma-separated --tags= value", () => {
  expect(parseTagsFlag(["--tags=alibaba,stage"])).toEqual({ tags: ["alibaba", "stage"], rest: [] });
});

test("parseTagsFlag combines repeated --tags= flags instead of last-wins", () => {
  expect(parseTagsFlag(["--tags=a", "--tags=b"])).toEqual({ tags: ["a", "b"], rest: [] });
});

test("an empty --tags= adds nothing", () => {
  expect(parseTagsFlag(["--tags="])).toEqual({ tags: [], rest: [] });
});

test("parseTagsFlag leaves a host name in rest", () => {
  expect(parseTagsFlag(["web1", "--tags=a"])).toEqual({ tags: ["a"], rest: ["web1"] });
});

test("parseTagsFlag and parseSortFlag compose, each ignoring the other's flag", () => {
  const { rest, invalid } = parseSortFlag(["--tags=a", "--sort=dsc"]);
  expect(invalid).toBeUndefined();
  expect(parseTagsFlag(rest)).toEqual({ tags: ["a"], rest: [] });
});

test("--sort=tags composes with --tags=, each parser ignoring the other's flag", () => {
  const { order, rest, invalid } = parseSortFlag(["--tags=a", "--sort=tags"]);
  expect(order).toBe("tags");
  expect(invalid).toBeUndefined();
  expect(parseTagsFlag(rest)).toEqual({ tags: ["a"], rest: [] });
});

test("groupSelectItems maps each group to a header separator followed by its choices", () => {
  const items = groupSelectItems([{ label: "[A]", names: ["web1", "web2"] }]);
  expect(items).toEqual([
    { separator: "[A]" },
    { name: "web1", value: "web1" },
    { name: "web2", value: "web2" },
  ]);
});

test("groupSelectItems inserts one blank separator between groups, never leading or trailing", () => {
  const items = groupSelectItems([
    { label: "[A]", names: ["web1"] },
    { label: "[B]", names: ["web2"] },
  ]);
  expect(items).toEqual([
    { separator: "[A]" },
    { name: "web1", value: "web1" },
    { separator: " " },
    { separator: "[B]" },
    { name: "web2", value: "web2" },
  ]);
});

test("groupSelectItems returns an empty array for no groups", () => {
  expect(groupSelectItems([])).toEqual([]);
});
