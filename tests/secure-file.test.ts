import { test, expect } from "bun:test";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { writeSecure, writeSecureAtomic, ensureSecureDir, type CommandRunner } from "../src/secure-file";

function withScratchDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mssh-secure-file-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Forces the win32 branch for the duration of fn, regardless of the real OS,
// so the icacls path is exercised from Linux dev machines too.
function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

const okRunner: CommandRunner = () => ({ status: 0 });
const failingStatusRunner: CommandRunner = () => ({ status: 1 });
const failingSpawnRunner: CommandRunner = () => ({ status: null, error: new Error("spawn icacls ENOENT") });

test("writeSecure writes the given content to the path correctly", () => {
  withScratchDir((dir) => {
    const path = join(dir, "secret.txt");
    writeSecure(path, "top secret contents");
    expect(readFileSync(path, "utf8")).toBe("top secret contents");
  });
});

test("writeSecure accepts a Buffer and round-trips bytes exactly", () => {
  withScratchDir((dir) => {
    const path = join(dir, "secret.bin");
    const data = Buffer.from([0x00, 0x01, 0xff, 0x42]);
    writeSecure(path, data);
    expect(readFileSync(path)).toEqual(data);
  });
});

test.skipIf(process.platform === "win32")("writeSecure sets file mode to 0600 on POSIX", () => {
  withScratchDir((dir) => {
    const path = join(dir, "secret.txt");
    writeSecure(path, "data");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

test("writeSecure with the \"wx\" flag throws instead of overwriting a pre-existing file", () => {
  withScratchDir((dir) => {
    const path = join(dir, "secret.txt");
    writeSecure(path, "first");
    expect(() => writeSecure(path, "second", undefined, "wx")).toThrow();
    expect(readFileSync(path, "utf8")).toBe("first");
  });
});

test("writeSecureAtomic replaces existing content", () => {
  withScratchDir((dir) => {
    const path = join(dir, "config");
    writeSecure(path, "old contents");
    writeSecureAtomic(path, "new contents");
    expect(readFileSync(path, "utf8")).toBe("new contents");
  });
});

test("writeSecureAtomic leaves the original file intact when the write fails", () => {
  withScratchDir((dir) => {
    withPlatform("win32", () => {
      const path = join(dir, "config");
      writeSecure(path, "original", okRunner);
      expect(() => writeSecureAtomic(path, "replacement", failingStatusRunner)).toThrow();
      expect(readFileSync(path, "utf8")).toBe("original");
      expect(readdirSync(dir)).toEqual(["config"]);
    });
  });
});

test.skipIf(process.platform === "win32")(
  "writeSecureAtomic result is mode 0600 with no .tmp- sibling left behind",
  () => {
    withScratchDir((dir) => {
      const path = join(dir, "config");
      writeSecureAtomic(path, "sealed contents");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual(["config"]);
    });
  },
);

test("ensureSecureDir creates the directory if missing and sets 0700 on POSIX", () => {
  withScratchDir((dir) => {
    const target = join(dir, "nested", "keys");
    expect(existsSync(target)).toBe(false);
    ensureSecureDir(target);
    expect(existsSync(target)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o700);
    }
  });
});

test("ensureSecureDir is idempotent", () => {
  withScratchDir((dir) => {
    const target = join(dir, "keys");
    ensureSecureDir(target);
    expect(() => ensureSecureDir(target)).not.toThrow();
    if (process.platform !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o700);
    }
  });
});

test("writeSecure on Windows throws when the icacls runner reports a non-zero exit code", () => {
  withScratchDir((dir) => {
    withPlatform("win32", () => {
      const path = join(dir, "secret.txt");
      expect(() => writeSecure(path, "data", failingStatusRunner)).toThrow();
    });
  });
});

test("writeSecure on Windows throws when the icacls runner reports a spawn error", () => {
  withScratchDir((dir) => {
    withPlatform("win32", () => {
      const path = join(dir, "secret.txt");
      expect(() => writeSecure(path, "data", failingSpawnRunner)).toThrow();
    });
  });
});

test("writeSecure on Windows calls the icacls runner exactly once and does not throw on success", () => {
  withScratchDir((dir) => {
    withPlatform("win32", () => {
      const path = join(dir, "secret.txt");
      let calls = 0;
      const countingRunner: CommandRunner = () => {
        calls++;
        return { status: 0 };
      };
      expect(() => writeSecure(path, "data", countingRunner)).not.toThrow();
      expect(calls).toBe(1);
    });
  });
});

test("ensureSecureDir on Windows throws when the icacls runner fails", () => {
  withScratchDir((dir) => {
    withPlatform("win32", () => {
      const target = join(dir, "keys");
      expect(() => ensureSecureDir(target, failingStatusRunner)).toThrow();
    });
  });
});

test("ensureSecureDir on Windows calls the icacls runner exactly once and does not throw on success", () => {
  withScratchDir((dir) => {
    withPlatform("win32", () => {
      const target = join(dir, "keys");
      let calls = 0;
      const countingRunner: CommandRunner = () => {
        calls++;
        return { status: 0 };
      };
      expect(() => ensureSecureDir(target, countingRunner)).not.toThrow();
      expect(calls).toBe(1);
    });
  });
});

test("writeSecure passes the exact expected icacls argv to the injected runner", () => {
  withScratchDir((dir) => {
    withPlatform("win32", () => {
      const path = join(dir, "secret.txt");
      let capturedArgv: string[] | undefined;
      const capturingRunner: CommandRunner = (argv) => {
        capturedArgv = argv;
        return { status: 0 };
      };
      writeSecure(path, "data", capturingRunner);
      expect(capturedArgv).toEqual(["icacls", path, "/inheritance:r", "/grant:r", `${userInfo().username}:F`]);
    });
  });
});

test("ensureSecureDir passes the exact expected icacls argv to the injected runner", () => {
  withScratchDir((dir) => {
    withPlatform("win32", () => {
      const target = join(dir, "keys");
      let capturedArgv: string[] | undefined;
      const capturingRunner: CommandRunner = (argv) => {
        capturedArgv = argv;
        return { status: 0 };
      };
      ensureSecureDir(target, capturingRunner);
      expect(capturedArgv).toEqual(["icacls", target, "/inheritance:r", "/grant:r", `${userInfo().username}:F`]);
    });
  });
});

test("neither writeSecure's nor ensureSecureDir's icacls grant is read-only (:R)", () => {
  withScratchDir((dir) => {
    withPlatform("win32", () => {
      const argvs: string[][] = [];
      const capturingRunner: CommandRunner = (argv) => {
        argvs.push(argv);
        return { status: 0 };
      };
      writeSecure(join(dir, "secret.txt"), "data", capturingRunner);
      ensureSecureDir(join(dir, "keys"), capturingRunner);

      for (const argv of argvs) {
        expect(argv[argv.length - 1]).not.toBe(`${userInfo().username}:R`);
      }
    });
  });
});
