import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  parseArguments,
  transferArtifact,
  validateCachedArtifact,
} from "../skills/dawn-forge/scripts/transfer-artifact.mjs";
import { targetIdentityDigest } from "../skills/dawn-forge/scripts/target-identity.mjs";
import { artifactRequestDigest } from "../skills/dawn-forge/scripts/artifact-cache.mjs";

const root = mkdtempSync(join(tmpdir(), "dawn-forge-transfer-artifact-"));
const home = join(root, "controller home");
const config = join(home, ".ssh", "config");
const knownHosts = join(home, ".ssh", "known_hosts");
const identityFile = join(home, ".ssh", "id_ed25519");
const targetReceipt = join(
  home,
  ".dawn-forge",
  "targets",
  "mini",
  "identity.json",
);
const artifactRequest = {
  artifactId: "clash-verge",
  version: "2.4.3",
  architecture: "arm64",
  url: "https://github.com/releases/Clash%20Verge.pkg",
  allowedHosts: ["github.com"],
  sourceMode: "canonical",
};
const requestDigest = artifactRequestDigest(artifactRequest);
const cacheEntry = join(
  home,
  ".dawn-forge",
  "artifacts",
  requestDigest,
);
const metadataPath = join(cacheEntry, "metadata.json");
const artifactPath = join(cacheEntry, "Clash Verge.pkg");
const artifact = Buffer.from("signed-installer-fixture", "utf8");
const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
const bundle = join(home, ".dawn-forge", "plans", "network-bootstrap");
const miniPlanPath = join(bundle, "mini-plan.json");
const profilePath = join(bundle, "profile.json");
const artifactRequestPath = join(bundle, "artifact-request.json");
const profileRaw = `${JSON.stringify({
  id: "mac-mini-personal-dev",
  platform: "macos",
})}\n`;
const identity = {
  user: "wangxiao",
  os: "Darwin",
  architecture: "arm64",
  machineId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
};
const hostKeyBlob = Buffer.from("fixture-host-key", "utf8");
const hostKeyBase64 = hostKeyBlob.toString("base64");
const hostKeyFingerprints = [
  `SHA256:${createHash("sha256")
    .update(hostKeyBlob)
    .digest("base64")
    .replace(/=+$/, "")}`,
];
const targetIdentitySha256 = targetIdentityDigest({
  platform: "macos",
  ...identity,
  hostKeyFingerprints,
});
const keyFingerprint = `SHA256:${"B".repeat(43)}`;
const miniPlanValue = {
  schemaVersion: 1,
  generatedAt: new Date(0).toISOString(),
  profileSha256: createHash("sha256")
    .update(profileRaw, "utf8")
    .digest("hex"),
  targetIdentitySha256,
  target: {
    alias: "mini",
    platform: "macos",
    architecture: "arm64",
  },
  targetDirectProbe: {
    origin: "api.github.com",
    route: "direct",
    reachable: false,
  },
  status: "confirmation-required",
  controllerRoute: "direct",
  artifactRequest,
  action: {
    softwareId: "clash-verge",
    installer: "official-download",
    version: "2.4.3",
    executionMode: "manual-receipt",
  },
};
const miniPlanSha256 = createHash("sha256")
  .update(JSON.stringify(miniPlanValue), "utf8")
  .digest("hex");
const miniPlan = { ...miniPlanValue, miniPlanSha256 };

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fakeLocal(command, args) {
  if (command === "ssh") {
    return {
      status: 0,
      stdout: [
        "hostname mini.local",
        "user wangxiao",
        "port 22",
        "identitiesonly yes",
        `identityfile ${identityFile}`,
      ].join("\n"),
      stderr: "",
    };
  }
  if (args[0] === "-F") {
    return {
      status: 0,
      stdout: `mini.local ssh-ed25519 ${hostKeyBase64}\n`,
      stderr: "",
    };
  }
  return {
    status: 0,
    stdout: `256 ${keyFingerprint} fixture (ED25519)\n`,
    stderr: "",
  };
}

function baseInput(overrides = {}) {
  return {
    metadata: metadataPath,
    miniPlan: miniPlanPath,
    miniPlanSha256,
    target: "mini",
    config,
    platform: "macos",
    targetIdentitySha256,
    ...overrides,
  };
}

try {
  mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(targetReceipt), { recursive: true, mode: 0o700 });
  mkdirSync(cacheEntry, { recursive: true, mode: 0o700 });
  mkdirSync(bundle, { recursive: true, mode: 0o700 });
  writeFileSync(
    config,
    "Host mini\n  HostName mini.local\n  User wangxiao\n",
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    knownHosts,
    `mini.local ssh-ed25519 ${hostKeyBase64}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(identityFile, "fixture-private-key\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(profilePath, profileRaw, { encoding: "utf8", mode: 0o600 });
  writeFileSync(
    artifactRequestPath,
    `${JSON.stringify(artifactRequest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    miniPlanPath,
    `${JSON.stringify(miniPlan, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(artifactPath, artifact, { mode: 0o600 });
  writeFileSync(
    metadataPath,
    `${JSON.stringify({
      schemaVersion: 2,
      requestDigest,
      artifactId: "clash-verge",
      version: "2.4.3",
      architecture: "arm64",
      sourceHost: "github.com",
      sourceMode: "canonical",
      allowedHosts: ["github.com"],
      filename: "Clash Verge.pkg",
      size: artifact.length,
      sha256: artifactSha256,
      publisherSha256: null,
      publisherDigestMatched: false,
      publisherVerified: false,
      cachedAt: new Date(0).toISOString(),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    targetReceipt,
    `${JSON.stringify({
      schemaVersion: 1,
      finalized: true,
      platform: "macos",
      host: "mini.local",
      user: "wangxiao",
      alias: "mini",
      identityFile,
      keyFingerprint,
      hostKeyFingerprints,
      sshConfigPath: config,
      sshConfigSha256: sha256File(config),
      knownHostsPath: knownHosts,
      knownHostsSha256: sha256File(knownHosts),
      handoff: {
        schemaVersion: 1,
        relativePath: ".dawn-forge/handoff",
        protection: "owner-directory-0700",
      },
      targetIdentitySha256,
      identity,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  assert.equal(
    parseArguments([
      "--metadata",
      metadataPath,
      "--mini-plan",
      miniPlanPath,
      "--mini-plan-sha256",
      miniPlanSha256,
      "--target",
      "mini",
      "--config",
      config,
      "--platform",
      "macos",
      "--target-identity-sha256",
      targetIdentitySha256,
    ]).metadata,
    metadataPath,
  );
  assert.deepEqual(parseArguments(["--help"]), { help: true });
  assert.throws(
    () =>
      parseArguments([
        "--metadata",
        "https://example.invalid/tool.pkg",
      ]),
    /不得包含 URL/,
  );
  assert.equal(
    validateCachedArtifact(metadataPath, { home }).metadata.filename,
    "Clash Verge.pkg",
  );

  const calls = [];
  const result = transferArtifact(baseInput(), {
    home,
    inspectWindowsAcl: () => ({ safe: true, reparsePoint: false }),
    localPlatform: process.platform,
    randomToken: () => "c".repeat(32),
    spawnLocal: fakeLocal,
    spawnTransfer(command, args, options) {
      calls.push({
        command,
        args,
        input: options.input,
        timeout: options.timeout,
      });
      if (command === "scp") {
        assert.equal(args.at(-2), artifactPath);
        return { status: 0, stdout: "", stderr: "" };
      }
      const marker = options.input.match(
        /__DAWN_FORGE_ARTIFACT_[a-f0-9]{32}__/,
      )?.[0];
      return {
        status: 0,
        stdout: `${marker} ${artifactSha256} ${artifact.length}\n`,
        stderr: "",
      };
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ command }) => command), ["scp", "ssh"]);
  assert.deepEqual(calls.map(({ timeout }) => timeout), [120_000, 120_000]);
  assert.match(calls[1].input, /target_directory="\$base_directory\/artifacts"/);
  assert.equal(result.installed, false);
  assert.equal(result.executed, false);
  assert.equal(result.miniPlanSha256, miniPlanSha256);
  assert.equal(result.sha256, artifactSha256);

  const wrongTargetValue = {
    ...miniPlanValue,
    target: { ...miniPlanValue.target, alias: "other" },
  };
  const wrongTargetDigest = createHash("sha256")
    .update(JSON.stringify(wrongTargetValue), "utf8")
    .digest("hex");
  writeFileSync(
    miniPlanPath,
    `${JSON.stringify({
      ...wrongTargetValue,
      miniPlanSha256: wrongTargetDigest,
    })}\n`,
    "utf8",
  );
  let wrongTargetTransferred = false;
  assert.throws(
    () =>
      transferArtifact(
        baseInput({ miniPlanSha256: wrongTargetDigest }),
        {
          home,
          inspectWindowsAcl: () => ({ safe: true, reparsePoint: false }),
          localPlatform: process.platform,
          spawnTransfer: () => {
            wrongTargetTransferred = true;
          },
        },
      ),
    /targetIdentity、profile、action 或 artifact binding/,
  );
  assert.equal(wrongTargetTransferred, false);
  writeFileSync(
    miniPlanPath,
    `${JSON.stringify(miniPlan, null, 2)}\n`,
    "utf8",
  );

  writeFileSync(
    artifactRequestPath,
    `${JSON.stringify({
      ...artifactRequest,
      artifactId: "forged-artifact",
    })}\n`,
    "utf8",
  );
  let wrongArtifactTransferred = false;
  assert.throws(
    () =>
      transferArtifact(baseInput(), {
        home,
        inspectWindowsAcl: () => ({ safe: true, reparsePoint: false }),
        localPlatform: process.platform,
        spawnTransfer: () => {
          wrongArtifactTransferred = true;
        },
      }),
    /artifact binding/,
  );
  assert.equal(wrongArtifactTransferred, false);
  writeFileSync(
    artifactRequestPath,
    `${JSON.stringify(artifactRequest, null, 2)}\n`,
    "utf8",
  );

  const outsideMetadata = join(root, "metadata.json");
  writeFileSync(outsideMetadata, "{}", "utf8");
  assert.throws(
    () => validateCachedArtifact(outsideMetadata, { home }),
    /canonical artifact cache/,
  );

  writeFileSync(artifactPath, "tampered", "utf8");
  let transferCalled = false;
  assert.throws(
    () =>
      transferArtifact(baseInput(), {
        home,
        inspectWindowsAcl: () => ({ safe: true, reparsePoint: false }),
        localPlatform: process.platform,
        spawnLocal: fakeLocal,
        spawnTransfer: () => {
          transferCalled = true;
        },
      }),
    /metadata 不一致/,
  );
  assert.equal(transferCalled, false);

  console.log("Artifact transfer tests passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
