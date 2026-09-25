import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { isNewer, checksumFor, runUpdate, type UpdateDeps } from "../src/commands/update";
import { archiveName, binaryName } from "../src/release-assets";
import { withScratchDirAsync as withScratchDir } from "./helpers";

test("isNewer: newer patch is newer", () => {
  expect(isNewer("0.1.6", "0.1.5")).toBe(true);
});

test("isNewer: equal versions are not newer", () => {
  expect(isNewer("0.1.5", "0.1.5")).toBe(false);
});

test("isNewer: older is not newer", () => {
  expect(isNewer("0.1.4", "0.1.5")).toBe(false);
});

test("isNewer: a leading v on either side is stripped", () => {
  expect(isNewer("v0.2.0", "0.1.5")).toBe(true);
  expect(isNewer("0.1.5", "v0.1.5")).toBe(false);
});

test("isNewer: newer minor/major beats a smaller patch", () => {
  expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  expect(isNewer("0.2.0", "0.1.9")).toBe(true);
});

test("isNewer: throws on a malformed version", () => {
  expect(() => isNewer("not-a-version", "0.1.5")).toThrow(/malformed version/);
  expect(() => isNewer("0.1.5", "1.2")).toThrow(/malformed version/);
});

test("checksumFor: finds the matching entry among several", () => {
  const text = [
    "aaaa111  mssh_0.1.6_linux_64-bit.zip",
    "bbbb222  mssh_0.1.6_macos_64-bit.zip",
    "cccc333  checksum-unrelated-line",
  ].join("\n");
  expect(checksumFor(text, "mssh_0.1.6_macos_64-bit.zip")).toBe("bbbb222");
});

test("checksumFor: returns undefined when the archive has no entry", () => {
  const text = "aaaa111  mssh_0.1.6_linux_64-bit.zip\n";
  expect(checksumFor(text, "mssh_0.1.6_windows_64-bit.zip")).toBeUndefined();
});

function buildZipWithBinary(binName: string, content: Buffer): Buffer {
  const compressed = deflateRawSync(content);
  const crc = Bun.hash.crc32(content);
  const nameBuf = Buffer.from(binName, "utf8");

  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n, 0);
    return b;
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n, 0);
    return b;
  };

  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(8),
    u16(0),
    u16(0),
    u32(crc),
    u32(compressed.length),
    u32(content.length),
    u16(nameBuf.length),
    u16(0),
    nameBuf,
  ]);

  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(8),
    u16(0),
    u16(0),
    u32(crc),
    u32(compressed.length),
    u32(content.length),
    u16(nameBuf.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    nameBuf,
  ]);

  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length + compressed.length),
    u16(0),
  ]);

  return Buffer.concat([local, compressed, central, eocd]);
}

function fakeFetch(routes: Map<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const handler = routes.get(url);
    if (!handler) throw new Error(`fakeFetch: no route for ${url}`);
    return handler();
  }) as typeof fetch;
}

const RELEASE_URL = "https://api.github.com/repos/dimaskiddo/mssh/releases/latest";
const ARCHIVE_URL = "https://example.invalid/archive.zip";
const CHECKSUM_URL = "https://example.invalid/checksum.txt";

function baseDeps(dir: string, overrides: Partial<UpdateDeps> = {}): UpdateDeps {
  const target = join(dir, "mssh");
  writeFileSync(target, "old mssh binary", { mode: 0o755 });

  return {
    fetchFn: fakeFetch(new Map()),
    execPath: target,
    main: "/$bunfs/root/mssh",
    currentVersion: "0.1.5",
    platform: "linux",
    arch: "x64",
    verify: () => ({ ok: true, stdout: "mssh v0.1.6\n" }),
    replace: () => ({ commit: () => {}, rollback: () => {} }),
    ...overrides,
  };
}

test("runUpdate refuses on a non-compiled binary and touches nothing", async () => {
  await withScratchDir("mssh-update-test-", async (dir) => {
    const deps = baseDeps(dir, { main: "/home/user/mssh/index.ts" });
    await expect(runUpdate(deps)).rejects.toThrow(/compiled release binary/);
  });
});

test("runUpdate reports up to date and never fetches the archive", async () => {
  await withScratchDir("mssh-update-test-", async (dir) => {
    let archiveFetched = false;
    const routes = new Map<string, () => Response>([
      [RELEASE_URL, () => Response.json({ tag_name: "v0.1.5", assets: [] })],
      [ARCHIVE_URL, () => ((archiveFetched = true), new Response(""))],
    ]);
    const deps = baseDeps(dir, { fetchFn: fakeFetch(routes) });
    await runUpdate(deps);
    expect(archiveFetched).toBe(false);
    expect(readFileSync(deps.execPath, "utf8")).toBe("old mssh binary");
  });
});

test("runUpdate downloads, verifies and replaces on a newer release", async () => {
  await withScratchDir("mssh-update-test-", async (dir) => {
    const binary = Buffer.from("new mssh binary");
    const archive = buildZipWithBinary("mssh", binary);
    const archiveName_ = archiveName("0.1.6", "linux", "x64");
    const checksum = `${createHash("sha256").update(archive).digest("hex")}  ${archiveName_}\n`;

    const routes = new Map<string, () => Response>([
      [
        RELEASE_URL,
        () =>
          Response.json({
            tag_name: "v0.1.6",
            assets: [
              { name: archiveName_, browser_download_url: ARCHIVE_URL },
              { name: "checksum.txt", browser_download_url: CHECKSUM_URL },
            ],
          }),
      ],
      [ARCHIVE_URL, () => new Response(archive)],
      [CHECKSUM_URL, () => new Response(checksum)],
    ]);

    let replaced: Buffer | undefined;
    let committed = false;
    const deps = baseDeps(dir, {
      fetchFn: fakeFetch(routes),
      replace: (_target, data) => {
        replaced = data;
        return {
          commit: () => {
            committed = true;
          },
          rollback: () => {
            throw new Error("rollback should not run on success");
          },
        };
      },
    });

    await runUpdate(deps);
    expect(replaced).toEqual(binary);
    expect(committed).toBe(true);
  });
});

test("runUpdate refuses and leaves the binary untouched on a checksum mismatch", async () => {
  await withScratchDir("mssh-update-test-", async (dir) => {
    const archive = buildZipWithBinary("mssh", Buffer.from("new mssh binary"));
    const archiveName_ = archiveName("0.1.6", "linux", "x64");

    const routes = new Map<string, () => Response>([
      [
        RELEASE_URL,
        () =>
          Response.json({
            tag_name: "v0.1.6",
            assets: [
              { name: archiveName_, browser_download_url: ARCHIVE_URL },
              { name: "checksum.txt", browser_download_url: CHECKSUM_URL },
            ],
          }),
      ],
      [ARCHIVE_URL, () => new Response(archive)],
      [CHECKSUM_URL, () => new Response(`deadbeef  ${archiveName_}\n`)],
    ]);

    let replaceCalled = false;
    const deps = baseDeps(dir, {
      fetchFn: fakeFetch(routes),
      replace: () => {
        replaceCalled = true;
        return { commit: () => {}, rollback: () => {} };
      },
    });

    await expect(runUpdate(deps)).rejects.toThrow(/checksum mismatch/);
    expect(replaceCalled).toBe(false);
  });
});

test("runUpdate fails clearly when the release has no asset for this platform/arch", async () => {
  await withScratchDir("mssh-update-test-", async (dir) => {
    const routes = new Map<string, () => Response>([
      [
        RELEASE_URL,
        () =>
          Response.json({
            tag_name: "v0.1.6",
            assets: [{ name: "checksum.txt", browser_download_url: CHECKSUM_URL }],
          }),
      ],
    ]);
    const deps = baseDeps(dir, { fetchFn: fakeFetch(routes) });
    await expect(runUpdate(deps)).rejects.toThrow(/no build for/);
  });
});

test("runUpdate fails clearly on an HTTP error from the release endpoint", async () => {
  await withScratchDir("mssh-update-test-", async (dir) => {
    const routes = new Map<string, () => Response>([[RELEASE_URL, () => new Response("nope", { status: 500 })]]);
    const deps = baseDeps(dir, { fetchFn: fakeFetch(routes) });
    await expect(runUpdate(deps)).rejects.toThrow(/HTTP 500/);
  });
});

test("runUpdate rolls back when the post-swap smoke test fails", async () => {
  await withScratchDir("mssh-update-test-", async (dir) => {
    const archive = buildZipWithBinary("mssh", Buffer.from("new mssh binary"));
    const archiveName_ = archiveName("0.1.6", "linux", "x64");
    const checksum = `${createHash("sha256").update(archive).digest("hex")}  ${archiveName_}\n`;

    const routes = new Map<string, () => Response>([
      [
        RELEASE_URL,
        () =>
          Response.json({
            tag_name: "v0.1.6",
            assets: [
              { name: archiveName_, browser_download_url: ARCHIVE_URL },
              { name: "checksum.txt", browser_download_url: CHECKSUM_URL },
            ],
          }),
      ],
      [ARCHIVE_URL, () => new Response(archive)],
      [CHECKSUM_URL, () => new Response(checksum)],
    ]);

    let rolledBack = false;
    let committed = false;
    const deps = baseDeps(dir, {
      fetchFn: fakeFetch(routes),
      verify: () => ({ ok: false, stdout: "" }),
      replace: () => ({
        commit: () => {
          committed = true;
        },
        rollback: () => {
          rolledBack = true;
        },
      }),
    });

    await expect(runUpdate(deps)).rejects.toThrow(/smoke test/);
    expect(rolledBack).toBe(true);
    expect(committed).toBe(false);
  });
});

test("runUpdate rolls back on a substring-only version match, not just an exact match", async () => {
  await withScratchDir("mssh-update-test-", async (dir) => {
    const archive = buildZipWithBinary("mssh", Buffer.from("new mssh binary"));
    const archiveName_ = archiveName("0.1.6", "linux", "x64");
    const checksum = `${createHash("sha256").update(archive).digest("hex")}  ${archiveName_}\n`;

    const routes = new Map<string, () => Response>([
      [
        RELEASE_URL,
        () =>
          Response.json({
            tag_name: "v0.1.6",
            assets: [
              { name: archiveName_, browser_download_url: ARCHIVE_URL },
              { name: "checksum.txt", browser_download_url: CHECKSUM_URL },
            ],
          }),
      ],
      [ARCHIVE_URL, () => new Response(archive)],
      [CHECKSUM_URL, () => new Response(checksum)],
    ]);

    let rolledBack = false;
    const deps = baseDeps(dir, {
      fetchFn: fakeFetch(routes),
      // "v0.1.60" is a substring-match for "v0.1.6" but not the same version.
      verify: () => ({ ok: true, stdout: "MSSH v0.1.60\n" }),
      replace: () => ({
        commit: () => {
          throw new Error("commit should not run on a bad version match");
        },
        rollback: () => {
          rolledBack = true;
        },
      }),
    });

    await expect(runUpdate(deps)).rejects.toThrow(/smoke test/);
    expect(rolledBack).toBe(true);
  });
});

test("runUpdate reports both failures when rollback itself throws after a failed smoke test", async () => {
  await withScratchDir("mssh-update-test-", async (dir) => {
    const archive = buildZipWithBinary("mssh", Buffer.from("new mssh binary"));
    const archiveName_ = archiveName("0.1.6", "linux", "x64");
    const checksum = `${createHash("sha256").update(archive).digest("hex")}  ${archiveName_}\n`;

    const routes = new Map<string, () => Response>([
      [
        RELEASE_URL,
        () =>
          Response.json({
            tag_name: "v0.1.6",
            assets: [
              { name: archiveName_, browser_download_url: ARCHIVE_URL },
              { name: "checksum.txt", browser_download_url: CHECKSUM_URL },
            ],
          }),
      ],
      [ARCHIVE_URL, () => new Response(archive)],
      [CHECKSUM_URL, () => new Response(checksum)],
    ]);

    const deps = baseDeps(dir, {
      fetchFn: fakeFetch(routes),
      verify: () => ({ ok: false, stdout: "" }),
      replace: () => ({
        commit: () => {},
        rollback: () => {
          throw new Error("disk full");
        },
      }),
    });

    let caught: Error | undefined;
    try {
      await runUpdate(deps);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/smoke test/);
    expect(caught?.message).toMatch(/disk full/);
  });
});

test("runUpdate rejects a non-https download URL before ever fetching it", async () => {
  await withScratchDir("mssh-update-test-", async (dir) => {
    const archiveName_ = archiveName("0.1.6", "linux", "x64");
    const insecureUrl = "http://example.invalid/archive.zip";
    let archiveFetched = false;

    const routes = new Map<string, () => Response>([
      [
        RELEASE_URL,
        () =>
          Response.json({
            tag_name: "v0.1.6",
            assets: [
              { name: archiveName_, browser_download_url: insecureUrl },
              { name: "checksum.txt", browser_download_url: CHECKSUM_URL },
            ],
          }),
      ],
      [insecureUrl, () => ((archiveFetched = true), new Response(""))],
      [CHECKSUM_URL, () => new Response("")],
    ]);

    const deps = baseDeps(dir, { fetchFn: fakeFetch(routes) });
    await expect(runUpdate(deps)).rejects.toThrow(/https/);
    expect(archiveFetched).toBe(false);
  });
});

test("runUpdate fails clearly when tag_name is present but not a string", async () => {
  await withScratchDir("mssh-update-test-", async (dir) => {
    const routes = new Map<string, () => Response>([[RELEASE_URL, () => Response.json({ tag_name: 7, assets: [] })]]);
    const deps = baseDeps(dir, { fetchFn: fakeFetch(routes) });
    await expect(runUpdate(deps)).rejects.toThrow(/missing tag_name/);
  });
});

test("binaryName is used to pick the archive entry", () => {
  expect(binaryName("linux")).toBe("mssh");
  expect(binaryName("win32")).toBe("mssh.exe");
});
