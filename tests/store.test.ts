import { test, expect, mock } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { loadRaw, loadHosts, saveHosts } from "../src/store";
import { parse, withKeepAlive } from "../src/ssh-config";
import type { Host } from "../src/ssh-config";
import * as realCrypto from "../src/crypto";
import { seal } from "../src/crypto";
import { withScratchDir as scratch } from "./helpers";

const withScratchDir = (fn: (dir: string) => void): void => scratch("mssh-store-test-", fn);

const SAMPLE_TEXT = `Host myserver
  HostName 1.2.3.4
  Port 2222
  User root
`;

test("saveHosts then loadHosts round-trips the same hosts, with keepalive added on save", () => {
  withScratchDir((dir) => {
    const path = join(dir, "ssh_config.enc");
    const hosts = parse(SAMPLE_TEXT);

    saveHosts(path, hosts, "correct-horse");
    const loaded = loadHosts(path, "correct-horse");

    expect(loaded).toEqual(withKeepAlive(hosts));
  });
});

test("loadHosts/loadRaw with wrong password throws an opaque error", () => {
  withScratchDir((dir) => {
    const path = join(dir, "ssh_config.enc");
    saveHosts(path, parse(SAMPLE_TEXT), "correct-horse");

    let thrown: unknown;
    try {
      loadHosts(path, "wrong-password");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("wrong password or corrupted file");
    expect(message).not.toContain("wrong-password");
    expect(message).not.toContain("correct-horse");
    expect(message.toLowerCase()).not.toContain("auth tag");
  });
});

test("loadRaw on a tampered file throws the same opaque message as wrong password", () => {
  withScratchDir((dir) => {
    const path = join(dir, "ssh_config.enc");
    saveHosts(path, parse(SAMPLE_TEXT), "correct-horse");

    const raw = readFileSync(path);
    const tampered = Buffer.from(raw);
    const flipIndex = tampered.length - 1;
    tampered[flipIndex] = (tampered[flipIndex] ?? 0) ^ 0xff;
    writeFileSync(path, tampered);

    let tamperedErr: unknown;
    try {
      loadRaw(path, "correct-horse");
    } catch (err) {
      tamperedErr = err;
    }

    let wrongPasswordErr: unknown;
    try {
      loadRaw(path, "wrong-password");
    } catch (err) {
      wrongPasswordErr = err;
    }

    expect(tamperedErr).toBeInstanceOf(Error);
    expect(wrongPasswordErr).toBeInstanceOf(Error);
    expect((tamperedErr as Error).message).toBe((wrongPasswordErr as Error).message);
  });
});

test("loadRaw on a nonexistent file throws a distinct 'no config found' error mentioning the path", () => {
  withScratchDir((dir) => {
    const path = join(dir, "does-not-exist.enc");

    let thrown: unknown;
    try {
      loadRaw(path, "any-password");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("no config found");
    expect(message).toContain(path);
  });
});

test("saveHosts with exclusive:true refuses to overwrite an existing config", () => {
  withScratchDir((dir) => {
    const path = join(dir, "ssh_config.enc");
    saveHosts(path, parse(SAMPLE_TEXT), "correct-horse", { exclusive: true });

    expect(() => saveHosts(path, [], "different-password", { exclusive: true })).toThrow();

    const loaded = loadHosts(path, "correct-horse");
    expect(loaded).toEqual(withKeepAlive(parse(SAMPLE_TEXT)));
  });
});

test("saveHosts propagates the duplicate-alias error, confirming the invariant reaches the single write path", () => {
  withScratchDir((dir) => {
    const path = join(dir, "ssh_config.enc");
    const hosts: Host[] = [{ names: ["web1"], extras: [] }, { names: ["web1"], extras: [] }];

    expect(() => saveHosts(path, hosts, "correct-horse")).toThrow(/alias "web1" is defined by more than one host/);
  });
});

test("loadHosts on a sealed duplicate-bearing config returns both hosts without throwing — read paths stay permissive", () => {
  withScratchDir((dir) => {
    const path = join(dir, "ssh_config.enc");
    const dupText = "Host web1\n  HostName first.example\n\nHost web1\n  HostName second.example\n";
    writeFileSync(path, seal(dupText, "correct-horse"));

    const loaded = loadHosts(path, "correct-horse");
    expect(loaded).toEqual(parse(dupText));
    expect(loaded).toHaveLength(2);
  });
});

// mock.module() mutates the shared module object rather than swapping it, so
// keep every test exercising real crypto (above) ordered before these two.
test("loadRaw reports a scrypt resource error distinctly instead of folding it into wrong password", () => {
  withScratchDir((dir) => {
    const path = join(dir, "ssh_config.enc");
    writeFileSync(path, Buffer.from("irrelevant, open() is mocked below"));

    mock.module("../src/crypto", () => ({
      ...realCrypto,
      open: () => {
        const err = new Error("Cannot allocate memory") as NodeJS.ErrnoException;
        err.code = "ERR_CRYPTO_OUT_OF_MEMORY";
        throw err;
      },
    }));

    try {
      expect(() => loadRaw(path, "any-password")).toThrow(/resource error, not a wrong password/);
    } finally {
      // mock.module() mutates Bun's shared registry for the whole run — restore it (see connect-spawn.test.ts).
      mock.module("../src/crypto", () => realCrypto);
    }
  });
});

test("loadRaw reports an internal TypeError distinctly instead of folding it into wrong password", () => {
  withScratchDir((dir) => {
    const path = join(dir, "ssh_config.enc");
    writeFileSync(path, Buffer.from("irrelevant, open() is mocked below"));

    mock.module("../src/crypto", () => ({
      ...realCrypto,
      open: () => {
        throw new TypeError("payload.subarray is not a function");
      },
    }));

    try {
      expect(() => loadRaw(path, "any-password")).toThrow(/internal error, not a wrong password/);
    } finally {
      mock.module("../src/crypto", () => realCrypto);
    }
  });
});

test("saveHosts writes an encrypted file, not plaintext of the host data", () => {
  withScratchDir((dir) => {
    const path = join(dir, "ssh_config.enc");
    const hosts: Host[] = [{ names: ["supersecrethostname"], hostname: "10.0.0.99", extras: [] }];

    saveHosts(path, hosts, "correct-horse");
    const raw = readFileSync(path);

    expect(raw.includes("supersecrethostname")).toBe(false);
    expect(raw.includes("10.0.0.99")).toBe(false);
  });
});
