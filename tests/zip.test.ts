// Builds tiny zip archives entirely in memory (no fixtures on disk, no `zip`
// CLI) to test extractZipEntry against both the stored and deflated methods,
// and against every malformed/hostile shape it must reject.
import { test, expect } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { extractZipEntry } from "../src/zip";

type ZipEntryOpts = {
  name: string;
  data: Buffer;
  method?: 0 | 8; // 0 = stored, 8 = deflate
  flags?: number;
  localExtra?: Buffer;
  centralExtra?: Buffer;
  centralUncompressedSizeOverride?: number;
  centralCrcOverride?: number;
};

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

// Minimal single-disk zip writer covering exactly what extractZipEntry reads:
// local header + data per entry, then one central directory + EOCD.
function buildZip(entries: ZipEntryOpts[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const method = e.method ?? 8;
    const stored = method === 0 ? e.data : deflateRawSync(e.data);
    const crc = e.centralCrcOverride ?? Bun.hash.crc32(e.data);
    const uncompressedSize = e.centralUncompressedSizeOverride ?? e.data.length;
    const nameBuf = Buffer.from(e.name, "utf8");
    const localExtra = e.localExtra ?? Buffer.alloc(0);
    const centralExtra = e.centralExtra ?? Buffer.alloc(0);
    const flags = e.flags ?? 0;

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(flags),
      u16(method),
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(stored.length),
      u32(uncompressedSize),
      u16(nameBuf.length),
      u16(localExtra.length),
      nameBuf,
      localExtra,
    ]);
    localParts.push(localHeader, stored);

    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(stored.length),
      u32(uncompressedSize),
      u16(nameBuf.length),
      u16(centralExtra.length),
      u16(0), // comment length
      u16(0), // disk number start
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(offset),
      nameBuf,
      centralExtra,
    ]);
    centralParts.push(centralHeader);

    offset += localHeader.length + stored.length;
  }

  const centralDirOffset = offset;
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), // disk number
    u16(0), // disk with central dir
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(centralDirOffset),
    u16(0), // comment length
  ]);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

const MAX = 10 * 1024 * 1024;

test("extractZipEntry reads a deflated entry", () => {
  const data = Buffer.from("hello deflated world, ".repeat(50));
  const zip = buildZip([{ name: "mssh", data, method: 8 }]);
  expect(extractZipEntry(zip, "mssh", MAX)).toEqual(data);
});

test("extractZipEntry reads a stored (uncompressed) entry", () => {
  const data = Buffer.from("stored bytes");
  const zip = buildZip([{ name: "mssh", data, method: 0 }]);
  expect(extractZipEntry(zip, "mssh", MAX)).toEqual(data);
});

test("extractZipEntry picks the named entry out of several", () => {
  const zip = buildZip([
    { name: "README.md", data: Buffer.from("readme contents") },
    { name: "mssh", data: Buffer.from("the binary") },
    { name: "LICENSE", data: Buffer.from("license text") },
  ]);
  expect(extractZipEntry(zip, "mssh", MAX)).toEqual(Buffer.from("the binary"));
});

test("extractZipEntry throws when the entry is missing", () => {
  const zip = buildZip([{ name: "README.md", data: Buffer.from("readme") }]);
  expect(() => extractZipEntry(zip, "mssh", MAX)).toThrow(/mssh/);
});

test("extractZipEntry throws on an encrypted entry", () => {
  const zip = buildZip([{ name: "mssh", data: Buffer.from("secret"), flags: 0x0001 }]);
  expect(() => extractZipEntry(zip, "mssh", MAX)).toThrow(/encrypted/);
});

test("extractZipEntry throws on an unsupported compression method", () => {
  // Method 12 (BZIP2) as an arbitrary unsupported value; buildZip only ever
  // deflates or stores, so a mismatched method here is exactly the hostile case.
  const zip = buildZip([{ name: "mssh", data: Buffer.from("x"), method: 8 }]);
  const patched = Buffer.from(zip);
  const centralMethodOffset = patched.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10;
  patched.writeUInt16LE(12, centralMethodOffset);
  expect(() => extractZipEntry(patched, "mssh", MAX)).toThrow(/compression method/);
});

test("extractZipEntry throws on a CRC mismatch", () => {
  const zip = buildZip([{ name: "mssh", data: Buffer.from("x"), centralCrcOverride: 0xdeadbeef }]);
  expect(() => extractZipEntry(zip, "mssh", MAX)).toThrow(/crc/i);
});

test("extractZipEntry throws when the entry exceeds maxSize", () => {
  const data = Buffer.from("a".repeat(1000));
  const zip = buildZip([{ name: "mssh", data }]);
  expect(() => extractZipEntry(zip, "mssh", 10)).toThrow();
});

test("extractZipEntry throws on a truncated buffer", () => {
  const zip = buildZip([{ name: "mssh", data: Buffer.from("hello") }]);
  expect(() => extractZipEntry(zip.subarray(0, 10), "mssh", MAX)).toThrow();
});

test("extractZipEntry tolerates a local extra-field length that differs from the central one", () => {
  const data = Buffer.from("payload");
  const zip = buildZip([{ name: "mssh", data, localExtra: Buffer.from([1, 2, 3, 4]) }]);
  expect(extractZipEntry(zip, "mssh", MAX)).toEqual(data);
});

test("extractZipEntry throws when the declared uncompressed size does not match the inflated size", () => {
  const zip = buildZip([{ name: "mssh", data: Buffer.from("x"), centralUncompressedSizeOverride: 999 }]);
  expect(() => extractZipEntry(zip, "mssh", MAX)).toThrow();
});
