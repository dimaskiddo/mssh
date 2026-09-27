import { test, expect } from "bun:test";
import { unquote, stripComment, decodeValue } from "../../src/ssh/tokens";

test("unquote leaves an unquoted value untouched", () => {
  expect(unquote("plain")).toBe("plain");
  expect(unquote('"')).toBe('"');
});

test("stripComment cuts an unquoted, token-boundary comment", () => {
  expect(stripComment("bob # c")).toBe("bob ");
  expect(stripComment("bob#c")).toBe("bob#c");
  expect(stripComment('"bob"#c')).toBe('"bob"#c');
  expect(stripComment('"#x"')).toBe('"#x"');
});

test("decodeValue applies OpenSSH's escape rules", () => {
  expect(decodeValue("a\\b")).toBe("a\\b");
  expect(decodeValue("a\\\\b")).toBe("a\\b");
  expect(decodeValue('a\\"b')).toBe('a"b');
  expect(decodeValue("a\\ b")).toBe("a b");
  expect(decodeValue("a\\tb")).toBe("a\\tb");
});

test("decodeValue returns undefined for an unterminated quote", () => {
  expect(decodeValue('"unterminated')).toBeUndefined();
});
