#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  TransferPrivateInputError,
  assertTrustFilesUnchanged,
  buildScpInvocation,
  buildSshInvocation,
  inspectWindowsFileAcl,
  parseRemoteReceipt,
  processSucceeded,
  runControlledProcess,
  validateEffectiveSshTrust,
  validateIdentityReceipt,
} from "./transfer-private-input.mjs";
import {
  artifactRequestDigest,
  validateArtifactRequest,
} from "./artifact-cache.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const digestPattern = /^[a-f0-9]{64}$/;
const finalizedAliasPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const safeIdentityPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,126}[A-Za-z0-9])?$/;
const safeFilenamePattern = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,179}$/;
const supportedExtensions = [
  ".tar.gz",
  ".dmg",
  ".pkg",
  ".exe",
  ".msi",
  ".zip",
];
const urlPattern = /[a-z][a-z0-9+.-]*:\/\/\S*/i;

export class TransferArtifactError extends Error {
  constructor(message, exitCode = 2, reasonCode = "invalid-input") {
    super(message);
    this.name = "TransferArtifactError";
    this.exitCode = exitCode;
    this.reasonCode = reasonCode;
  }
}

export function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    return { help: true };
  }
  if (argv.some((value) => urlPattern.test(value))) {
    throw new TransferArtifactError(
      "artifact transfer 参数不得包含 URL。",
    );
  }
  const allowed = new Set([
    "--metadata",
    "--mini-plan",
    "--mini-plan-sha256",
    "--target",
    "--config",
    "--platform",
    "--target-identity-sha256",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!allowed.has(option) || Object.hasOwn(values, option)) {
      throw new TransferArtifactError(
        "存在未知、重复或不受支持的参数；参数内容未回显。",
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TransferArtifactError("artifact transfer 参数缺少值。");
    }
    values[option] = value;
    index += 1;
  }
  for (const option of allowed) {
    if (!Object.hasOwn(values, option)) {
      throw new TransferArtifactError(`缺少必需参数 \`${option}\`。`);
    }
  }
  if (
    !isAbsolute(values["--metadata"]) ||
    !isAbsolute(values["--mini-plan"]) ||
    !isAbsolute(values["--config"])
  ) {
    throw new TransferArtifactError(
      "`--metadata`、`--mini-plan` 和 `--config` 必须是绝对路径。",
    );
  }
  if (!digestPattern.test(values["--mini-plan-sha256"])) {
    throw new TransferArtifactError(
      "`--mini-plan-sha256` 必须是小写 SHA-256。",
    );
  }
  return {
    metadata: resolve(values["--metadata"]),
    miniPlan: resolve(values["--mini-plan"]),
    miniPlanSha256: values["--mini-plan-sha256"],
    target: values["--target"],
    config: resolve(values["--config"]),
    platform: values["--platform"],
    targetIdentitySha256: values["--target-identity-sha256"],
  };
}

export function validateCachedArtifact(
  metadataPath,
  {
    home = homedir(),
  } = {},
) {
  const cacheRoot = join(resolve(home), ".dawn-forge", "artifacts");
  const resolvedMetadata = resolve(metadataPath);
  if (
    basename(resolvedMetadata) !== "metadata.json" ||
    !isPathWithin(resolvedMetadata, cacheRoot)
  ) {
    throw new TransferArtifactError(
      "`--metadata` 必须是 canonical artifact cache 内的 `metadata.json`。",
      2,
      "metadata-outside-cache",
    );
  }
  assertUnredirectedPath(cacheRoot, resolvedMetadata);

  let metadata;
  try {
    const value = readFileSync(resolvedMetadata, "utf8");
    if (Buffer.byteLength(value, "utf8") > 1024 * 1024) {
      throw new Error("oversized");
    }
    metadata = JSON.parse(value);
  } catch {
    throw new TransferArtifactError(
      "canonical artifact metadata 无效。",
      2,
      "metadata-invalid",
    );
  }
  if (
    metadata?.schemaVersion !== 2 ||
    !digestPattern.test(metadata.requestDigest ?? "") ||
    basename(dirname(resolvedMetadata)) !== metadata.requestDigest ||
    !safeIdentityPattern.test(metadata.artifactId ?? "") ||
    !safeIdentityPattern.test(metadata.version ?? "") ||
    !safeIdentityPattern.test(metadata.architecture ?? "") ||
    !safeFilename(metadata.filename) ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size <= 0 ||
    !digestPattern.test(metadata.sha256 ?? "") ||
    !["canonical", "signed-download"].includes(metadata.sourceMode) ||
    typeof metadata.sourceHost !== "string" ||
    metadata.sourceHost.length === 0 ||
    metadata.publisherVerified !== false ||
    typeof metadata.publisherDigestMatched !== "boolean"
  ) {
    throw new TransferArtifactError(
      "canonical artifact metadata schema 或字段无效。",
      2,
      "metadata-invalid",
    );
  }

  const artifactPath = join(dirname(resolvedMetadata), metadata.filename);
  assertUnredirectedPath(cacheRoot, artifactPath);
  const observed = hashStableArtifact(artifactPath);
  if (
    observed.bytes !== metadata.size ||
    observed.sha256 !== metadata.sha256
  ) {
    throw new TransferArtifactError(
      "canonical cache artifact 的 SHA-256 或 size 与 metadata 不一致。",
      3,
      "cache-integrity-mismatch",
    );
  }
  return {
    artifactPath,
    metadata,
    observed,
  };
}

export function transferArtifact(input, dependencies = {}) {
  if (
    !isAbsolute(input?.metadata ?? "") ||
    !isAbsolute(input?.miniPlan ?? "") ||
    !isAbsolute(input?.config ?? "") ||
    !digestPattern.test(input?.miniPlanSha256 ?? "") ||
    !digestPattern.test(input?.targetIdentitySha256 ?? "") ||
    !finalizedAliasPattern.test(input?.target ?? "") ||
    input.target.includes("..") ||
    !["macos", "windows"].includes(input?.platform)
  ) {
    throw new TransferArtifactError(
      "artifact transfer 参数未通过 finalized alias、path、platform 或 digest 校验。",
    );
  }
  const {
    home = homedir(),
    inspectWindowsAcl = inspectWindowsFileAcl,
    localPlatform = process.platform,
    randomToken = () => randomBytes(16).toString("hex"),
    spawnLocal = spawnSync,
    spawnTransfer = spawnSync,
  } = dependencies;
  const cached = validateCachedArtifact(input.metadata, { home });
  validateMiniPlanBinding(input.miniPlan, input, cached);
  const identityInput = {
    target: input.target,
    config: input.config,
    platform: input.platform,
    targetIdentitySha256: input.targetIdentitySha256,
  };
  let receipt;
  try {
    receipt = validateIdentityReceipt(identityInput, {
      home,
      inspectWindowsAcl,
      localPlatform,
    });
    validateEffectiveSshTrust(receipt, { spawnLocal });
  } catch (error) {
    if (error instanceof TransferPrivateInputError) {
      throw new TransferArtifactError(
        error.message,
        error.exitCode,
        error.reasonCode,
      );
    }
    throw error;
  }

  const nonce = randomToken();
  if (!/^[a-f0-9]{32}$/.test(nonce)) {
    throw new TransferArtifactError(
      "无法生成安全的 artifact transfer nonce。",
      1,
      "nonce-invalid",
    );
  }
  const marker = `__DAWN_FORGE_ARTIFACT_${randomBytes(16).toString("hex")}__`;
  const scpInvocation = buildScpInvocation({
    config: input.config,
    expectedIdentity: receipt.identity,
    localPath: cached.artifactPath,
    nonce,
    target: input.target,
  });
  assertTrustFilesUnchanged(receipt);
  const scpResult = runControlledProcess(
    spawnTransfer,
    scpInvocation,
    undefined,
  );

  let cacheDrift;
  if (processSucceeded(scpResult)) {
    try {
      const afterScp = hashStableArtifact(cached.artifactPath);
      if (
        afterScp.bytes !== cached.observed.bytes ||
        afterScp.sha256 !== cached.observed.sha256
      ) {
        cacheDrift = new TransferArtifactError(
          "canonical cache artifact 在 SCP 期间发生变化。",
          3,
          "cache-drift",
        );
      }
    } catch (error) {
      cacheDrift =
        error instanceof TransferArtifactError
          ? error
          : new TransferArtifactError(
              "无法在 SCP 后复验 canonical cache artifact。",
              3,
              "cache-drift",
            );
    }
  }

  const sshInvocation = buildSshInvocation({
    cleanupOnly: !processSucceeded(scpResult) || cacheDrift !== undefined,
    config: input.config,
    destinationKind: "artifact",
    expectedIdentity: receipt.identity,
    expectedBytes: cached.observed.bytes,
    expectedSha256: cached.observed.sha256,
    marker,
    name: cached.metadata.filename,
    nonce,
    platform: input.platform,
    target: input.target,
  });
  const sshResult = runControlledProcess(
    spawnTransfer,
    sshInvocation,
    sshInvocation.driver,
  );

  if (!processSucceeded(scpResult)) {
    throw new TransferArtifactError(
      "artifact SCP 失败；已尝试精确清理本次 nonce 临时文件。",
      1,
      "scp-failed",
    );
  }
  if (cacheDrift !== undefined) throw cacheDrift;
  if (!processSucceeded(sshResult)) {
    throw new TransferArtifactError(
      "artifact 远端原子发布失败；已尝试精确清理本次 nonce 临时文件。",
      1,
      "publish-failed",
    );
  }
  const remote = parseRemoteReceipt(sshResult.stdout, marker);
  if (
    remote.sha256 !== cached.observed.sha256 ||
    remote.bytes !== cached.observed.bytes
  ) {
    throw new TransferArtifactError(
      "目标 artifact 的 SHA-256 或 size 不一致。",
      1,
      "remote-integrity-mismatch",
    );
  }
  return {
    status: "transferred",
    requestDigest: cached.metadata.requestDigest,
    miniPlanSha256: input.miniPlanSha256,
    filename: cached.metadata.filename,
    targetPath:
      input.platform === "macos"
        ? `~/Downloads/dawn-forge/artifacts/${cached.metadata.filename}`
        : `%USERPROFILE%\\Downloads\\dawn-forge\\artifacts\\${cached.metadata.filename}`,
    sha256: cached.observed.sha256,
    bytes: cached.observed.bytes,
    targetIdentitySha256: input.targetIdentitySha256,
    installed: false,
    executed: false,
  };
}

export function validateMiniPlanBinding(miniPlanPath, input, cached) {
  const resolvedPlan = resolve(miniPlanPath);
  if (basename(resolvedPlan) !== "mini-plan.json") {
    throw new TransferArtifactError(
      "`--mini-plan` 必须指向 canonical network-bootstrap bundle 的 `mini-plan.json`。",
      2,
      "mini-plan-invalid",
    );
  }
  const bundle = dirname(resolvedPlan);
  const profilePath = join(bundle, "profile.json");
  const artifactRequestPath = join(bundle, "artifact-request.json");
  for (const path of [resolvedPlan, profilePath, artifactRequestPath]) {
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new TransferArtifactError(
        "network-bootstrap bundle 文件缺失或被重定向。",
        2,
        "mini-plan-invalid",
      );
    }
  }

  let miniPlan;
  let artifactRequest;
  let profileRaw;
  try {
    miniPlan = JSON.parse(readFileSync(resolvedPlan, "utf8"));
    artifactRequest = JSON.parse(readFileSync(artifactRequestPath, "utf8"));
    profileRaw = readFileSync(profilePath, "utf8");
  } catch {
    throw new TransferArtifactError(
      "network-bootstrap bundle JSON 无效。",
      2,
      "mini-plan-invalid",
    );
  }
  const valueForDigest = { ...miniPlan };
  delete valueForDigest.miniPlanSha256;
  const observedMiniPlanSha256 = createHash("sha256")
    .update(JSON.stringify(valueForDigest), "utf8")
    .digest("hex");
  if (
    miniPlan?.schemaVersion !== 1 ||
    miniPlan.status !== "confirmation-required" ||
    miniPlan.miniPlanSha256 !== input.miniPlanSha256 ||
    observedMiniPlanSha256 !== input.miniPlanSha256 ||
    miniPlan.profileSha256 !==
      createHash("sha256").update(profileRaw, "utf8").digest("hex") ||
    miniPlan.targetIdentitySha256 !== input.targetIdentitySha256 ||
    miniPlan.target?.alias !== input.target ||
    miniPlan.target?.platform !== input.platform ||
    miniPlan.target?.architecture !== cached.metadata.architecture ||
    miniPlan.action?.softwareId !== cached.metadata.artifactId ||
    miniPlan.action?.installer !== "official-download" ||
    miniPlan.action?.executionMode !== "manual-receipt" ||
    miniPlan.action?.version !== cached.metadata.version ||
    JSON.stringify(miniPlan.artifactRequest) !==
      JSON.stringify(artifactRequest)
  ) {
    throw new TransferArtifactError(
      "mini-plan 的 digest、targetIdentity、profile、action 或 artifact binding 不一致。",
      3,
      "mini-plan-binding-mismatch",
    );
  }

  let normalizedRequest;
  let expectedRequestDigest;
  try {
    normalizedRequest = validateArtifactRequest(artifactRequest);
    expectedRequestDigest = artifactRequestDigest(artifactRequest);
  } catch {
    throw new TransferArtifactError(
      "mini-plan 的 canonical artifact request 无效。",
      2,
      "mini-plan-artifact-invalid",
    );
  }
  if (
    expectedRequestDigest !== cached.metadata.requestDigest ||
    normalizedRequest.artifactId !== cached.metadata.artifactId ||
    normalizedRequest.version !== cached.metadata.version ||
    normalizedRequest.architecture !== cached.metadata.architecture ||
    normalizedRequest.filename !== cached.metadata.filename ||
    normalizedRequest.sourceMode !== cached.metadata.sourceMode
  ) {
    throw new TransferArtifactError(
      "mini-plan artifact requestDigest 与 canonical cache metadata 不一致。",
      3,
      "artifact-request-mismatch",
    );
  }
  return {
    miniPlanSha256: observedMiniPlanSha256,
    profileSha256: miniPlan.profileSha256,
    requestDigest: expectedRequestDigest,
  };
}

function hashStableArtifact(path) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error("not-regular");
    }
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error("changed");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after = fstatSync(descriptor);
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      bytes !== opened.size
    ) {
      throw new Error("changed");
    }
    return {
      bytes,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    if (error instanceof TransferArtifactError) throw error;
    throw new TransferArtifactError(
      "canonical cache artifact 不存在、被重定向或读取期间发生变化。",
      3,
      "cache-artifact-invalid",
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertUnredirectedPath(root, destination) {
  const resolvedRoot = resolve(root);
  const resolvedDestination = resolve(destination);
  let candidate = resolvedRoot;
  for (const segment of relative(resolvedRoot, resolvedDestination).split(sep)) {
    const status = lstatSync(candidate);
    if (status.isSymbolicLink()) {
      throw new TransferArtifactError(
        "canonical cache 路径包含 symlink/reparse point。",
        2,
        "cache-path-redirected",
      );
    }
    const real = realpathSync(candidate);
    const realStatus = lstatSync(real);
    if (realStatus.dev !== status.dev || realStatus.ino !== status.ino) {
      throw new TransferArtifactError(
        "canonical cache 路径包含 symlink/reparse point。",
        2,
        "cache-path-redirected",
      );
    }
    candidate = join(candidate, segment);
  }
}

function isPathWithin(path, root) {
  const fromRoot = relative(resolve(root), resolve(path));
  return (
    fromRoot.length > 0 &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function safeFilename(value) {
  const lower = String(value ?? "").toLowerCase();
  return (
    safeFilenamePattern.test(value ?? "") &&
    !value.includes("..") &&
    !/[. ]$/.test(value) &&
    supportedExtensions.some((extension) => lower.endsWith(extension))
  );
}

async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    process.stdout.write(`${artifactTransferUsage()}\n`);
    return;
  }
  const result = transferArtifact(parsed);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function artifactTransferUsage() {
  return [
    "Usage:",
    `  node "${scriptPath}" --metadata <canonical-cache-metadata.json> \\`,
    "    --mini-plan <network-bootstrap-bundle/mini-plan.json> \\",
    "    --mini-plan-sha256 <digest> --target <finalized-alias> \\",
    "    --config <absolute-ssh-config> --platform <macos|windows> \\",
    "    --target-identity-sha256 <digest>",
    "",
    "Requires artifact-cache schemaVersion 2 metadata and a canonical finalize identity receipt.",
    "The command transfers verified bytes only; it never installs or executes them.",
  ].join("\n");
}

if (resolve(process.argv[1] ?? "") === resolve(scriptPath)) {
  try {
    await runCli();
  } catch (error) {
    if (error instanceof TransferArtifactError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
    } else {
      console.error("artifact 受控传输失败；URL 与子进程输出未回显。");
      process.exitCode = 1;
    }
  }
}
