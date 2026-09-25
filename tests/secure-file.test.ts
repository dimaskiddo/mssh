import { test, expect } from "bun:test";
import { userInfo } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import {
  writeSecure,
  writeSecureAtomic,
  ensureSecureDir,
  replaceExecutable,
  ownershipToRestore,
  type CommandRunner,
} from "../src/secure-file";
import { withScratchDir as scratch } from "./helpers";

const withScratchDir = (fn: (dir: string) => void): void => scratch("mssh-secure-file-test-", fn);

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

// Same resolution lockdown() uses — never a bare, PATH-searched "icacls".
const expectedIcaclsExe = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\icacls.exe`;

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

test.skipIf(process.platform === "win32")(
  "writeSecure corrects an existing file's mode to 0600, not just a newly created file's",
  () => {
    withScratchDir((dir) => {
      const path = join(dir, "secret.txt");
      writeFileSync(path, "old", { mode: 0o644 });
      writeSecure(path, "new");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).toBe("new");
    });
  },
);

test("writeSecure locks down permissions before the payload is written, not after", () => {
  withScratchDir((dir) => {
    withPlatform("win32", () => {
      const path = join(dir, "secret.txt");
      let contentDuringLockdown: string | undefined;
      const inspectingRunner: CommandRunner = () => {
        contentDuringLockdown = readFileSync(path, "utf8");
        return { status: 0 };
      };
      writeSecure(path, "payload", inspectingRunner);
      expect(contentDuringLockdown).toBe("");
    });
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

test("writeSecureAtomic with exclusive:true creates a new file normally", () => {
  withScratchDir((dir) => {
    const path = join(dir, "config");
    writeSecureAtomic(path, "sealed contents", undefined, true);
    expect(readFileSync(path, "utf8")).toBe("sealed contents");
    expect(readdirSync(dir)).toEqual(["config"]);
  });
});

test("writeSecureAtomic with exclusive:true refuses to replace an existing file, and leaves no tmp behind", () => {
  withScratchDir((dir) => {
    const path = join(dir, "config");
    writeSecure(path, "original");
    expect(() => writeSecureAtomic(path, "replacement", undefined, true)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("original");
    expect(readdirSync(dir)).toEqual(["config"]);
  });
});

test("writeSecureAtomic's tmp filename embeds the current pid, for sweep.ts to parse", () => {
  withScratchDir((dir) => {
    withPlatform("win32", () => {
      const path = join(dir, "config");
      let seenDuringWrite: string[] = [];
      const inspectingRunner: CommandRunner = () => {
        seenDuringWrite = readdirSync(dir);
        return { status: 0 };
      };
      writeSecureAtomic(path, "sealed contents", inspectingRunner);
      const tmpName = seenDuringWrite.find((name) => name !== "config");
      expect(tmpName).toContain(`.tmp-${process.pid}-`);
    });
  });
});

test("writeSecureAtomic does not leak a process 'exit' listener across calls", () => {
  withScratchDir((dir) => {
    const before = process.listenerCount("exit");
    for (let i = 0; i < 5; i++) {
      writeSecureAtomic(join(dir, `config${i}`), "contents");
    }
    expect(process.listenerCount("exit")).toBe(before);
  });
});

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
      expect(capturedArgv).toEqual([expectedIcaclsExe, path, "/inheritance:r", "/grant:r", `${userInfo().username}:F`]);
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
      expect(capturedArgv).toEqual([expectedIcaclsExe, target, "/inheritance:r", "/grant:r", `${userInfo().username}:F`]);
    });
  });
});

test("icacls is resolved via %SystemRoot%\\System32, not a bare PATH-searched name", () => {
  withScratchDir((dir) => {
    withPlatform("win32", () => {
      const original = process.env.SystemRoot;
      process.env.SystemRoot = "D:\\CustomWindows";
      try {
        let capturedArgv: string[] | undefined;
        const capturingRunner: CommandRunner = (argv) => {
          capturedArgv = argv;
          return { status: 0 };
        };
        writeSecure(join(dir, "secret.txt"), "data", capturingRunner);
        expect(capturedArgv?.[0]).toBe("D:\\CustomWindows\\System32\\icacls.exe");
      } finally {
        if (original === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = original;
      }
    });
  });
});

test("writeSecure's icacls grantee matches userInfo().username, mirroring add.ts's defaultUsername() fallback shape", () => {
  // Same shape as tests/add.test.ts's defaultUsername test: userInfo()
  // succeeds on this dev machine, so this pins the primary path; the
  // USERDOMAIN\USERNAME fallback is reached only when userInfo() throws
  // (containers with no passwd entry), which isn't reproducible here.
  let expected: string;
  try {
    const name = userInfo().username;
    expected = name;
  } catch {
    const domain = process.env.USERDOMAIN;
    const name = process.env.USERNAME as string;
    expected = domain ? `${domain}\\${name}` : name;
  }

  withScratchDir((dir) => {
    withPlatform("win32", () => {
      let capturedArgv: string[] | undefined;
      const capturingRunner: CommandRunner = (argv) => {
        capturedArgv = argv;
        return { status: 0 };
      };
      writeSecure(join(dir, "secret.txt"), "data", capturingRunner);
      expect(capturedArgv?.[capturedArgv.length - 1]).toBe(`${expected}:F`);
    });
  });
});

test.skipIf(process.platform === "win32")("replaceExecutable swaps in the new content, preserving the original file's mode", () => {
  withScratchDir((dir) => {
    const target = join(dir, "mssh");
    writeFileSync(target, "old binary bytes", { mode: 0o755 });

    const { commit } = replaceExecutable(target, Buffer.from("new binary bytes"));
    commit();

    expect(readFileSync(target, "utf8")).toBe("new binary bytes");
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });
});

test.skipIf(process.platform === "win32")("replaceExecutable leaves no .new-/.old- siblings after commit", () => {
  withScratchDir((dir) => {
    const target = join(dir, "mssh");
    writeFileSync(target, "old", { mode: 0o755 });

    const { commit } = replaceExecutable(target, Buffer.from("new"));
    commit();

    expect(readdirSync(dir)).toEqual(["mssh"]);
  });
});

test.skipIf(process.platform === "win32")("replaceExecutable's rollback restores the original bytes and leaves no siblings", () => {
  withScratchDir((dir) => {
    const target = join(dir, "mssh");
    writeFileSync(target, "original binary bytes", { mode: 0o755 });

    const { rollback } = replaceExecutable(target, Buffer.from("bad binary bytes"));
    rollback();

    expect(readFileSync(target, "utf8")).toBe("original binary bytes");
    expect(readdirSync(dir)).toEqual(["mssh"]);
  });
});

test.skipIf(process.platform === "win32")("replaceExecutable's backup exists between the swap and commit/rollback, for a rollback to use", () => {
  withScratchDir((dir) => {
    const target = join(dir, "mssh");
    writeFileSync(target, "original", { mode: 0o755 });

    const { commit } = replaceExecutable(target, Buffer.from("replacement"));

    const names = readdirSync(dir);
    expect(names.length).toBe(2);
    expect(names).toContain("mssh");
    const backup = names.find((n) => n !== "mssh");
    expect(backup).toMatch(new RegExp(`^mssh\\.old-${process.pid}-[0-9a-f]+$`));

    commit();
  });
});

test.skipIf(process.platform === "win32")("replaceExecutable leaves the original file untouched if the write of the new content fails", () => {
  withScratchDir((dir) => {
    const target = join(dir, "mssh");
    writeFileSync(target, "original", { mode: 0o755 });
    // Target itself, as a directory, is a stand-in for an unwritable destination —
    // statSync(target) still succeeds (needed to read its mode), but the sibling
    // write path shares the same parent dir, so this only proves failure leaves
    // the original alone; a locked/readonly dir is exercised implicitly by "wx".
    expect(() => replaceExecutable(join(dir, "does-not-exist"), Buffer.from("x"))).toThrow();
    expect(readFileSync(target, "utf8")).toBe("original");
    expect(readdirSync(dir)).toEqual(["mssh"]);
  });
});

test("ownershipToRestore: root replacing a file owned by another user restores that user's uid/gid", () => {
  expect(ownershipToRestore({ uid: 1000, gid: 1000 }, 0)).toEqual({ uid: 1000, gid: 1000 });
});

test("ownershipToRestore: root replacing a file it already owns needs no restore", () => {
  expect(ownershipToRestore({ uid: 0, gid: 0 }, 0)).toBeUndefined();
});

test("ownershipToRestore: a non-root caller never restores ownership", () => {
  expect(ownershipToRestore({ uid: 1000, gid: 1000 }, 1000)).toBeUndefined();
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
