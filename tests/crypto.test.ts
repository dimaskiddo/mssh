import { test, expect } from "bun:test";
import { seal, open, UnsupportedVersionError } from "../src/crypto";

const HEADER_LENGTH = 1 + 16 + 12 + 16;

test("round-trip: seal then open with same password returns original plaintext", () => {
  const plaintext = "Host example\n  HostName 1.2.3.4\n  User root\n";
  const payload = seal(plaintext, "correct-horse");
  expect(open(payload, "correct-horse")).toBe(plaintext);
});

test("seal writes the current version byte as the first byte of the payload", () => {
  const payload = seal("secret data", "correct-horse");
  expect(payload[0]).toBe(1);
});

test("open with wrong password throws", () => {
  const payload = seal("secret data", "correct-horse");
  expect(() => open(payload, "wrong-password")).toThrow();
});

test("open throws when a ciphertext byte is flipped (tampering detection)", () => {
  const payload = seal("secret data", "correct-horse");
  const tampered = Buffer.from(payload);
  tampered[HEADER_LENGTH] = (tampered[HEADER_LENGTH] ?? 0) ^ 0xff;
  expect(() => open(tampered, "correct-horse")).toThrow();
});

test("open throws when an auth tag byte is flipped", () => {
  const payload = seal("secret data", "correct-horse");
  const tampered = Buffer.from(payload);
  const tagStart = 1 + 16 + 12;
  tampered[tagStart] = (tampered[tagStart] ?? 0) ^ 0xff;
  expect(() => open(tampered, "correct-horse")).toThrow();
});

test("open throws on a payload too short to contain the header", () => {
  expect(() => open(Buffer.alloc(10), "correct-horse")).toThrow();
});

test("open rejects a payload with an unrecognized version byte", () => {
  const payload = seal("secret data", "correct-horse");
  const tampered = Buffer.from(payload);
  tampered[0] = 99;
  expect(() => open(tampered, "correct-horse")).toThrow(UnsupportedVersionError);
});

test("a payload truncated below header length throws the length error, not UnsupportedVersionError", () => {
  // Length check runs before the version check.
  const tooShort = Buffer.alloc(HEADER_LENGTH - 1);
  tooShort[0] = 1;
  let thrown: unknown;
  try {
    open(tooShort, "correct-horse");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(UnsupportedVersionError);
});

test("two seals of the same plaintext/password differ, and both open correctly", () => {
  const plaintext = "identical plaintext";
  const password = "same-password";
  const a = seal(plaintext, password);
  const b = seal(plaintext, password);
  expect(a.equals(b)).toBe(false);
  expect(open(a, password)).toBe(plaintext);
  expect(open(b, password)).toBe(plaintext);
});
