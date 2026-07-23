#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  link,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const safeIdentityPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,126}[A-Za-z0-9])?$/;
const publicDnsHostPattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const controlledFilenamePattern = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,179}$/;
const supportedArtifactExtensions = [
  ".tar.gz",
  ".dmg",
  ".pkg",
  ".exe",
  ".msi",
  ".zip",
];
const reservedWindowsStemPattern =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const nonPublicDnsSuffixes = [
  ".example",
  ".invalid",
  ".local",
  ".localhost",
  ".onion",
  ".test",
];
const strongEtagPattern = /^"(?:[\u0021\u0023-\u007e\u0080-\u00ff]*)"$/u;
const sha256Pattern = /^[a-fA-F0-9]{64}$/;
const defaultMaximumBytes = 32 * 1024 * 1024 * 1024;
const defaultMaximumRedirects = 5;
const defaultOrphanLockGraceMs = 30_000;
const defaultConnectTimeoutMs = 15_000;
const defaultHeadersTimeoutMs = 60_000;
const defaultIdleTimeoutMs = 60_000;
const defaultOverallTimeoutMs = 30 * 60_000;
const maximumRequestFileBytes = 64 * 1024;
const allowedArtifactRequestKeys = new Set([
  "url",
  "artifactId",
  "version",
  "architecture",
  "allowedHosts",
  "publisherSha256",
  "sourceMode",
]);

export class ArtifactCacheError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage);
    this.name = "ArtifactCacheError";
    this.code = code;
  }
}

export async function readArtifactRequestFile(requestPath) {
  if (
    typeof requestPath !== "string" ||
    requestPath.trim().length === 0 ||
    requestPath.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(requestPath)
  ) {
    throw cacheError(
      "invalid-request-path",
      "artifact request path is invalid",
    );
  }

  let absolutePath;
  try {
    absolutePath = resolve(requestPath);
  } catch {
    throw cacheError(
      "invalid-request-path",
      "artifact request path is invalid",
    );
  }

  let handle;
  let raw;
  try {
    const before = await lstat(absolutePath);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size < 1 ||
      before.size > maximumRequestFileBytes
    ) {
      throw cacheError(
        "unsafe-request-path",
        "artifact request must be a bounded regular file",
      );
    }
    const canonical = await realpath(absolutePath);
    if (
      normalizeFilesystemPath(canonical) !==
      normalizeFilesystemPath(absolutePath)
    ) {
      throw cacheError(
        "unsafe-request-path",
        "artifact request must not resolve through a redirected path",
      );
    }
    handle = await open(absolutePath, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw cacheError(
        "unsafe-request-path",
        "artifact request changed during validation",
      );
    }
    raw = await handle.readFile("utf8");
    const after = await lstat(absolutePath);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      !sameFileIdentity(opened, after) ||
      Buffer.byteLength(raw, "utf8") !== after.size
    ) {
      throw cacheError(
        "unsafe-request-path",
        "artifact request changed during validation",
      );
    }
  } catch (error) {
    if (error instanceof ArtifactCacheError) throw error;
    throw cacheError(
      "request-read-failed",
      "artifact request file could not be read",
    );
  } finally {
    await handle?.close().catch(() => {});
  }

  if (
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(raw) ||
    /[a-z][a-z0-9+.-]*:\/\/[^/\s:@"]+:[^/\s@"]+@/iu.test(raw) ||
    /"(?:password|passwd|token|secret|credential|subscription|private.?key|api.?key)"\s*:/iu.test(
      raw,
    )
  ) {
    throw cacheError(
      "secret-bearing-request",
      "artifact request contains forbidden secret-like content",
    );
  }

  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    throw cacheError(
      "invalid-request-json",
      "artifact request JSON is invalid",
    );
  }
  if (
    !isPlainObject(request) ||
    Object.keys(request).some(
      (key) => !allowedArtifactRequestKeys.has(key),
    )
  ) {
    throw cacheError(
      "invalid-request-schema",
      "artifact request contains unsupported fields",
    );
  }
  validateArtifactRequest(request);
  return request;
}

export function validateArtifactRequest(request) {
  if (!isPlainObject(request)) {
    throw cacheError("invalid-request", "artifact request must be an object");
  }

  const artifactId = validateIdentityPart(
    request.artifactId,
    "artifact identity",
  );
  const version = validateIdentityPart(request.version, "version");
  const architecture = validateIdentityPart(
    request.architecture,
    "architecture",
  );
  const sourceMode = request.sourceMode ?? "canonical";
  if (!["canonical", "signed-download"].includes(sourceMode)) {
    throw cacheError(
      "invalid-source-mode",
      "source mode must be canonical or signed-download",
    );
  }
  const allowedHosts = validateAllowedHosts(request.allowedHosts);
  const sourceUrl = validateHttpsUrl(
    request.url,
    new Set(allowedHosts),
    "host-not-allowed",
    sourceMode,
    false,
  );
  const filename = extractArtifactFilename(sourceUrl);

  let publisherSha256 = null;
  if (request.publisherSha256 !== undefined && request.publisherSha256 !== null) {
    if (
      typeof request.publisherSha256 !== "string" ||
      !sha256Pattern.test(request.publisherSha256)
    ) {
      throw cacheError(
        "invalid-publisher-digest",
        "publisher SHA-256 must contain exactly 64 hexadecimal characters",
      );
    }
    publisherSha256 = request.publisherSha256.toLowerCase();
  }

  return {
    sourceUrl,
    artifactId,
    version,
    architecture,
    filename,
    sourceMode,
    allowedHosts,
    publisherSha256,
  };
}

export async function fetchArtifact(
  request,
  {
    cacheRoot = join(homedir(), ".dawn-forge", "artifacts"),
    fetchImpl = defaultHttpsFetch,
    restartFetchImpl = fetchImpl,
    maximumBytes = defaultMaximumBytes,
    maximumRedirects = defaultMaximumRedirects,
    orphanLockGraceMs = defaultOrphanLockGraceMs,
    connectTimeoutMs = defaultConnectTimeoutMs,
    headersTimeoutMs = defaultHeadersTimeoutMs,
    idleTimeoutMs = defaultIdleTimeoutMs,
    overallTimeoutMs = defaultOverallTimeoutMs,
    processIsAlive = defaultProcessIsAlive,
  } = {},
) {
  const normalized = validateArtifactRequest(request);
  validateDependencies({
    cacheRoot,
    fetchImpl,
    restartFetchImpl,
    maximumBytes,
    maximumRedirects,
    orphanLockGraceMs,
    connectTimeoutMs,
    headersTimeoutMs,
    idleTimeoutMs,
    overallTimeoutMs,
    processIsAlive,
  });

  const requestDigest = digestRequest(normalized);
  const paths = cachePaths(
    resolve(cacheRoot),
    requestDigest,
    normalized.filename,
  );
  await ensureSafeCacheDirectory(paths.cacheRoot);
  await ensureSafeCacheDirectory(paths.lockRoot);

  const owner = await acquireOwnerLock(paths, {
    orphanLockGraceMs,
    processIsAlive,
  });
  if (owner === null) {
    return {
      status: "existing-owner",
      requestDigest,
      filename: normalized.filename,
      publisherDigestMatched: false,
      publisherVerified: false,
    };
  }

  let overallTimer = null;
  let timeoutContext = null;
  try {
    const cacheHit = await readVerifiedCacheHit(
      paths,
      normalized,
      requestDigest,
    );
    if (cacheHit !== null) return cacheHit;

    const resume = await readResumeCandidate(paths, requestDigest);
    const allowedHostSet = new Set(normalized.allowedHosts);
    const overallController = new AbortController();
    const deadline = Date.now() + overallTimeoutMs;
    overallTimer = setTimeout(
      () => overallController.abort(),
      overallTimeoutMs,
    );
    timeoutContext = {
      connectTimeoutMs,
      headersTimeoutMs,
      idleTimeoutMs,
      deadline,
      signal: overallController.signal,
    };
    let response;
    let append = false;
    let initialSize = 0;

    if (resume !== null) {
      response = await requestResponse({
        fetchImpl,
        sourceUrl: normalized.sourceUrl,
        allowedHostSet,
        maximumRedirects,
        sourceMode: normalized.sourceMode,
        timeoutContext,
        headers: {
          Range: `bytes=${resume.size}-`,
          "If-Range": resume.etag,
        },
      });

      if (isSafePartialResponse(response, resume)) {
        append = true;
        initialSize = resume.size;
      } else if (response.status === 200) {
        await removePartialMetadata(paths);
      } else {
        await removePartialFiles(paths);
        response = await requestResponse({
          fetchImpl: restartFetchImpl,
          sourceUrl: normalized.sourceUrl,
          allowedHostSet,
          maximumRedirects,
          sourceMode: normalized.sourceMode,
          timeoutContext,
          headers: {},
        });
      }
    } else {
      response = await requestResponse({
        fetchImpl,
        sourceUrl: normalized.sourceUrl,
        allowedHostSet,
        maximumRedirects,
        sourceMode: normalized.sourceMode,
        timeoutContext,
        headers: {},
      });
    }

    if ((!append && response.status !== 200) || (append && response.status !== 206)) {
      throw cacheError(
        "unexpected-http-status",
        "artifact server returned an unsupported HTTP status",
      );
    }

    const transfer = transferDescription(response, {
      append,
      initialSize,
      maximumBytes,
    });
    await writePartialMetadata(paths, {
      schemaVersion: 1,
      requestDigest,
      etag: transfer.etag,
      expectedTotal: transfer.expectedTotal,
    });

    const downloadedSize = await streamResponseToPartial(
      response,
      paths.partialPath,
      {
        append,
        initialSize,
        expectedSegmentBytes: transfer.expectedSegmentBytes,
        expectedTotal: transfer.expectedTotal,
        maximumBytes,
        timeoutContext,
      },
    );
    throwIfOverallTimedOut(timeoutContext);
    const localSha256 = await hashFile(paths.partialPath);
    throwIfOverallTimedOut(timeoutContext);

    if (
      normalized.publisherSha256 !== null &&
      localSha256 !== normalized.publisherSha256
    ) {
      await removePartialFiles(paths);
      throw cacheError(
        "publisher-digest-mismatch",
        "downloaded artifact does not match the expected SHA-256",
      );
    }

    await ensureSafeCacheDirectory(paths.entryPath);
    await rename(paths.partialPath, paths.artifactPath);
    const metadata = {
      schemaVersion: 2,
      requestDigest,
      artifactId: normalized.artifactId,
      version: normalized.version,
      architecture: normalized.architecture,
      sourceHost: normalized.sourceUrl.hostname.toLowerCase(),
      sourceMode: normalized.sourceMode,
      allowedHosts: [...normalized.allowedHosts],
      filename: normalized.filename,
      size: downloadedSize,
      sha256: localSha256,
      publisherSha256: normalized.publisherSha256,
      publisherDigestMatched: normalized.publisherSha256 !== null,
      publisherVerified: false,
      cachedAt: new Date().toISOString(),
    };
    await writeJsonAtomically(paths.metadataPath, metadata);
    await removePartialMetadata(paths);

    return publicResult("downloaded", paths.artifactPath, metadata);
  } finally {
    if (overallTimer !== null) clearTimeout(overallTimer);
    await releaseOwnerLock(paths, owner);
  }
}

function validateDependencies({
  cacheRoot,
  fetchImpl,
  restartFetchImpl,
  maximumBytes,
  maximumRedirects,
  orphanLockGraceMs,
  connectTimeoutMs,
  headersTimeoutMs,
  idleTimeoutMs,
  overallTimeoutMs,
  processIsAlive,
}) {
  if (typeof cacheRoot !== "string" || cacheRoot.trim().length === 0) {
    throw cacheError("invalid-cache-root", "cache root must be a path");
  }
  if (typeof fetchImpl !== "function" || typeof restartFetchImpl !== "function") {
    throw cacheError("invalid-fetch", "a fetch implementation is required");
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    !Number.isSafeInteger(maximumRedirects) ||
    maximumRedirects < 0 ||
    maximumRedirects > 20 ||
    !Number.isSafeInteger(orphanLockGraceMs) ||
    orphanLockGraceMs < 1_000 ||
    !isPositiveTimeout(connectTimeoutMs) ||
    !isPositiveTimeout(headersTimeoutMs) ||
    !isPositiveTimeout(idleTimeoutMs) ||
    !isPositiveTimeout(overallTimeoutMs) ||
    typeof processIsAlive !== "function"
  ) {
    throw cacheError("invalid-option", "artifact cache options are invalid");
  }
}

function validateIdentityPart(value, label) {
  if (
    typeof value !== "string" ||
    !safeIdentityPattern.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw cacheError(
      "invalid-artifact-identity",
      `${label} is not a safe cache identity`,
    );
  }
  return value;
}

function validateAllowedHosts(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw cacheError(
      "invalid-host-allowlist",
      "an explicit host allowlist is required",
    );
  }

  const normalized = value.map((host) => {
    if (
      typeof host !== "string" ||
      host !== host.toLowerCase() ||
      host.length > 253 ||
      !publicDnsHostPattern.test(host) ||
      nonPublicDnsSuffixes.some((suffix) => host.endsWith(suffix))
    ) {
      throw cacheError(
        "invalid-host-allowlist",
        "host allowlist contains an invalid hostname",
      );
    }
    return host;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw cacheError(
      "invalid-host-allowlist",
      "host allowlist must not contain duplicates",
    );
  }
  return [...normalized].sort();
}

function validateHttpsUrl(
  value,
  allowedHostSet,
  disallowedHostCode,
  sourceMode,
  isRedirect,
) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw cacheError("invalid-source-url", "artifact source URL is invalid");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw cacheError("invalid-source-url", "artifact source URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    (parsed.port !== "" && parsed.port !== "443")
  ) {
    throw cacheError(
      "invalid-source-url",
      "artifact source must be credential-free HTTPS without a fragment",
    );
  }
  if (parsed.search !== "") {
    if (!isRedirect || sourceMode !== "signed-download") {
      throw cacheError(
        "invalid-source-url",
        "only a signed HTTPS redirect may contain a query",
      );
    }
    validateSignedQuery(parsed.search);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!allowedHostSet.has(hostname)) {
    throw cacheError(
      disallowedHostCode,
      "artifact source host is not explicitly allowed",
    );
  }
  return parsed;
}

function validateSignedQuery(search) {
  const rawQuery = search.slice(1);
  if (
    rawQuery.length < 1 ||
    rawQuery.length > 4096 ||
    /%(?![0-9A-Fa-f]{2})/.test(rawQuery)
  ) {
    throw cacheError(
      "invalid-signed-query",
      "signed-download query is not structurally valid",
    );
  }

  const parameters = new URLSearchParams(rawQuery);
  const names = new Set();
  let count = 0;
  for (const [name, value] of parameters) {
    count += 1;
    if (
      count > 32 ||
      !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(name) ||
      value.length < 1 ||
      value.length > 2048 ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      names.has(name)
    ) {
      throw cacheError(
        "invalid-signed-query",
        "signed-download query is not structurally valid",
      );
    }
    names.add(name);
  }
  if (count === 0) {
    throw cacheError(
      "invalid-signed-query",
      "signed-download query must contain at least one parameter",
    );
  }
}

function extractArtifactFilename(sourceUrl) {
  const encodedFilename = sourceUrl.pathname.split("/").at(-1);
  if (!encodedFilename) {
    throw cacheError(
      "invalid-artifact-filename",
      "artifact URL must end with a supported installer filename",
    );
  }

  let filename;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    throw cacheError(
      "invalid-artifact-filename",
      "artifact URL filename is not valid percent-encoding",
    );
  }
  const lowerFilename = filename.toLowerCase();
  if (
    !controlledFilenamePattern.test(filename) ||
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    reservedWindowsStemPattern.test(filename) ||
    !supportedArtifactExtensions.some((extension) =>
      lowerFilename.endsWith(extension),
    )
  ) {
    throw cacheError(
      "invalid-artifact-filename",
      "artifact URL must end with a controlled installer filename",
    );
  }
  return filename;
}

function digestRequest(normalized) {
  const sourceUrlSha256 = createHash("sha256")
    .update(normalized.sourceUrl.href, "utf8")
    .digest("hex");
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        sourceUrlSha256,
        sourceHost: normalized.sourceUrl.hostname.toLowerCase(),
        sourceMode: normalized.sourceMode,
        allowedHosts: [...normalized.allowedHosts],
        artifactId: normalized.artifactId,
        version: normalized.version,
        architecture: normalized.architecture,
        filename: normalized.filename,
        publisherSha256: normalized.publisherSha256,
      }),
      "utf8",
    )
    .digest("hex");
}

export function artifactRequestDigest(request) {
  return digestRequest(validateArtifactRequest(request));
}

function isPositiveTimeout(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 24 * 60 * 60_000
  );
}

function cachePaths(cacheRoot, requestDigest, filename) {
  const entryPath = join(cacheRoot, requestDigest);
  return {
    cacheRoot,
    entryPath,
    requestDigest,
    lockRoot: join(cacheRoot, ".locks"),
    lockPath: join(cacheRoot, ".locks", requestDigest),
    reclaimPath: join(cacheRoot, ".locks", `${requestDigest}.reclaim`),
    artifactPath: join(entryPath, filename),
    metadataPath: join(entryPath, "metadata.json"),
    partialPath: join(cacheRoot, `${requestDigest}.partial`),
    partialMetadataPath: join(cacheRoot, `${requestDigest}.partial.json`),
  };
}

async function ensureSafeCacheDirectory(path) {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw cacheError(
        "unsafe-cache-path",
        "artifact cache directory is not a real directory",
      );
    }
  } catch (error) {
    if (error instanceof ArtifactCacheError) throw error;
    if (error.code !== "ENOENT") {
      throw cacheError(
        "unsafe-cache-path",
        "artifact cache directory cannot be inspected",
      );
    }
    await assertSafeExistingParent(path);
    await mkdir(path, { recursive: true, mode: 0o700 });
  }

  const published = await lstat(path);
  if (published.isSymbolicLink() || !published.isDirectory()) {
    throw cacheError(
      "unsafe-cache-path",
      "artifact cache directory changed during validation",
    );
  }
  const canonical = await realpath(path);
  if (
    normalizeFilesystemPath(canonical) !==
    normalizeFilesystemPath(resolve(path))
  ) {
    throw cacheError(
      "unsafe-cache-path",
      "artifact cache directory resolves through a redirected path",
    );
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function assertSafeExistingParent(path) {
  let candidate = dirname(resolve(path));
  for (;;) {
    try {
      const parentStat = await lstat(candidate);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        throw cacheError(
          "unsafe-cache-path",
          "artifact cache parent is not a real directory",
        );
      }
      const canonical = await realpath(candidate);
      if (
        normalizeFilesystemPath(canonical) !==
        normalizeFilesystemPath(candidate)
      ) {
        throw cacheError(
          "unsafe-cache-path",
          "artifact cache parent resolves through a redirected path",
        );
      }
      return;
    } catch (error) {
      if (error instanceof ArtifactCacheError) throw error;
      if (error.code !== "ENOENT") {
        throw cacheError(
          "unsafe-cache-path",
          "artifact cache parent cannot be inspected",
        );
      }
    }
    const next = dirname(candidate);
    if (next === candidate) {
      throw cacheError(
        "unsafe-cache-path",
        "artifact cache parent cannot be established",
      );
    }
    candidate = next;
  }
}

function normalizeFilesystemPath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

async function acquireOwnerLock(
  paths,
  { orphanLockGraceMs, processIsAlive },
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const publishedOwner = await publishOwnerCandidate(paths);
    if (publishedOwner !== null) return publishedOwner;

    const existingOwner = await inspectExistingOwner(paths, {
      orphanLockGraceMs,
      processIsAlive,
    });
    if (existingOwner.missing) continue;
    if (!existingOwner.stale) return null;

    const reclaimOwner = await publishJsonLock(
      paths.reclaimPath,
      paths.lockRoot,
      `${paths.requestDigest}.reclaim`,
    );
    if (reclaimOwner === null) return null;
    try {
      const recheckedOwner = await inspectExistingOwner(paths, {
        orphanLockGraceMs,
        processIsAlive,
      });
      if (recheckedOwner.missing) {
        return publishOwnerCandidate(paths, { ignoreReclaimGuard: true });
      }
      if (
        !recheckedOwner.stale ||
        !(await existingOwnerStillMatches(paths, recheckedOwner))
      ) {
        return null;
      }
      await rm(paths.lockPath, { recursive: true, force: true });
      return publishOwnerCandidate(paths, { ignoreReclaimGuard: true });
    } finally {
      await releasePublishedLock(paths.reclaimPath, reclaimOwner);
    }
  }
  return null;
}

async function publishOwnerCandidate(
  paths,
  { ignoreReclaimGuard = false } = {},
) {
  if (!ignoreReclaimGuard) {
    try {
      await stat(paths.reclaimPath);
      return null;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw cacheError("cache-lock-failed", "artifact cache lock failed");
      }
    }
  }
  return publishJsonLock(
    paths.lockPath,
    paths.lockRoot,
    paths.requestDigest,
  );
}

async function publishJsonLock(lockPath, lockRoot, candidatePrefix) {
  const nonce = randomUUID();
  const candidatePath = join(
    lockRoot,
    `.${candidatePrefix}.${process.pid}.${nonce}.candidate`,
  );
  try {
    const owner = {
      schemaVersion: 1,
      pid: process.pid,
      nonce,
      startedAt: new Date().toISOString(),
    };
    await writeJsonAtomically(candidatePath, owner);
    try {
      await link(candidatePath, lockPath);
      return owner;
    } catch {
      try {
        await stat(lockPath);
        return null;
      } catch {
        // The canonical lock did not appear, so this was not lock contention.
      }
      throw cacheError("cache-lock-failed", "artifact cache lock failed");
    }
  } finally {
    await rm(candidatePath, { recursive: true, force: true }).catch(() => {});
  }
}

async function inspectExistingOwner(
  paths,
  { orphanLockGraceMs, processIsAlive },
) {
  const [owner, lockStat] = await Promise.all([
    readLockOwner(paths),
    stat(paths.lockPath).catch(() => null),
  ]);
  if (lockStat === null) {
    return { missing: true, stale: true, ownerText: null, mtimeMs: null };
  }

  if (
    isPlainObject(owner) &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid >= 1
  ) {
    if (owner.pid === process.pid) {
      return {
        missing: false,
        stale: false,
        ownerText: JSON.stringify(owner),
        mtimeMs: lockStat.mtimeMs,
      };
    }
    let alive = true;
    try {
      alive = processIsAlive(owner.pid);
    } catch {
      alive = true;
    }
    return {
      missing: false,
      stale: !alive,
      ownerText: JSON.stringify(owner),
      mtimeMs: lockStat.mtimeMs,
    };
  }

  return {
    missing: false,
    stale: Date.now() - lockStat.mtimeMs >= orphanLockGraceMs,
    ownerText: null,
    mtimeMs: lockStat.mtimeMs,
  };
}

async function existingOwnerStillMatches(paths, inspected) {
  const lockStat = await stat(paths.lockPath).catch(() => null);
  if (lockStat === null || lockStat.mtimeMs !== inspected.mtimeMs) return false;
  const owner = await readLockOwner(paths);
  const ownerText = isPlainObject(owner) ? JSON.stringify(owner) : null;
  return ownerText === inspected.ownerText;
}

async function releaseOwnerLock(paths, expectedOwner) {
  const owner = await readLockOwner(paths);
  if (
    isPlainObject(owner) &&
    owner.pid === process.pid &&
    owner.nonce === expectedOwner.nonce
  ) {
    await rm(paths.lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function releasePublishedLock(lockPath, expectedOwner) {
  const owner = await readJson(lockPath);
  if (
    isPlainObject(owner) &&
    owner.pid === process.pid &&
    owner.nonce === expectedOwner.nonce
  ) {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function readLockOwner(paths) {
  const currentOwner = await readJson(paths.lockPath);
  if (currentOwner !== null) return currentOwner;
  return readJson(join(paths.lockPath, "owner.json"));
}

function defaultProcessIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readVerifiedCacheHit(paths, normalized, requestDigest) {
  const metadata = await readJson(paths.metadataPath);
  if (!isValidCacheMetadata(metadata, normalized, requestDigest)) {
    await removeFinalFiles(paths);
    return null;
  }

  let artifactStat;
  try {
    artifactStat = await lstat(paths.artifactPath);
  } catch {
    await removeFinalFiles(paths);
    return null;
  }
  if (
    artifactStat.isSymbolicLink() ||
    !artifactStat.isFile() ||
    artifactStat.size !== metadata.size
  ) {
    await removeFinalFiles(paths);
    return null;
  }

  const actualSha256 = await hashFile(paths.artifactPath);
  if (
    actualSha256 !== metadata.sha256 ||
    (normalized.publisherSha256 !== null &&
      actualSha256 !== normalized.publisherSha256)
  ) {
    await removeFinalFiles(paths);
    return null;
  }
  return publicResult("cache-hit", paths.artifactPath, metadata);
}

function isValidCacheMetadata(metadata, normalized, requestDigest) {
  return (
    isPlainObject(metadata) &&
    metadata.schemaVersion === 2 &&
    metadata.requestDigest === requestDigest &&
    metadata.artifactId === normalized.artifactId &&
    metadata.version === normalized.version &&
    metadata.architecture === normalized.architecture &&
    metadata.sourceHost === normalized.sourceUrl.hostname.toLowerCase() &&
    metadata.sourceMode === normalized.sourceMode &&
    Array.isArray(metadata.allowedHosts) &&
    JSON.stringify(metadata.allowedHosts) ===
      JSON.stringify(normalized.allowedHosts) &&
    metadata.filename === normalized.filename &&
    Number.isSafeInteger(metadata.size) &&
    metadata.size >= 0 &&
    typeof metadata.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(metadata.sha256) &&
    metadata.publisherSha256 === normalized.publisherSha256 &&
    metadata.publisherDigestMatched === (normalized.publisherSha256 !== null) &&
    metadata.publisherVerified === false
  );
}

async function readResumeCandidate(paths, requestDigest) {
  let partialStat;
  try {
    partialStat = await lstat(paths.partialPath);
  } catch {
    await removePartialMetadata(paths);
    return null;
  }
  const metadata = await readJson(paths.partialMetadataPath);
  if (
    partialStat.isSymbolicLink() ||
    !partialStat.isFile() ||
    partialStat.size < 1 ||
    !isPlainObject(metadata) ||
    metadata.schemaVersion !== 1 ||
    metadata.requestDigest !== requestDigest ||
    !isStrongEtag(metadata.etag) ||
    !Number.isSafeInteger(metadata.expectedTotal) ||
    metadata.expectedTotal <= partialStat.size
  ) {
    await removePartialFiles(paths);
    return null;
  }
  return {
    size: partialStat.size,
    etag: metadata.etag,
    expectedTotal: metadata.expectedTotal,
  };
}

async function requestResponse({
  fetchImpl,
  sourceUrl,
  allowedHostSet,
  maximumRedirects,
  sourceMode,
  timeoutContext,
  headers,
}) {
  let currentUrl = sourceUrl;
  for (let redirects = 0; ; redirects += 1) {
    let response;
    try {
      response = await fetchWithPhaseTimeouts(
        fetchImpl,
        currentUrl,
        {
          method: "GET",
          headers: {
            "Accept-Encoding": "identity",
            ...headers,
          },
          redirect: "manual",
        },
        timeoutContext,
      );
    } catch (error) {
      if (error instanceof ArtifactCacheError) throw error;
      throw cacheError("download-failed", "artifact request failed (URL omitted)");
    }
    if (
      response === null ||
      typeof response !== "object" ||
      !Number.isInteger(response.status) ||
      response.headers === null ||
      typeof response.headers?.get !== "function"
    ) {
      throw cacheError(
        "invalid-http-response",
        "artifact server returned an invalid response",
      );
    }

    if (!redirectStatuses.has(response.status)) return response;
    response.body?.destroy?.();
    if (redirects >= maximumRedirects) {
      throw cacheError("too-many-redirects", "artifact redirect limit exceeded");
    }

    const location = response.headers.get("location");
    if (typeof location !== "string" || location.length === 0) {
      throw cacheError(
        "invalid-redirect",
        "artifact redirect did not include a valid destination",
      );
    }
    let redirectUrl;
    try {
      redirectUrl = new URL(location, currentUrl);
    } catch {
      throw cacheError(
        "invalid-redirect",
        "artifact redirect destination is invalid",
      );
    }
    try {
      currentUrl = validateHttpsUrl(
        redirectUrl.href,
        allowedHostSet,
        "redirect-not-allowed",
        sourceMode,
        true,
      );
    } catch (error) {
      if (error instanceof ArtifactCacheError) {
        throw cacheError(
          error.code === "host-not-allowed"
            ? "redirect-not-allowed"
            : error.code,
          error.message,
        );
      }
      throw error;
    }
  }
}

function fetchWithPhaseTimeouts(
  fetchImpl,
  url,
  requestOptions,
  timeoutContext,
) {
  throwIfOverallTimedOut(timeoutContext);
  const requestController = new AbortController();

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let connected = false;
    let connectTimer;
    let headersTimer;

    const cleanup = () => {
      clearTimeout(connectTimer);
      clearTimeout(headersTimer);
      timeoutContext.signal.removeEventListener("abort", onOverallAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (code, message) => {
      requestController.abort();
      settle(rejectPromise, cacheError(code, message));
    };
    const onOverallAbort = () =>
      fail("overall-timeout", "artifact operation exceeded its overall timeout");
    const onConnected = () => {
      if (connected || settled) return;
      connected = true;
      clearTimeout(connectTimer);
    };

    timeoutContext.signal.addEventListener("abort", onOverallAbort, {
      once: true,
    });
    if (timeoutContext.signal.aborted) {
      onOverallAbort();
      return;
    }
    connectTimer = setTimeout(
      () =>
        fail(
          "connect-timeout",
          "artifact connection exceeded its timeout",
        ),
      timeoutContext.connectTimeoutMs,
    );
    headersTimer = setTimeout(
      () =>
        fail(
          "headers-timeout",
          "artifact response headers exceeded their timeout",
        ),
      timeoutContext.headersTimeoutMs,
    );

    Promise.resolve()
      .then(() =>
        fetchImpl(url, {
          ...requestOptions,
          signal: requestController.signal,
          onConnected,
        }),
      )
      .then(
        (response) => {
          onConnected();
          settle(resolvePromise, response);
        },
        (error) => {
          if (settled) return;
          if (error instanceof ArtifactCacheError) {
            requestController.abort();
            settle(rejectPromise, error);
            return;
          }
          if (timeoutContext.signal.aborted) {
            onOverallAbort();
            return;
          }
          requestController.abort();
          settle(
            rejectPromise,
            cacheError(
              "download-failed",
              "artifact request failed (URL omitted)",
            ),
          );
        },
      );
  });
}

function defaultHttpsFetch(
  url,
  { method, headers, signal, onConnected },
) {
  return new Promise((resolvePromise, rejectPromise) => {
    let responseBody = null;
    let responsePublished = false;
    let request;

    const removeAbortListener = () =>
      signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      request?.destroy();
      responseBody?.destroy();
      if (!responsePublished) {
        rejectPromise(
          cacheError("download-failed", "artifact request was aborted"),
        );
      }
    };

    try {
      request = httpsRequest(
        url,
        {
          method,
          headers,
        },
        (response) => {
          responsePublished = true;
          responseBody = response;
          onConnected();
          response.once("close", removeAbortListener);
          resolvePromise({
            status: response.statusCode,
            headers: {
              get(name) {
                const value = response.headers[name.toLowerCase()];
                if (Array.isArray(value)) return value.join(", ");
                return value === undefined ? null : String(value);
              },
            },
            body: response,
          });
        },
      );
    } catch {
      rejectPromise(
        cacheError("download-failed", "artifact request failed (URL omitted)"),
      );
      return;
    }

    request.once("socket", (socket) => {
      if (!socket.connecting) {
        onConnected();
        return;
      }
      socket.once("secureConnect", onConnected);
    });
    request.once("error", () => {
      if (!responsePublished) {
        removeAbortListener();
        rejectPromise(
          cacheError("download-failed", "artifact request failed (URL omitted)"),
        );
      }
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

function isSafePartialResponse(response, resume) {
  if (response.status !== 206) return false;
  const range = parseContentRange(response.headers.get("content-range"));
  const etag = response.headers.get("etag");
  if (
    range === null ||
    range.start !== resume.size ||
    range.total !== resume.expectedTotal ||
    etag !== resume.etag
  ) {
    return false;
  }
  const contentLength = parseContentLength(
    response.headers.get("content-length"),
  );
  return (
    contentLength === null ||
    contentLength === range.end - range.start + 1
  );
}

function transferDescription(
  response,
  { append, initialSize, maximumBytes },
) {
  const etagValue = response.headers.get("etag");
  const etag = isStrongEtag(etagValue) ? etagValue : null;
  const contentLength = parseContentLength(
    response.headers.get("content-length"),
  );
  let expectedSegmentBytes = contentLength;
  let expectedTotal =
    contentLength === null ? null : initialSize + contentLength;

  if (append) {
    const range = parseContentRange(response.headers.get("content-range"));
    if (range === null || range.start !== initialSize) {
      throw cacheError(
        "invalid-content-range",
        "artifact server returned an invalid byte range",
      );
    }
    expectedSegmentBytes = range.end - range.start + 1;
    expectedTotal = range.total;
  }

  if (expectedTotal !== null && expectedTotal > maximumBytes) {
    throw cacheError(
      "artifact-too-large",
      "artifact exceeds the configured size limit",
    );
  }
  return { etag, expectedSegmentBytes, expectedTotal };
}

async function streamResponseToPartial(
  response,
  partialPath,
  {
    append,
    initialSize,
    expectedSegmentBytes,
    expectedTotal,
    maximumBytes,
    timeoutContext,
  },
) {
  if (
    response.body === null ||
    response.body === undefined ||
    typeof response.body[Symbol.asyncIterator] !== "function"
  ) {
    throw cacheError(
      "invalid-http-response",
      "artifact response did not contain a readable body",
    );
  }

  let fileHandle;
  let segmentBytes = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      (append ? fsConstants.O_APPEND : fsConstants.O_TRUNC) |
      noFollow;
    fileHandle = await open(partialPath, flags, 0o600);
    const [handleStat, pathStat] = await Promise.all([
      fileHandle.stat(),
      lstat(partialPath),
    ]);
    if (
      !handleStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      (handleStat.ino !== 0 &&
        pathStat.ino !== 0 &&
        (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino))
    ) {
      throw cacheError(
        "unsafe-cache-path",
        "artifact partial file changed during validation",
      );
    }
    while (true) {
      const next = await readNextBodyChunk(
        iterator,
        response.body,
        timeoutContext,
      );
      if (next.done) break;
      const value = next.value;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (chunk.length === 0) continue;
      if (initialSize + segmentBytes + chunk.length > maximumBytes) {
        throw cacheError(
          "artifact-too-large",
          "artifact exceeds the configured size limit",
        );
      }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await fileHandle.write(
          chunk,
          offset,
          chunk.length - offset,
          null,
        );
        if (bytesWritten < 1) {
          throw cacheError(
            "download-failed",
            "artifact file write did not make progress",
          );
        }
        offset += bytesWritten;
      }
      segmentBytes += chunk.length;
    }
    await fileHandle.sync();
  } catch (error) {
    response.body?.destroy?.();
    try {
      Promise.resolve(iterator.return?.()).catch(() => {});
    } catch {
      // The transfer error below remains the authoritative failure.
    }
    if (error instanceof ArtifactCacheError) throw error;
    throw cacheError("download-failed", "artifact download was interrupted");
  } finally {
    await fileHandle?.close().catch(() => {});
  }

  const totalBytes = initialSize + segmentBytes;
  if (
    (expectedSegmentBytes !== null && segmentBytes !== expectedSegmentBytes) ||
    (expectedTotal !== null && totalBytes !== expectedTotal)
  ) {
    throw cacheError(
      "incomplete-download",
      "artifact response length did not match its declared length",
    );
  }
  return totalBytes;
}

function readNextBodyChunk(iterator, body, timeoutContext) {
  throwIfOverallTimedOut(timeoutContext);
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let idleTimer;

    const cleanup = () => {
      clearTimeout(idleTimer);
      timeoutContext.signal.removeEventListener("abort", onOverallAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const stopBody = () => body?.destroy?.();
    const onOverallAbort = () => {
      stopBody();
      settle(
        rejectPromise,
        cacheError(
          "overall-timeout",
          "artifact operation exceeded its overall timeout",
        ),
      );
    };

    timeoutContext.signal.addEventListener("abort", onOverallAbort, {
      once: true,
    });
    if (timeoutContext.signal.aborted) {
      onOverallAbort();
      return;
    }
    idleTimer = setTimeout(() => {
      stopBody();
      settle(
        rejectPromise,
        cacheError(
          "idle-timeout",
          "artifact response body exceeded its idle timeout",
        ),
      );
    }, timeoutContext.idleTimeoutMs);

    Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => settle(resolvePromise, result),
        (error) => {
          if (settled) return;
          if (error instanceof ArtifactCacheError) {
            settle(rejectPromise, error);
            return;
          }
          settle(
            rejectPromise,
            cacheError("download-failed", "artifact download was interrupted"),
          );
        },
      );
  });
}

function throwIfOverallTimedOut(timeoutContext) {
  if (
    timeoutContext.signal.aborted ||
    Date.now() >= timeoutContext.deadline
  ) {
    throw cacheError(
      "overall-timeout",
      "artifact operation exceeded its overall timeout",
    );
  }
}

function parseContentLength(value) {
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw cacheError(
      "invalid-content-length",
      "artifact server returned an invalid content length",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw cacheError(
      "invalid-content-length",
      "artifact server returned an invalid content length",
    );
  }
  return parsed;
}

function parseContentRange(value) {
  if (typeof value !== "string") return null;
  const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(value);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) {
    return null;
  }
  return { start, end, total };
}

function isStrongEtag(value) {
  return typeof value === "string" && strongEtagPattern.test(value);
}

async function hashFile(path) {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch {
    throw cacheError("cache-read-failed", "artifact cache file could not be read");
  }
  return hash.digest("hex");
}

async function readJson(path) {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${createHash("sha256")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 12)}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
  } catch {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw cacheError(
      "cache-metadata-write-failed",
      "artifact cache metadata could not be written",
    );
  }
}

async function writePartialMetadata(paths, value) {
  await writeJsonAtomically(paths.partialMetadataPath, value);
}

async function removePartialMetadata(paths) {
  await rm(paths.partialMetadataPath, { force: true }).catch(() => {});
}

async function removePartialFiles(paths) {
  await Promise.all([
    rm(paths.partialPath, { force: true }).catch(() => {}),
    rm(paths.partialMetadataPath, { force: true }).catch(() => {}),
  ]);
}

async function removeFinalFiles(paths) {
  await Promise.all([
    rm(paths.artifactPath, { force: true }).catch(() => {}),
    rm(paths.metadataPath, { force: true }).catch(() => {}),
  ]);
}

function publicResult(status, path, metadata) {
  return {
    status,
    requestDigest: metadata.requestDigest,
    artifactId: metadata.artifactId,
    version: metadata.version,
    architecture: metadata.architecture,
    sourceHost: metadata.sourceHost,
    sourceMode: metadata.sourceMode,
    filename: metadata.filename,
    path,
    size: metadata.size,
    sha256: metadata.sha256,
    publisherDigestMatched: metadata.publisherDigestMatched,
    publisherVerified: metadata.publisherVerified,
  };
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function cacheError(code, safeMessage) {
  return new ArtifactCacheError(code, safeMessage);
}

export function parseArguments(argv) {
  if (
    (argv.length === 1 && ["--help", "help"].includes(argv[0])) ||
    (argv.length === 2 && argv[0] === "fetch" && argv[1] === "--help")
  ) {
    return { help: true };
  }
  if (argv[0] === "fetch") {
    if (
      argv.length !== 3 ||
      argv[1] !== "--request" ||
      typeof argv[2] !== "string" ||
      argv[2].length === 0 ||
      argv[2].startsWith("--")
    ) {
      throw cacheError(
        "invalid-arguments",
        "fetch requires exactly one --request file",
      );
    }
    return {
      command: "fetch",
      requestPath: argv[2],
    };
  }
  throw cacheError(
    "invalid-arguments",
    "artifact cache requires fetch --request",
  );
}

function usage() {
  return [
    "Usage:",
    `  node "${fileURLToPath(import.meta.url)}" fetch --request <network-bootstrap-bundle/artifact-request.json>`,
    "",
    "The request file must be a bounded regular file with the controlled artifact-request schema.",
    "The command runs in the foreground and prints one secret-free JSON result.",
  ].join("\n");
}

export function formatCliError(error) {
  const code =
    error instanceof ArtifactCacheError ? error.code : "artifact-cache-failed";
  const message =
    error instanceof ArtifactCacheError
      ? error.message
      : "artifact cache operation failed";
  return `artifact-cache: ${code}: ${message}\n`;
}

async function runCli() {
  const argumentsValue = parseArguments(process.argv.slice(2));
  if (argumentsValue.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const request = await readArtifactRequestFile(
    argumentsValue.requestPath,
  );
  const result = await fetchArtifact(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  runCli().catch((error) => {
    process.stderr.write(formatCliError(error));
    process.exitCode = 1;
  });
}
