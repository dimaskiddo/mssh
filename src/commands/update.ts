// `mssh update`: pulls the latest dimaskiddo/mssh release, verifies its
// checksum.txt entry, and swaps the running binary in place. Network-only —
// unlike every other command it needs no ~/.mssh, no password, no ssh.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { archiveName, binaryName } from "../release-assets";
import { extractZipEntry } from "../zip";
import { replaceExecutable } from "../secure-file";
import { isCompiledBinary } from "../sweep";
import pkg from "../../package.json";

const RELEASES_URL = "https://api.github.com/repos/dimaskiddo/mssh/releases/latest";
const RELEASE_FETCH_TIMEOUT_MS = 30_000;
const ARCHIVE_FETCH_TIMEOUT_MS = 600_000;
// ponytail: a body-size cap enforced after the full response is buffered,
// not a true streaming cap — good enough against a truncated/oversized
// asset, not against a server that ignores Content-Length and keeps
// sending. Upgrade path: cap via response.body's reader if that ever matters.
const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const BINARY_MAX_BYTES = 512 * 1024 * 1024;
const SMOKE_TEST_TIMEOUT_MS = 10_000;

function parseVersion(v: string): [number, number, number] {
  const stripped = v.startsWith("v") ? v.slice(1) : v;
  const parts = stripped.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`update: malformed version "${v}"`);
  }
  const [a, b, c] = parts as [string, string, string];
  return [Number(a), Number(b), Number(c)];
}

export function isNewer(latest: string, current: string): boolean {
  const [lMaj, lMin, lPatch] = parseVersion(latest);
  const [cMaj, cMin, cPatch] = parseVersion(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPatch > cPatch;
}

// checksum.txt lines are "<sha256 hex>  <archive name>"; release.ts writes
// exactly two whitespace-separated fields per line.
export function checksumFor(text: string, archive: string): string | undefined {
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 2) continue;
    const [hash, name] = parts as [string, string];
    if (name === archive) return hash;
  }
  return undefined;
}

type ReleaseAsset = { name: string; browser_download_url: string };
type ReleaseResponse = { tag_name?: string; assets?: ReleaseAsset[] };

export type UpdateDeps = {
  fetchFn: typeof fetch;
  execPath: string;
  main: string;
  currentVersion: string;
  platform: string;
  arch: string;
  verify: (target: string) => { ok: boolean; stdout: string };
  replace: (target: string, data: Buffer) => { commit: () => void; rollback: () => void };
};

function defaultVerify(target: string): { ok: boolean; stdout: string } {
  const result = spawnSync(target, ["--version"], { encoding: "utf8", timeout: SMOKE_TEST_TIMEOUT_MS });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

function defaultDeps(): UpdateDeps {
  return {
    fetchFn: fetch,
    execPath: process.execPath,
    main: Bun.main,
    currentVersion: pkg.version,
    platform: process.platform,
    arch: process.arch,
    verify: defaultVerify,
    replace: replaceExecutable,
  };
}

async function fetchBuffer(fetchFn: typeof fetch, url: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`download failed for ${url} (HTTP ${res.status})`);
  // res.url is "" for a constructed Response (as in tests) — only a real
  // fetch's final URL is meaningful here, so an empty one is not a redirect to flag.
  if (res.url !== "" && !res.url.startsWith("https:")) throw new Error(`refusing a non-https redirect for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error(`download for ${url} exceeded the ${maxBytes}-byte limit`);
  return buf;
}

export async function runUpdate(deps: UpdateDeps = defaultDeps()): Promise<void> {
  if (!isCompiledBinary(deps.main)) {
    throw new Error("mssh update only works on a compiled release binary");
  }

  const res = await deps.fetchFn(RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "mssh-update" },
    signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`could not query the latest release (HTTP ${res.status})`);
  const release = (await res.json()) as ReleaseResponse;
  if (!release.tag_name) throw new Error("update: release response is missing tag_name");

  if (!isNewer(release.tag_name, deps.currentVersion)) {
    console.log(`mssh v${deps.currentVersion} is already up to date.`);
    return;
  }

  const version = release.tag_name.startsWith("v") ? release.tag_name.slice(1) : release.tag_name;
  const archive = archiveName(version, deps.platform, deps.arch);
  const assets = release.assets ?? [];
  const archiveAsset = assets.find((a) => a.name === archive);
  const checksumAsset = assets.find((a) => a.name === "checksum.txt");
  if (!archiveAsset) throw new Error(`release ${release.tag_name} has no build for ${deps.platform}/${deps.arch}`);
  if (!checksumAsset) throw new Error(`release ${release.tag_name} is missing checksum.txt`);

  console.log(`Downloading mssh ${release.tag_name} (${archive})...`);
  const archiveBuf = await fetchBuffer(deps.fetchFn, archiveAsset.browser_download_url, ARCHIVE_FETCH_TIMEOUT_MS, ARCHIVE_MAX_BYTES);
  const checksumBuf = await fetchBuffer(deps.fetchFn, checksumAsset.browser_download_url, RELEASE_FETCH_TIMEOUT_MS, 1024 * 1024);

  const expected = checksumFor(checksumBuf.toString("utf8"), archive);
  const actual = createHash("sha256").update(archiveBuf).digest("hex");
  if (expected === undefined || expected !== actual) {
    throw new Error(`checksum mismatch for ${archive} — not installing`);
  }

  const binary = extractZipEntry(archiveBuf, binaryName(deps.platform), BINARY_MAX_BYTES);
  const target = realpathSync(deps.execPath);

  let swap: { commit: () => void; rollback: () => void };
  try {
    swap = deps.replace(target, binary);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`cannot replace ${target}: permission denied — re-run with elevated rights (e.g. sudo mssh update)`);
    }
    throw err;
  }

  const smoke = deps.verify(target);
  if (!smoke.ok || !smoke.stdout.includes(`v${version}`)) {
    swap.rollback();
    throw new Error(`update produced a binary that failed its smoke test; reverted ${target}`);
  }
  swap.commit();

  console.log(`Updated mssh v${deps.currentVersion} → v${version} at ${target}.`);
}
