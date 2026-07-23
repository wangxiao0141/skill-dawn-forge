#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname as systemHostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import {
  machineExecutionIdentityDigest,
  targetIdentityDigest,
} from "./target-identity.mjs";

const command = process.argv[2];
let options;
try {
  options = parseOptions(process.argv.slice(3));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const defaultKey = resolve(homedir(), ".ssh", "id_ed25519");
const keyPath = expandPath(options.key ?? defaultKey);
const publicKeyPath = `${keyPath}.pub`;
const sshKeygen = options["ssh-keygen"] ?? "ssh-keygen";
const sshExecutable = options.ssh ?? "ssh";
const scriptPath = fileURLToPath(import.meta.url);
const controllerName = controllerIdentityName();

if (
  !command ||
  options.help ||
  !["key", "plan", "install-key", "finalize"].includes(command)
) {
  printUsage();
  process.exit(command && !options.help ? 2 : 0);
}

try {
  validateCommandOptions(command, options);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

try {
  if (command === "key") {
    const result = inspectOrCreateKey(Boolean(options.create));
    printJson(result);
  } else if (command === "plan") {
    printJson(createPlan());
  } else if (command === "install-key") {
    installKey();
  } else {
    printJson(finalizeConnection());
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function parseOptions(args) {
  const parsed = {};
  const flags = new Set(["create", "windows-admin", "help"]);
  const values = new Set([
    "platform",
    "host",
    "user",
    "alias",
    "config",
    "key",
    "controller-name",
    "ssh",
    "ssh-keygen",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);

    const name = token.slice(2);
    if (!flags.has(name) && !values.has(name)) {
      throw new Error(`Unsupported option: --${name}`);
    }
    if (Object.prototype.hasOwnProperty.call(parsed, name)) {
      throw new Error(`Duplicate option: --${name}`);
    }
    if (flags.has(name)) {
      parsed[name] = true;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    parsed[name] = value;
    index += 1;
  }

  return parsed;
}

function validateCommandOptions(selectedCommand, parsed) {
  const commonTarget = [
    "platform",
    "host",
    "user",
    "alias",
    "config",
    "key",
    "ssh",
    "ssh-keygen",
  ];
  const allowed = {
    key: new Set(["create", "key", "controller-name", "ssh-keygen"]),
    plan: new Set([...commonTarget, "controller-name", "windows-admin"]),
    "install-key": new Set([
      ...commonTarget,
      "controller-name",
      "windows-admin",
    ]),
    finalize: new Set(commonTarget),
  }[selectedCommand];

  for (const name of Object.keys(parsed)) {
    if (!allowed.has(name)) {
      throw new Error(`Option --${name} is not supported by ${selectedCommand}.`);
    }
  }
}

function expandPath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

function assertRegularFile(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`The ${label} must be a regular file: ${path}.`);
  }
}

function secureLocalTrustFile(path, label) {
  assertRegularFile(path, label);
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
    return;
  }

  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$expected=@($me.Value,'S-1-5-18')",
    "& icacls.exe $p /inheritance:r | Out-Null",
    "if($LASTEXITCODE -ne 0){throw \"icacls failed: $LASTEXITCODE\"}",
    "$a=Get-Acl -LiteralPath $p",
    "$a.SetAccessRuleProtection($true,$false)",
    "foreach($r in @($a.Access)){[void]$a.RemoveAccessRuleSpecific($r)}",
    "foreach($sid in $expected){$id=[Security.Principal.SecurityIdentifier]::new($sid);$rule=[Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl','Allow');$a.AddAccessRule($rule)}",
    "Set-Acl -LiteralPath $p -AclObject $a",
    "$post=Get-Acl -LiteralPath $p",
    "$actual=@($post.Access|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}|Sort-Object -Unique)",
    "$wanted=@($expected|Sort-Object -Unique)",
    "$bad=@($post.Access|Where-Object{$_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $_.IsInherited})",
    "if(-not $post.AreAccessRulesProtected -or (Compare-Object $wanted $actual) -or $post.Access.Count -ne $wanted.Count -or $bad.Count -ne 0){throw 'local trust ACL postcondition failed'}",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  if (result.error) {
    throw new Error(`Cannot secure ${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `Cannot secure ${label}.`).trim(),
    );
  }
}

function runKeygen(args, timeout = 10_000) {
  const result = spawnSync(sshKeygen, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });

  if (result.error?.code === "ETIMEDOUT") {
    throw new Error("ssh-keygen operation exceeded its bounded timeout.");
  }
  if (result.error) throw new Error(`Cannot run ssh-keygen: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "ssh-keygen failed").trim());
  }

  return result.stdout.trim();
}

function fingerprint(path, timeout) {
  const output = runKeygen(["-lf", path], timeout);
  const match = output.match(/\bSHA256:[A-Za-z0-9+/=]+\b/);
  if (!match) throw new Error(`Cannot parse fingerprint for ${path}`);
  return match[0];
}

function inspectOrCreateKey(create, deadline) {
  const privateExists = existsSync(keyPath);
  const publicExists = existsSync(publicKeyPath);
  if (privateExists) assertRegularFile(keyPath, "management private key");
  if (publicExists) assertRegularFile(publicKeyPath, "management public key");

  if (!privateExists && !publicExists && !create) {
    return {
      exists: false,
      keyPath,
      publicKeyPath,
      next: "Run the same command with --create.",
    };
  }

  if (!privateExists && !publicExists) {
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    runKeygen([
      "-t",
      "ed25519",
      "-f",
      keyPath,
      "-N",
      "",
      "-C",
      controllerName,
    ], deadline ? remainingFinalizeTimeout(deadline) : undefined);
  } else if (!privateExists || !publicExists) {
    throw new Error("The SSH key pair is incomplete; do not overwrite it.");
  }
  secureLocalTrustFile(keyPath, "management private key");
  secureLocalTrustFile(publicKeyPath, "management public key");

  const publicLine = readFileSync(publicKeyPath, "utf8").trim();
  if (!publicLine.startsWith("ssh-ed25519 ")) {
    throw new Error("The default management key is not ED25519.");
  }

  const privateFingerprint = fingerprint(
    keyPath,
    deadline ? remainingFinalizeTimeout(deadline) : undefined,
  );
  const publicFingerprint = fingerprint(
    publicKeyPath,
    deadline ? remainingFinalizeTimeout(deadline) : undefined,
  );
  if (privateFingerprint !== publicFingerprint) {
    throw new Error("The private and public key fingerprints do not match.");
  }
  const passphrase = privateExists
    ? inspectPassphraseStatus(
        publicLine,
        deadline ? remainingFinalizeTimeout(deadline) : undefined,
      )
    : "none";

  return {
    exists: true,
    created: !privateExists,
    keyPath,
    publicKeyPath,
    fingerprint: publicFingerprint,
    passphrase,
  };
}

function inspectPassphraseStatus(publicLine, timeout = 10_000) {
  const result = spawnSync(
    sshKeygen,
    ["-y", "-P", "", "-f", keyPath],
    {
      encoding: "utf8",
      timeout,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) return "unknown-or-required";

  const [, expectedBlob] = publicLine.split(/\s+/, 2);
  const [, actualBlob] = result.stdout.trim().split(/\s+/, 2);
  return expectedBlob && actualBlob === expectedBlob ? "none" : "unknown-or-required";
}

function assertNonInteractiveManagementKey(key) {
  if (key.passphrase !== "none") {
    throw new Error(
      "The management key is encrypted or its empty passphrase cannot be proven; refusing a flow that disables ssh-agent.",
    );
  }
}

function createPlan() {
  const { platform, host, user } = targetOptions();
  const alias = requiredOption("alias");

  if (!validAlias(alias)) throw new Error("--alias contains unsupported characters.");

  const configPath = selectedConfigPath();
  preflightManagedAlias({ alias, configPath, host, user });
  preflightDirectTarget({ configPath, host, user });
  const key = inspectOrCreateKey(true);
  assertNonInteractiveManagementKey(key);

  return {
    platform,
    host,
    user,
    alias,
    controllerName,
    keyCreated: key.created,
    keyFingerprint: key.fingerprint,
    passphrase: key.passphrase,
    installKeyCommand: buildInstallKeyCommand(platform, host, user, alias, configPath),
    finalizeCommand: buildFinalizeCommand(platform, host, user, alias, configPath),
  };
}

function finalizeConnection() {
  const deadline = Date.now() + 30_000;
  const key = inspectOrCreateKey(false, deadline);
  assertNonInteractiveManagementKey(key);
  const { platform, host, user } = targetOptions();
  const alias = requiredOption("alias");

  if (!validAlias(alias)) {
    throw new Error("--alias contains unsupported characters.");
  }
  const configPath = selectedConfigPath();
  const operationLock = acquireOperationLock(configPath, alias);
  try {
    const previousReceipt = readIdentityReceipt(alias);
    preflightManagedAlias({
      alias,
      configPath,
      host,
      timeout: remainingFinalizeTimeout(deadline),
      user,
    });
    ensureConfigFile(configPath);
    secureLocalTrustFile(configPath, "SSH config");
    secureLocalTrustFile(
      controlledKnownHostsPath(configPath),
      "controlled known_hosts",
    );

    const directResolved = resolveDestination(
      `${user}@${host}`,
      configPath,
      remainingFinalizeTimeout(deadline),
    );
    validateDirectResolution(directResolved, { configPath, host, user });
    const directHostKeys = knownHostFingerprints(
      directResolved,
      controlledKnownHostsPath(configPath),
      remainingFinalizeTimeout(deadline),
    );
    assertHistoricalHostKeys(previousReceipt, directHostKeys);
    const directIdentity = probeTarget({
      configPath,
      host,
      platform,
      identityFile: keyPath,
      timeout: remainingFinalizeTimeout(deadline),
      user,
    });
    validateIdentity(directIdentity, { platform, host, user });
    const targetIdentitySha256 = targetIdentityDigest({
      platform,
      user: directIdentity.user,
      os: directIdentity.os,
      architecture: directIdentity.architecture,
      machineId: directIdentity.machineId,
      hostKeyFingerprints: directHostKeys,
    });
    const machineExecutionIdentitySha256 = machineExecutionIdentityDigest({
      platform,
      machineId: directIdentity.machineId,
      hostKeyFingerprints: directHostKeys,
    });
    assertHistoricalIdentity(previousReceipt, {
      directIdentity,
      hostKeyFingerprints: directHostKeys,
      machineExecutionIdentitySha256,
      targetIdentitySha256,
    });

    const configChange = ensureAlias({
      alias,
      configPath,
      host,
      identityFile: portableIdentityFile(keyPath),
      knownHostsFile: portableConfigPath(controlledKnownHostsPath(configPath)),
      timeout: remainingFinalizeTimeout(deadline),
      user,
    });

    try {
      const expectedConfigHash = configChange.writtenHash;
      const sshConfigSha256 = hashFile(configPath);
      if (sshConfigSha256 !== expectedConfigHash) {
        throw new Error(
          "SSH config changed concurrently before final verification.",
        );
      }
      const resolved = resolveCandidateDestination(
        alias,
        configPath,
        remainingFinalizeTimeout(deadline),
      );
      validateResolvedAlias(resolved, { configPath, host, keyPath, user });
      if (hashFile(configPath) !== sshConfigSha256) {
        throw new Error("SSH config changed during final verification.");
      }
      const knownHostsPath = controlledKnownHostsPath(configPath);
      const knownHostsSha256 = hashRequiredFile(
        knownHostsPath,
        "controlled known_hosts",
      );
      const aliasHostKeys = knownHostFingerprints(
        resolved,
        knownHostsPath,
        remainingFinalizeTimeout(deadline),
      );
      if (
        hashRequiredFile(knownHostsPath, "controlled known_hosts") !==
        knownHostsSha256
      ) {
        throw new Error(
          "The controlled known_hosts file changed during verification.",
        );
      }
      if (!sameFingerprintSet(directHostKeys, aliasHostKeys)) {
        throw new Error("The final alias resolves to a different SSH host key.");
      }
      const finalPrivateFingerprint = fingerprint(
        keyPath,
        remainingFinalizeTimeout(deadline),
      );
      const finalPublicFingerprint = fingerprint(
        publicKeyPath,
        remainingFinalizeTimeout(deadline),
      );
      if (
        finalPrivateFingerprint !== key.fingerprint ||
        finalPublicFingerprint !== key.fingerprint
      ) {
        throw new Error("The management SSH key changed during finalization.");
      }
      const identityFileSha256 = hashRequiredFile(
        keyPath,
        "management private key",
      );
      if (
        hashFile(configPath) !== sshConfigSha256 ||
        hashRequiredFile(knownHostsPath, "controlled known_hosts") !==
          knownHostsSha256 ||
        hashRequiredFile(keyPath, "management private key") !==
          identityFileSha256
      ) {
        throw new Error(
          "Local SSH trust material changed before receipt persistence.",
        );
      }

      const receipt = {
        schemaVersion: 1,
        finalizedAt: new Date().toISOString(),
        finalized: true,
        platform,
        host,
        user,
        alias,
        identityFile: keyPath,
        identityFileSha256,
        keyFingerprint: key.fingerprint,
        hostKeyFingerprints: aliasHostKeys,
        sshConfigPath: configPath,
        sshConfigSha256,
        knownHostsPath,
        knownHostsSha256,
        targetIdentitySha256,
        machineExecutionIdentitySha256,
        handoff: {
          schemaVersion: 1,
          relativePath: ".dawn-forge/handoff",
          protection:
            platform === "macos"
              ? "owner-directory-0700"
              : "current-user-inheritable-dacl",
        },
        identity: directIdentity,
        sshConfig: configChange.result,
      };
      const identityReceiptPath = writeIdentityReceipt(
        alias,
        receipt,
        previousReceipt,
      );
      return { ...receipt, identityReceiptPath };
    } catch (error) {
      const rolledBack = rollbackAlias(configChange);
      if (configChange.result.changed && !rolledBack) {
        throw new Error(
          `${error.message} The new alias could not be rolled back because the SSH config changed concurrently.`,
        );
      }
      throw error;
    }
  } finally {
    releaseOperationLock(operationLock);
  }
}

function identityReceiptPath(alias) {
  return resolve(
    homedir(),
    ".dawn-forge",
    "targets",
    alias.toLowerCase(),
    "identity.json",
  );
}

function readIdentityReceipt(alias) {
  const receiptPath = identityReceiptPath(alias);
  if (!existsSync(receiptPath)) {
    return { exists: false, hash: null, path: receiptPath, receipt: null };
  }
  secureLocalTrustFile(receiptPath, "identity receipt");
  const bytes = readFileSync(receiptPath);
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`The existing identity receipt is invalid: ${receiptPath}.`);
  }
  const requiredSafeStrings = [
    receipt.platform,
    receipt.host,
    receipt.user,
    receipt.alias,
    receipt.identityFile,
    receipt.keyFingerprint,
    receipt.sshConfigPath,
    receipt.knownHostsPath,
    receipt.identity?.user,
    receipt.identity?.os,
    receipt.identity?.architecture,
    receipt.identity?.version,
    receipt.identity?.machineId,
  ];
  const validFingerprint = (value) =>
    typeof value === "string" &&
    /^SHA256:[A-Za-z0-9+/]+={0,2}$/.test(value);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.finalized !== true ||
    requiredSafeStrings.some(
      (value) =>
        typeof value !== "string" ||
        !value ||
        /[\u0000-\u001f\u007f]/.test(value),
    ) ||
    receipt.alias.toLowerCase() !== alias.toLowerCase() ||
    !["macos", "windows"].includes(receipt.platform) ||
    !validFingerprint(receipt.keyFingerprint) ||
    !Array.isArray(receipt.hostKeyFingerprints) ||
    receipt.hostKeyFingerprints.length === 0 ||
    receipt.hostKeyFingerprints.some((value) => !validFingerprint(value)) ||
    !/^[a-f0-9]{64}$/.test(receipt.sshConfigSha256) ||
    !/^[a-f0-9]{64}$/.test(receipt.knownHostsSha256) ||
    !/^[a-f0-9]{64}$/.test(receipt.identityFileSha256) ||
    !/^[a-f0-9]{64}$/.test(receipt.targetIdentitySha256) ||
    !/^[a-f0-9]{64}$/.test(receipt.machineExecutionIdentitySha256) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      receipt.identity.machineId,
    ) ||
    receipt.handoff?.schemaVersion !== 1 ||
    receipt.handoff?.relativePath !== ".dawn-forge/handoff" ||
    receipt.handoff?.protection !==
      (receipt.platform === "macos"
        ? "owner-directory-0700"
        : "current-user-inheritable-dacl") ||
    receipt.user.toLowerCase() !== receipt.identity.user.toLowerCase()
  ) {
    throw new Error(`The existing identity receipt is incomplete: ${receiptPath}.`);
  }
  const recomputedTargetIdentity = targetIdentityDigest({
    platform: receipt.platform,
    user: receipt.identity.user,
    os: receipt.identity.os,
    architecture: receipt.identity.architecture,
    machineId: receipt.identity.machineId,
    hostKeyFingerprints: receipt.hostKeyFingerprints,
  });
  const recomputedMachineIdentity = machineExecutionIdentityDigest({
    platform: receipt.platform,
    machineId: receipt.identity.machineId,
    hostKeyFingerprints: receipt.hostKeyFingerprints,
  });
  if (
    recomputedTargetIdentity !== receipt.targetIdentitySha256 ||
    recomputedMachineIdentity !== receipt.machineExecutionIdentitySha256
  ) {
    throw new Error(
      `The existing identity receipt has inconsistent identity digests: ${receiptPath}.`,
    );
  }
  return {
    exists: true,
    hash: createHash("sha256").update(bytes).digest("hex"),
    path: receiptPath,
    receipt,
  };
}

function assertHistoricalIdentity(
  previous,
  {
    directIdentity,
    hostKeyFingerprints,
    machineExecutionIdentitySha256,
    targetIdentitySha256,
  },
) {
  if (!previous.exists) return;
  const old = previous.receipt;
  if (
    old.targetIdentitySha256 !== targetIdentitySha256 ||
    old.machineExecutionIdentitySha256 !== machineExecutionIdentitySha256 ||
    old.identity.machineId.toLowerCase() !==
      directIdentity.machineId.toLowerCase() ||
    !sameFingerprintSet(
      [...old.hostKeyFingerprints].sort(),
      [...hostKeyFingerprints].sort(),
    )
  ) {
    throw new Error(
      "The target identity conflicts with the existing finalized receipt; refusing to overwrite history.",
    );
  }
}

function assertHistoricalHostKeys(previous, hostKeyFingerprints) {
  if (!previous.exists) return;
  if (
    !sameFingerprintSet(
      [...previous.receipt.hostKeyFingerprints].sort(),
      [...hostKeyFingerprints].sort(),
    )
  ) {
    throw new Error(
      "The target host key conflicts with the existing finalized receipt; refusing to probe or overwrite history.",
    );
  }
}

function writeIdentityReceipt(alias, receipt, previous) {
  const receiptPath = identityReceiptPath(alias);
  const targetDirectory = dirname(receiptPath);
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    targetDirectory,
    `.identity.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    secureLocalTrustFile(temporaryPath, "identity receipt candidate");
    const existsNow = existsSync(receiptPath);
    if (existsNow !== previous.exists) {
      throw new Error("The identity receipt changed concurrently.");
    }
    if (
      existsNow &&
      createHash("sha256").update(readFileSync(receiptPath)).digest("hex") !==
        previous.hash
    ) {
      throw new Error("The identity receipt changed concurrently.");
    }
    publishReceiptCandidate(temporaryPath, receiptPath, previous);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Nothing was published.
    }
    throw new Error(
      `Cannot persist the target identity receipt: ${error.message ?? error.code ?? "write-failed"}.`,
    );
  }
  return receiptPath;
}

function publishReceiptCandidate(candidatePath, receiptPath, previous) {
  if (!previous.exists) {
    linkSync(candidatePath, receiptPath);
    try {
      unlinkSync(candidatePath);
    } catch {
      // Published receipt is valid; a stale private temp link can be cleaned later.
    }
    return;
  }

  const previousPath = join(
    dirname(receiptPath),
    `.identity.previous.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  renameSync(receiptPath, previousPath);
  if (hashFile(previousPath) !== previous.hash) {
    restoreBackupNoClobber(previousPath, receiptPath);
    throw new Error("The identity receipt changed concurrently.");
  }
  try {
    linkSync(candidatePath, receiptPath);
    try {
      unlinkSync(candidatePath);
      unlinkSync(previousPath);
    } catch {
      // Published receipt is valid; stale private temp links can be cleaned later.
    }
  } catch (error) {
    if (!existsSync(receiptPath)) {
      restoreBackupNoClobber(previousPath, receiptPath);
    }
    throw error;
  }
}

function installKey() {
  const { platform, host, user } = targetOptions();
  const alias = requiredOption("alias");
  if (!validAlias(alias)) {
    throw new Error("--alias contains unsupported characters.");
  }
  const configPath = selectedConfigPath();
  preflightManagedAlias({ alias, configPath, host, user });
  ensureConfigFile(configPath);
  const directResolved = resolveDestination(`${user}@${host}`, configPath);
  validateDirectResolution(directResolved, { configPath, host, user });
  const key = inspectOrCreateKey(false);
  assertNonInteractiveManagementKey(key);
  const managedKey = managedKeyPayload();
  const remoteCommand =
    platform === "macos"
      ? macosAuthorizeCommand(managedKey)
      : windowsRemoteCommand(
          windowsAuthorizeCommand(managedKey, Boolean(options["windows-admin"])),
        );

  const result = spawnSync(
    sshExecutable,
    [
      "-F",
      "none",
      ...sshContainmentOptions(configPath),
      ...directEndpointOptions(host, user),
      "-o",
      "BatchMode=no",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PasswordAuthentication=yes",
      "-o",
      "KbdInteractiveAuthentication=yes",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "HostbasedAuthentication=no",
      "-o",
      "GSSAPIAuthentication=no",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "NumberOfPasswordPrompts=1",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "ConnectionAttempts=1",
      host,
      remoteCommand,
    ],
    {
      stdio: "inherit",
      windowsHide: false,
    },
  );

  if (result.error) throw new Error(`Cannot run ssh: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`SSH key installation failed with exit code ${result.status}.`);
  secureLocalTrustFile(
    controlledKnownHostsPath(configPath),
    "controlled known_hosts",
  );

  printJson({
    installed: true,
    platform,
    host,
    user,
    controllerName,
    keyFingerprint: key.fingerprint,
  });
}

function targetOptions() {
  const platform = requiredOption("platform");
  const host = requiredOption("host");
  const user = requiredOption("user");

  if (!["macos", "windows"].includes(platform)) {
    throw new Error("--platform must be macos or windows.");
  }
  if (!validHost(host)) {
    throw new Error("--host must be a LAN hostname or private IP address.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(user)) {
    throw new Error("--user contains unsupported characters.");
  }

  return { platform, host, user };
}

function managedKeyPayload() {
  const publicLine = readFileSync(publicKeyPath, "utf8").trim();
  const [type, blob] = publicLine.split(/\s+/, 2);
  const managedLine = [
    "no-agent-forwarding,no-port-forwarding,no-X11-forwarding",
    type,
    blob,
    controllerName,
  ].join(" ");

  return {
    encodedLine: Buffer.from(managedLine, "utf8").toString("base64"),
    blob,
  };
}

function buildInstallKeyCommand(platform, host, user, alias, configPath) {
  const parts = [
    executableForUserShell(process.execPath),
    quoteForUserShell(scriptPath),
    "install-key",
    "--platform",
    platform,
    "--host",
    host,
    "--user",
    user,
    "--alias",
    alias,
    "--config",
    quoteForUserShell(configPath),
    "--controller-name",
    quoteForUserShell(controllerName),
  ];

  if (options["windows-admin"]) parts.push("--windows-admin");
  if (keyPath !== defaultKey) parts.push("--key", quoteForUserShell(keyPath));
  if (options.ssh) parts.push("--ssh", quoteForUserShell(options.ssh));
  if (options["ssh-keygen"]) {
    parts.push("--ssh-keygen", quoteForUserShell(options["ssh-keygen"]));
  }

  return parts.join(" ");
}

function buildFinalizeCommand(platform, host, user, alias, configPath) {
  const parts = [
    executableForUserShell(process.execPath),
    quoteForUserShell(scriptPath),
    "finalize",
    "--platform",
    platform,
    "--host",
    host,
    "--user",
    user,
    "--alias",
    alias,
    "--config",
    quoteForUserShell(configPath),
  ];

  if (keyPath !== defaultKey) parts.push("--key", quoteForUserShell(keyPath));
  if (options.ssh) parts.push("--ssh", quoteForUserShell(options.ssh));
  if (options["ssh-keygen"]) {
    parts.push("--ssh-keygen", quoteForUserShell(options["ssh-keygen"]));
  }

  return parts.join(" ");
}

function selectedConfigPath() {
  return expandPath(options.config ?? resolve(homedir(), ".ssh", "config"));
}

function sshConfigOptions(configPath) {
  return ["-F", configPath];
}

function controlledKnownHostsPath(configPath) {
  return resolve(dirname(configPath), "known_hosts");
}

function controlledKnownHostsOption(configPath) {
  const path = portableConfigPath(controlledKnownHostsPath(configPath));
  return `UserKnownHostsFile=${quoteSshConfigValue(path)}`;
}

function directEndpointOptions(host, user) {
  return [
    "-o",
    `HostName=${host}`,
    "-o",
    `User=${user}`,
    "-o",
    "Port=22",
    "-o",
    `HostKeyAlias=${host}`,
  ];
}

function remainingFinalizeTimeout(deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new Error("SSH finalization exceeded its overall timeout.");
  return remaining;
}

function requiredOption(name) {
  const value = options[name];
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

function controllerIdentityName() {
  const value = String(options["controller-name"] ?? systemHostname()).trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Cannot determine a safe controller host name.");
  }
  return value;
}

function validHost(host) {
  const addressFamily = isIP(host);
  if (addressFamily === 4) return isPrivateIpv4(host);
  if (addressFamily === 6) return isPrivateIpv6(host);
  if (host.length > 253) return false;
  const labels = host.split(".");
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  ) {
    return false;
  }

  const lower = host.toLowerCase();
  if (["localhost", "localhost.localdomain"].includes(lower)) return false;
  if (!lower.includes(".")) return false;
  return [".local", ".home.arpa"].some((suffix) => lower.endsWith(suffix));
}

function validAlias(alias) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias);
}

function isPrivateIpv4(host) {
  const octets = host.split(".").map(Number);
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254)
  );
}

function isPrivateIpv6(host) {
  const firstHextet = Number.parseInt(host.split(":", 1)[0], 16);
  if (!Number.isFinite(firstHextet)) return false;
  if ((firstHextet & 0xfe00) === 0xfc00) return true;
  if ((firstHextet & 0xffc0) === 0xfe80) return host.includes("%");
  return false;
}

function portableIdentityFile(path) {
  if (path === defaultKey) return "~/.ssh/id_ed25519";
  return path.replaceAll("\\", "/");
}

function portableConfigPath(path) {
  return path.replaceAll("\\", "/");
}

function quoteForUserShell(value) {
  if (process.platform === "win32") return `'${value.replaceAll("'", "''")}'`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteSshConfigValue(value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("SSH config path contains unsupported control characters.");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function executableForUserShell(value) {
  const quoted = quoteForUserShell(value);
  return process.platform === "win32" ? `& ${quoted}` : quoted;
}

function macosAuthorizeCommand({ encodedLine, blob }) {
  return [
    "set -e",
    `KEY="$(printf %s '${encodedLine}' | base64 -D)"`,
    `BLOB='${blob}'`,
    "umask 077",
    'mkdir -p "$HOME/.ssh"',
    'AUTH="$HOME/.ssh/authorized_keys"',
    'TMP="$AUTH.dawn-forge.$$"',
    'trap \'rm -f "$TMP"\' EXIT',
    'touch "$AUTH"',
    'chmod 700 "$HOME/.ssh"',
    'chmod 600 "$AUTH"',
    "awk -v blob=\"$BLOB\" '{ keep=1; for (i=1; i<=NF; i++) if ($i == blob) keep=0; if (keep) print }' \"$AUTH\" > \"$TMP\"",
    'printf \'%s\\n\' "$KEY" >> "$TMP"',
    'mv "$TMP" "$AUTH"',
    'chmod 600 "$AUTH"',
  ].join("; ");
}

function windowsAuthorizeCommand({ encodedLine, blob }, administrator) {
  const fileSetup = administrator
    ? "$d=Join-Path $env:ProgramData 'ssh';if(-not (Test-Path -LiteralPath $d)){throw 'Windows OpenSSH directory is missing'};$directory=Get-Item -Force -LiteralPath $d;if(-not $directory.PSIsContainer -or (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'invalid Windows OpenSSH directory'};$f=Join-Path $d 'administrators_authorized_keys'"
    : "$d=Join-Path $HOME '.ssh';if(Test-Path -LiteralPath $d){$directory=Get-Item -Force -LiteralPath $d;if(-not $directory.PSIsContainer -or (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'invalid SSH directory'}}else{New-Item -ItemType Directory -Path $d -ErrorAction Stop | Out-Null};$f=Join-Path $d 'authorized_keys'";
  const expectedSids = administrator
    ? "@('S-1-5-32-544','S-1-5-18')"
    : "@($me.Value,'S-1-5-18')";
  const operation = [
    "if(Test-Path -LiteralPath $f){Assert-DawnForgeRegularFile $f}else{$created=[IO.File]::Open($f,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$created.Dispose()}",
    "$oldHash=Get-DawnForgeHash $f",
    "$lines=@([IO.File]::ReadAllLines($f,$utf8))",
    "$kept=@($lines | Where-Object { -not (($_ -split '\\s+') -contains $b) })",
    "$text=((@($kept + $k) -join \"`n\") + \"`n\")",
    "$newBytes=$utf8.GetBytes($text)",
    "$tmp=Join-Path $d ('.dawn-forge-authorized-keys-new-'+[IO.Path]::GetRandomFileName())",
    "$backup=Join-Path $d ('.dawn-forge-authorized-keys-previous-'+[IO.Path]::GetRandomFileName())",
    "$failedPath=Join-Path $d ('.dawn-forge-authorized-keys-failed-'+[IO.Path]::GetRandomFileName())",
    "$stream=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)",
    "try{$stream.Write($newBytes,0,$newBytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}",
    "Set-DawnForgeAcl $tmp",
    "$newHash=Get-DawnForgeHash $tmp",
    "$published=$false",
    "try{[IO.File]::Replace($tmp,$f,$backup,$true);$published=$true;Assert-DawnForgeRegularFile $backup;Assert-DawnForgeRegularFile $f;$backupHash=Get-DawnForgeHash $backup;if($backupHash -ne $oldHash){throw 'authorized_keys changed concurrently before publish'};if((Get-DawnForgeHash $f) -ne $newHash){throw 'authorized_keys changed during publish'};Set-DawnForgeAcl $f;if((Get-DawnForgeHash $backup) -ne $backupHash -or (Get-DawnForgeHash $f) -ne $newHash){throw 'authorized_keys changed during ACL verification'};Remove-Item -LiteralPath $backup -Force}catch{$failure=$_;$rollbackFailure=$null;try{if($published){if(-not (Test-Path -LiteralPath $backup)){throw 'authorized_keys backup disappeared'};Assert-DawnForgeRegularFile $backup;Assert-DawnForgeRegularFile $f;if((Get-DawnForgeHash $f) -ne $newHash){throw 'published file was replaced'};$restoreHash=Get-DawnForgeHash $backup;[IO.File]::Replace($backup,$f,$failedPath,$true);if((Get-DawnForgeHash $f) -ne $restoreHash){throw 'authorized_keys rollback verification failed'};Remove-Item -LiteralPath $failedPath -Force}}catch{$rollbackFailure=$_};if($null -ne $rollbackFailure){throw \"authorized_keys rollback failed: $($rollbackFailure.Exception.Message); preserved previous file at $backup\"};throw $failure}finally{Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue}",
  ].join(";");

  return [
    "$ErrorActionPreference='Stop'",
    "$utf8=[Text.UTF8Encoding]::new($false,$true)",
    `$k=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedLine}'))`,
    `$b='${blob}'`,
    fileSetup,
    "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    `$expected=${expectedSids}`,
    "function Assert-DawnForgeRegularFile([string]$path){$item=Get-Item -Force -LiteralPath $path;if($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'authorized_keys must be a regular non-reparse file'}}",
    "function Get-DawnForgeHash([string]$path){$sha=[Security.Cryptography.SHA256]::Create();try{$bytes=[IO.File]::ReadAllBytes($path);return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}",
    "function Set-DawnForgeAcl([string]$path){& icacls.exe $path /inheritance:r | Out-Null;if($LASTEXITCODE -ne 0){throw \"icacls failed: $LASTEXITCODE\"};$a=Get-Acl -LiteralPath $path;$a.SetAccessRuleProtection($true,$false);foreach($r in @($a.Access)){[void]$a.RemoveAccessRuleSpecific($r)};foreach($sid in $expected){$id=[Security.Principal.SecurityIdentifier]::new($sid);$rule=[Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl','Allow');$a.AddAccessRule($rule)};Set-Acl -LiteralPath $path -AclObject $a;$post=Get-Acl -LiteralPath $path;$actual=@($post.Access|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}|Sort-Object -Unique);$wanted=@($expected|Sort-Object -Unique);$bad=@($post.Access|Where-Object{$_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $_.IsInherited});if(-not $post.AreAccessRulesProtected -or (Compare-Object $wanted $actual) -or $post.Access.Count -ne $wanted.Count -or $bad.Count -ne 0){throw 'authorized_keys ACL postcondition failed'}}",
    "$lockPath=Join-Path $d '.dawn-forge-authorized-keys.lock'",
    "$lockStream=[IO.FileStream]::new($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None,1,[IO.FileOptions]::DeleteOnClose)",
    `try{${operation}}finally{$lockStream.Dispose()}`,
  ].join("; ");
}

function windowsRemoteCommand(commandText) {
  const encoded = Buffer.from(commandText, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function probeTarget({
  configPath,
  host,
  platform,
  identityFile,
  timeout,
  user,
}) {
  const args = [
    "-F",
    "none",
    ...sshSafetyOptions(configPath),
    ...directEndpointOptions(host, user),
  ];
  if (identityFile) args.push("-i", identityFile);
  args.push(
    host,
    platform === "macos" ? macosProbeCommand() : windowsProbeCommand(),
  );

  const result = runSsh(args, timeout);
  return platform === "macos"
    ? parseMacosProbe(result.stdout)
    : parseWindowsProbe(result.stdout);
}

function sshContainmentOptions(configPath) {
  return [
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "CanonicalizeHostname=no",
    "-o",
    "ForkAfterAuthentication=no",
    "-o",
    "StdinNull=no",
    "-o",
    "RequestTTY=no",
    "-o",
    "Tunnel=no",
    "-o",
    "RemoteCommand=none",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "KnownHostsCommand=none",
    "-o",
    "IdentityAgent=none",
    "-o",
    "AddKeysToAgent=no",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    controlledKnownHostsOption(configPath),
    "-o",
    "GlobalKnownHostsFile=none",
  ];
}

function sshSafetyOptions(configPath) {
  return [
    ...sshContainmentOptions(configPath),
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "PubkeyAuthentication=yes",
    "-o",
    "HostbasedAuthentication=no",
    "-o",
    "GSSAPIAuthentication=no",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ConnectionAttempts=1",
  ];
}

function runSsh(args, timeout = 10_000) {
  const result = spawnSync(sshExecutable, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });

  if (result.error?.code === "ETIMEDOUT") {
    throw new Error("SSH operation exceeded its bounded timeout.");
  }
  if (result.error) throw new Error(`Cannot run ssh: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `ssh failed with exit code ${result.status}`).trim(),
    );
  }
  return result;
}

function macosProbeCommand() {
  return [
    "set -e",
    "umask 077",
    'handoff_base="$HOME/.dawn-forge"',
    'handoff_directory="$handoff_base/handoff"',
    'if [ -e "$handoff_base" ] || [ -L "$handoff_base" ]; then [ -d "$handoff_base" ] && [ ! -L "$handoff_base" ]; else mkdir "$handoff_base"; fi',
    'if [ -e "$handoff_directory" ] || [ -L "$handoff_directory" ]; then [ -d "$handoff_directory" ] && [ ! -L "$handoff_directory" ]; else mkdir "$handoff_directory"; fi',
    'chmod 700 "$handoff_base" "$handoff_directory"',
    'owner_uid="$(id -u)"',
    '[ "$(stat -f \'%u\' "$handoff_base")" = "$owner_uid" ]',
    '[ "$(stat -f \'%u\' "$handoff_directory")" = "$owner_uid" ]',
    '[ "$(stat -f \'%Lp\' "$handoff_base")" = "700" ]',
    '[ "$(stat -f \'%Lp\' "$handoff_directory")" = "700" ]',
    "printf '%s\\n' __DAWN_FORGE_MACOS_V1__",
    "id -un",
    "uname -s",
    "uname -m",
    "sw_vers -productVersion",
    "scutil --get LocalHostName 2>/dev/null || printf '\\n'",
    "scutil --get ComputerName 2>/dev/null || printf '\\n'",
    "scutil --get HostName 2>/dev/null || printf '\\n'",
    "ioreg -rd1 -c IOPlatformExpertDevice",
  ].join("; ");
}

function windowsProbeCommand() {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$handoffBase=Join-Path $HOME '.dawn-forge'",
    "$handoffDirectory=Join-Path $handoffBase 'handoff'",
    "foreach($directory in @($handoffBase,$handoffDirectory)){if(Test-Path -LiteralPath $directory){$item=Get-Item -Force -LiteralPath $directory;if(-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'invalid-handoff-directory'}}else{New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null}}",
    "function Set-DawnForgeHandoffAcl([string]$path){$security=[Security.AccessControl.DirectorySecurity]::new();$security.SetOwner($currentSid);$security.SetAccessRuleProtection($true,$false);$rule=[Security.AccessControl.FileSystemAccessRule]::new($currentSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');[void]$security.AddAccessRule($rule);Set-Acl -LiteralPath $path -AclObject $security;$post=Get-Acl -LiteralPath $path;$owner=$post.GetOwner([Security.Principal.SecurityIdentifier]);$rules=@($post.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if(-not $post.AreAccessRulesProtected -or $owner.Value -ne $currentSid.Value -or $rules.Count -ne 1){throw 'handoff ACL postcondition failed'};$only=$rules[0];$wanted=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit;if($only.IsInherited -or $only.IdentityReference.Value -ne $currentSid.Value -or $only.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($only.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) -or (($only.InheritanceFlags -band $wanted) -ne $wanted) -or $only.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){throw 'handoff ACL postcondition failed'}}",
    "Set-DawnForgeHandoffAcl $handoffBase",
    "Set-DawnForgeHandoffAcl $handoffDirectory",
    "$machineId=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid",
    "$value=[ordered]@{marker='__DAWN_FORGE_WINDOWS_V1__';user=[Environment]::UserName;os='Windows';architecture=$env:PROCESSOR_ARCHITECTURE;version=[Environment]::OSVersion.Version.ToString();machineId=$machineId;computerName=$env:COMPUTERNAME}",
    "$value | ConvertTo-Json -Compress",
  ].join("; ");
  return windowsRemoteCommand(script);
}

function parseMacosProbe(output) {
  const lines = output.replaceAll("\r", "").split("\n");
  if (lines[0] !== "__DAWN_FORGE_MACOS_V1__") {
    throw new Error("Cannot parse the macOS identity probe.");
  }

  const machineIdMatch = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  if (!machineIdMatch) throw new Error("Cannot determine the macOS machine ID.");

  return {
    user: lines[1],
    os: lines[2],
    architecture: lines[3],
    version: lines[4],
    localHostName: lines[5],
    computerName: lines[6],
    hostName: lines[7],
    machineId: machineIdMatch[1],
  };
}

function parseWindowsProbe(output) {
  let value;
  try {
    value = JSON.parse(output.trim());
  } catch {
    throw new Error("Cannot parse the Windows identity probe.");
  }
  if (value.marker !== "__DAWN_FORGE_WINDOWS_V1__") {
    throw new Error("Cannot parse the Windows identity probe.");
  }
  return {
    user: value.user,
    os: value.os,
    architecture: value.architecture,
    version: value.version,
    computerName: value.computerName,
    machineId: value.machineId,
  };
}

function validateIdentity(identity, expected) {
  for (const field of ["user", "os", "architecture", "version", "machineId"]) {
    if (
      typeof identity[field] !== "string" ||
      !identity[field].trim() ||
      /[\u0000-\u001f\u007f]/.test(identity[field])
    ) {
      throw new Error(`Remote identity has an invalid ${field}.`);
    }
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      identity.machineId,
    )
  ) {
    throw new Error("Remote identity has an invalid machineId.");
  }
  if (identity.user.toLowerCase() !== expected.user.toLowerCase()) {
    throw new Error(`Remote user mismatch: expected ${expected.user}, got ${identity.user}.`);
  }

  if (expected.platform === "macos") {
    if (identity.os !== "Darwin") {
      throw new Error(`Remote platform mismatch: expected Darwin, got ${identity.os}.`);
    }
    if (!["arm64", "x86_64"].includes(identity.architecture)) {
      throw new Error(`Unsupported macOS architecture: ${identity.architecture}.`);
    }
    if (!isIP(expected.host) && expected.host.toLowerCase().endsWith(".local")) {
      const discovered = `${identity.localHostName}.local`.toLowerCase();
      if (discovered !== expected.host.toLowerCase()) {
        throw new Error(
          `Remote LocalHostName mismatch: expected ${expected.host}, got ${discovered}.`,
        );
      }
    }
  } else {
    if (identity.os !== "Windows") {
      throw new Error(`Remote platform mismatch: expected Windows, got ${identity.os}.`);
    }
    if (!["AMD64", "ARM64"].includes(identity.architecture.toUpperCase())) {
      throw new Error(`Unsupported Windows architecture: ${identity.architecture}.`);
    }
  }
}

function ensureAlias({
  alias,
  configPath,
  host,
  identityFile,
  knownHostsFile,
  timeout,
  user,
}) {
  const { block, endMarker, startMarker } = managedAliasBlock({
    alias,
    host,
    identityFile,
    knownHostsFile,
    user,
  });
  const existed = existsSync(configPath);
  if (existed) assertRegularFile(configPath, "SSH config");
  const original = existed ? readFileSync(configPath, "utf8") : "";
  assertConfigCanBeEvaluated(original, configPath);
  const managedStart = original.indexOf(startMarker);

  if (managedStart !== -1) {
    const managedEnd = original.indexOf(endMarker, managedStart);
    if (managedEnd === -1) {
      throw new Error(`The Dawn Forge block for ${alias} is incomplete.`);
    }
    if (
      original.indexOf(startMarker, managedStart + startMarker.length) !== -1 ||
      original.indexOf(endMarker, managedEnd + endMarker.length) !== -1
    ) {
      throw new Error(`The Dawn Forge block for ${alias} is duplicated.`);
    }
    const existingBlock = original
      .slice(managedStart, managedEnd + endMarker.length)
      .replaceAll("\r\n", "\n");
    if (existingBlock !== block) {
      throw new Error(`The existing Dawn Forge block for ${alias} conflicts with this target.`);
    }
    const unmanaged = `${original.slice(0, managedStart)}${original.slice(
      managedEnd + endMarker.length,
    )}`;
    if (containsUnmanagedHostAlias(unmanaged, alias)) {
      throw new Error(`SSH alias ${alias} also exists outside its Dawn Forge block.`);
    }
    return {
      existed,
      originalHash: hashText(original),
      result: { path: configPath, changed: false, backup: null },
      writtenHash: hashText(original),
    };
  }

  if (containsUnmanagedHostAlias(original, alias)) {
    throw new Error(`SSH alias ${alias} already exists outside a Dawn Forge block.`);
  }

  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const written = composeManagedConfig(block, original);
  const candidatePath = writeConfigCandidate(configPath, written);
  let backup = null;
  try {
    const resolved = resolveCandidateDestination(alias, candidatePath, timeout);
    validateResolvedAlias(resolved, {
      configPath: candidatePath,
      host,
      keyPath,
      user,
    });
    backup = publishConfigCandidate({
      candidatePath,
      configPath,
      existed,
      originalHash: hashText(original),
    });
  } catch (error) {
    if (existsSync(candidatePath)) {
      unlinkSync(candidatePath);
    }
    throw error;
  }

  return {
    existed,
    originalHash: hashText(original),
    result: { path: configPath, changed: true, backup },
    writtenHash: hashText(written),
  };
}

function managedAliasBlock({
  alias,
  host,
  identityFile,
  knownHostsFile,
  user,
}) {
  const startMarker = `# >>> Dawn Forge: ${alias} >>>`;
  const endMarker = `# <<< Dawn Forge: ${alias} <<<`;
  return {
    startMarker,
    endMarker,
    block: [
      startMarker,
      `Host ${alias}`,
      `  HostName ${host}`,
      `  User ${user}`,
      `  IdentityFile ${quoteSshConfigValue(identityFile)}`,
      "  IdentitiesOnly yes",
      "  ClearAllForwardings yes",
      "  ForwardAgent no",
      "  ForwardX11 no",
      "  PermitLocalCommand no",
      "  ControlMaster no",
      "  ControlPath none",
      "  ControlPersist no",
      "  CanonicalizeHostname no",
      "  ForkAfterAuthentication no",
      "  StdinNull no",
      "  RequestTTY no",
      "  Tunnel no",
      "  RemoteCommand none",
      "  ProxyCommand none",
      "  ProxyJump none",
      "  KnownHostsCommand none",
      "  IdentityAgent none",
      "  AddKeysToAgent no",
      "  UpdateHostKeys no",
      "  BatchMode yes",
      "  PasswordAuthentication no",
      "  KbdInteractiveAuthentication no",
      "  PreferredAuthentications publickey",
      "  PubkeyAuthentication yes",
      "  HostbasedAuthentication no",
      "  GSSAPIAuthentication no",
      "  StrictHostKeyChecking yes",
      "  ConnectTimeout 8",
      "  ConnectionAttempts 1",
      `  UserKnownHostsFile ${quoteSshConfigValue(knownHostsFile)}`,
      "  GlobalKnownHostsFile none",
      endMarker,
    ].join("\n"),
  };
}

function preflightManagedAlias({ alias, configPath, host, timeout, user }) {
  const identityFile = portableIdentityFile(keyPath);
  const knownHostsFile = portableConfigPath(controlledKnownHostsPath(configPath));
  const { block, endMarker, startMarker } = managedAliasBlock({
    alias,
    host,
    identityFile,
    knownHostsFile,
    user,
  });
  const configExists = existsSync(configPath);
  if (configExists) assertRegularFile(configPath, "SSH config");
  const original = configExists ? readFileSync(configPath, "utf8") : "";
  assertConfigCanBeEvaluated(original, configPath);
  const managedStart = original.indexOf(startMarker);

  if (managedStart !== -1) {
    const managedEnd = original.indexOf(endMarker, managedStart);
    if (managedEnd === -1) {
      throw new Error(`The Dawn Forge block for ${alias} is incomplete.`);
    }
    if (
      original.indexOf(startMarker, managedStart + startMarker.length) !== -1 ||
      original.indexOf(endMarker, managedEnd + endMarker.length) !== -1
    ) {
      throw new Error(`The Dawn Forge block for ${alias} is duplicated.`);
    }
    const existingBlock = original
      .slice(managedStart, managedEnd + endMarker.length)
      .replaceAll("\r\n", "\n");
    if (existingBlock !== block) {
      throw new Error(`The existing Dawn Forge block for ${alias} conflicts with this target.`);
    }
    const unmanaged = `${original.slice(0, managedStart)}${original.slice(
      managedEnd + endMarker.length,
    )}`;
    if (containsUnmanagedHostAlias(unmanaged, alias)) {
      throw new Error(`SSH alias ${alias} also exists outside its Dawn Forge block.`);
    }
    const resolved = resolveCandidateDestination(alias, configPath, timeout);
    validateResolvedAlias(resolved, { configPath, host, keyPath, user });
    return;
  }

  if (containsUnmanagedHostAlias(original, alias)) {
    throw new Error(`SSH alias ${alias} already exists outside a Dawn Forge block.`);
  }

  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const preflightPath = writeConfigCandidate(
    configPath,
    composeManagedConfig(block, original),
  );

  try {
    const resolved = resolveCandidateDestination(alias, preflightPath, timeout);
    validateResolvedAlias(resolved, {
      configPath: preflightPath,
      host,
      keyPath,
      user,
    });
  } finally {
    unlinkSync(preflightPath);
  }
}

function composeManagedConfig(block, original) {
  if (!original) return `${block}\n`;
  const normalizedOriginal = original.endsWith("\n")
    ? original
    : `${original}\n`;
  return `${block}\n\nHost *\n${normalizedOriginal}`;
}

function preflightDirectTarget({ configPath, host, user }) {
  if (!existsSync(configPath)) return;
  assertRegularFile(configPath, "SSH config");
  assertConfigCanBeEvaluated(readFileSync(configPath, "utf8"), configPath);
  const resolved = resolveDestination(`${user}@${host}`, configPath);
  validateDirectResolution(resolved, { configPath, host, user });
}

function assertConfigCanBeEvaluated(content, configPath) {
  for (const rawLine of content.replaceAll("\r", "").split("\n")) {
    const line = rawLine.trimStart();
    if (!line || line.startsWith("#")) continue;
    if (/^(Include|Match)(?:\s|=)/i.test(line)) {
      throw new Error(
        `Cannot safely manage ${configPath}: Include and Match directives require manual review.`,
      );
    }
  }
}

function containsUnmanagedHostAlias(content, alias) {
  for (const rawLine of content.replaceAll("\r", "").split("\n")) {
    const line = rawLine.trimStart();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^Host(?:\s+|=)(.*)$/i);
    if (!match) continue;
    const patterns = match[1].split(/\s+/).filter(Boolean);
    if (
      patterns.some(
        (pattern) =>
          !pattern.startsWith("!") &&
          pattern.toLowerCase() === alias.toLowerCase(),
      )
    ) {
      return true;
    }
  }
  return false;
}

function ensureConfigFile(configPath) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  if (!existsSync(configPath)) {
    writeFileSync(configPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  } else {
    assertRegularFile(configPath, "SSH config");
  }
}

function acquireOperationLock(configPath, alias) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const lockPath = join(
    dirname(configPath),
    `.${basename(configPath)}.dawn-forge.lock`,
  );
  const token = randomBytes(16).toString("hex");
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify({ alias, pid: process.pid, token })}\n`,
      "utf8",
    );
    fsyncSync(descriptor);
    return { descriptor, lockPath, token };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error.code === "EEXIST") {
      throw new Error(
        `Another SSH finalization owns the operation lock: ${lockPath}.`,
      );
    }
    throw error;
  }
}

function releaseOperationLock(lock) {
  closeSync(lock.descriptor);
  try {
    const value = JSON.parse(readFileSync(lock.lockPath, "utf8"));
    if (value.token === lock.token) unlinkSync(lock.lockPath);
  } catch {
    // Never delete a lock whose ownership can no longer be proven.
  }
}

function writeConfigCandidate(configPath, content) {
  const candidatePath = join(
    dirname(configPath),
    `.${basename(configPath)}.dawn-forge-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(candidatePath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    secureLocalTrustFile(candidatePath, "SSH config candidate");
    return candidatePath;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(candidatePath)) unlinkSync(candidatePath);
    throw error;
  }
}

function publishConfigCandidate({
  candidatePath,
  configPath,
  existed,
  originalHash,
}) {
  const existsNow = existsSync(configPath);
  if (existsNow !== existed) {
    throw new Error("SSH config changed concurrently; candidate was not published.");
  }
  if (existed && hashText(readFileSync(configPath, "utf8")) !== originalHash) {
    throw new Error("SSH config changed concurrently; candidate was not published.");
  }

  if (!existed) {
    linkSync(candidatePath, configPath);
    try {
      unlinkSync(candidatePath);
    } catch {
      // The published hard link is authoritative; a temp link can be cleaned later.
    }
    return null;
  }

  const backup = nextBackupPath(configPath);
  renameSync(configPath, backup);
  if (hashFile(backup) !== originalHash) {
    const restored = restoreBackupNoClobber(backup, configPath);
    throw new Error(
      restored
        ? "SSH config changed concurrently; candidate was not published."
        : `SSH config changed concurrently and was preserved at ${backup}.`,
    );
  }
  try {
    linkSync(candidatePath, configPath);
    try {
      unlinkSync(candidatePath);
    } catch {
      // The published hard link is authoritative; a temp link can be cleaned later.
    }
    return backup;
  } catch (error) {
    if (!existsSync(configPath)) {
      restoreBackupNoClobber(backup, configPath);
    }
    throw error;
  }
}

function restoreBackupNoClobber(backupPath, configPath) {
  if (!existsSync(backupPath) || existsSync(configPath)) return false;
  try {
    linkSync(backupPath, configPath);
    unlinkSync(backupPath);
    return true;
  } catch {
    return false;
  }
}

function rollbackAlias(change) {
  if (!change.result.changed) return true;
  if (!existsSync(change.result.path)) return false;
  if (hashText(readFileSync(change.result.path, "utf8")) !== change.writtenHash) {
    return false;
  }

  const failedPath = join(
    dirname(change.result.path),
    `.${basename(change.result.path)}.dawn-forge-rollback-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  renameSync(change.result.path, failedPath);
  if (hashFile(failedPath) !== change.writtenHash) {
    restoreBackupNoClobber(failedPath, change.result.path);
    return false;
  }

  if (change.existed) {
    if (
      !change.result.backup ||
      !restoreBackupNoClobber(change.result.backup, change.result.path)
    ) {
      return false;
    }
  }
  const concurrentReplacement = existsSync(change.result.path) && !change.existed;
  unlinkSync(failedPath);
  if (concurrentReplacement) return false;
  return true;
}

function hashText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashRequiredFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`The ${label} file is missing: ${path}.`);
  }
  assertRegularFile(path, label);
  return hashFile(path);
}

function nextBackupPath(configPath) {
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  let candidate = `${configPath}.dawn-forge-${stamp}.bak`;
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = `${configPath}.dawn-forge-${stamp}-${suffix}.bak`;
    suffix += 1;
  }
  return candidate;
}

function resolveDestination(destination, configPath, timeout) {
  return resolveSshG([
    ...sshConfigOptions(configPath),
    "-G",
    ...sshSafetyOptions(configPath),
    destination,
  ], timeout);
}

function resolveCandidateDestination(destination, configPath, timeout) {
  return resolveSshG([
    ...sshConfigOptions(configPath),
    "-G",
    destination,
  ], timeout);
}

function resolveSshG(args, timeout) {
  const result = runSsh(args, timeout);
  const values = {};
  for (const line of result.stdout.replaceAll("\r", "").split("\n")) {
    const separator = line.indexOf(" ");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "identityfile") {
      (values.identityfile ??= []).push(value);
    } else if (!(key in values)) {
      values[key] = value;
    }
  }
  return values;
}

function validateResolvedAlias(
  resolved,
  { configPath, host, keyPath: expectedKeyPath, user },
) {
  if (resolved.hostname?.toLowerCase() !== host.toLowerCase()) {
    throw new Error(`SSH alias resolves to unexpected HostName: ${resolved.hostname}.`);
  }
  if (resolved.user?.toLowerCase() !== user.toLowerCase()) {
    throw new Error(`SSH alias resolves to unexpected User: ${resolved.user}.`);
  }
  if (resolved.identitiesonly !== "yes") {
    throw new Error("SSH alias must resolve to IdentitiesOnly yes.");
  }
  validateDirectResolution(resolved, { configPath, host, user });

  const identities = (resolved.identityfile ?? []).map((value) => expandPath(value));
  if (
    identities.length !== 1 ||
    !sameLocalPath(identities[0], resolve(expectedKeyPath))
  ) {
    throw new Error("SSH alias resolves to an unexpected IdentityFile.");
  }
}

function validateDirectResolution(resolved, { configPath, host, user }) {
  if (resolved.hostname?.toLowerCase() !== host.toLowerCase()) {
    throw new Error(
      `SSH destination resolves to unexpected HostName: ${resolved.hostname}.`,
    );
  }
  if (resolved.user?.toLowerCase() !== user.toLowerCase()) {
    throw new Error(`SSH destination resolves to unexpected User: ${resolved.user}.`);
  }
  if (resolved.port !== undefined && resolved.port !== "22") {
    throw new Error(`SSH destination resolves to unsupported Port: ${resolved.port}.`);
  }
  if (
    resolved.hostkeyalias &&
    resolved.hostkeyalias !== "none" &&
    resolved.hostkeyalias.toLowerCase() !== host.toLowerCase()
  ) {
    throw new Error(
      `SSH destination resolves to unexpected HostKeyAlias: ${resolved.hostkeyalias}.`,
    );
  }
  for (const field of ["proxycommand", "proxyjump"]) {
    if (resolved[field] && resolved[field] !== "none") {
      throw new Error(`SSH destination must not use ${field}.`);
    }
  }
  const requiredValues = {
    clearallforwardings: "yes",
    forwardagent: "no",
    forwardx11: "no",
    permitlocalcommand: "no",
    controlmaster: "false",
    controlpersist: "no",
    canonicalizehostname: "false",
    forkafterauthentication: "no",
    stdinnull: "no",
    requesttty: "false",
    tunnel: "false",
    batchmode: "yes",
    passwordauthentication: "no",
    kbdinteractiveauthentication: "no",
    preferredauthentications: "publickey",
    pubkeyauthentication: "true",
    hostbasedauthentication: "no",
    gssapiauthentication: "no",
    identitiesonly: "yes",
    stricthostkeychecking: "true",
    connecttimeout: "8",
    connectionattempts: "1",
  };
  for (const [field, expected] of Object.entries(requiredValues)) {
    if (resolved[field] !== expected) {
      throw new Error(`SSH destination resolves to unsafe ${field}: ${resolved[field]}.`);
    }
  }
  for (const field of ["localcommand", "knownhostscommand"]) {
    if (resolved[field] && resolved[field] !== "none") {
      throw new Error(`SSH destination must not use ${field}.`);
    }
  }
  if (resolved.controlpath && resolved.controlpath !== "none") {
    throw new Error(`SSH destination resolves to unsafe controlpath: ${resolved.controlpath}.`);
  }
  if (resolved.identityagent !== "none") {
    throw new Error(`SSH destination resolves to unsafe identityagent: ${resolved.identityagent}.`);
  }
  const rawKnownHosts = resolved.userknownhostsfile ?? "";
  const expectedKnownHosts = controlledKnownHostsPath(configPath);
  const exactKnownHostsPath =
    rawKnownHosts &&
    sameLocalPath(expandKnownHostsPath(rawKnownHosts), expectedKnownHosts);
  if (!exactKnownHostsPath) {
    throw new Error("SSH destination must use the controlled known_hosts file.");
  }
  if (resolved.globalknownhostsfile !== "none") {
    throw new Error("SSH destination must not use a global known_hosts file.");
  }
}

function sameLocalPath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function knownHostFingerprints(resolved, knownHostsPath, timeout = 10_000) {
  const host = resolved.hostkeyalias && resolved.hostkeyalias !== "none"
    ? resolved.hostkeyalias
    : resolved.hostname;
  if (!host) throw new Error("Cannot determine the resolved SSH host name.");
  const port = Number.parseInt(resolved.port ?? "22", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Unsupported resolved SSH port: ${resolved.port}.`);
  }
  const lookup = port === 22 ? host : `[${host}]:${port}`;
  const fingerprints = new Set();
  if (!existsSync(knownHostsPath)) {
    throw new Error(
      `Cannot confirm the SSH host key fingerprint for ${lookup}; finalize refused.`,
    );
  }
  const result = spawnSync(
    sshKeygen,
    ["-F", lookup, "-f", knownHostsPath],
    { encoding: "utf8", timeout, windowsHide: true },
  );
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error("SSH host-key lookup exceeded its bounded timeout.");
  }
  if (result.error) {
    throw new Error(`Cannot run ssh-keygen: ${result.error.message}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error((result.stderr || result.stdout || "ssh-keygen failed").trim());
  }
  if (result.status === 0) {
    for (const line of result.stdout.replaceAll("\r", "").split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const fields = line.trim().split(/\s+/);
      const keyTypeIndex = fields.findIndex(
        (value) =>
          value.startsWith("ssh-") ||
          value.startsWith("ecdsa-") ||
          value.startsWith("sk-"),
      );
      if (keyTypeIndex === -1 || !fields[keyTypeIndex + 1]) continue;
      const key = Buffer.from(fields[keyTypeIndex + 1], "base64");
      if (key.length === 0) continue;
      const digest = createHash("sha256")
        .update(key)
        .digest("base64")
        .replace(/=+$/, "");
      fingerprints.add(`SHA256:${digest}`);
    }
  }

  if (fingerprints.size === 0) {
    throw new Error(
      `Cannot confirm the SSH host key fingerprint for ${lookup}; finalize refused.`,
    );
  }
  return [...fingerprints].sort();
}

function expandKnownHostsPath(path) {
  const expanded = path.replaceAll("%d", homedir());
  return expandPath(expanded);
}

function sameFingerprintSet(left, right) {
  return (
    left.length === right.length &&
    left.every((fingerprint, index) => fingerprint === right[index])
  );
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printUsage() {
  console.log(`Usage:
  node "${scriptPath}" key [--create] [--key <path>] [--controller-name <name>] [--ssh-keygen <path>]
  node "${scriptPath}" plan --platform <macos|windows> --host <hostname-or-private-ip> --user <user> --alias <alias> [--config <path>] [--windows-admin] [--key <path>] [--controller-name <name>] [--ssh <path>]
  node "${scriptPath}" install-key --platform <macos|windows> --host <hostname-or-private-ip> --user <user> --alias <alias> [--config <path>] [--windows-admin] [--key <path>] [--controller-name <name>] [--ssh <path>]
  node "${scriptPath}" finalize --platform <macos|windows> --host <hostname-or-ip> --user <user> --alias <alias> [--key <path>] [--ssh <path>] [--ssh-keygen <path>] [--config <path>]`);
}
