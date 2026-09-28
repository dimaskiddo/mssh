import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { archiveName, binaryName, CHECKSUM_FILENAME, checksumFor, stripV } from "../release/release-assets";
import { extractZipEntry } from "../release/zip";
import { replaceExecutable } from "../fs/executable";
import { isCompiledBinary } from "../core/platform";
import pkg from "../../package.json";

const RELEASES_URL = "https://api.github.com/repos/dimaskiddo/mssh/releases/latest";
const REPO_URL = "https://github.com/dimaskiddo/mssh";
const LATEST_WEB_URL = `${REPO_URL}/releases/latest`;
// Pinned host + exact tag shape: this string is spliced straight into the
// download URL below, so a redirect to another host or an unexpected path
// can't steer the download anywhere but a real dimaskiddo/mssh release.
const LATEST_REDIRECT_RE = /^https:\/\/github\.com\/dimaskiddo\/mssh\/releases\/tag\/(v\d+\.\d+\.\d+)$/;
const RELEASE_FETCH_TIMEOUT_MS = 30_000;
const ARCHIVE_FETCH_TIMEOUT_MS = 600_000;
// size cap checked after the full body is buffered, not streamed.
// Upgrade path: cap via response.body's reader.
const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const BINARY_MAX_BYTES = 512 * 1024 * 1024;
const SMOKE_TEST_TIMEOUT_MS = 10_000;

function parseVersion(v: string): [number, number, number] {
  const stripped = stripV(v);
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

// Re-exported for update.test.ts's import path.
export { checksumFor };

type ReleaseAsset = { name: string; browser_download_url: string };
type ReleaseResponse = { tag_name?: string; assets?: ReleaseAsset[] };

export function tagFromLatestRedirect(location: string | null): string | undefined {
  if (location === null) return undefined;
  return LATEST_REDIRECT_RE.exec(location)?.[1];
}

export function rateLimitHint(headers: Headers): string {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) return ` — GitHub API rate limit reached, retry after ${retryAfter} s`;
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset !== null) {
    const resetAt = new Date(Number(reset) * 1000).toISOString();
    return ` — GitHub API rate limit reached, resets at ${resetAt}`;
  }
  return "";
}

type LatestRelease = { tag: string; urlFor: (name: string) => string | undefined };

async function resolveLatest(fetchFn: typeof fetch, signal: AbortSignal): Promise<LatestRelease> {
  const res = await fetchFn(RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "mssh-update" },
    signal,
  });
  if (res.ok) {
    const release = (await res.json()) as ReleaseResponse;
    if (!release.tag_name || typeof release.tag_name !== "string") {
      throw new Error("update: release response is missing tag_name");
    }
    const assets = release.assets ?? [];
    return { tag: release.tag_name, urlFor: (name) => assets.find((a) => a.name === name)?.browser_download_url };
  }
  if (res.status !== 403 && res.status !== 429) {
    throw new Error(`could not query the latest release (HTTP ${res.status})`);
  }

  // The unauthenticated GitHub API caps out at 60 requests/hour per IP, which
  // a shared corporate NAT can exhaust — fall back to the same release page a
  // browser would hit, which isn't API rate limited.
  const fallback = await fetchFn(LATEST_WEB_URL, {
    headers: { "User-Agent": "mssh-update" },
    redirect: "manual",
    signal,
  });
  const tag = (fallback.status === 301 || fallback.status === 302) && tagFromLatestRedirect(fallback.headers.get("location"));
  if (!tag) {
    throw new Error(`could not query the latest release (HTTP ${res.status}${rateLimitHint(res.headers)}; github.com fallback also failed)`);
  }
  return { tag, urlFor: (name) => `${REPO_URL}/releases/download/${tag}/${name}` };
}

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
  if (!url.startsWith("https://")) throw new Error(`refusing a non-https download URL: ${url}`);
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`download failed for ${url} (HTTP ${res.status})`);
  // res.url is "" for a constructed Response (as in tests) — falls back to the
  // request url, which is already validated above, so there is no bypass.
  if (!(res.url || url).startsWith("https:")) throw new Error(`refusing a non-https redirect for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error(`download for ${url} exceeded the ${maxBytes}-byte limit`);
  return buf;
}

export async function runUpdate(deps: UpdateDeps = defaultDeps()): Promise<void> {
  if (!isCompiledBinary(deps.main)) {
    throw new Error("mssh update only works on a compiled release binary");
  }

  const release = await resolveLatest(deps.fetchFn, AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS));

  if (!isNewer(release.tag, deps.currentVersion)) {
    console.log(`mssh v${deps.currentVersion} is already up to date.`);
    return;
  }

  const version = stripV(release.tag);
  const archive = archiveName(version, deps.platform, deps.arch);
  const archiveUrl = release.urlFor(archive);
  const checksumUrl = release.urlFor(CHECKSUM_FILENAME);
  if (!archiveUrl) throw new Error(`release ${release.tag} has no build for ${deps.platform}/${deps.arch}`);
  if (!checksumUrl) throw new Error(`release ${release.tag} is missing ${CHECKSUM_FILENAME}`);

  console.log(`Downloading mssh ${release.tag} (${archive})...`);
  const archiveBuf = await fetchBuffer(deps.fetchFn, archiveUrl, ARCHIVE_FETCH_TIMEOUT_MS, ARCHIVE_MAX_BYTES);
  const checksumBuf = await fetchBuffer(deps.fetchFn, checksumUrl, RELEASE_FETCH_TIMEOUT_MS, 1024 * 1024);

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
  // Exact line match, not includes(): "v0.1.1" is a substring of "v0.1.10".
  const smokeOk = smoke.ok && smoke.stdout.split(/\r?\n/).some((line) => line.endsWith(` v${version}`));
  if (!smokeOk) {
    try {
      swap.rollback();
    } catch (rollbackErr) {
      const rollbackMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      throw new Error(
        `update produced a binary that failed its smoke test, and restoring ${target} failed: ${rollbackMsg}`,
      );
    }
    throw new Error(`update produced a binary that failed its smoke test; reverted ${target}`);
  }
  swap.commit();

  console.log(`Updated mssh v${deps.currentVersion} → v${version} at ${target}.`);
}
