#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { targetIdentityDigest } from "./target-identity.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const maxPrivateInputBytes = 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;
const finalizedAliasPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const urlPattern = /[a-z][a-z0-9+.-]*:\/\/\S*/i;
const sshSafetyOptions = Object.freeze([
  "BatchMode=yes",
  "StrictHostKeyChecking=yes",
  "IdentitiesOnly=yes",
  "ClearAllForwardings=yes",
  "ForwardAgent=no",
  "ForwardX11=no",
  "PermitLocalCommand=no",
  "ControlMaster=no",
  "ControlPath=none",
  "ControlPersist=no",
  "CanonicalizeHostname=no",
  "ForkAfterAuthentication=no",
  "StdinNull=no",
  "RequestTTY=no",
  "Tunnel=no",
  "RemoteCommand=none",
  "ProxyCommand=none",
  "ProxyJump=none",
  "KnownHostsCommand=none",
  "IdentityAgent=none",
  "AddKeysToAgent=no",
  "UpdateHostKeys=no",
  "GlobalKnownHostsFile=none",
  "PasswordAuthentication=no",
  "KbdInteractiveAuthentication=no",
  "PreferredAuthentications=publickey",
  "PubkeyAuthentication=yes",
  "HostbasedAuthentication=no",
  "GSSAPIAuthentication=no",
  "ConnectionAttempts=1",
  "ConnectTimeout=15",
  "ServerAliveInterval=10",
  "ServerAliveCountMax=3",
]);

export const controlledPrivateInputNames = Object.freeze([
  "clash-subscription-url.txt",
  "clash-config.yaml",
]);

export class TransferPrivateInputError extends Error {
  constructor(message, exitCode = 2, reasonCode = "invalid-input") {
    super(message);
    this.name = "TransferPrivateInputError";
    this.exitCode = exitCode;
    this.reasonCode = reasonCode;
  }
}

export function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    return { help: true };
  }
  if (argv.some((value) => urlPattern.test(value))) {
    throw new TransferPrivateInputError(
      "命令参数不得包含 URL 或秘密值；`--input` 只能指向本地受保护文件。",
    );
  }

  const options = {};
  const allowed = new Set([
    "--input",
    "--name",
    "--target",
    "--config",
    "--platform",
    "--target-identity-sha256",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!allowed.has(option) || Object.hasOwn(options, option)) {
      throw new TransferPrivateInputError(
        "存在未知、重复或不受支持的命令参数；参数内容未回显。",
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TransferPrivateInputError(
        "命令参数缺少值；参数内容未回显。",
      );
    }
    options[option] = value;
    index += 1;
  }

  for (const option of allowed) {
    if (!Object.hasOwn(options, option)) {
      throw new TransferPrivateInputError(`缺少必需参数 \`${option}\`。`);
    }
  }

  return {
    input: options["--input"],
    name: options["--name"],
    target: options["--target"],
    config: options["--config"],
    platform: options["--platform"],
    targetIdentitySha256: options["--target-identity-sha256"],
  };
}

export function validateOptions(input) {
  if (
    typeof input.input !== "string" ||
    typeof input.config !== "string" ||
    !isAbsolute(input.input) ||
    !isAbsolute(input.config)
  ) {
    throw new TransferPrivateInputError(
      "`--input` 和 `--config` 必须是绝对路径。",
    );
  }
  if (!controlledPrivateInputNames.includes(input.name)) {
    throw new TransferPrivateInputError(
      "`--name` 不在受控文件名 allowlist 中。",
    );
  }
  if (
    !finalizedAliasPattern.test(input.target ?? "") ||
    input.target.includes("..")
  ) {
    throw new TransferPrivateInputError(
      "`--target` 必须是 finalized SSH alias，不能是 `user@host` 或地址。",
    );
  }
  if (!["macos", "windows"].includes(input.platform)) {
    throw new TransferPrivateInputError(
      "`--platform` 必须是 `macos` 或 `windows`。",
    );
  }
  if (!digestPattern.test(input.targetIdentitySha256 ?? "")) {
    throw new TransferPrivateInputError(
      "`--target-identity-sha256` 必须是小写 SHA-256。",
    );
  }
  return {
    ...input,
    input: resolve(input.input),
    config: resolve(input.config),
  };
}

export function validateIdentityReceipt(
  input,
  {
    home = homedir(),
    inspectWindowsAcl = inspectWindowsFileAcl,
    localPlatform = process.platform,
    readReceipt = readFileSync,
  } = {},
) {
  const receiptPath = join(
    resolve(home),
    ".dawn-forge",
    "targets",
    input.target.toLowerCase(),
    "identity.json",
  );
  assertRegularUnredirectedFile(receiptPath, home, "target identity receipt");
  assertSecureTrustFile(receiptPath, {
    inspectWindowsAcl,
    localPlatform,
    ownerOnly: true,
  });

  let receipt;
  try {
    const serialized = readReceipt(receiptPath, "utf8");
    if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) {
      throw new Error("oversized");
    }
    receipt = JSON.parse(serialized);
  } catch {
    throw new TransferPrivateInputError(
      "无法读取有效的 finalized target identity receipt。",
      2,
      "identity-receipt-invalid",
    );
  }

  const receiptConfig =
    typeof receipt?.sshConfigPath === "string"
      ? resolve(receipt.sshConfigPath)
      : undefined;
  const knownHostsPath =
    typeof receipt?.knownHostsPath === "string"
      ? resolve(receipt.knownHostsPath)
      : undefined;
  const identityFile =
    typeof receipt?.identityFile === "string"
      ? resolve(receipt.identityFile)
      : undefined;
  const expectedHandoffProtection =
    input.platform === "macos"
      ? "owner-directory-0700"
      : "current-user-inheritable-dacl";
  if (
    receipt?.schemaVersion !== 1 ||
    receipt?.finalized !== true ||
    receipt?.alias?.toLowerCase() !== input.target.toLowerCase() ||
    receipt?.platform !== input.platform ||
    receipt?.targetIdentitySha256 !== input.targetIdentitySha256 ||
    receiptConfig === undefined ||
    !sameFilesystemPath(receiptConfig, input.config) ||
    !digestPattern.test(receipt?.sshConfigSha256 ?? "") ||
    knownHostsPath === undefined ||
    !sameFilesystemPath(
      knownHostsPath,
      join(dirname(input.config), "known_hosts"),
    ) ||
    receipt?.handoff?.schemaVersion !== 1 ||
    receipt?.handoff?.relativePath !== ".dawn-forge/handoff" ||
    receipt?.handoff?.protection !== expectedHandoffProtection ||
    !digestPattern.test(receipt?.knownHostsSha256 ?? "") ||
    identityFile === undefined ||
    typeof receipt?.keyFingerprint !== "string" ||
    !/^SHA256:[A-Za-z0-9+/=]{20,128}$/.test(receipt.keyFingerprint)
  ) {
    throw new TransferPrivateInputError(
      "目标身份、平台或 SSH config 与 finalized receipt 不一致；已拒绝传输。",
      3,
      "identity-mismatch",
    );
  }
  const identity = receipt.identity;
  if (
    !identity ||
    !["user", "os", "architecture", "machineId"].every(
      (key) =>
        typeof identity[key] === "string" &&
        identity[key].length > 0 &&
        identity[key].length <= 256 &&
        !/[\u0000-\u001f\u007f]/.test(identity[key]),
    ) ||
    (input.platform === "macos" && identity.os !== "Darwin") ||
    (input.platform === "windows" && identity.os !== "Windows") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(identity.user)
  ) {
    throw new TransferPrivateInputError(
      "finalized target identity receipt 缺少可验证的强身份字段。",
      2,
      "identity-receipt-invalid",
    );
  }
  if (
    !Array.isArray(receipt.hostKeyFingerprints) ||
    receipt.hostKeyFingerprints.length === 0 ||
    receipt.hostKeyFingerprints.some(
      (value) =>
        typeof value !== "string" ||
        !/^SHA256:[A-Za-z0-9+/=]{20,128}$/.test(value),
    )
  ) {
    throw new TransferPrivateInputError(
      "finalized target identity receipt 缺少有效的 host-key fingerprints。",
      2,
      "identity-receipt-invalid",
    );
  }
  const recomputedDigest = targetIdentityDigest({
    platform: receipt.platform,
    user: identity.user,
    os: identity.os,
    architecture: identity.architecture,
    machineId: identity.machineId,
    hostKeyFingerprints: receipt.hostKeyFingerprints,
  });
  if (recomputedDigest !== receipt.targetIdentitySha256) {
    throw new TransferPrivateInputError(
      "finalized receipt 的 target identity digest 无法复算。",
      3,
      "identity-mismatch",
    );
  }
  assertRegularUnredirectedFile(
    receiptConfig,
    dirname(receiptConfig),
    "SSH config",
  );
  assertSecureTrustFile(receiptConfig, {
    inspectWindowsAcl,
    localPlatform,
  });
  assertRegularUnredirectedFile(
    knownHostsPath,
    dirname(knownHostsPath),
    "controlled known_hosts",
  );
  assertSecureTrustFile(knownHostsPath, {
    inspectWindowsAcl,
    localPlatform,
  });
  assertRegularUnredirectedFile(
    identityFile,
    dirname(identityFile),
    "management identity file",
  );
  assertSecureTrustFile(identityFile, {
    inspectWindowsAcl,
    localPlatform,
    ownerOnly: true,
  });
  if (
    hashLocalFile(receiptConfig, 8 * 1024 * 1024) !==
      receipt.sshConfigSha256 ||
    hashLocalFile(knownHostsPath, 16 * 1024 * 1024) !==
      receipt.knownHostsSha256
  ) {
    throw new TransferPrivateInputError(
      "SSH config 或 controlled known_hosts 在 finalize 后发生变化；已拒绝传输。",
      3,
      "ssh-trust-drift",
    );
  }
  return {
    alias: receipt.alias,
    identity: {
      user: identity.user,
      os: identity.os,
      architecture: identity.architecture,
      machineId: identity.machineId,
    },
    host: receipt.host,
    hostKeyFingerprints: [...receipt.hostKeyFingerprints].sort(),
    handoff: { ...receipt.handoff },
    identityFile,
    keyFingerprint: receipt.keyFingerprint,
    knownHostsPath,
    knownHostsSha256: receipt.knownHostsSha256,
    receiptPath,
    sshConfigPath: receiptConfig,
    sshConfigSha256: receipt.sshConfigSha256,
    targetIdentitySha256: receipt.targetIdentitySha256,
    user: receipt.user,
  };
}

export function validateEffectiveSshTrust(
  receipt,
  {
    spawnLocal = spawnSync,
  } = {},
) {
  if (
    typeof receipt.host !== "string" ||
    receipt.host.length === 0 ||
    /[\u0000-\u0020\u007f]/.test(receipt.host) ||
    typeof receipt.user !== "string" ||
    receipt.user.toLowerCase() !== receipt.identity.user.toLowerCase()
  ) {
    throw new TransferPrivateInputError(
      "finalized receipt 的 SSH HostName/User 无效。",
      2,
      "identity-receipt-invalid",
    );
  }
  assertTrustFilesUnchanged(receipt);

  const resolution = runLocalProcess(
    spawnLocal,
    "ssh",
    [
      "-G",
      "-F",
      receipt.sshConfigPath,
      ...sshOptionArguments(
        receipt.sshConfigPath,
        receipt.user,
      ),
      receipt.alias,
    ],
  );
  if (!processSucceeded(resolution)) {
    throw new TransferPrivateInputError(
      "无法解析 finalized SSH alias；已拒绝传输。",
      3,
      "ssh-resolution-failed",
    );
  }
  const resolved = parseSshResolution(resolution.stdout);
  const identityFiles = resolved.identityfile ?? [];
  if (
    resolved.hostname?.toLowerCase() !== receipt.host.toLowerCase() ||
    resolved.user?.toLowerCase() !== receipt.user.toLowerCase() ||
    resolved.port !== "22" ||
    resolved.identitiesonly !== "yes" ||
    identityFiles.length !== 1 ||
    !sameFilesystemPath(expandHomePath(identityFiles[0]), receipt.identityFile)
  ) {
    throw new TransferPrivateInputError(
      "finalized SSH alias 的有效 HostName/User/IdentityFile 已漂移。",
      3,
      "ssh-resolution-drift",
    );
  }

  const key = runLocalProcess(
    spawnLocal,
    "ssh-keygen",
    ["-lf", receipt.identityFile],
  );
  const observedFingerprint = String(key.stdout ?? "").match(
    /(?:^|\s)(SHA256:[A-Za-z0-9+/=]{20,128})(?=\s|$)/,
  )?.[1];
  if (
    !processSucceeded(key) ||
    observedFingerprint !== receipt.keyFingerprint
  ) {
    throw new TransferPrivateInputError(
      "管理 SSH key fingerprint 与 finalized receipt 不一致。",
      3,
      "management-key-drift",
    );
  }
  const lookup =
    typeof resolved.hostkeyalias === "string" &&
    resolved.hostkeyalias !== "none"
      ? resolved.hostkeyalias
      : resolved.hostname;
  const knownHostsLookup = runLocalProcess(
    spawnLocal,
    "ssh-keygen",
    ["-F", lookup, "-f", receipt.knownHostsPath],
  );
  const observedHostFingerprints = parseKnownHostFingerprints(
    knownHostsLookup.stdout,
  );
  if (
    !processSucceeded(knownHostsLookup) ||
    JSON.stringify(observedHostFingerprints) !==
      JSON.stringify(receipt.hostKeyFingerprints)
  ) {
    throw new TransferPrivateInputError(
      "controlled known_hosts 的目标 host-key fingerprints 与 finalized receipt 不一致。",
      3,
      "host-key-drift",
    );
  }
  assertTrustFilesUnchanged(receipt);
}

export function validatePrivateInputSource(
  inputPath,
  {
    home = homedir(),
    localPlatform = process.platform,
    inspectWindowsAcl = inspectWindowsFileAcl,
  } = {},
) {
  const resolvedHome = resolve(home);
  const resolvedInput = resolve(inputPath);
  if (!isPathWithin(resolvedInput, resolvedHome, false)) {
    throw new TransferPrivateInputError(
      "`--input` 必须位于当前用户 home 内的受保护目录。",
      2,
      "source-outside-private-root",
    );
  }

  assertPathChainUnredirected(resolvedHome, resolvedInput);
  const privateRoot = dirname(resolvedInput);
  const parentStatus = lstatSync(privateRoot);
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
    throw new TransferPrivateInputError(
      "private input 的父目录不是受保护的普通目录。",
      2,
      "source-parent-unsafe",
    );
  }
  const status = lstatSync(resolvedInput);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new TransferPrivateInputError(
      "private input 不是普通文件，或包含 symlink/reparse point。",
      2,
      "source-not-regular",
    );
  }
  if (status.size <= 0 || status.size > maxPrivateInputBytes) {
    throw new TransferPrivateInputError(
      "private input 必须是非空且不超过 1 MiB 的文件。",
      2,
      "source-size-invalid",
    );
  }

  if (localPlatform === "win32") {
    const parentAcl = inspectWindowsAcl(privateRoot);
    const acl = inspectWindowsAcl(resolvedInput);
    if (
      !(parentAcl?.integritySafe === true || parentAcl?.safe === true) ||
      parentAcl?.reparsePoint ||
      !acl?.safe ||
      acl?.reparsePoint
    ) {
      throw new TransferPrivateInputError(
        "private input 或父目录的 Windows owner/ACL 不满足仅当前用户可访问的要求。",
        2,
        "source-acl-unsafe",
      );
    }
  } else {
    if (
      typeof process.getuid === "function" &&
      (status.uid !== process.getuid() ||
        parentStatus.uid !== process.getuid())
    ) {
      throw new TransferPrivateInputError(
        "private input owner 不是当前控制机用户。",
        2,
        "source-owner-mismatch",
      );
    }
    if ((parentStatus.mode & 0o077) !== 0) {
      throw new TransferPrivateInputError(
        "private input 父目录 mode 不安全；必须只允许 owner 访问。",
        2,
        "source-parent-mode-unsafe",
      );
    }
    if ((status.mode & 0o077) !== 0 || (status.mode & 0o400) === 0) {
      throw new TransferPrivateInputError(
        "private input mode 不安全；必须只允许 owner 读取。",
        2,
        "source-mode-unsafe",
      );
    }
  }

  assertNotGitTracked(resolvedInput);
  return {
    path: resolvedInput,
    size: status.size,
    status,
    privateRoot,
  };
}

export function buildScpInvocation({
  config,
  expectedIdentity,
  localPath,
  nonce,
  target,
}) {
  const remoteTemporaryName = `.dawn-forge/handoff/${nonce}.tmp`;
  return {
    command: "scp",
    args: [
      "-q",
      "-F",
      config,
      ...sshOptionArguments(config, expectedIdentity.user),
      localPath,
      `${target}:${remoteTemporaryName}`,
    ],
    remoteTemporaryName,
  };
}

export function buildSshInvocation({
  cleanupOnly = false,
  config,
  destinationKind = "private",
  expectedIdentity,
  expectedBytes,
  expectedSha256,
  marker,
  name,
  nonce,
  platform,
  target,
}) {
  if (!["private", "artifact"].includes(destinationKind)) {
    throw new TransferPrivateInputError(
      "不支持的受控传输目标类型。",
    );
  }
  const command =
    platform === "macos"
      ? ["sh", "-s"]
      : [
          "powershell.exe",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "-",
        ];
  return {
    command: "ssh",
    args: [
      "-F",
      config,
      ...sshOptionArguments(config, expectedIdentity.user),
      target,
      ...command,
    ],
    driver:
      platform === "macos"
        ? macosPublishDriver({
            cleanupOnly,
            destinationKind,
            expectedIdentity,
            expectedBytes,
            expectedSha256,
            marker,
            name,
            nonce,
          })
        : windowsPublishDriver({
            cleanupOnly,
            destinationKind,
            expectedIdentity,
            expectedBytes,
            expectedSha256,
            marker,
            name,
            nonce,
          }),
  };
}

export function transferPrivateInput(input, dependencies = {}) {
  const prepared = validateOptions(input);
  const {
    home = homedir(),
    inspectWindowsAcl = inspectWindowsFileAcl,
    localPlatform = process.platform,
    randomToken = () => randomBytes(16).toString("hex"),
    spawnLocal = spawnSync,
    spawnTransfer = spawnSync,
    tightenWindowsAcl = tightenWindowsFileAcl,
  } = dependencies;

  const identityReceipt = validateIdentityReceipt(prepared, {
    home,
    inspectWindowsAcl,
    localPlatform,
  });
  validateEffectiveSshTrust(identityReceipt, { spawnLocal });
  const source = validatePrivateInputSource(prepared.input, {
    home,
    inspectWindowsAcl,
    localPlatform,
  });
  assertRegularUnredirectedFile(prepared.config, dirname(prepared.config), "SSH config");

  const nonce = randomToken();
  if (!/^[a-f0-9]{32}$/.test(nonce)) {
    throw new TransferPrivateInputError(
      "无法生成安全的 transfer nonce。",
      1,
      "nonce-invalid",
    );
  }
  const staged = stagePrivateInput(source, {
    localPlatform,
    nonce,
    inspectWindowsAcl,
    tightenWindowsAcl,
  });
  let result;
  let primaryError;
  try {
    const marker = `__DAWN_FORGE_HANDOFF_${randomBytes(16).toString("hex")}__`;
    const scpInvocation = buildScpInvocation({
      config: prepared.config,
      expectedIdentity: identityReceipt.identity,
      localPath: staged.path,
      nonce,
      target: prepared.target,
    });
    assertTrustFilesUnchanged(identityReceipt);

    const scpResult = runControlledProcess(
      spawnTransfer,
      scpInvocation,
      undefined,
    );
    const sshInvocation = buildSshInvocation({
      cleanupOnly: !processSucceeded(scpResult),
      config: prepared.config,
      expectedIdentity: identityReceipt.identity,
      expectedBytes: staged.bytes,
      expectedSha256: staged.sha256,
      marker,
      name: prepared.name,
      nonce,
      platform: prepared.platform,
      target: prepared.target,
    });
    const sshResult = runControlledProcess(
      spawnTransfer,
      sshInvocation,
      sshInvocation.driver,
    );

    if (!processSucceeded(scpResult)) {
      throw new TransferPrivateInputError(
        "private input 的 SCP 传输失败；已仅尝试清理本次 nonce 临时文件。",
        1,
        "scp-failed",
      );
    }
    if (!processSucceeded(sshResult)) {
      throw new TransferPrivateInputError(
        "private input 的远端原子发布失败；已尝试清理本次 nonce 临时文件。",
        1,
        "publish-failed",
      );
    }

    const remote = parseRemoteReceipt(sshResult.stdout, marker);
    if (remote.sha256 !== staged.sha256 || remote.bytes !== staged.bytes) {
      throw new TransferPrivateInputError(
        "远端文件的 SHA-256 或 size 与控制机不一致。",
        1,
        "remote-integrity-mismatch",
      );
    }

    result = {
      status: "transferred",
      name: prepared.name,
      targetPath:
        prepared.platform === "macos"
          ? `~/Downloads/dawn-forge/${prepared.name}`
          : `%USERPROFILE%\\Downloads\\dawn-forge\\${prepared.name}`,
      sha256: staged.sha256,
      bytes: staged.bytes,
      targetIdentitySha256: prepared.targetIdentitySha256,
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    unlinkSync(staged.path);
  } catch (error) {
    if (error.code !== "ENOENT") cleanupError = error;
  }
  if (cleanupError !== undefined) {
    throw new TransferPrivateInputError(
      "本地 private-input staging 清理失败；仅保留本次精确 nonce 路径以便恢复。",
      1,
      "local-cleanup-failed",
    );
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
  return result;
}

function stagePrivateInput(
  source,
  {
    inspectWindowsAcl,
    localPlatform,
    nonce,
    tightenWindowsAcl,
  },
) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let sourceDescriptor;
  let stagedDescriptor;
  let stagedReady = false;
  const stagedPath = join(
    source.privateRoot,
    `.transfer-${nonce}.tmp`,
  );
  try {
    sourceDescriptor = openSync(source.path, constants.O_RDONLY | noFollow);
    const openedBefore = fstatSync(sourceDescriptor);
    if (
      !openedBefore.isFile() ||
      openedBefore.dev !== source.status.dev ||
      openedBefore.ino !== source.status.ino ||
      openedBefore.size !== source.status.size
    ) {
      throw new TransferPrivateInputError(
        "private input 在检查期间发生变化；已拒绝传输。",
        2,
        "source-changed",
      );
    }
    const value = readFileSync(sourceDescriptor);
    const openedAfter = fstatSync(sourceDescriptor);
    if (
      openedAfter.size !== openedBefore.size ||
      openedAfter.mtimeMs !== openedBefore.mtimeMs
    ) {
      throw new TransferPrivateInputError(
        "private input 在读取期间发生变化；已拒绝传输。",
        2,
        "source-changed",
      );
    }
    stagedDescriptor = openSync(
      stagedPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    if (localPlatform === "win32") {
      closeSync(stagedDescriptor);
      stagedDescriptor = undefined;
      if (
        !tightenWindowsAcl(stagedPath) ||
        !inspectWindowsAcl(stagedPath)?.safe
      ) {
        throw new TransferPrivateInputError(
          "无法保护本次传输的 Windows 临时文件。",
          2,
          "staging-acl-unsafe",
        );
      }
      stagedDescriptor = openSync(stagedPath, constants.O_WRONLY);
      const reopened = fstatSync(stagedDescriptor);
      if (!reopened.isFile() || reopened.size !== 0) {
        throw new TransferPrivateInputError(
          "Windows staging file 在写入前发生变化。",
          2,
          "staging-changed",
        );
      }
    } else {
      chmodSync(stagedPath, 0o600);
    }
    writeFileSync(stagedDescriptor, value);
    fsyncSync(stagedDescriptor);
    closeSync(stagedDescriptor);
    stagedDescriptor = undefined;
    if (
      localPlatform === "win32" &&
      !inspectWindowsAcl(stagedPath)?.safe
    ) {
      throw new TransferPrivateInputError(
        "Windows staging file 写入后的 ACL postcondition 失败。",
        2,
        "staging-acl-unsafe",
      );
    }
    const result = {
      path: stagedPath,
      bytes: value.length,
      sha256: createHash("sha256").update(value).digest("hex"),
    };
    stagedReady = true;
    return result;
  } finally {
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
    if (stagedDescriptor !== undefined) closeSync(stagedDescriptor);
    if (!stagedReady && existsSync(stagedPath)) {
      unlinkSync(stagedPath);
    }
  }
}

export function runControlledProcess(spawnProcess, invocation, input) {
  try {
    return spawnProcess(invocation.command, invocation.args, {
      encoding: "utf8",
      input,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
      windowsHide: true,
    });
  } catch {
    return { error: new Error("spawn-failed"), status: null };
  }
}

function runLocalProcess(spawnProcess, command, args) {
  try {
    return spawnProcess(command, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      windowsHide: true,
    });
  } catch {
    return { error: new Error("spawn-failed"), status: null };
  }
}

export function processSucceeded(result) {
  return result?.error === undefined && result?.status === 0;
}

export function parseRemoteReceipt(stdout, marker) {
  const expression = new RegExp(
    `^${escapeRegExp(marker)} ([a-f0-9]{64}) ([1-9][0-9]*)$`,
  );
  const matches = String(stdout ?? "")
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.match(expression))
    .filter(Boolean);
  if (matches.length !== 1) {
    throw new TransferPrivateInputError(
      "远端没有返回唯一、有效的脱敏发布 receipt。",
      1,
      "remote-receipt-invalid",
    );
  }
  return {
    sha256: matches[0][1],
    bytes: Number.parseInt(matches[0][2], 10),
  };
}

function macosPublishDriver({
  cleanupOnly,
  destinationKind,
  expectedIdentity,
  expectedBytes,
  expectedSha256,
  marker,
  name,
  nonce,
}) {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    !digestPattern.test(expectedSha256 ?? "")
  ) {
    throw new TransferPrivateInputError(
      "远端发布缺少有效的 expected SHA-256/size。",
    );
  }
  const expected = encodeIdentity(expectedIdentity);
  const artifactDirectory =
    destinationKind === "artifact" ? '/artifacts' : "";
  return `#!/bin/sh
set -eu
handoff_base="$HOME/.dawn-forge"
handoff_directory="$handoff_base/handoff"
source_file="$handoff_directory/${nonce}.tmp"
downloads="$HOME/Downloads"
base_directory="$downloads/dawn-forge"
target_directory="$base_directory${artifactDirectory}"
destination="$target_directory/${name}"
published_by_this_run=0
confirmed=0
cleanup_enabled=0
cleanup() {
  if [ "$cleanup_enabled" = "1" ]; then
    rm -f "$source_file"
  fi
  if [ "$published_by_this_run" = "1" ] && [ "$confirmed" != "1" ]; then
    rm -f "$destination"
  fi
}
decode_identity() {
  printf '%s' "$1" | base64 -D
}
expected_user="$(decode_identity '${expected.user}')"
expected_os="$(decode_identity '${expected.os}')"
expected_architecture="$(decode_identity '${expected.architecture}')"
expected_machine_id="$(decode_identity '${expected.machineId}')"
[ "$(id -un)" = "$expected_user" ]
[ "$(uname -s)" = "$expected_os" ]
[ "$(uname -m)" = "$expected_architecture" ]
actual_machine_id="$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F '"' '/"IOPlatformUUID"/ { print $4; exit }')"
[ "$actual_machine_id" = "$expected_machine_id" ]
[ -d "$handoff_base" ] && [ ! -L "$handoff_base" ]
[ -d "$handoff_directory" ] && [ ! -L "$handoff_directory" ]
owner_uid="$(id -u)"
[ "$(stat -f '%u' "$handoff_base")" = "$owner_uid" ]
[ "$(stat -f '%u' "$handoff_directory")" = "$owner_uid" ]
[ "$(stat -f '%Lp' "$handoff_base")" = "700" ]
[ "$(stat -f '%Lp' "$handoff_directory")" = "700" ]
cleanup_enabled=1
trap cleanup EXIT HUP INT TERM
if [ "${cleanupOnly ? "1" : "0"}" = "1" ]; then
  exit 0
fi
[ -f "$source_file" ] && [ ! -L "$source_file" ]
[ "$(stat -f '%u' "$source_file")" = "$owner_uid" ]
chmod 600 "$source_file"
[ "$(stat -f '%Lp' "$source_file")" = "600" ]
[ "$(shasum -a 256 "$source_file" | awk '{print $1}')" = "${expectedSha256}" ]
[ "$(stat -f '%z' "$source_file")" = "${expectedBytes}" ]
[ -d "$downloads" ] && [ ! -L "$downloads" ]
if [ -e "$base_directory" ] || [ -L "$base_directory" ]; then
  [ -d "$base_directory" ] && [ ! -L "$base_directory" ]
else
  umask 077
  mkdir "$base_directory"
fi
chmod 700 "$base_directory"
if [ "$target_directory" != "$base_directory" ]; then
  if [ -e "$target_directory" ] || [ -L "$target_directory" ]; then
    [ -d "$target_directory" ] && [ ! -L "$target_directory" ]
  else
    umask 077
    mkdir "$target_directory"
  fi
fi
chmod 700 "$target_directory"
if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ -f "$destination" ] && [ ! -L "$destination" ]
  [ "$(stat -f '%u' "$destination")" = "$owner_uid" ]
  [ "$(stat -f '%Lp' "$destination")" = "600" ]
  digest="$(shasum -a 256 "$destination" | awk '{print $1}')"
  bytes="$(stat -f '%z' "$destination")"
  [ "$digest" = "${expectedSha256}" ] && [ "$bytes" = "${expectedBytes}" ]
  confirmed=1
  printf '%s %s %s\\n' '${marker}' "$digest" "$bytes"
  exit 0
fi
ln "$source_file" "$destination"
published_by_this_run=1
rm -f "$source_file"
[ -f "$destination" ] && [ ! -L "$destination" ]
[ "$(stat -f '%u' "$destination")" = "$owner_uid" ]
[ "$(stat -f '%Lp' "$destination")" = "600" ]
digest="$(shasum -a 256 "$destination" | awk '{print $1}')"
bytes="$(stat -f '%z' "$destination")"
[ "$digest" = "${expectedSha256}" ] && [ "$bytes" = "${expectedBytes}" ]
confirmed=1
printf '%s %s %s\\n' '${marker}' "$digest" "$bytes"
`;
}

function windowsPublishDriver({
  cleanupOnly,
  destinationKind,
  expectedIdentity,
  expectedBytes,
  expectedSha256,
  marker,
  name,
  nonce,
}) {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    !digestPattern.test(expectedSha256 ?? "")
  ) {
    throw new TransferPrivateInputError(
      "远端发布缺少有效的 expected SHA-256/size。",
    );
  }
  const expected = encodeIdentity(expectedIdentity);
  const artifactDirectory =
    destinationKind === "artifact" ? "artifacts" : undefined;
  return `$ErrorActionPreference = 'Stop'
$handoffBase = Join-Path $HOME '.dawn-forge'
$handoffDirectory = Join-Path $handoffBase 'handoff'
$sourceFile = Join-Path $handoffDirectory '${nonce}.tmp'
$downloads = Join-Path $HOME 'Downloads'
$baseDirectory = Join-Path $downloads 'dawn-forge'
$targetDirectory = ${artifactDirectory ? `Join-Path $baseDirectory '${artifactDirectory}'` : "$baseDirectory"}
$destination = Join-Path $targetDirectory '${name}'
$publishedByThisRun = $false
$confirmed = $false
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function Assert-DawnForgeHandoffDirectory([string]$path) {
  $item = Get-Item -Force -LiteralPath $path
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'invalid-handoff-directory' }
  $acl = Get-Acl -LiteralPath $path
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if (-not $acl.AreAccessRulesProtected -or $owner.Value -ne $currentSid.Value -or $rules.Count -ne 1) { throw 'handoff-acl-postcondition' }
  $only = $rules[0]
  $wanted = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  if ($only.IsInherited -or $only.IdentityReference.Value -ne $currentSid.Value -or $only.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($only.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) -or (($only.InheritanceFlags -band $wanted) -ne $wanted) -or $only.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'handoff-acl-postcondition' }
}
function Set-DawnForgeOwnedDirectory([string]$path) {
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($currentSid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($currentSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  [void]$security.AddAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $security
  Assert-DawnForgeHandoffDirectory $path
}
Assert-DawnForgeHandoffDirectory $handoffBase
Assert-DawnForgeHandoffDirectory $handoffDirectory
try {
  if (${cleanupOnly ? "$true" : "$false"}) { exit 0 }
  $expectedUser = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected.user}'))
  $expectedOs = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected.os}'))
  $expectedArchitecture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected.architecture}'))
  $expectedMachineId = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected.machineId}'))
  $actualMachineId = (Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid
  if (-not [String]::Equals([Environment]::UserName, $expectedUser, [StringComparison]::OrdinalIgnoreCase) -or $expectedOs -ne 'Windows' -or -not [String]::Equals($env:PROCESSOR_ARCHITECTURE, $expectedArchitecture, [StringComparison]::OrdinalIgnoreCase) -or -not [String]::Equals($actualMachineId, $expectedMachineId, [StringComparison]::OrdinalIgnoreCase)) { throw 'target-identity-mismatch' }
  $sourceItem = Get-Item -Force -LiteralPath $sourceFile
  if ($sourceItem.PSIsContainer -or (($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'invalid-source' }
  $sourceSecurity = [Security.AccessControl.FileSecurity]::new()
  $sourceSecurity.SetOwner($currentSid)
  $sourceSecurity.SetAccessRuleProtection($true, $false)
  $sourceRule = [Security.AccessControl.FileSystemAccessRule]::new($currentSid, 'FullControl', 'Allow')
  [void]$sourceSecurity.AddAccessRule($sourceRule)
  Set-Acl -LiteralPath $sourceFile -AclObject $sourceSecurity
  $sourceDigest = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($sourceDigest -ne '${expectedSha256}' -or $sourceItem.Length -ne ${expectedBytes}) { throw 'source-integrity-mismatch' }
  $downloadsItem = Get-Item -Force -LiteralPath $downloads
  if (-not $downloadsItem.PSIsContainer -or (($downloadsItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'invalid-downloads' }
  $baseItem = Get-Item -Force -LiteralPath $baseDirectory -ErrorAction SilentlyContinue
  if ($null -eq $baseItem) {
    New-Item -ItemType Directory -Path $baseDirectory -ErrorAction Stop | Out-Null
    $baseItem = Get-Item -Force -LiteralPath $baseDirectory
  }
  if (-not $baseItem.PSIsContainer -or (($baseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'invalid-base-directory' }
  Set-DawnForgeOwnedDirectory $baseDirectory
  $targetItem = Get-Item -Force -LiteralPath $targetDirectory -ErrorAction SilentlyContinue
  if ($null -eq $targetItem) {
    New-Item -ItemType Directory -Path $targetDirectory -ErrorAction Stop | Out-Null
    $targetItem = Get-Item -Force -LiteralPath $targetDirectory
  }
  if (-not $targetItem.PSIsContainer -or (($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'invalid-target-directory' }
  Set-DawnForgeOwnedDirectory $targetDirectory
  $existing = Get-Item -Force -LiteralPath $destination -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    [IO.File]::Move($sourceFile, $destination)
    $publishedByThisRun = $true
  }
  $published = Get-Item -Force -LiteralPath $destination
  if ($published.PSIsContainer) { throw 'published-not-file' }
  if (($published.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'published-reparse-point' }
  $acl = Get-Acl -LiteralPath $destination
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier])
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if (-not $acl.AreAccessRulesProtected -or $ownerSid.Value -ne $currentSid.Value -or $rules.Count -ne 1) { throw 'acl-postcondition' }
  $onlyRule = $rules[0]
  if ($onlyRule.IdentityReference.Value -ne $currentSid.Value -or $onlyRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($onlyRule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) { throw 'acl-postcondition' }
  $digest = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  $bytes = $published.Length
  if ($digest -ne '${expectedSha256}' -or $bytes -ne ${expectedBytes}) { throw 'published-integrity-mismatch' }
  $confirmed = $true
  [Console]::Out.WriteLine('${marker} ' + $digest + ' ' + $bytes)
} finally {
  if (Test-Path -LiteralPath $sourceFile) {
    Remove-Item -Force -LiteralPath $sourceFile
  }
  if ($publishedByThisRun -and -not $confirmed -and (Test-Path -LiteralPath $destination)) {
    Remove-Item -Force -LiteralPath $destination
  }
}
`;
}

function sshOptionArguments(config, user) {
  const knownHostsPath = join(dirname(config), "known_hosts").replaceAll(
    "\\",
    "/",
  );
  return [
    ...sshSafetyOptions,
    `UserKnownHostsFile=${quoteSshConfigValue(knownHostsPath)}`,
    `User=${user}`,
  ].flatMap((option) => ["-o", option]);
}

function quoteSshConfigValue(value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new TransferPrivateInputError(
      "SSH trust path 包含不支持的控制字符。",
    );
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function parseSshResolution(output) {
  const result = {};
  for (const line of String(output ?? "").replaceAll("\r", "").split("\n")) {
    const separator = line.indexOf(" ");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1);
    if (key === "identityfile") {
      (result.identityfile ??= []).push(value);
    } else if (!Object.hasOwn(result, key)) {
      result[key] = value;
    }
  }
  return result;
}

function parseKnownHostFingerprints(output) {
  const fingerprints = new Set();
  for (const line of String(output ?? "").replaceAll("\r", "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const fields = trimmed.split(/\s+/);
    const keyIndex = fields.findIndex((field) =>
      /^(?:ssh-|ecdsa-|sk-)/.test(field),
    );
    if (keyIndex < 0 || fields[keyIndex + 1] === undefined) continue;
    let blob;
    try {
      blob = Buffer.from(fields[keyIndex + 1], "base64");
    } catch {
      continue;
    }
    if (blob.length === 0) continue;
    const digest = createHash("sha256")
      .update(blob)
      .digest("base64")
      .replace(/=+$/, "");
    fingerprints.add(`SHA256:${digest}`);
  }
  return [...fingerprints].sort();
}

function assertSecureTrustFile(
  path,
  {
    inspectWindowsAcl,
    localPlatform,
    ownerOnly = false,
  },
) {
  const status = lstatSync(path);
  if (localPlatform === "win32") {
    const acl = inspectWindowsAcl(path);
    const safe =
      ownerOnly
        ? acl?.confidentialitySafe === true || acl?.safe === true
        : acl?.integritySafe === true || acl?.safe === true;
    if (
      !safe ||
      acl?.reparsePoint
    ) {
      throw new TransferPrivateInputError(
        "本地 SSH trust file 的 Windows ACL 向当前用户、SYSTEM 或 Administrators 之外的主体授予了访问权。",
        2,
        "ssh-trust-permissions-unsafe",
      );
    }
    return;
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new TransferPrivateInputError(
      "本地 SSH trust file 的 owner 不是当前用户。",
      2,
      "ssh-trust-permissions-unsafe",
    );
  }
  const forbidden = ownerOnly ? 0o077 : 0o022;
  if ((status.mode & forbidden) !== 0) {
    throw new TransferPrivateInputError(
      "本地 SSH trust file 的 mode 不安全。",
      2,
      "ssh-trust-permissions-unsafe",
    );
  }
}

export function assertTrustFilesUnchanged(receipt) {
  if (
    hashLocalFile(receipt.sshConfigPath, 8 * 1024 * 1024) !==
      receipt.sshConfigSha256 ||
    hashLocalFile(receipt.knownHostsPath, 16 * 1024 * 1024) !==
      receipt.knownHostsSha256
  ) {
    throw new TransferPrivateInputError(
      "SSH trust files 在传输前发生变化；尚未发送 private input。",
      3,
      "ssh-trust-drift",
    );
  }
}

function hashLocalFile(path, maximumBytes) {
  let before;
  let after;
  let value;
  try {
    before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > maximumBytes
    ) {
      throw new Error("invalid");
    }
    value = readFileSync(path);
    after = lstatSync(path);
  } catch {
    throw new TransferPrivateInputError(
      "无法安全读取本地 SSH trust file。",
      2,
      "ssh-trust-file-invalid",
    );
  }
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new TransferPrivateInputError(
      "本地 SSH trust file 在读取期间发生变化。",
      3,
      "ssh-trust-drift",
    );
  }
  return createHash("sha256").update(value).digest("hex");
}

function expandHomePath(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

function encodeIdentity(identity) {
  return Object.fromEntries(
    Object.entries(identity).map(([key, value]) => [
      key,
      Buffer.from(value, "utf8").toString("base64"),
    ]),
  );
}

function assertRegularUnredirectedFile(path, root, label) {
  try {
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error("not-regular");
    const realPath = realpathSync(path);
    if (!isPathWithin(realPath, resolve(root), true)) throw new Error("redirected");
  } catch {
    throw new TransferPrivateInputError(
      `${label} 不存在、不是普通文件或经过 symlink/reparse point。`,
      2,
      "local-file-invalid",
    );
  }
}

function assertPathChainUnredirected(root, destination) {
  const resolvedRoot = resolve(root);
  const resolvedDestination = resolve(destination);
  if (!isPathWithin(resolvedDestination, resolvedRoot, false)) {
    throw new TransferPrivateInputError(
      "private input 路径超出受保护目录。",
      2,
      "source-outside-private-root",
    );
  }
  let candidate = resolvedRoot;
  for (const segment of relative(resolvedRoot, resolvedDestination).split(sep)) {
    const status = lstatSync(candidate);
    if (status.isSymbolicLink()) {
      throw new TransferPrivateInputError(
        "private input 路径包含 symlink/reparse point。",
        2,
        "source-path-redirected",
      );
    }
    if (!sameFilesystemPath(realpathSync(candidate), candidate)) {
      throw new TransferPrivateInputError(
        "private input 路径包含 symlink/reparse point。",
        2,
        "source-path-redirected",
      );
    }
    candidate = join(candidate, segment);
  }
}

function assertNotGitTracked(path) {
  const marker = findNearestGitMarker(dirname(path));
  if (marker === undefined) return;
  const rootResult = spawnSync(
    "git",
    ["-C", dirname(path), "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  if (rootResult.error || rootResult.status !== 0) {
    throw new TransferPrivateInputError(
      "无法确认 private input 的 Git tracked 状态。",
      2,
      "git-status-unknown",
    );
  }
  const worktree = resolve(rootResult.stdout.trim());
  const relativePath = relative(worktree, path).replaceAll("\\", "/");
  const tracked = spawnSync(
    "git",
    ["-C", worktree, "ls-files", "--error-unmatch", "--", relativePath],
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );
  if (tracked.error || ![0, 1].includes(tracked.status)) {
    throw new TransferPrivateInputError(
      "无法确认 private input 的 Git tracked 状态。",
      2,
      "git-status-unknown",
    );
  }
  if (tracked.status === 0) {
    throw new TransferPrivateInputError(
      "private input 已被 Git tracked，已拒绝传输。",
      2,
      "source-git-tracked",
    );
  }
  const ignored = spawnSync(
    "git",
    ["-C", worktree, "check-ignore", "--quiet", "--", relativePath],
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );
  if (ignored.error || ignored.status !== 0) {
    throw new TransferPrivateInputError(
      "Git worktree 内的 private input 未被 ignore，已拒绝传输。",
      2,
      "source-not-ignored",
    );
  }
}

function findNearestGitMarker(start) {
  let candidate = resolve(start);
  while (true) {
    if (existsSync(join(candidate, ".git"))) return join(candidate, ".git");
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

export function inspectWindowsFileAcl(path) {
  const script = `$ErrorActionPreference='Stop'
$path=[Console]::In.ReadToEnd()
$item=Get-Item -Force -LiteralPath $path
$reparse=(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=Get-Acl -LiteralPath $path
$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier])
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
$safe=($acl.AreAccessRulesProtected -and $owner.Value -eq $current.Value -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $current.Value -and $rules[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and (($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl))
$trusted=@($current.Value,'S-1-5-18','S-1-5-32-544')
function Test-TrustedSid([string]$sid){return (($trusted -contains $sid) -or $sid.StartsWith('S-1-5-5-'))}
$integritySafe=(Test-TrustedSid $owner.Value)
$confidentialitySafe=$integritySafe
$writeMask=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
foreach($rule in $rules){
  if(-not (Test-TrustedSid $rule.IdentityReference.Value)){
    $confidentialitySafe=$false
    if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and (($rule.FileSystemRights -band $writeMask) -ne 0)){$integritySafe=$false}
  }
}
[Console]::Out.Write((@{safe=$safe;integritySafe=$integritySafe;confidentialitySafe=$confidentialitySafe;reparsePoint=$reparse}|ConvertTo-Json -Compress))
`;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      input: path,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) return { safe: false };
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { safe: false };
  }
}

function tightenWindowsFileAcl(path) {
  const account = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  if (!account) return false;
  const icacls = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "icacls.exe")
    : "icacls.exe";
  const inheritance = spawnSync(
    icacls,
    [path, "/inheritance:r", "/grant:r", `${account}:F`, "/q"],
    { stdio: "ignore", windowsHide: true },
  );
  return inheritance.status === 0;
}

function isPathWithin(path, root, allowRoot) {
  const fromRoot = relative(resolve(root), resolve(path));
  if (allowRoot && fromRoot.length === 0) return true;
  return (
    fromRoot.length > 0 &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function sameFilesystemPath(left, right) {
  try {
    const leftRealPath = realpathSync(left);
    const rightRealPath = realpathSync(right);
    const leftStatus = lstatSync(leftRealPath);
    const rightStatus = lstatSync(rightRealPath);
    return (
      leftStatus.dev === rightStatus.dev &&
      leftStatus.ino === rightStatus.ino
    );
  } catch {
    const normalizedLeft = resolve(left);
    const normalizedRight = resolve(right);
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    process.stdout.write(`${privateTransferUsage()}\n`);
    return;
  }
  const result = transferPrivateInput(parsed);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function privateTransferUsage() {
  return [
    "Usage:",
    `  node "${scriptPath}" --input <absolute-protected-file> \\`,
    "    --name <allowlisted-filename> --target <finalized-alias> \\",
    "    --config <absolute-ssh-config> --platform <macos|windows> \\",
    "    --target-identity-sha256 <digest>",
    "",
    "Requires a canonical finalize identity receipt with bound SSH config, known_hosts, management-key and target-identity digests.",
    `Allowed names: ${controlledPrivateInputNames.join(", ")}`,
    "The command never accepts a secret value or URL in argv.",
  ].join("\n");
}

if (resolve(process.argv[1] ?? "") === resolve(scriptPath)) {
  try {
    await runCli();
  } catch (error) {
    if (error instanceof TransferPrivateInputError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
    } else {
      console.error("private input 传输失败；秘密内容与子进程输出未回显。");
      process.exitCode = 1;
    }
  }
}
