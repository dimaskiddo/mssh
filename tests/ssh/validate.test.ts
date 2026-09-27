import { test, expect } from "bun:test";
import { isValidFieldValue, isValidHostName, isValidNewHostName, isValidPort, isValidTag } from "../../src/ssh/validate";

test("isValidFieldValue rejects newlines and carriage returns", () => {
  expect(isValidFieldValue("plain-value")).toBe(true);
  expect(isValidFieldValue("h\n  ProxyCommand touch /tmp/pwned")).toBe(false);
  expect(isValidFieldValue("value\rwith-cr")).toBe(false);
});

test("isValidHostName rejects empty and whitespace-containing names", () => {
  expect(isValidHostName("web1")).toBe(true);
  expect(isValidHostName("")).toBe(false);
  expect(isValidHostName("web 1")).toBe(false);
  expect(isValidHostName("web\t1")).toBe(false);
});

// A leading '-' makes ssh (and mssh's own argv) read the alias as an
// option rather than a hostname, e.g. Host -oProxyCommand=x.
test("isValidHostName rejects a name starting with '-', even one that already exists in an old config", () => {
  expect(isValidHostName("-oProxyCommand=id")).toBe(false);
  expect(isValidHostName("-F")).toBe(false);
  expect(isValidHostName("-")).toBe(false);
});

test("isValidNewHostName accepts the ASCII allowlist", () => {
  expect(isValidNewHostName("web1")).toBe(true);
  expect(isValidNewHostName("web1.internal")).toBe(true);
  expect(isValidNewHostName("jump-box_2")).toBe(true);
});

test("isValidNewHostName rejects anything outside the allowlist, including glob/argv/path metacharacters", () => {
  expect(isValidNewHostName("")).toBe(false);
  expect(isValidNewHostName("#x")).toBe(false);
  expect(isValidNewHostName('a"b')).toBe(false);
  expect(isValidNewHostName("*")).toBe(false);
  expect(isValidNewHostName("!x")).toBe(false);
  expect(isValidNewHostName("we b")).toBe(false);
  expect(isValidNewHostName("-oProxyCommand=id")).toBe(false);
  expect(isValidNewHostName("-F")).toBe(false);
  expect(isValidNewHostName("../evil")).toBe(false);
  expect(isValidNewHostName(".")).toBe(false);
  expect(isValidNewHostName("..")).toBe(false);
  expect(isValidNewHostName("user@host")).toBe(false);
  expect(isValidNewHostName("café")).toBe(false);
});

test("isValidPort accepts in-range integers", () => {
  expect(isValidPort("1")).toBe(true);
  expect(isValidPort("22")).toBe(true);
  expect(isValidPort("2222")).toBe(true);
  expect(isValidPort("65535")).toBe(true);
});

test("isValidPort rejects out-of-range, non-numeric, and malformed values", () => {
  expect(isValidPort("")).toBe(false);
  expect(isValidPort("0")).toBe(false);
  expect(isValidPort("-1")).toBe(false);
  expect(isValidPort("65536")).toBe(false);
  expect(isValidPort("99999")).toBe(false);
  expect(isValidPort("abc")).toBe(false);
  expect(isValidPort("22 ")).toBe(false);
  expect(isValidPort("2.2")).toBe(false);
  expect(isValidPort("０２２")).toBe(false); // full-width digits — Number() would otherwise coerce these
});

test("isValidTag accepts a plain lowercase tag and one with allowed punctuation", () => {
  expect(isValidTag("stage")).toBe(true);
  expect(isValidTag("ali-baba_1.x")).toBe(true);
});

// Only the lowercase form is ever stored — splitTags lowercases on the way in.
test("isValidTag rejects empty, whitespace, comma, hash, newline, and uppercase", () => {
  expect(isValidTag("")).toBe(false);
  expect(isValidTag("a b")).toBe(false);
  expect(isValidTag("a,b")).toBe(false);
  expect(isValidTag("a#b")).toBe(false);
  expect(isValidTag("a\nb")).toBe(false);
  expect(isValidTag("A")).toBe(false);
});
