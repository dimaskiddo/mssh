import { test, expect } from "bun:test";
import { rejectedFlags, firstPositional } from "../../src/ssh/argv";

test("rejectedFlags passes through an argv with no dangerous flags", () => {
  expect(rejectedFlags(["myhost", "-L", "8080:localhost:80"])).toBeUndefined();
});

test("rejectedFlags rejects a separate -F flag", () => {
  expect(rejectedFlags(["myhost", "-F", "/tmp/other"])).toBe("-F");
});

test("rejectedFlags rejects an attached -Fpath flag", () => {
  expect(rejectedFlags(["myhost", "-F/tmp/other"])).toBe("-F/tmp/other");
});

test("rejectedFlags rejects -o ProxyCommand=... as a separate argument", () => {
  expect(rejectedFlags(["myhost", "-o", "ProxyCommand=id"])).toBe("-o");
});

test("rejectedFlags rejects -oProxyCommand=... attached, case-insensitively", () => {
  expect(rejectedFlags(["myhost", "-oproxycommand=id"])).toBe("-oproxycommand=id");
});

test("rejectedFlags does not reject an unrelated -o option", () => {
  expect(rejectedFlags(["myhost", "-o", "StrictHostKeyChecking=no"])).toBeUndefined();
});

test("rejectedFlags rejects -o LocalCommand=... as a separate argument", () => {
  expect(rejectedFlags(["myhost", "-o", "LocalCommand=id"])).toBe("-o");
});

test("rejectedFlags rejects -oKnownHostsCommand=... attached, case-insensitively", () => {
  expect(rejectedFlags(["myhost", "-oKnownHostsCommand=/tmp/evil"])).toBe("-oKnownHostsCommand=/tmp/evil");
});

test("rejectedFlags passes through a harmless -o ServerAliveInterval", () => {
  expect(rejectedFlags(["myhost", "-o", "ServerAliveInterval=30"])).toBeUndefined();
});

test("rejectedFlags passes through -p and -J, whose values are never inspected", () => {
  expect(rejectedFlags(["myhost", "-p", "2222"])).toBeUndefined();
  expect(rejectedFlags(["myhost", "-J", "bastion"])).toBeUndefined();
});

test("rejectedFlags rejects a bundled short flag ending in F", () => {
  expect(rejectedFlags(["myhost", "-4F", "/tmp/other"])).toBe("-4F");
});

test("rejectedFlags rejects a bundled short flag carrying -o", () => {
  expect(rejectedFlags(["myhost", "-4oProxyCommand=id"])).toBe("-4oProxyCommand=id");
});

test("rejectedFlags rejects a whitespace-separated -o value, not just the =-form", () => {
  expect(rejectedFlags(["myhost", "-o", "ProxyCommand id"])).toBe("-o");
});

test("rejectedFlags rejects a tab-separated -o value", () => {
  expect(rejectedFlags(["myhost", "-o", "ProxyCommand\tid"])).toBe("-o");
});

test("rejectedFlags rejects a quoted directive name inside -o's value", () => {
  expect(rejectedFlags(["myhost", "-o", '"ProxyCommand"=id'])).toBe("-o");
});

test("rejectedFlags rejects -o Include, which redirects into an arbitrary file", () => {
  expect(rejectedFlags(["myhost", "-o", "Include=/tmp/evil"])).toBe("-o");
});

test("rejectedFlags passes through -o PermitLocalCommand=no, a hardening flag", () => {
  expect(rejectedFlags(["myhost", "-o", "PermitLocalCommand=no"])).toBeUndefined();
  expect(rejectedFlags(["myhost", "-opermitlocalcommand=NO"])).toBeUndefined();
});

test("rejectedFlags still rejects -o PermitLocalCommand=yes, which enables LocalCommand", () => {
  expect(rejectedFlags(["myhost", "-o", "PermitLocalCommand=yes"])).toBe("-o");
});

test("rejectedFlags still rejects a bare -o PermitLocalCommand with no value", () => {
  expect(rejectedFlags(["myhost", "-o", "PermitLocalCommand"])).toBe("-o");
});

test("rejectedFlags refuses a quoted PermitLocalCommand value — the argv surface does not decode quotes, unlike parse()", () => {
  expect(rejectedFlags(["myhost", '-oPermitLocalCommand="no"'])).toBe('-oPermitLocalCommand="no"');
});

// An unclassifiable -o name must not fall through as "allowed" (fail open).
// ssh itself strips leading whitespace/'=' and embedded quotes from the
// keyword before matching it — these all resolve to proxycommand/localcommand
// under `ssh -G` and must be rejected here too.
test("rejectedFlags rejects a leading-space -o value", () => {
  expect(rejectedFlags(["myhost", "-o", " ProxyCommand=x"])).toBe("-o");
});

test("rejectedFlags rejects a leading-= -o value", () => {
  expect(rejectedFlags(["myhost", "-o", "=ProxyCommand x"])).toBe("-o");
});

test("rejectedFlags rejects a leading-tab -o value", () => {
  expect(rejectedFlags(["myhost", "-o", "\tProxyCommand x"])).toBe("-o");
});

test("rejectedFlags rejects a -o keyword with an embedded quote, not just a fully-wrapped one", () => {
  expect(rejectedFlags(["myhost", "-o", 'Proxy"Command" x'])).toBe("-o");
});

test("rejectedFlags rejects -o=ProxyCommand=x, the '=' form directly after -o", () => {
  expect(rejectedFlags(["myhost", "-o=ProxyCommand=x"])).toBe("-o=ProxyCommand=x");
});

test("rejectedFlags rejects a trailing -o with no value at all", () => {
  expect(rejectedFlags(["myhost", "-o"])).toBe("-o");
});

// SmartcardDevice is ssh's alias for PKCS11Provider — both load a shared
// library, i.e. code execution — and -I sets it directly.
test("rejectedFlags rejects a separate -I flag", () => {
  expect(rejectedFlags(["myhost", "-I", "/tmp/lib.so"])).toBe("-I");
});

test("rejectedFlags rejects an attached -Ipath flag", () => {
  expect(rejectedFlags(["myhost", "-I/tmp/lib.so"])).toBe("-I/tmp/lib.so");
});

test("rejectedFlags rejects -oSmartcardDevice=..., case-insensitively", () => {
  expect(rejectedFlags(["myhost", "-oSmartcardDevice=/tmp/lib.so"])).toBe("-oSmartcardDevice=/tmp/lib.so");
});

test("firstPositional skips a flag's separate-token value", () => {
  expect(firstPositional(["-p", "22", "web"])).toBe("web");
});

test("firstPositional skips a separate-token value through a clustered flag", () => {
  expect(firstPositional(["-vp", "22", "x"])).toBe("x");
});

test("firstPositional treats an attached value as part of the flag, not the target", () => {
  expect(firstPositional(["-p22", "x"])).toBe("x");
});

test("firstPositional returns undefined when the argv is only a flag and its value", () => {
  expect(firstPositional(["-p", "22"])).toBeUndefined();
});
