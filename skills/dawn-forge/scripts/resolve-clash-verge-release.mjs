#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const releaseApiUrl =
  "https://api.github.com/repos/clash-verge-rev/clash-verge-rev/releases/latest";
const officialDownloadHosts = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

function usage() {
  return [
    "Usage:",
    "  node resolve-clash-verge-release.mjs --platform <macos|windows> --arch <arm64|x64> [--download-dir <directory>]",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--platform", "--arch", "--download-dir"].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    index += 1;
    if (flag === "--platform") options.platform = value;
    if (flag === "--arch") options.arch = value;
    if (flag === "--download-dir") options.downloadDir = value;
  }

  if (!["macos", "windows"].includes(options.platform)) {
    throw new Error("--platform must be 'macos' or 'windows'");
  }
  if (!["arm64", "x64"].includes(options.arch)) {
    throw new Error("--arch must be 'arm64' or 'x64'");
  }

  return options;
}

export function validateOfficialAssetUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Release asset URL is invalid");
  }

  if (url.protocol !== "https:") {
    throw new Error("Release asset URL must use HTTPS");
  }
  if (url.hostname !== "github.com") {
    throw new Error("Release metadata must point to github.com");
  }
  if (
    !url.pathname.startsWith(
      "/clash-verge-rev/clash-verge-rev/releases/download/",
    )
  ) {
    throw new Error("Release asset does not belong to the official repository");
  }

  return url;
}

export function selectAsset(release, platform, arch) {
  if (!release || typeof release !== "object") {
    throw new Error("Release metadata must be an object");
  }
  if (release.draft || release.prerelease) {
    throw new Error("Latest release is not a stable release");
  }
  if (
    typeof release.tag_name !== "string" ||
    !/^v?\d+\.\d+\.\d+$/.test(release.tag_name)
  ) {
    throw new Error("Stable release tag is missing or unsupported");
  }
  if (!Array.isArray(release.assets)) {
    throw new Error("Release assets are missing");
  }

  const matchers = {
    "macos:arm64": /^Clash[ .]Verge_.+_aarch64\.dmg$/i,
    "macos:x64": /^Clash[ .]Verge_.+_(?:x64|x86_64)\.dmg$/i,
    "windows:arm64": /^Clash[ .]Verge_.+_arm64-setup\.exe$/i,
    "windows:x64": /^Clash[ .]Verge_.+_x64-setup\.exe$/i,
  };
  const matcher = matchers[`${platform}:${arch}`];
  if (!matcher) throw new Error(`Unsupported target: ${platform}/${arch}`);

  const matches = release.assets.filter(
    (asset) =>
      asset &&
      typeof asset.name === "string" &&
      matcher.test(asset.name) &&
      !/(?:alpha|autobuild|portable|fixed[_-]?webview)/i.test(asset.name),
  );

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${platform}/${arch} asset, found ${matches.length}`,
    );
  }

  const asset = matches[0];
  validateOfficialAssetUrl(asset.browser_download_url);

  if (
    asset.digest != null &&
    !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)
  ) {
    throw new Error("Publisher digest is not a supported SHA-256 value");
  }

  return asset;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadAsset(asset, directory) {
  const outputDirectory = resolve(directory);
  const outputPath = resolve(outputDirectory, basename(asset.name));
  const temporaryPath = `${outputPath}.dawn-forge-part`;
  const publisherSha256 = asset.digest?.slice("sha256:".length).toLowerCase();

  await mkdir(outputDirectory, { recursive: true });

  try {
    await stat(outputPath);
    const existingSha256 = await sha256File(outputPath);
    if (!publisherSha256) {
      throw new Error(
        `Artifact already exists but the publisher supplied no digest: ${outputPath}`,
      );
    }
    if (existingSha256 !== publisherSha256) {
      throw new Error(`Existing artifact digest mismatch: ${outputPath}`);
    }
    return {
      localPath: outputPath,
      localSha256: existingSha256,
      publisherDigestVerified: true,
      reused: true,
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const response = await fetch(asset.browser_download_url, {
    redirect: "follow",
    headers: { "User-Agent": "dawn-forge" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Artifact download failed with HTTP ${response.status}`);
  }

  const finalUrl = new URL(response.url);
  if (
    finalUrl.protocol !== "https:" ||
    !officialDownloadHosts.has(finalUrl.hostname)
  ) {
    throw new Error(
      `Artifact redirected to an untrusted host: ${finalUrl.hostname}`,
    );
  }

  await rm(temporaryPath, { force: true });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporaryPath, { flags: "wx" }),
    );
    const localSha256 = await sha256File(temporaryPath);
    if (publisherSha256 && localSha256 !== publisherSha256) {
      throw new Error("Downloaded artifact does not match publisher SHA-256");
    }
    await rename(temporaryPath, outputPath);
    return {
      localPath: outputPath,
      localSha256,
      publisherDigestVerified: Boolean(publisherSha256),
      reused: false,
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function resolveRelease(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const response = await fetchImpl(releaseApiUrl, {
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "dawn-forge",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub Release lookup failed with HTTP ${response.status}`);
  }
  if (response.url && response.url !== releaseApiUrl) {
    throw new Error("GitHub Release API redirected unexpectedly");
  }

  const release = await response.json();
  const asset = selectAsset(release, options.platform, options.arch);
  const result = {
    repository: "clash-verge-rev/clash-verge-rev",
    release: release.tag_name,
    platform: options.platform,
    arch: options.arch,
    asset: asset.name,
    assetUrl: asset.browser_download_url,
    publisherDigest: asset.digest ?? null,
  };

  if (options.downloadDir) {
    Object.assign(result, await downloadAsset(asset, options.downloadDir));
  }

  return result;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await resolveRelease(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
