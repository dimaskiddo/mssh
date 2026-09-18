import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const STAGING_DIR = join("dist", "staging");
const DIST_DIR = "dist";

// Runs to completion with output streamed live (build/zip progress is for a
// human watching the release run) and exits the whole script on failure —
// there's no sound way to continue a release after a build step fails.
function runOrExit(argv: string[]): void {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("release: empty command");
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.error) {
    console.error(`❌ Failed to run '${argv.join(" ")}': ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`❌ '${argv.join(" ")}' exited with status ${result.status}`);
    process.exit(1);
  }
}

// Mirrors the previous `$\`…\`.nothrow().text()` pattern: empty string on any
// failure, no exception, no output printed (git plumbing output isn't for
// the user, only its parsed result is).
function captureOrEmpty(argv: string[]): string {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("release: empty command");
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) return "";
  return (result.stdout ?? "").trim();
}

let token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || process.env.PAT;
let gitTag = "";

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg) continue;

  if (arg === "--token" || arg === "-t") {
    token = process.argv[i + 1] || "";
    i++;
  } else if (!arg.startsWith("-")) {
    gitTag = arg;
  }
}

if (!token) {
  console.error("❌ Error: GitHub Personal Access Token (PAT) is not defined!");
  console.error("💡 Please set GITHUB_TOKEN, GITHUB_PAT, or PAT env variable, or pass it via: --token <PAT> / -t <PAT>");
  process.exit(1);
}

// --exact-match (not --abbrev=0) so a release only ever builds from a commit
// that IS a tag, not the nearest reachable one — otherwise an untagged
// commit publishes binaries under a stale tag name.
if (!gitTag) {
  gitTag = captureOrEmpty(["git", "describe", "--tags", "--exact-match", "HEAD"]);
}

if (!gitTag) {
  console.error("❌ Error: HEAD is not exactly at a Git tag, and no tag was provided.");
  console.info("💡 To create a release on GitHub, tag your repository first:");
  console.info("   git tag -a v1.0.0 -m \"Release v1.0.0\"");
  console.info("   bun run release v1.0.0");
  process.exit(1);
}

const gitStatus = captureOrEmpty(["git", "status", "--porcelain"]);
if (gitStatus !== "") {
  console.error("❌ Error: working tree is not clean. Commit or stash changes before releasing.");
  process.exit(1);
}

function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  if (!url) return null;
  // Non-greedy repo capture anchored to end-of-string, so a repo name that
  // itself contains a dot isn't truncated at its first one.
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url.trim());
  if (match && match[1] && match[2]) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

console.log("🧹 Cleaning staging and old archives...");
runOrExit(["bun", "run", "build:clean"]);

if (existsSync(STAGING_DIR)) {
  rmSync(STAGING_DIR, { recursive: true, force: true });
}

console.log("🏗️ Compiling standalone binaries for all platforms...");
runOrExit(["bun", "run", "build:all"]);

const filesToBundle = ["README.md", "LICENSE", ".env.example"];
for (const file of filesToBundle) {
  if (!existsSync(file)) {
    console.error(`❌ Error: ${file} is missing!`);
    process.exit(1);
  }
}

const version = gitTag.startsWith("v") ? gitTag.slice(1) : gitTag;

const targets = [
  { binary: "mssh-linux-64-bit", archive: `mssh_${version}_linux_64-bit.zip`, binName: "mssh" },
  { binary: "mssh-linux-arm64", archive: `mssh_${version}_linux_arm-64-bit.zip`, binName: "mssh" },
  { binary: "mssh-macos-64-bit", archive: `mssh_${version}_macos_64-bit.zip`, binName: "mssh" },
  { binary: "mssh-macos-arm64", archive: `mssh_${version}_macos_arm-64-bit.zip`, binName: "mssh" },
  { binary: "mssh-windows-64-bit.exe", archive: `mssh_${version}_windows_64-bit.zip`, binName: "mssh.exe" },
  { binary: "mssh-windows-arm64.exe", archive: `mssh_${version}_windows_arm-64-bit.zip`, binName: "mssh.exe" },
];

const archivesCreated: string[] = [];

console.log("📦 Creating release archives...");
for (const target of targets) {
  const binaryPath = join(DIST_DIR, target.binary);
  if (!existsSync(binaryPath)) {
    console.warn(`⚠️ Warning: Binary not found at ${binaryPath}. Skipping.`);
    continue;
  }

  const platformStaging = join(STAGING_DIR, target.archive.replace(/\.zip$/, ""));
  mkdirSync(platformStaging, { recursive: true });

  copyFileSync(binaryPath, join(platformStaging, target.binName));
  for (const file of filesToBundle) {
    copyFileSync(file, join(platformStaging, file));
  }

  const archiveOutPath = join(DIST_DIR, target.archive);
  // Explicit file list, not a shell glob: works identically with an argv
  // array and spawnSync, and is exact about what's bundled.
  const stagedFiles = [target.binName, ...filesToBundle].map((f) => join(platformStaging, f));

  const zipResult = spawnSync("zip", ["-q", "-j", archiveOutPath, ...stagedFiles], { stdio: "inherit" });
  if (zipResult.error) {
    const isMissing = (zipResult.error as NodeJS.ErrnoException).code === "ENOENT";
    console.error(isMissing ? "❌ Error: 'zip' is not installed or not on PATH." : `❌ Error running zip: ${zipResult.error.message}`);
    process.exit(1);
  }
  if (zipResult.status !== 0) {
    console.error(`❌ zip exited with status ${zipResult.status} while creating ${archiveOutPath}`);
    process.exit(1);
  }

  archivesCreated.push(target.archive);
  console.log(`✅ Created archive: ${archiveOutPath}`);
}

// A partial archive set must never reach GitHub Releases under a real tag —
// the release is created as a draft below specifically so this check (and
// any upload failure past it) can still abort before anyone sees it.
if (archivesCreated.length !== targets.length) {
  console.error(`❌ Error: only ${archivesCreated.length}/${targets.length} archives were created; aborting release.`);
  process.exit(1);
}

console.log("🔒 Calculating SHA-256 checksums...");

let checksumContent = "";
for (const archive of archivesCreated) {
  const archivePath = join(DIST_DIR, archive);
  const fileBuffer = readFileSync(archivePath);
  const hash = createHash("sha256").update(fileBuffer).digest("hex");
  checksumContent += `${hash}  ${archive}\n`;
}

const checksumFile = join(DIST_DIR, "checksum.txt");
writeFileSync(checksumFile, checksumContent);
console.log(`✅ Generated checksums file: ${checksumFile}`);

rmSync(STAGING_DIR, { recursive: true, force: true });

console.log(`🚀 Creating GitHub Release for tag: ${gitTag}...`);
try {
  const remoteUrl = captureOrEmpty(["git", "remote", "get-url", "origin"]);
  const parsed = parseGithubRemote(remoteUrl);

  if (!parsed) {
    console.error(`❌ Error: Could not determine GitHub owner and repository from remote URL: "${remoteUrl}"`);
    process.exit(1);
  }

  const { owner, repo } = parsed;
  console.log(`📡 Connecting to GitHub API for repository: ${owner}/${repo}...`);

  console.log("📝 Generating changelog from git history...");
  let changelog = "";
  const tags = captureOrEmpty(["git", "tag", "--sort=-v:refname"]).split("\n").filter(Boolean);
  const currentTagIndex = tags.indexOf(gitTag);
  if (currentTagIndex !== -1 && currentTagIndex < tags.length - 1) {
    const prevTag = tags[currentTagIndex + 1] as string;
    changelog = captureOrEmpty(["git", "log", "--oneline", `${prevTag}..${gitTag}`]);
  } else {
    changelog = captureOrEmpty(["git", "log", "--oneline", "-n", "10"]);
  }
  if (!changelog) changelog = "Initial release.";

  const authHeaders = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Bun-Release-Script",
  };

  // The release stays invisible until every asset below has uploaded
  // successfully; a failed upload leaves a draft, not a public release with
  // missing assets.
  const releaseResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: gitTag,
      name: gitTag,
      body: `## Changelog\n${changelog}`,
      draft: true,
      prerelease: false,
      generate_release_notes: false,
    }),
  });

  if (!releaseResponse.ok) {
    const errText = await releaseResponse.text();
    console.error(`❌ Failed to create release: HTTP ${releaseResponse.status} - ${errText}`);
    process.exit(1);
  }

  const releaseData = (await releaseResponse.json()) as { id: number };
  const releaseId = releaseData.id;
  console.log(`✅ Draft release created with ID: ${releaseId}`);

  const assets = [
    ...archivesCreated.map((a) => ({ name: a, path: join(DIST_DIR, a) })),
    { name: "checksum.txt", path: checksumFile },
  ];

  for (const asset of assets) {
    console.log(`📤 Uploading asset ${asset.name}...`);
    const fileData = readFileSync(asset.path);

    const uploadResponse = await fetch(
      `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${asset.name}`,
      {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/octet-stream",
          "Content-Length": fileData.byteLength.toString(),
        },
        body: fileData,
      },
    );

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text();
      console.error(`❌ Failed to upload asset ${asset.name}: HTTP ${uploadResponse.status} - ${errText}`);
      console.error(`⚠️ Release ${releaseId} remains a draft; fix the issue and re-run, or delete it on GitHub.`);
      process.exit(1);
    }
    console.log(`✅ Uploaded ${asset.name} successfully!`);
  }

  const publishResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/${releaseId}`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ draft: false }),
  });

  if (!publishResponse.ok) {
    const errText = await publishResponse.text();
    console.error(`❌ Failed to publish release: HTTP ${publishResponse.status} - ${errText}`);
    console.error(`⚠️ Release ${releaseId} remains a draft; all assets are attached, so publishing it manually on GitHub is safe.`);
    process.exit(1);
  }

  console.log(`🎉 GitHub Release successfully published for ${gitTag}!`);
} catch (err) {
  console.error(`❌ Failed to push release to GitHub: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
