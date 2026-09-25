// Minimal zip reader for commands/update.ts: extracts exactly one named entry
// from a release archive built by `zip -j` (.scripts/release.ts). No new
// dependency — just the central directory walk over node:zlib's inflate.
//
// ponytail: no ZIP64 and no multi-disk archives — our own release archives
// are single binaries well under 4 GiB. Upgrade path: parse the ZIP64 extra
// field (0x0001) when a release archive ever needs one.
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 65535;

const ENCRYPTED_FLAG = 0x0001;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

function findEocd(buf: Buffer): number {
  const searchStart = Math.max(0, buf.length - EOCD_MIN_SIZE - EOCD_MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("zip: end-of-central-directory record not found (not a zip file, or truncated)");
}

type CentralEntry = {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function readCentralDirectory(buf: Buffer, offset: number, count: number): CentralEntry[] {
  const entries: CentralEntry[] = [];
  let pos = offset;

  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length) throw new Error("zip: central directory entry runs past end of buffer");
    if (buf.readUInt32LE(pos) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error("zip: malformed central directory (bad entry signature)");
    }

    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc32 = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error("zip: ZIP64 archives are not supported");
    }

    const nameStart = pos + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buf.length) throw new Error("zip: central directory entry name runs past end of buffer");
    const name = buf.toString("utf8", nameStart, nameEnd);

    entries.push({ name, method, flags, crc32, compressedSize, uncompressedSize, localHeaderOffset });
    pos = nameEnd + extraLength + commentLength;
  }

  return entries;
}

export function extractZipEntry(buf: Buffer, name: string, maxSize: number): Buffer {
  const eocdOffset = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = readCentralDirectory(buf, centralDirOffset, entryCount);
  const entry = entries.find((e) => e.name === name);
  if (entry === undefined) {
    throw new Error(`zip: entry "${name}" not found in archive`);
  }

  if ((entry.flags & ENCRYPTED_FLAG) !== 0) {
    throw new Error(`zip: entry "${name}" is encrypted, which is not supported`);
  }
  if (entry.uncompressedSize > maxSize) {
    throw new Error(`zip: entry "${name}" (${entry.uncompressedSize} bytes) exceeds the ${maxSize}-byte limit`);
  }

  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.length) throw new Error(`zip: local header for "${name}" runs past end of buffer`);
  if (buf.readUInt32LE(lh) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`zip: malformed local header for "${name}"`);
  }
  const localNameLength = buf.readUInt16LE(lh + 26);
  const localExtraLength = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) throw new Error(`zip: data for "${name}" runs past end of buffer`);
  const compressed = buf.subarray(dataStart, dataEnd);

  let data: Buffer;
  if (entry.method === METHOD_STORED) {
    data = Buffer.from(compressed);
  } else if (entry.method === METHOD_DEFLATE) {
    try {
      data = inflateRawSync(compressed, { maxOutputLength: maxSize });
    } catch (err) {
      throw new Error(`zip: failed to inflate "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    throw new Error(`zip: unsupported compression method ${entry.method} for "${name}"`);
  }

  if (data.length !== entry.uncompressedSize) {
    throw new Error(`zip: "${name}" inflated to ${data.length} bytes, expected ${entry.uncompressedSize}`);
  }
  if (Bun.hash.crc32(data) !== entry.crc32) {
    throw new Error(`zip: crc32 mismatch for "${name}" — archive is corrupt or tampered`);
  }

  return data;
}
