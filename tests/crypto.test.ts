import { test, expect } from "bun:test";
import { seal, open, openBytes, isSealedPayload, UnsupportedVersionError } from "../src/crypto";

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

test("seal/openBytes round-trips non-UTF-8 binary data unchanged", () => {
  const raw = Buffer.from([0x00, 0xff, 0x10, 0xfe, 0x80, 0x81, 0x00, 0x7f]);
  const payload = seal(raw, "correct-horse");
  const opened = openBytes(payload, "correct-horse");
  expect(opened.equals(raw)).toBe(true);
});

test("isSealedPayload is true for a sealed buffer", () => {
  const payload = seal("secret data", "correct-horse");
  expect(isSealedPayload(payload)).toBe(true);
});

test("isSealedPayload is false for OpenSSH PEM, PuTTY, DER and short inputs", () => {
  expect(isSealedPayload(Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\n"))).toBe(false);
  expect(isSealedPayload(Buffer.from("PuTTY-User-Key-File-3: ssh-ed25519\n"))).toBe(false);
  expect(isSealedPayload(Buffer.from([0x30, 0x82, 0x01, 0x00]))).toBe(false);
  expect(isSealedPayload(Buffer.alloc(10))).toBe(false);
});
