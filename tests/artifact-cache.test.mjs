import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  ArtifactCacheError,
  fetchArtifact,
  formatCliError,
  parseArguments,
  readArtifactRequestFile,
  validateArtifactRequest,
} from "../skills/dawn-forge/scripts/artifact-cache.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "dawn-forge-artifact-cache-"));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function headers(values = {}) {
  const normalized = new Map(
    Object.entries(values).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
  return {
    get(name) {
      return normalized.get(name.toLowerCase()) ?? null;
    },
  };
}

function response(status, body, headerValues = {}) {
  return {
    status,
    headers: headers(headerValues),
    body:
      body === null
        ? null
        : (async function* streamBody() {
            yield Buffer.from(body);
          })(),
  };
}

function baseRequest(overrides = {}) {
  return {
    url: "https://downloads.example.com/releases/tool.pkg",
    artifactId: "example-tool",
    version: "1.2.3",
    architecture: "arm64",
    allowedHosts: ["downloads.example.com"],
    ...overrides,
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ArtifactCacheError);
    assert.equal(error.code, code);
    return true;
  });
}

try {
  {
    const invalidRequests = [
      [
        baseRequest({ url: "http://downloads.example.com/tool.pkg" }),
        "invalid-source-url",
      ],
      [
        baseRequest({
          url: "https://user:secret@downloads.example.com/tool.pkg",
        }),
        "invalid-source-url",
      ],
      [
        baseRequest({
          url: "https://downloads.example.com/tool.pkg?token=secret",
        }),
        "invalid-source-url",
      ],
      [
        baseRequest({ sourceMode: "uncontrolled" }),
        "invalid-source-mode",
      ],
      [
        baseRequest({
          url: "https://downloads.example.com/tool.pkg#secret",
        }),
        "invalid-source-url",
      ],
      [
        baseRequest({
          url: "https://other.example.com/tool.pkg",
        }),
        "host-not-allowed",
      ],
      [
        baseRequest({
          url: "https://downloads.example.com/tool.sh",
        }),
        "invalid-artifact-filename",
      ],
      [
        baseRequest({
          url: "https://downloads.example.com/escaped%2Ftool.pkg",
        }),
        "invalid-artifact-filename",
      ],
      [
        baseRequest({ artifactId: "../escape" }),
        "invalid-artifact-identity",
      ],
      [
        baseRequest({ publisherSha256: "not-a-digest" }),
        "invalid-publisher-digest",
      ],
    ];

    for (const [request, expectedCode] of invalidRequests) {
      assert.throws(
        () => validateArtifactRequest(request),
        (error) =>
          error instanceof ArtifactCacheError &&
          error.code === expectedCode,
      );
    }

    const invalidPublicHosts = [
      "localhost",
      "download",
      "127.0.0.1",
      "[::1]",
      "downloads.example.test",
      "downloads.example.local",
    ];
    for (const host of invalidPublicHosts) {
      assert.throws(
        () =>
          validateArtifactRequest(
            baseRequest({
              url: `https://${host}/tool.pkg`,
              allowedHosts: [host],
            }),
          ),
        (error) =>
          error instanceof ArtifactCacheError &&
          error.code === "invalid-host-allowlist",
      );
    }

    assert.equal(
      validateArtifactRequest(
        baseRequest({
          url: "https://downloads.example.com/Example%20Tool.tar.gz",
        }),
      ).filename,
      "Example Tool.tar.gz",
    );

    assert.throws(
      () =>
        validateArtifactRequest(
          baseRequest({
            sourceMode: "signed-download",
            url:
              "https://downloads.example.com/tool.pkg" +
              "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=argv-secret",
          }),
        ),
      (error) =>
        error instanceof ArtifactCacheError &&
        error.code === "invalid-source-url",
    );
    assert.equal(
      validateArtifactRequest(
        baseRequest({
          sourceMode: "signed-download",
          url: "https://downloads.example.com/tool.pkg",
        }),
      ).sourceMode,
      "signed-download",
    );
    assert.throws(
      () =>
        validateArtifactRequest(
          baseRequest({
            sourceMode: "signed-download",
            url: "https://downloads.example.com/tool.pkg?bad%ZZ=value",
          }),
        ),
      (error) =>
        error instanceof ArtifactCacheError &&
        error.code === "invalid-source-url",
    );
  }

  {
    const cacheRoot = join(temporaryRoot, "verified");
    const content = Buffer.from("signed installer bytes");
    const calls = [];
    const request = baseRequest({ publisherSha256: sha256(content) });
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      assert.equal(options.headers["Accept-Encoding"], "identity");
      return response(200, content, {
        "content-length": content.length,
        etag: '"release-1"',
      });
    };

    const downloaded = await fetchArtifact(request, { cacheRoot, fetchImpl });
    assert.equal(downloaded.status, "downloaded");
    assert.equal(downloaded.sha256, sha256(content));
    assert.equal(downloaded.publisherDigestMatched, true);
    assert.equal(downloaded.publisherVerified, false);
    assert.equal(downloaded.filename, "tool.pkg");
    assert.equal(basename(downloaded.path), "tool.pkg");
    assert.equal(readFileSync(downloaded.path, "utf8"), content.toString());
    assert.equal(
      JSON.parse(
        readFileSync(join(dirname(downloaded.path), "metadata.json"), "utf8"),
      ).filename,
      "tool.pkg",
    );
    assert.equal(calls.length, 1);

    const cacheHit = await fetchArtifact(request, {
      cacheRoot,
      fetchImpl: async () => {
        throw new Error("cache hit must not make a request");
      },
    });
    assert.equal(cacheHit.status, "cache-hit");
    assert.equal(cacheHit.sha256, downloaded.sha256);
    assert.equal(cacheHit.publisherDigestMatched, true);
    assert.equal(cacheHit.publisherVerified, false);
    assert.equal(cacheHit.filename, "tool.pkg");
  }

  {
    const cacheRoot = join(temporaryRoot, "local-digest");
    const content = Buffer.from("publisher did not publish a digest");
    const result = await fetchArtifact(baseRequest(), {
      cacheRoot,
      fetchImpl: async () =>
        response(200, content, { "content-length": content.length }),
    });
    assert.equal(result.publisherVerified, false);
    assert.equal(result.sha256, sha256(content));
    assert.equal(
      Object.values(result).some((value) =>
        String(value).includes("downloads.example.com/releases/tool.pkg"),
      ),
      false,
    );
  }

  {
    const cacheRoot = join(temporaryRoot, "digest-mismatch");
    await expectCode(
      fetchArtifact(
        baseRequest({
          publisherSha256: sha256("different publisher artifact"),
        }),
        {
          cacheRoot,
          fetchImpl: async () =>
            response(200, "tampered", { "content-length": 8 }),
        },
      ),
      "publisher-digest-mismatch",
    );
  }

  {
    const cacheRoot = join(temporaryRoot, "resume");
    const request = baseRequest();
    let firstCall = true;
    const interruptedFetch = async () => {
      assert.equal(firstCall, true);
      firstCall = false;
      return {
        status: 200,
        headers: headers({
          "content-length": 6,
          etag: '"stable-release"',
        }),
        body: (async function* interruptedBody() {
          yield Buffer.from("abc");
          throw new Error("fixture connection loss");
        })(),
      };
    };
    await expectCode(
      fetchArtifact(request, { cacheRoot, fetchImpl: interruptedFetch }),
      "download-failed",
    );

    let observedRange;
    const resumed = await fetchArtifact(request, {
      cacheRoot,
      fetchImpl: async (_url, options) => {
        observedRange = options.headers.Range;
        assert.equal(options.headers["If-Range"], '"stable-release"');
        return response(206, "def", {
          "content-length": 3,
          "content-range": "bytes 3-5/6",
          etag: '"stable-release"',
        });
      },
    });
    assert.equal(observedRange, "bytes=3-");
    assert.equal(readFileSync(resumed.path, "utf8"), "abcdef");
  }

  {
    const cacheRoot = join(temporaryRoot, "unsafe-resume");
    const request = baseRequest();
    await expectCode(
      fetchArtifact(request, {
        cacheRoot,
        fetchImpl: async () => ({
          status: 200,
          headers: headers({
            "content-length": 6,
            etag: '"old-release"',
          }),
          body: (async function* interruptedBody() {
            yield Buffer.from("old");
            throw new Error("fixture interruption");
          })(),
        }),
      }),
      "download-failed",
    );

    const requestHeaders = [];
    const restarted = await fetchArtifact(request, {
      cacheRoot,
      fetchImpl: async (_url, options) => {
        requestHeaders.push({ ...options.headers });
        return response(206, "malicious-tail", {
          "content-range": "bytes 99-112/113",
          etag: '"different-release"',
        });
      },
      restartFetchImpl: async (_url, options) => {
        requestHeaders.push({ ...options.headers });
        return response(200, "new", {
          "content-length": 3,
          etag: '"new-release"',
        });
      },
    });
    assert.equal(requestHeaders[0].Range, "bytes=3-");
    assert.equal(requestHeaders[1].Range, undefined);
    assert.equal(readFileSync(restarted.path, "utf8"), "new");
  }

  {
    const cacheRoot = join(temporaryRoot, "owner-lock");
    let releaseResponse;
    let ownerStarted;
    const ownerStartedPromise = new Promise((resolvePromise) => {
      ownerStarted = resolvePromise;
    });
    const responsePromise = new Promise((resolvePromise) => {
      releaseResponse = resolvePromise;
    });
    const first = fetchArtifact(baseRequest(), {
      cacheRoot,
      fetchImpl: async () => {
        ownerStarted();
        return responsePromise;
      },
    });
    await ownerStartedPromise;

    const startedAt = Date.now();
    const second = await fetchArtifact(baseRequest(), {
      cacheRoot,
      fetchImpl: async () => {
        throw new Error("second owner must not fetch");
      },
    });
    assert.equal(second.status, "existing-owner");
    assert.ok(Date.now() - startedAt < 500);

    releaseResponse(response(200, "one owner", { "content-length": 9 }));
    await first;
  }

  {
    const cacheRoot = join(temporaryRoot, "redirects");
    const seen = [];
    const result = await fetchArtifact(
      baseRequest({
        allowedHosts: [
          "downloads.example.com",
          "cdn.example.com",
        ],
      }),
      {
        cacheRoot,
        fetchImpl: async (url) => {
          seen.push(String(url));
          if (seen.length === 1) {
            return response(302, null, {
              location: "https://cdn.example.com/tool.pkg",
            });
          }
          return response(200, "redirected", { "content-length": 10 });
        },
      },
    );
    assert.equal(result.status, "downloaded");
    assert.equal(seen.length, 2);

    await expectCode(
      fetchArtifact(
        baseRequest({
          version: "2.0.0",
          allowedHosts: ["downloads.example.com"],
        }),
        {
          cacheRoot,
          fetchImpl: async () =>
            response(302, null, {
              location: "https://untrusted.example.com/tool.pkg",
            }),
        },
      ),
      "redirect-not-allowed",
    );

    const redirectSecret = "redirect-secret-must-not-appear";
    let redirectError;
    try {
      await fetchArtifact(
        baseRequest({ version: "3.0.0" }),
        {
          cacheRoot,
          fetchImpl: async () =>
            response(302, null, {
              location:
                `https://downloads.example.com/tool.pkg?token=${redirectSecret}`,
            }),
        },
      );
    } catch (error) {
      redirectError = error;
    }
    assert.ok(redirectError instanceof ArtifactCacheError);
    assert.equal(formatCliError(redirectError).includes(redirectSecret), false);

    const signedResult = await fetchArtifact(
      baseRequest({
        version: "4.0.0",
        sourceMode: "signed-download",
        url: "https://downloads.example.com/tool.pkg",
        allowedHosts: [
          "downloads.example.com",
          "signed-cdn.example.com",
        ],
      }),
      {
        cacheRoot,
        fetchImpl: async (url) => {
          if (String(url).includes("downloads.example.com")) {
            return response(302, null, {
              location:
                "https://signed-cdn.example.com/tool.pkg" +
                "?X-Amz-Signature=redirect-secret",
            });
          }
          return response(200, "signed", { "content-length": 6 });
        },
      },
    );
    assert.equal(signedResult.status, "downloaded");
    assert.equal(
      JSON.stringify(signedResult).includes("initial-secret"),
      false,
    );
    assert.equal(
      JSON.stringify(signedResult).includes("redirect-secret"),
      false,
    );
    const signedMetadata = readFileSync(
      join(dirname(signedResult.path), "metadata.json"),
      "utf8",
    );
    assert.equal(signedMetadata.includes("initial-secret"), false);
    assert.equal(signedMetadata.includes("redirect-secret"), false);
    assert.equal(signedMetadata.includes("https://"), false);
  }

  {
    const requestPath = join(
      temporaryRoot,
      "artifact-request.json",
    );
    const request = baseRequest({
      sourceMode: "signed-download",
    });
    writeFileSync(
      requestPath,
      `${JSON.stringify(request, null, 2)}\n`,
      "utf8",
    );
    assert.deepEqual(
      parseArguments(["fetch", "--request", requestPath]),
      {
        command: "fetch",
        requestPath,
      },
    );
    assert.deepEqual(await readArtifactRequestFile(requestPath), request);

    const unknownFieldPath = join(
      temporaryRoot,
      "artifact-request-unknown.json",
    );
    writeFileSync(
      unknownFieldPath,
      JSON.stringify({ ...request, unexpected: true }),
      "utf8",
    );
    await expectCode(
      readArtifactRequestFile(unknownFieldPath),
      "invalid-request-schema",
    );

    const secret = "request-secret-must-not-appear";
    const secretPath = join(
      temporaryRoot,
      "artifact-request-secret.json",
    );
    writeFileSync(
      secretPath,
      JSON.stringify({ ...request, token: secret }),
      "utf8",
    );
    let secretError;
    try {
      await readArtifactRequestFile(secretPath);
    } catch (error) {
      secretError = error;
    }
    assert.ok(secretError instanceof ArtifactCacheError);
    assert.equal(secretError.code, "secret-bearing-request");
    assert.equal(formatCliError(secretError).includes(secret), false);
    assert.equal(formatCliError(secretError).includes(secretPath), false);

    const invalidJsonPath = join(
      temporaryRoot,
      "artifact-request-invalid.json",
    );
    writeFileSync(invalidJsonPath, "{", "utf8");
    await expectCode(
      readArtifactRequestFile(invalidJsonPath),
      "invalid-request-json",
    );

    const redirectedPath = join(
      temporaryRoot,
      "artifact-request-link.json",
    );
    let linkCreated = false;
    try {
      symlinkSync(requestPath, redirectedPath, "file");
      linkCreated = true;
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    }
    if (linkCreated) {
      await expectCode(
        readArtifactRequestFile(redirectedPath),
        "unsafe-request-path",
      );
    }

    assert.throws(
      () => parseArguments(["fetch", "--request", requestPath, "--url", "x"]),
      (error) =>
        error instanceof ArtifactCacheError &&
        error.code === "invalid-arguments",
    );
  }

  {
    const secret = "must-not-appear";
    let error;
    try {
      parseArguments([
        "--url",
        `https://downloads.example.com/tool.pkg?token=${secret}`,
        "--artifact-id",
        "example-tool",
        "--version",
        "1.0.0",
        "--architecture",
        "arm64",
        "--allow-host",
        "downloads.example.com",
      ]);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof ArtifactCacheError);
    assert.equal(error.code, "invalid-arguments");
    const stderr = formatCliError(error);
    assert.equal(stderr.includes(secret), false);
    assert.equal(stderr.includes("?token="), false);
    assert.deepEqual(parseArguments(["--help"]), { help: true });
    assert.throws(
      () => parseArguments(["--cache-root", temporaryRoot]),
      (caught) =>
        caught instanceof ArtifactCacheError &&
        caught.code === "invalid-arguments",
    );
  }

  {
    const cacheRoot = join(temporaryRoot, "cache-identities");
    const body = Buffer.from("identity");
    const first = await fetchArtifact(baseRequest({ version: "5.0.0" }), {
      cacheRoot,
      fetchImpl: async (_url, options) => {
        options.onConnected();
        return response(200, body, { "content-length": body.length });
      },
    });
    const second = await fetchArtifact(
      baseRequest({
        version: "5.0.0",
        allowedHosts: [
          "downloads.example.com",
          "cdn.example.com",
        ],
      }),
      {
        cacheRoot,
        fetchImpl: async (_url, options) => {
          options.onConnected();
          return response(200, body, { "content-length": body.length });
        },
      },
    );
    assert.notEqual(first.requestDigest, second.requestDigest);
  }

  {
    const cacheRoot = join(temporaryRoot, "timeouts");
    await expectCode(
      fetchArtifact(baseRequest({ version: "6.0.0" }), {
        cacheRoot,
        connectTimeoutMs: 20,
        headersTimeoutMs: 100,
        idleTimeoutMs: 100,
        overallTimeoutMs: 500,
        fetchImpl: async () => new Promise(() => {}),
      }),
      "connect-timeout",
    );

    await expectCode(
      fetchArtifact(baseRequest({ version: "6.0.1" }), {
        cacheRoot,
        connectTimeoutMs: 100,
        headersTimeoutMs: 20,
        idleTimeoutMs: 100,
        overallTimeoutMs: 500,
        fetchImpl: async (_url, options) => {
          options.onConnected();
          return new Promise(() => {});
        },
      }),
      "headers-timeout",
    );

    await expectCode(
      fetchArtifact(baseRequest({ version: "6.0.2" }), {
        cacheRoot,
        connectTimeoutMs: 100,
        headersTimeoutMs: 100,
        idleTimeoutMs: 20,
        overallTimeoutMs: 500,
        fetchImpl: async (_url, options) => {
          options.onConnected();
          return {
            status: 200,
            headers: headers({ "content-length": 2 }),
            body: (async function* idleBody() {
              yield Buffer.from("a");
              await new Promise(() => {});
            })(),
          };
        },
      }),
      "idle-timeout",
    );

    await expectCode(
      fetchArtifact(baseRequest({ version: "6.0.3" }), {
        cacheRoot,
        connectTimeoutMs: 100,
        headersTimeoutMs: 100,
        idleTimeoutMs: 500,
        overallTimeoutMs: 20,
        fetchImpl: async (_url, options) => {
          options.onConnected();
          return {
            status: 200,
            headers: headers({ "content-length": 2 }),
            body: (async function* overallBody() {
              yield Buffer.from("a");
              await new Promise(() => {});
            })(),
          };
        },
      }),
      "overall-timeout",
    );
  }

  {
    const cacheRoot = join(temporaryRoot, "orphan-lock");
    const request = baseRequest({ version: "9.9.9" });
    const first = await fetchArtifact(request, {
      cacheRoot,
      fetchImpl: async () =>
        response(200, "cached", { "content-length": 6 }),
    });
    const orphanLock = join(cacheRoot, ".locks", first.requestDigest);
    mkdirSync(orphanLock, { recursive: true });

    const insideGrace = await fetchArtifact(request, {
      cacheRoot,
      orphanLockGraceMs: 30_000,
      fetchImpl: async () => {
        throw new Error("fresh owner-publication grace must not fetch");
      },
    });
    assert.equal(insideGrace.status, "existing-owner");
    assert.equal(existsSync(orphanLock), true);

    const old = new Date(Date.now() - 120_000);
    utimesSync(orphanLock, old, old);

    const recovered = await fetchArtifact(request, {
      cacheRoot,
      orphanLockGraceMs: 30_000,
      fetchImpl: async () => {
        throw new Error("verified cache hit must not redownload");
      },
    });
    assert.equal(recovered.status, "cache-hit");
    assert.equal(recovered.filename, "tool.pkg");
  }

  {
    const realRoot = join(temporaryRoot, "real-cache-root");
    const redirectedRoot = join(temporaryRoot, "redirected-cache-root");
    mkdirSync(realRoot, { recursive: true });
    let linkCreated = false;
    try {
      symlinkSync(realRoot, redirectedRoot, "junction");
      linkCreated = true;
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    }
    if (linkCreated) {
      await assert.rejects(
        fetchArtifact(baseRequest(), {
          cacheRoot: redirectedRoot,
          fetchImpl: async () =>
            response(200, "must-not-write", { "content-length": 14 }),
        }),
        (error) =>
          error instanceof ArtifactCacheError &&
          error.code === "unsafe-cache-path",
      );
      assert.equal(
        existsSync(join(realRoot, ".locks")),
        false,
        "redirected cache roots must be rejected before publishing files",
      );
    }
  }

  console.log("artifact-cache tests passed");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
