import { test, expect } from "bun:test";
import { isCompiledBinary } from "../../src/core/platform";

test("isCompiledBinary is true for Bun's compiled-executable virtual path", () => {
  expect(isCompiledBinary("/$bunfs/root/mssh")).toBe(true);
});

test("isCompiledBinary is false when run via `bun index.ts`", () => {
  expect(isCompiledBinary("/home/user/mssh/index.ts")).toBe(false);
});
