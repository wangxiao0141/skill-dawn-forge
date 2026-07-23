#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createInstallationSchedule } from "./installation-batches.mjs";
import { validateProfile } from "./profile-validation.mjs";
import {
  machineExecutionIdentityDigest,
  targetIdentityDigest,
} from "./target-identity.mjs";

const protocol = "dawn-forge-preflight-v1";
const networkBootstrapProtocol = "dawn-forge-network-bootstrap-v1";
const sha256Pattern = /^[a-f0-9]{64}$/;
const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const routePattern = /^(?:direct|clash)$/;
const originPattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,63}$/;
const safeVersionPattern = /^[A-Za-z0-9][A-Za-z0-9.+_~^-]{0,79}$/;
const targetSources = new Set([
  "brew-formula",
  "brew-cask",
  "winget",
  "npm-global",
  "volta-tool",
]);
const manualSources = new Set([
  "manual",
  "mac-app-store",
  "microsoft-store",
]);

/**
 * 生成无秘密的完整安装计划。
 *
 * `spawnProcess` 是唯一 SSH seam；`probeControllerSoftware` 是
 * `official-download` 的受控 controller-side metadata/probe seam。
 */
export async function planInstallation(input, dependencies = {}) {
  const prepared = validatePlanInput(input);
  const now = dependencies.now ?? (() => new Date());
  const generatedAt = toUtcTimestamp(now());
  const priorReceipt = validatePriorPreflight(
    input.priorPreflightReceipt,
    input.priorPreflightSha256,
    prepared,
  );
  const snapshot = collectTargetSnapshot(prepared, priorReceipt, {
    spawnProcess: dependencies.spawnProcess ?? spawnSync,
  });

  const resolution = await resolveProfile({
    prepared,
    snapshot,
    generatedAt,
    probeControllerSoftware:
      dependencies.probeControllerSoftware ?? probeOfficialSoftware,
    priorControllerEvidence: priorReceipt?.controllerProbes ?? [],
  });
  const preflightReceipt = {
    schemaVersion: 1,
    protocol,
    observedAt: generatedAt,
    profileSha256: prepared.profileSha256,
    targetIdentitySha256:
      prepared.targetIdentityReceipt.targetIdentitySha256,
    machineExecutionIdentitySha256:
      prepared.targetIdentityReceipt.machineExecutionIdentitySha256,
    initialRoutes: { ...prepared.initialRoutes },
    target: {
      platform: prepared.profile.platform,
      architecture: snapshot.identity.architecture,
    },
    sshTrust: {
      sshConfigSha256:
        prepared.targetIdentityReceipt.sshConfigSha256,
      knownHostsSha256:
        prepared.targetIdentityReceipt.knownHostsSha256,
      identityFileSha256:
        prepared.targetIdentityReceipt.identityFileSha256,
    },
    inventory: publicInventory(snapshot.inventory),
    targetMetadata: snapshot.items.map(publicSnapshotItem),
    targetProbes: snapshot.probes.map(publicProbe),
    controllerProbes: resolution.controllerEvidence,
  };
  rejectSecretBearingValue(preflightReceipt, "$.preflightReceipt");
  const preflightSha256 = sha256(JSON.stringify(preflightReceipt));
  const hasRequiredConflict = resolution.decisions.some(
    (item) => item.disposition === "conflict",
  );
  const hasPendingProbe = resolution.decisions.some(
    (item) => item.disposition === "probe-required",
  );
  const status = hasRequiredConflict
    ? "conflict"
    : hasPendingProbe
      ? "route-probe-required"
    : resolution.actions.some(
        (action) => action.executionMode === "manual-receipt",
      )
      ? "manual-gate"
      : "planned";
  const schedule = hasRequiredConflict || hasPendingProbe
    ? null
    : createInstallationSchedule(resolution.actions, {
        initialRoutes: prepared.initialRoutes,
        maxItemsPerBatch: 3,
        preflightSha256,
        machineExecutionIdentitySha256:
          prepared.targetIdentityReceipt.machineExecutionIdentitySha256,
      });

  const plan = {
    schemaVersion: 1,
    status,
    generatedAt,
    profile: {
      id: prepared.profile.id,
      name: prepared.profile.name,
      platform: prepared.profile.platform,
      sha256: prepared.profileSha256,
    },
    target: {
      alias: prepared.targetAlias,
      platform: prepared.profile.platform,
      architecture: snapshot.identity.architecture,
      targetIdentitySha256:
        prepared.targetIdentityReceipt.targetIdentitySha256,
      machineExecutionIdentitySha256:
        prepared.targetIdentityReceipt.machineExecutionIdentitySha256,
    },
    initialRoutes: { ...prepared.initialRoutes },
    preflightSha256,
    preflightReceipt,
    inventory: publicInventory(snapshot.inventory),
    decisions: resolution.decisions,
    resolvedActions: resolution.actions,
    schedule,
    pendingRouteProbes: resolution.pendingRouteProbes,
    manualTasks: [...(prepared.profile.manualTasks ?? [])],
  };
  rejectSecretBearingValue(plan, "$");
  assertSshTrustFilesUnchanged(prepared);
  return plan;
}

export async function planNetworkBootstrap(input, dependencies = {}) {
  const prepared = validatePlanInput(input);
  const clashItems = prepared.profile.software.filter(
    (item) =>
      item.id === "clash-verge-rev" &&
      item.source === "official-download",
  );
  if (
    clashItems.length !== 1 ||
    prepared.profile.software.filter(
      (item) => item.id === "clash-verge-rev",
    ).length !== 1
  ) {
    throw new Error(
      "Network bootstrap requires exactly one Clash official-download item.",
    );
  }
  if (prepared.initialRoutes.target !== "direct") {
    throw new Error(
      "Network bootstrap target probe must start on the direct route.",
    );
  }
  const generatedAt = toUtcTimestamp(
    (dependencies.now ?? (() => new Date()))(),
  );
  if (clashItems[0].required !== true) {
    const value = {
      schemaVersion: 1,
      generatedAt,
      profileSha256: prepared.profileSha256,
      targetIdentitySha256:
        prepared.targetIdentityReceipt.targetIdentitySha256,
      machineExecutionIdentitySha256:
        prepared.targetIdentityReceipt.machineExecutionIdentitySha256,
      target: {
        alias: prepared.targetAlias,
        platform: prepared.profile.platform,
        architecture:
          prepared.targetIdentityReceipt.identity.architecture,
      },
      targetDirectProbe: null,
      status: "not-required",
      installedVersion: null,
      artifactRequest: null,
      action: null,
    };
    const result = {
      ...value,
      miniPlanSha256: sha256(JSON.stringify(value)),
    };
    assertSshTrustFilesUnchanged(prepared);
    return result;
  }
  const request = {
    protocol: networkBootstrapProtocol,
    mode: "network-bootstrap",
    profileSha256: prepared.profileSha256,
    platform: prepared.profile.platform,
    targetIdentitySha256:
      prepared.targetIdentityReceipt.targetIdentitySha256,
    machineExecutionIdentitySha256:
      prepared.targetIdentityReceipt.machineExecutionIdentitySha256,
    currentRoute: "direct",
    software: [],
    origins: ["api.github.com"],
    inventorySoftware: ["clash-verge-rev"],
  };
  const snapshot = runTargetPreflight(prepared, request, {
    spawnProcess: dependencies.spawnProcess ?? spawnSync,
  });
  validateNetworkBootstrapSnapshot(snapshot, prepared);
  const installed = snapshot.installedSoftware["clash-verge-rev"];
  const directProbe = snapshot.probes[0];
  const common = {
    schemaVersion: 1,
    generatedAt,
    profileSha256: prepared.profileSha256,
    targetIdentitySha256:
      prepared.targetIdentityReceipt.targetIdentitySha256,
    machineExecutionIdentitySha256:
      prepared.targetIdentityReceipt.machineExecutionIdentitySha256,
    target: {
      alias: prepared.targetAlias,
      platform: prepared.profile.platform,
      architecture: snapshot.identity.architecture,
    },
    targetDirectProbe: publicProbe(directProbe),
  };
  if (installed.present) {
    const value = {
      ...common,
      status: "already-installed",
      installedVersion: installed.version,
      artifactRequest: null,
      action: null,
    };
    const result = {
      ...value,
      miniPlanSha256: sha256(JSON.stringify(value)),
    };
    assertSshTrustFilesUnchanged(prepared);
    return result;
  }
  const adapter =
    dependencies.probeControllerSoftware ?? probeOfficialSoftware;
  let controlled;
  try {
    controlled = await adapter({
      software: publicSoftwareRequest(clashItems[0]),
      platform: prepared.profile.platform,
      architecture: snapshot.identity.architecture,
      currentRoute: prepared.initialRoutes.controller,
      targetInstalledVersion: null,
    });
  } catch {
    controlled = null;
  }
  if (
    !isPlainObject(controlled) ||
    controlled.status !== "missing" ||
    controlled.route !== prepared.initialRoutes.controller ||
    controlled.reachable !== true ||
    !safeVersionPattern.test(controlled.resolvedVersion ?? "") ||
    !validObservedAt(controlled.observedAt) ||
    !Array.isArray(controlled.origins)
  ) {
    const value = {
      ...common,
      status: "conflict",
      reason: "controller-official-adapter-unavailable",
      artifactRequest: null,
      action: null,
    };
    const result = {
      ...value,
      miniPlanSha256: sha256(JSON.stringify(value)),
    };
    assertSshTrustFilesUnchanged(prepared);
    return result;
  }
  validateOrigins(controlled.origins);
  const artifactRequest = validateBootstrapArtifactRequest(
    controlled.artifactRequest,
    {
      architecture: snapshot.identity.architecture,
      version: controlled.resolvedVersion,
    },
  );
  const action = {
    softwareId: "clash-verge-rev",
    name: clashItems[0].name,
    installer: "official-download",
    package: "clash-verge-rev",
    version: controlled.resolvedVersion,
    route: prepared.initialRoutes.controller,
    networkLocation: "controller",
    routeEvidence: {
      method: "controller-probe",
      origins: unique(controlled.origins).sort(),
      observedAt: controlled.observedAt,
    },
    dependsOn: [],
    executionMode: "manual-receipt",
    requiresAdmin: true,
    requiresGui: true,
    requiresRestart: controlled.requiresRestart,
  };
  const value = {
    ...common,
    status: "confirmation-required",
    controllerRoute: prepared.initialRoutes.controller,
    artifactRequest,
    action,
  };
  rejectSecretBearingValue(value, "$.networkBootstrap");
  const result = {
    ...value,
    miniPlanSha256: sha256(JSON.stringify(value)),
  };
  assertSshTrustFilesUnchanged(prepared);
  return result;
}

function validateNetworkBootstrapSnapshot(snapshot, prepared) {
  if (
    !isPlainObject(snapshot) ||
    snapshot.protocol !== networkBootstrapProtocol ||
    snapshot.profileSha256 !== prepared.profileSha256 ||
    !isPlainObject(snapshot.identity) ||
    !isPlainObject(snapshot.installedSoftware) ||
    !Array.isArray(snapshot.probes) ||
    snapshot.probes.length !== 1
  ) {
    throw new Error("Network bootstrap snapshot is invalid.");
  }
  for (const key of ["user", "os", "architecture", "machineId"]) {
    if (
      snapshot.identity[key] !==
      prepared.targetIdentityReceipt.identity[key]
    ) {
      throw new Error(`Network bootstrap target identity ${key} changed.`);
    }
  }
  const installed = snapshot.installedSoftware["clash-verge-rev"];
  if (
    !isPlainObject(installed) ||
    typeof installed.present !== "boolean" ||
    (installed.version !== null &&
      !safeVersionPattern.test(installed.version ?? ""))
  ) {
    throw new Error("Network bootstrap Clash inventory is invalid.");
  }
  validateTargetProbes(snapshot.probes, "direct");
  if (snapshot.probes[0].origin !== "api.github.com") {
    throw new Error("Network bootstrap endpoint probe is invalid.");
  }
  rejectSecretBearingValue(snapshot, "$.networkBootstrapSnapshot");
}

function validateBootstrapArtifactRequest(value, expected) {
  if (
    !isPlainObject(value) ||
    value.artifactId !== "clash-verge-rev" ||
    value.version !== expected.version ||
    value.architecture !== expected.architecture ||
    value.sourceMode !== "signed-download" ||
    !Array.isArray(value.allowedHosts)
  ) {
    throw new Error("Network bootstrap artifact request is invalid.");
  }
  validateOrigins(value.allowedHosts);
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("Network bootstrap artifact request is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !value.allowedHosts.includes(url.hostname.toLowerCase())
  ) {
    throw new Error("Network bootstrap artifact request is invalid.");
  }
  return {
    artifactId: value.artifactId,
    version: value.version,
    architecture: value.architecture,
    url: url.href,
    allowedHosts: unique(value.allowedHosts).sort(),
    sourceMode: value.sourceMode,
  };
}

function validatePlanInput(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("plan input must be an object.");
  }
  const profile = input.profile;
  const profileErrors = validateProfile(profile);
  if (profileErrors.length > 0) {
    throw new Error(`Profile validation failed:\n${profileErrors.join("\n")}`);
  }
  const profileRaw =
    typeof input.profileRaw === "string"
      ? input.profileRaw
      : JSON.stringify(profile, null, 2);
  rejectSecretBearingRaw(profileRaw, "Profile");
  let parsedRaw;
  try {
    parsedRaw = JSON.parse(profileRaw);
  } catch {
    throw new TypeError("profileRaw must contain the supplied profile JSON.");
  }
  if (JSON.stringify(parsedRaw) !== JSON.stringify(profile)) {
    throw new TypeError("profileRaw does not match profile.");
  }
  rejectSecretBearingValue(profile, "$.profile");
  for (const reservedId of [
    "homebrew-metadata",
    "command-line-tools",
    "node-runtime",
  ]) {
    if (profile.software.some((item) => item.id === reservedId)) {
      throw new Error(
        `Profile software id ${reservedId} conflicts with a controlled prerequisite.`,
      );
    }
  }

  if (!aliasPattern.test(input.targetAlias ?? "")) {
    throw new TypeError(
      "targetAlias must be a finalized SSH alias, not a host address.",
    );
  }
  if (
    typeof input.sshConfigPath !== "string" ||
    input.sshConfigPath.length === 0
  ) {
    throw new TypeError("sshConfigPath must be a non-empty path.");
  }
  const sshConfigPath = resolve(input.sshConfigPath);
  const receipt = validateIdentityReceipt(
    input.targetIdentityReceipt,
    profile.platform,
    input.targetAlias,
    sshConfigPath,
  );
  const initialRoutes = validateInitialRoutes(input.initialRoutes);

  return {
    profile,
    profileRaw,
    profileSha256: sha256(profileRaw),
    targetAlias: input.targetAlias,
    sshConfigPath,
    targetIdentityReceipt: receipt,
    initialRoutes,
  };
}

function validateIdentityReceipt(value, platform, alias, sshConfigPath) {
  if (!isPlainObject(value) || value.finalized !== true) {
    throw new TypeError("targetIdentityReceipt must be a finalized receipt.");
  }
  rejectSecretBearingValue(value, "$.targetIdentityReceipt");
  if (value.platform !== platform) {
    throw new Error("Profile platform does not match the finalized target.");
  }
  if (value.alias !== alias) {
    throw new Error("Target alias does not match the finalized receipt.");
  }
  for (const key of [
    "targetIdentitySha256",
    "machineExecutionIdentitySha256",
  ]) {
    if (!sha256Pattern.test(value[key] ?? "")) {
      throw new TypeError(
        `targetIdentityReceipt.${key} must be a lowercase SHA-256 digest.`,
      );
    }
  }
  if (
    typeof value.sshConfigPath !== "string" ||
    resolve(value.sshConfigPath) !== sshConfigPath
  ) {
    throw new Error("SSH config path does not match the finalized receipt.");
  }
  for (const key of [
    "sshConfigSha256",
    "knownHostsSha256",
    "identityFileSha256",
  ]) {
    if (!sha256Pattern.test(value[key] ?? "")) {
      throw new TypeError(`targetIdentityReceipt.${key} is invalid.`);
    }
  }
  for (const key of ["knownHostsPath", "identityFile"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new TypeError(`targetIdentityReceipt.${key} is invalid.`);
    }
  }
  if (!isPlainObject(value.identity)) {
    throw new TypeError("Finalized receipt identity is missing.");
  }
  for (const key of ["user", "os", "architecture", "machineId"]) {
    if (
      typeof value.identity[key] !== "string" ||
      value.identity[key].length === 0 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value.identity[key])
    ) {
      throw new TypeError(`Finalized receipt identity.${key} is invalid.`);
    }
  }
  if (
    !Array.isArray(value.hostKeyFingerprints) ||
    value.hostKeyFingerprints.length === 0 ||
    value.hostKeyFingerprints.some(
      (fingerprint) =>
        typeof fingerprint !== "string" ||
        !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint),
    )
  ) {
    throw new TypeError(
      "targetIdentityReceipt.hostKeyFingerprints is invalid.",
    );
  }
  const identityInput = {
    platform,
    user: value.identity.user,
    os: value.identity.os,
    architecture: value.identity.architecture,
    machineId: value.identity.machineId,
    hostKeyFingerprints: value.hostKeyFingerprints,
  };
  if (targetIdentityDigest(identityInput) !== value.targetIdentitySha256) {
    throw new Error("Finalized target identity digest mismatch.");
  }
  if (
    machineExecutionIdentityDigest(identityInput) !==
    value.machineExecutionIdentitySha256
  ) {
    throw new Error("Finalized machine execution identity digest mismatch.");
  }
  if (
    hashRequiredLocalFile(sshConfigPath, "SSH config") !==
      value.sshConfigSha256 ||
    hashRequiredLocalFile(
      resolve(value.knownHostsPath),
      "controlled known_hosts",
    ) !== value.knownHostsSha256 ||
    hashRequiredLocalFile(
      resolve(value.identityFile),
      "SSH identity file",
    ) !== value.identityFileSha256
  ) {
    throw new Error("Finalized SSH trust files changed; preflight refused.");
  }
  return structuredClone(value);
}

function validateInitialRoutes(value) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== 2 ||
    !routePattern.test(value.controller ?? "") ||
    !routePattern.test(value.target ?? "")
  ) {
    throw new TypeError(
      "initialRoutes must explicitly contain controller and target as direct or clash.",
    );
  }
  return {
    controller: value.controller,
    target: value.target,
  };
}

function validatePriorPreflight(receipt, digest, prepared) {
  if (receipt === undefined && digest === undefined) return null;
  if (!isPlainObject(receipt) || !sha256Pattern.test(digest ?? "")) {
    throw new TypeError(
      "priorPreflightReceipt and priorPreflightSha256 must be supplied together.",
    );
  }
  rejectSecretBearingValue(receipt, "$.priorPreflightReceipt");
  if (sha256(JSON.stringify(receipt)) !== digest) {
    throw new Error("Prior preflight receipt digest mismatch.");
  }
  if (
    receipt.schemaVersion !== 1 ||
    receipt.protocol !== protocol ||
    receipt.profileSha256 !== prepared.profileSha256 ||
    receipt.targetIdentitySha256 !==
      prepared.targetIdentityReceipt.targetIdentitySha256 ||
    receipt.machineExecutionIdentitySha256 !==
      prepared.targetIdentityReceipt.machineExecutionIdentitySha256 ||
    receipt.sshTrust?.identityFileSha256 !==
      prepared.targetIdentityReceipt.identityFileSha256 ||
    receipt.sshTrust?.sshConfigSha256 !==
      prepared.targetIdentityReceipt.sshConfigSha256 ||
    receipt.sshTrust?.knownHostsSha256 !==
      prepared.targetIdentityReceipt.knownHostsSha256 ||
    receipt.target?.platform !== prepared.profile.platform ||
    receipt.target?.architecture !==
      prepared.targetIdentityReceipt.identity.architecture
  ) {
    throw new Error("Prior preflight receipt identity changed.");
  }
  validateInventory(receipt.inventory);
  validateSnapshotItems(
    receipt.targetMetadata,
    createPreflightRequest(prepared, "full").software,
  );
  for (const route of ["direct", "clash"]) {
    const matching = receipt.targetProbes.filter(
      (probe) => probe.route === route,
    );
    if (matching.length > 0) validateTargetProbes(matching, route);
  }
  if (!Array.isArray(receipt.controllerProbes)) {
    throw new Error("Prior controller probe receipt is invalid.");
  }
  return structuredClone(receipt);
}

function collectTargetSnapshot(prepared, priorReceipt, { spawnProcess }) {
  if (priorReceipt === null) {
    const request = createPreflightRequest(prepared, "full");
    const snapshot = runTargetPreflight(prepared, request, { spawnProcess });
    validateSnapshot(snapshot, prepared, request);
    return snapshot;
  }

  const allOrigins = unresolvedTargetOrigins(priorReceipt);
  const alreadyProbed = new Set(
    priorReceipt.targetProbes
      .filter((probe) => probe.route === prepared.initialRoutes.target)
      .map((probe) => probe.origin),
  );
  const origins = allOrigins.filter((origin) => !alreadyProbed.has(origin));
  let additionalProbes = [];
  if (origins.length > 0) {
    const request = createPreflightRequest(prepared, "probe-only", origins);
    const probeSnapshot = runTargetPreflight(prepared, request, {
      spawnProcess,
    });
    validateProbeSnapshot(probeSnapshot, prepared, request);
    additionalProbes = probeSnapshot.probes;
  }
  const mergedProbes = [...priorReceipt.targetProbes, ...additionalProbes];
  rejectDuplicateProbeBatches(mergedProbes);
  return {
    protocol,
    profileSha256: prepared.profileSha256,
    identity: structuredClone(prepared.targetIdentityReceipt.identity),
    inventory: structuredClone(priorReceipt.inventory),
    items: structuredClone(priorReceipt.targetMetadata),
    probes: mergedProbes,
  };
}

function unresolvedTargetOrigins(receipt) {
  const probes = new Map(
    receipt.targetProbes.map((probe) => [
      `${probe.route}|${probe.origin}`,
      probe,
    ]),
  );
  const origins = [];
  for (const item of receipt.targetMetadata) {
    if (item.status !== "missing") continue;
    const hasWorkingRoute = ["direct", "clash"].some((route) =>
      item.origins.every(
        (origin) =>
          probes.get(`${route}|${origin}`)?.reachable === true,
      ),
    );
    if (!hasWorkingRoute) origins.push(...item.origins);
  }
  return unique(origins).sort();
}

function createPreflightRequest(prepared, mode, origins = []) {
  const software = prepared.profile.software
    .filter((item) => targetSources.has(item.source ?? "auto"))
    .map((item) => ({
      softwareId: item.id,
      source: item.source,
      package: item.package,
      requestedVersion: item.version ?? "latest-stable",
    }));
  const needsNodeRuntime =
    prepared.profile.software.some(
      (item) =>
        item.required !== false && item.source === "npm-global",
    ) &&
    !prepared.profile.software.some(
      (item) =>
        item.required !== false &&
        item.source === "volta-tool" &&
        item.package === "node",
    );
  if (needsNodeRuntime) {
    software.push({
      softwareId: "node-runtime",
      source: "volta-tool",
      package: "node",
      requestedVersion: "latest-stable",
    });
  }
  return {
    protocol,
    mode,
    profileSha256: prepared.profileSha256,
    platform: prepared.profile.platform,
    targetIdentitySha256:
      prepared.targetIdentityReceipt.targetIdentitySha256,
    currentRoute: prepared.initialRoutes.target,
    software: mode === "full" ? software : [],
    inventorySoftware:
      mode === "full"
        ? prepared.profile.software
            .filter((item) => item.source === "official-download")
            .map((item) => item.id)
        : [],
    origins: mode === "probe-only" ? origins : [],
  };
}

function runTargetPreflight(prepared, request, { spawnProcess }) {
  const remoteCommand =
    prepared.profile.platform === "macos"
      ? "/usr/bin/osascript -l JavaScript -"
      : "powershell.exe -NoProfile -NonInteractive -Command -";
  const args = [
    "-F",
    prepared.sshConfigPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ConnectionAttempts=1",
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
    "CanonicalizeHostname=no",
    "-o",
    `UserKnownHostsFile=${resolve(
      prepared.targetIdentityReceipt.knownHostsPath,
    )}`,
    "-i",
    resolve(prepared.targetIdentityReceipt.identityFile),
    prepared.targetAlias,
    remoteCommand,
  ];
  const driver =
    prepared.profile.platform === "macos"
      ? createMacosPreflightDriver(request)
      : createWindowsPreflightDriver(request);
  const result = spawnProcess("ssh", args, {
    encoding: "utf8",
    input: driver,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
    killSignal: "SIGTERM",
    windowsHide: true,
  });
  if (
    result === null ||
    typeof result !== "object" ||
    typeof result.then === "function"
  ) {
    throw new TypeError("spawnProcess must return a synchronous spawn result.");
  }
  if (result.error) {
    throw new Error("Controlled SSH preflight could not start.");
  }
  if (result.status !== 0) {
    throw new Error("Controlled SSH preflight failed; remote output omitted.");
  }
  if (typeof result.stdout !== "string") {
    throw new Error("Controlled SSH preflight returned no structured snapshot.");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(result.stdout);
  } catch {
    throw new Error("Controlled SSH preflight returned an invalid snapshot.");
  }
  return snapshot;
}

function validateSnapshot(snapshot, prepared, request) {
  if (!isPlainObject(snapshot) || snapshot.protocol !== protocol) {
    throw new Error("Controlled SSH preflight protocol mismatch.");
  }
  if (snapshot.profileSha256 !== request.profileSha256) {
    throw new Error("Preflight snapshot does not match the selected profile.");
  }
  if (!isPlainObject(snapshot.identity)) {
    throw new Error("Preflight target identity is missing.");
  }
  const receiptIdentity = prepared.targetIdentityReceipt.identity;
  for (const key of ["user", "os", "architecture", "machineId"]) {
    if (snapshot.identity[key] !== receiptIdentity[key]) {
      throw new Error(`Preflight target identity ${key} changed.`);
    }
  }
  if (
    (prepared.profile.platform === "macos" &&
      snapshot.identity.os !== "Darwin") ||
    (prepared.profile.platform === "windows" &&
      snapshot.identity.os !== "Windows")
  ) {
    throw new Error("Preflight target platform mismatch.");
  }
  validateInventory(snapshot.inventory);
  validateSnapshotItems(snapshot.items, request.software);
  validateTargetProbes(
    snapshot.probes,
    prepared.initialRoutes.target,
  );
  rejectSecretBearingValue(snapshot, "$.snapshot");
}

function validateProbeSnapshot(snapshot, prepared, request) {
  if (
    !isPlainObject(snapshot) ||
    snapshot.protocol !== protocol ||
    snapshot.profileSha256 !== request.profileSha256 ||
    !isPlainObject(snapshot.identity)
  ) {
    throw new Error("Controlled SSH route probe protocol mismatch.");
  }
  for (const key of ["user", "os", "architecture", "machineId"]) {
    if (
      snapshot.identity[key] !==
      prepared.targetIdentityReceipt.identity[key]
    ) {
      throw new Error(`Route probe target identity ${key} changed.`);
    }
  }
  validateTargetProbes(snapshot.probes, request.currentRoute);
  const expected = [...request.origins].sort();
  const actual = snapshot.probes.map((probe) => probe.origin).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("Route probe origins do not match the staged request.");
  }
  rejectSecretBearingValue(snapshot, "$.probeSnapshot");
}

function rejectDuplicateProbeBatches(probes) {
  const seen = new Set();
  for (const probe of probes) {
    const key = `${probe.networkLocation}|${probe.route}|${probe.origin}`;
    if (seen.has(key)) {
      throw new Error("An endpoint was probed more than once on the same route.");
    }
    seen.add(key);
  }
}

function validateInventory(value) {
  if (!isPlainObject(value)) {
    throw new Error("Preflight inventory is missing.");
  }
  if (
    !Number.isSafeInteger(value.diskAvailableBytes) ||
    value.diskAvailableBytes < 0
  ) {
    throw new Error("Preflight disk inventory is invalid.");
  }
  if (typeof value.adminCapable !== "boolean") {
    throw new Error("Preflight permission inventory is invalid.");
  }
  if (!isPlainObject(value.tools)) {
    throw new Error("Preflight tool inventory is invalid.");
  }
  if (
    !isPlainObject(value.commandLineTools) ||
    typeof value.commandLineTools.present !== "boolean"
  ) {
    throw new Error("Preflight command-line-tools inventory is invalid.");
  }
  for (const name of ["homebrew", "npm", "volta"]) {
    const tool = value.tools[name];
    if (
      !isPlainObject(tool) ||
      typeof tool.present !== "boolean" ||
      (tool.version !== null &&
        (typeof tool.version !== "string" ||
          !safeVersionPattern.test(tool.version)))
    ) {
      throw new Error(`Preflight ${name} inventory is invalid.`);
    }
  }
  if (
    value.installedSoftware !== undefined &&
    !isPlainObject(value.installedSoftware)
  ) {
    throw new Error("Preflight installed-software inventory is invalid.");
  }
}

function validateSnapshotItems(items, requestedItems) {
  if (!Array.isArray(items)) {
    throw new Error("Preflight metadata items are missing.");
  }
  const requestById = new Map(
    requestedItems.map((item) => [item.softwareId, item]),
  );
  const seen = new Set();
  for (const item of items) {
    if (!isPlainObject(item) || !requestById.has(item.softwareId)) {
      throw new Error("Preflight returned unexpected software metadata.");
    }
    if (seen.has(item.softwareId)) {
      throw new Error("Preflight returned duplicate software metadata.");
    }
    seen.add(item.softwareId);
    const requested = requestById.get(item.softwareId);
    if (item.source !== requested.source || item.package !== requested.package) {
      throw new Error("Preflight software metadata does not match the profile.");
    }
    if (
      !["missing", "current", "outdated", "conflict"].includes(item.status)
    ) {
      throw new Error("Preflight software status is invalid.");
    }
    for (const key of ["installedVersion", "resolvedVersion"]) {
      if (
        item[key] !== null &&
        (typeof item[key] !== "string" ||
          !safeVersionPattern.test(item[key]))
      ) {
        throw new Error("Preflight software version metadata is invalid.");
      }
    }
    validateOrigins(item.origins);
    for (const key of [
      "requiresAdmin",
      "requiresGui",
      "requiresRestart",
    ]) {
      if (item[key] !== null && typeof item[key] !== "boolean") {
        throw new Error("Preflight permission metadata is invalid.");
      }
    }
  }
}

function validateTargetProbes(probes, currentRoute) {
  if (!Array.isArray(probes)) {
    throw new Error("Preflight endpoint probes are missing.");
  }
  const seen = new Set();
  for (const probe of probes) {
    if (
      !isPlainObject(probe) ||
      probe.networkLocation !== "target" ||
      probe.route !== currentRoute ||
      typeof probe.reachable !== "boolean" ||
      !validObservedAt(probe.observedAt)
    ) {
      throw new Error("Preflight target route evidence is invalid.");
    }
    validateOrigins([probe.origin]);
    if (seen.has(probe.origin)) {
      throw new Error("Preflight returned duplicate endpoint probes.");
    }
    seen.add(probe.origin);
  }
}

async function resolveProfile({
  prepared,
  snapshot,
  generatedAt,
  probeControllerSoftware,
  priorControllerEvidence,
}) {
  const actions = [];
  const decisions = [];
  const controllerEvidence = structuredClone(priorControllerEvidence);
  const pendingRouteProbes = [];
  const snapshotItems = new Map(
    snapshot.items.map((item) => [item.softwareId, item]),
  );
  const targetProbes = new Map(
    snapshot.probes.map((probe) => [
      `${probe.route}|${probe.origin}`,
      probe,
    ]),
  );
  const softwareById = new Map(
    prepared.profile.software.map((item) => [item.id, item]),
  );
  const selectedSoftware = prepared.profile.software.filter(
    (item) => item.required !== false,
  );

  const homebrew = softwareById.get("homebrew");
  const brewItems = selectedSoftware.filter((item) =>
    ["brew-formula", "brew-cask"].includes(item.source),
  );
  let commandLineToolsAction = null;
  if (
    prepared.profile.platform === "macos" &&
    brewItems.length > 0 &&
    snapshot.inventory.commandLineTools.present === false
  ) {
    commandLineToolsAction = {
      softwareId: "command-line-tools",
      name: "Apple Command Line Tools",
      installer: "manual",
      package: "command-line-tools",
      version: "latest-stable",
      route: "local",
      networkLocation: "none",
      routeEvidence: { method: "no-network", origins: [] },
      dependsOn: [],
      executionMode: "manual-receipt",
      requiresAdmin: true,
      requiresGui: true,
      requiresRestart: false,
    };
    actions.push(commandLineToolsAction);
    decisions.push({
      softwareId: "command-line-tools",
      name: "Apple Command Line Tools",
      source: "system-prerequisite",
      disposition: "manual",
      installedVersion: null,
      resolvedVersion: "latest-stable",
      reason: "command-line-tools-required",
    });
  }
  let homebrewAction = null;
  if (homebrew?.source === "auto") {
    if (snapshot.inventory.tools.homebrew.present) {
      decisions.push(
        decision(homebrew, "skip", {
          installedVersion: snapshot.inventory.tools.homebrew.version,
          resolvedVersion: snapshot.inventory.tools.homebrew.version,
          reason: "already-installed",
        }),
      );
    } else {
      homebrewAction = {
        softwareId: "homebrew",
        name: homebrew.name,
        installer: "manual",
        package: "homebrew",
        version: homebrew.version ?? "latest-stable",
        route: "local",
        networkLocation: "none",
        routeEvidence: {
          method: "no-network",
          origins: [],
        },
        dependsOn: commandLineToolsAction
          ? ["command-line-tools"]
          : [],
        executionMode: "manual-receipt",
        requiresAdmin: true,
        requiresGui: false,
        requiresRestart: false,
      };
      actions.push(homebrewAction);
      decisions.push(
        decision(homebrew, "manual", {
          installedVersion: null,
          resolvedVersion: homebrewAction.version,
          reason: "homebrew-bootstrap-requires-user-authorization",
        }),
      );
    }
  }

  let metadataAction = null;
  let metadataPendingRoute = null;
  if (brewItems.length > 0) {
    if (!snapshot.inventory.tools.homebrew.present && !homebrewAction) {
      for (const item of brewItems) {
        decisions.push(
          decision(item, "conflict", {
            reason: "homebrew-prerequisite-unresolved",
          }),
        );
      }
    } else {
      const metadataRoute = routeEvidenceForTarget(
        ["formulae.brew.sh"],
        targetProbes,
        prepared.initialRoutes.target,
      );
      if (metadataRoute !== null) {
        metadataAction = {
          softwareId: "homebrew-metadata",
          name: "Homebrew metadata",
          installer: "homebrew-metadata",
          package: "homebrew-metadata",
          version: "latest-stable",
          route: metadataRoute.route,
          networkLocation: "target",
          routeEvidence: metadataRoute.evidence,
          dependsOn: [
            ...(commandLineToolsAction
              ? ["command-line-tools"]
              : []),
            ...(homebrewAction ? ["homebrew"] : []),
          ],
          executionMode: "automated",
          requiresAdmin: false,
          requiresGui: false,
          requiresRestart: false,
        };
        actions.push(metadataAction);
      } else {
        const alternateRoute =
          prepared.initialRoutes.target === "direct" ? "clash" : "direct";
        if (!targetProbes.has(`${alternateRoute}|formulae.brew.sh`)) {
          metadataPendingRoute = alternateRoute;
          pendingRouteProbes.push({
            networkLocation: "target",
            route: alternateRoute,
            origins: ["formulae.brew.sh"],
          });
        }
      }
    }
  }

  if (
    selectedSoftware.some((item) => item.source === "npm-global") &&
    snapshot.inventory.tools.npm.present === false &&
    !selectedSoftware.some(
      (item) =>
        item.source === "volta-tool" && item.package === "node",
    )
  ) {
    const nodeSoftware = {
      id: "node-runtime",
      name: "Node.js runtime",
      source: "volta-tool",
      package: "node",
      required: true,
    };
    const resolvedNode = resolveTargetSoftware({
      software: nodeSoftware,
      metadata: snapshotItems.get("node-runtime"),
      targetProbes,
      currentRoute: prepared.initialRoutes.target,
      metadataDependency: [],
      softwareById,
      actions,
      inventory: snapshot.inventory,
    });
    if (resolvedNode.action) {
      resolvedNode.action.dependsOn =
        snapshot.inventory.tools.volta.present === false &&
        softwareById.has("volta")
          ? ["volta"]
          : [];
      actions.push(resolvedNode.action);
    }
    decisions.push(resolvedNode.decision);
    if (resolvedNode.pending) {
      pendingRouteProbes.push(resolvedNode.pending);
    }
  }

  for (const software of selectedSoftware) {
    const source = software.source ?? "auto";
    if (software.id === "homebrew" && source === "auto") continue;

    if (targetSources.has(source)) {
      if (
        ["brew-formula", "brew-cask"].includes(source) &&
        metadataAction === null
      ) {
        if (!decisions.some((item) => item.softwareId === software.id)) {
          decisions.push(
            decision(
              software,
              metadataPendingRoute ? "probe-required" : "conflict",
              {
                reason: metadataPendingRoute
                  ? `homebrew-metadata-route-evidence-required:${metadataPendingRoute}`
                  : "homebrew-metadata-unreachable",
              },
            ),
          );
        }
        continue;
      }
      const metadata = snapshotItems.get(software.id);
      const resolved = resolveTargetSoftware({
        software,
        metadata,
        targetProbes,
        currentRoute: prepared.initialRoutes.target,
        metadataDependency:
          ["brew-formula", "brew-cask"].includes(source) && metadataAction
            ? ["homebrew-metadata"]
            : [],
        softwareById,
        actions,
        inventory: snapshot.inventory,
      });
      decisions.push(resolved.decision);
      if (resolved.action) actions.push(resolved.action);
      if (resolved.pending) pendingRouteProbes.push(resolved.pending);
      continue;
    }

    if (source === "official-download") {
      const installed =
        snapshot.inventory.installedSoftware?.[software.id];
      if (
        !isPlainObject(installed) ||
        installed.present !== true ||
        !safeVersionPattern.test(installed.version ?? "")
      ) {
        decisions.push(
          decision(software, "conflict", {
            installedVersion: null,
            resolvedVersion: null,
            reason:
              "canonical-artifact-request-unavailable-in-full-plan",
          }),
        );
        continue;
      }
      let controlled = controllerEvidence.find(
        (item) =>
          item.softwareId === software.id &&
          (item.route === prepared.initialRoutes.controller ||
            item.route === "local"),
      );
      if (!controlled && typeof probeControllerSoftware !== "function") {
        decisions.push(
          decision(software, "conflict", {
            reason: "controller-adapter-unavailable",
          }),
        );
        continue;
      }
      if (!controlled) {
        let observed = null;
        try {
          observed = await probeControllerSoftware({
            software: publicSoftwareRequest(software),
            platform: prepared.profile.platform,
            architecture: snapshot.identity.architecture,
            currentRoute: prepared.initialRoutes.controller,
            targetInstalledVersion:
              snapshot.inventory.installedSoftware?.[software.id]?.version ??
              null,
          });
        } catch {
          observed = null;
        }
        controlled = normalizeControllerEvidence(
          software,
          observed,
          prepared.initialRoutes.controller,
        );
        if (controlled) controllerEvidence.push(controlled);
      }
      const resolved = resolveControllerSoftware({
        software,
        evidence: controllerEvidence.filter(
          (item) => item.softwareId === software.id,
        ),
        currentRoute: prepared.initialRoutes.controller,
      });
      decisions.push(resolved.decision);
      if (resolved.action) actions.push(resolved.action);
      if (resolved.pending) pendingRouteProbes.push(resolved.pending);
      continue;
    }

    if (manualSources.has(source)) {
      decisions.push(
        decision(software, "manual", {
          resolvedVersion: software.version ?? null,
          reason: "manual-source",
        }),
      );
      if (software.version) {
        actions.push({
          softwareId: software.id,
          name: software.name,
          installer: "manual",
          package: software.package ?? software.id,
          version: software.version,
          route: "local",
          networkLocation: "none",
          routeEvidence: { method: "no-network", origins: [] },
          dependsOn: [],
          executionMode: "manual-receipt",
          requiresAdmin: true,
          requiresGui: true,
          requiresRestart: false,
        });
      }
      continue;
    }

    decisions.push(
      decision(software, "conflict", {
        reason: "unsupported-or-ambiguous-source",
      }),
    );
  }

  cascadeUnresolvedDependencies(actions, decisions, snapshot.inventory);
  const scheduledIds = new Set(actions.map((action) => action.softwareId));
  for (const action of actions) {
    action.dependsOn = action.dependsOn.filter((dependency) =>
      scheduledIds.has(dependency),
    );
  }

  return {
    actions,
    decisions,
    controllerEvidence,
    pendingRouteProbes: deduplicatePendingProbes(pendingRouteProbes),
    generatedAt,
  };
}

function resolveTargetSoftware({
  software,
  metadata,
  targetProbes,
  currentRoute,
  metadataDependency,
  softwareById,
  actions,
  inventory,
}) {
  if (!metadata) {
    return {
      decision: decision(software, "conflict", {
        reason: "metadata-missing",
      }),
    };
  }
  if (metadata.status === "conflict") {
    return {
      decision: decision(software, "conflict", {
        installedVersion: metadata.installedVersion,
        resolvedVersion: metadata.resolvedVersion,
        reason: "adapter-reported-conflict",
      }),
    };
  }
  if (metadata.status === "current") {
    return {
      decision: decision(software, "skip", {
        installedVersion: metadata.installedVersion,
        resolvedVersion: metadata.resolvedVersion,
        reason: "already-satisfies-profile",
      }),
    };
  }
  if (metadata.status === "outdated") {
    return {
      decision: decision(software, "conflict", {
        installedVersion: metadata.installedVersion,
        resolvedVersion: metadata.resolvedVersion,
        reason: "explicit-update-operation-unavailable",
      }),
    };
  }
  if (
    !safeVersionPattern.test(metadata.resolvedVersion ?? "") ||
    [metadata.requiresAdmin, metadata.requiresGui, metadata.requiresRestart]
      .some((value) => typeof value !== "boolean")
  ) {
    return {
      decision: decision(software, "conflict", {
        installedVersion: metadata.installedVersion,
        reason: "metadata-incomplete",
      }),
    };
  }
  const routeResolution = routeEvidenceForTarget(
    metadata.origins,
    targetProbes,
    currentRoute,
  );
  if (routeResolution === null) {
    const alternateRoute =
      currentRoute === "direct" ? "clash" : "direct";
    const alternateMissing = metadata.origins.some(
      (origin) => !targetProbes.has(`${alternateRoute}|${origin}`),
    );
    return {
      decision: decision(
        software,
        alternateMissing ? "probe-required" : "conflict",
        {
        installedVersion: metadata.installedVersion,
        resolvedVersion: metadata.resolvedVersion,
          reason: alternateMissing
            ? `target-route-evidence-required:${alternateRoute}`
            : "target-endpoint-unreachable-on-observed-routes",
        },
      ),
      pending: alternateMissing
        ? {
            networkLocation: "target",
            route: alternateRoute,
            origins: unique(metadata.origins).sort(),
          }
        : undefined,
    };
  }

  const dependsOn = [...metadataDependency];
  if (
    software.version &&
    (software.source !== "brew-formula" ||
      !software.package.includes("@"))
  ) {
    return {
      decision: decision(software, "conflict", {
        installedVersion: metadata.installedVersion,
        resolvedVersion: metadata.resolvedVersion,
        reason: "homebrew-exact-version-not-runnable",
      }),
    };
  }
  if (software.source === "volta-tool") {
    addScheduledDependency(dependsOn, "volta", actions);
    if (
      !inventory.tools.volta.present &&
      !softwareById.has("volta")
    ) {
      return {
        decision: decision(software, "conflict", {
          resolvedVersion: metadata.resolvedVersion,
          reason: "volta-prerequisite-unresolved",
        }),
      };
    }
  }
  if (software.source === "npm-global") {
    if (!inventory.tools.npm.present) {
      addScheduledDependency(dependsOn, "node-runtime", actions);
      const declaredNode = [...softwareById.values()].find(
        (item) =>
          item.source === "volta-tool" && item.package === "node",
      );
      if (declaredNode) {
        addScheduledDependency(dependsOn, declaredNode.id, actions);
      }
      if (
        !actions.some(
          (action) =>
            action.softwareId === "node-runtime" ||
            action.softwareId === declaredNode?.id,
        )
      ) {
        return {
          decision: decision(software, "conflict", {
            resolvedVersion: metadata.resolvedVersion,
            reason: "npm-prerequisite-unresolved",
          }),
        };
      }
    }
  }

  const installer = software.source;
  const requiresManual =
    metadata.requiresAdmin ||
    metadata.requiresGui ||
    metadata.requiresRestart;
  const action = {
    softwareId: software.id,
    name: software.name,
    installer,
    package: software.package,
    version:
      ["brew-formula", "brew-cask"].includes(software.source)
        ? software.version ?? "latest-stable"
        : metadata.resolvedVersion,
    route: routeResolution.route,
    networkLocation: "target",
    routeEvidence: routeResolution.evidence,
    dependsOn: unique(dependsOn),
    executionMode: requiresManual ? "manual-receipt" : "automated",
    requiresAdmin: metadata.requiresAdmin,
    requiresGui: metadata.requiresGui,
    requiresRestart: metadata.requiresRestart,
  };
  return {
    action,
    decision: decision(
      software,
      "install",
      {
        installedVersion: metadata.installedVersion,
        resolvedVersion: metadata.resolvedVersion,
        reason: "not-installed",
      },
    ),
  };
}

function normalizeControllerEvidence(software, controlled, currentRoute) {
  if (!isPlainObject(controlled)) return null;
  rejectSecretBearingValue(controlled, "$.controllerProbe");
  if (
    ![
      "missing",
      "current",
      "outdated",
      "conflict",
      "probe-unreachable",
    ].includes(
      controlled.status,
    ) ||
    (controlled.resolvedVersion !== null &&
      !safeVersionPattern.test(controlled.resolvedVersion ?? "")) ||
    (controlled.installedVersion !== undefined &&
      controlled.installedVersion !== null &&
      !safeVersionPattern.test(controlled.installedVersion)) ||
    !Array.isArray(controlled.origins) ||
    !validObservedAt(controlled.observedAt) ||
    (controlled.route !== undefined &&
      controlled.route !== currentRoute) ||
    typeof controlled.reachable !== "boolean" ||
    [
      controlled.requiresAdmin,
      controlled.requiresGui,
      controlled.requiresRestart,
    ].some((value) => typeof value !== "boolean") ||
    typeof controlled.artifactCached !== "boolean"
  ) {
    return null;
  }
  validateOrigins(controlled.origins);
  return {
    softwareId: software.id,
    status: controlled.status,
    installedVersion: controlled.installedVersion ?? null,
    resolvedVersion: controlled.resolvedVersion,
    route: controlled.artifactCached ? "local" : currentRoute,
    networkLocation: controlled.artifactCached ? "none" : "controller",
    method: controlled.artifactCached
      ? "controller-cache"
      : "controller-probe",
    origins: unique(controlled.origins).sort(),
    observedAt: controlled.observedAt,
    reachable: controlled.reachable,
    artifactCached: controlled.artifactCached,
    requiresAdmin: controlled.requiresAdmin,
    requiresGui: controlled.requiresGui,
    requiresRestart: controlled.requiresRestart,
  };
}

function resolveControllerSoftware({ software, evidence, currentRoute }) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return {
      decision: decision(software, "conflict", {
        reason: "controller-metadata-missing",
      }),
    };
  }
  const invalid = evidence.some(
    (item) =>
      !isPlainObject(item) ||
      item.softwareId !== software.id ||
      !["direct", "clash", "local"].includes(item.route),
  );
  if (invalid) {
    return {
      decision: decision(software, "conflict", {
        reason: "controller-metadata-invalid",
      }),
    };
  }
  const resolvedEvidence = evidence.filter(
    (item) => item.status !== "probe-unreachable",
  );
  if (resolvedEvidence.length === 0) {
    const alternateRoute =
      currentRoute === "direct" ? "clash" : "direct";
    const alternateObserved = evidence.some(
      (item) => item.route === alternateRoute,
    );
    return {
      decision: decision(
        software,
        alternateObserved ? "conflict" : "probe-required",
        {
          reason: alternateObserved
            ? "controller-metadata-unreachable-on-observed-routes"
            : `controller-route-evidence-required:${alternateRoute}`,
        },
      ),
      pending: alternateObserved
        ? undefined
        : {
            networkLocation: "controller",
            route: alternateRoute,
            origins: unique(
              evidence.flatMap((item) => item.origins),
            ).sort(),
          },
    };
  }
  const current = resolvedEvidence.find(
    (item) => item.status === "current",
  );
  if (current) {
    return {
      decision: decision(software, "skip", {
        installedVersion: current.installedVersion,
        resolvedVersion: current.resolvedVersion,
        reason: "already-satisfies-profile",
      }),
    };
  }
  const first = resolvedEvidence[0];
  if (
    resolvedEvidence.some(
      (item) =>
        item.status !== first.status ||
        item.resolvedVersion !== first.resolvedVersion ||
        item.requiresAdmin !== first.requiresAdmin ||
        item.requiresGui !== first.requiresGui ||
        item.requiresRestart !== first.requiresRestart ||
        JSON.stringify(item.origins) !== JSON.stringify(first.origins),
    )
  ) {
    return {
      decision: decision(software, "conflict", {
        reason: "controller-metadata-drift",
      }),
    };
  }
  if (
    !["missing", "outdated"].includes(first.status) ||
    !safeVersionPattern.test(first.resolvedVersion ?? "")
  ) {
    return {
      decision: decision(software, "conflict", {
        reason: "controller-metadata-incomplete",
      }),
    };
  }
  if (first.status === "outdated") {
    return {
      decision: decision(software, "conflict", {
        installedVersion: first.installedVersion,
        resolvedVersion: first.resolvedVersion,
        reason: "explicit-update-operation-unavailable",
      }),
    };
  }
  return {
    decision: decision(
      software,
      "conflict",
      {
        installedVersion: first.installedVersion,
        resolvedVersion: first.resolvedVersion,
        reason: "canonical-artifact-request-unavailable-in-full-plan",
      },
    ),
  };
}

function routeEvidenceForTarget(origins, probes, currentRoute) {
  validateOrigins(origins);
  const normalizedOrigins = unique(origins).sort();
  for (const route of [
    currentRoute,
    currentRoute === "direct" ? "clash" : "direct",
  ]) {
    const selected = normalizedOrigins.map((origin) =>
      probes.get(`${route}|${origin}`),
    );
    if (
      selected.length > 0 &&
      selected.every(
        (probe) =>
          probe &&
          probe.route === route &&
          probe.networkLocation === "target" &&
          probe.reachable === true,
      )
    ) {
      return {
        route,
        evidence: {
          method: "target-probe",
          origins: normalizedOrigins,
          observedAt: selected
            .map((probe) => probe.observedAt)
            .sort()
            .at(-1),
        },
      };
    }
  }
  return null;
}

function addScheduledDependency(dependencies, softwareId, actions) {
  if (actions.some((action) => action.softwareId === softwareId)) {
    dependencies.push(softwareId);
  }
}

function cascadeUnresolvedDependencies(actions, decisions, inventory) {
  const decisionById = new Map(
    decisions.map((item) => [item.softwareId, item]),
  );
  const conflictIds = new Set(
    decisions
      .filter((item) => item.disposition === "conflict")
      .map((item) => item.softwareId),
  );
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    const unresolved = action.dependsOn.find((id) => conflictIds.has(id));
    if (!unresolved) continue;
    actions.splice(index, 1);
    const item = decisionById.get(action.softwareId);
    if (item) {
      item.disposition = "conflict";
      item.reason = `dependency-unresolved:${unresolved}`;
    }
    conflictIds.add(action.softwareId);
  }

  // `npm-global` 必须有当前 npm，或有本次计划中的受控 node provider。
  if (!inventory.tools.npm.present) {
    const actionIds = new Set(actions.map((action) => action.softwareId));
    for (let index = actions.length - 1; index >= 0; index -= 1) {
      const action = actions[index];
      if (
        action.installer !== "npm-global" ||
        actionIds.has("node") ||
        actionIds.has("node-runtime")
      ) {
        continue;
      }
      actions.splice(index, 1);
      const item = decisionById.get(action.softwareId);
      if (item) {
        item.disposition = "conflict";
        item.reason = "npm-prerequisite-unresolved";
      }
    }
  }
}

function decision(
  software,
  disposition,
  {
    installedVersion = null,
    resolvedVersion = null,
    reason,
  } = {},
) {
  return {
    softwareId: software.id,
    name: software.name,
    source: software.source ?? "auto",
    disposition,
    installedVersion,
    resolvedVersion,
    reason,
  };
}

function publicSoftwareRequest(software) {
  return {
    softwareId: software.id,
    source: software.source,
    requestedVersion: software.version ?? "latest-stable",
  };
}

export async function probeOfficialSoftware({
  software,
  platform,
  architecture,
  currentRoute,
  targetInstalledVersion = null,
}) {
  if (
    software?.softwareId !== "clash-verge-rev" ||
    software?.source !== "official-download"
  ) {
    return null;
  }
  if (!["macos", "windows"].includes(platform)) return null;
  if (!routePattern.test(currentRoute ?? "")) return null;

  const metadataEndpoint = new URL(
    "https://api.github.com/repos/clash-verge-rev/clash-verge-rev/releases/latest",
  );
  const metadataProbe = await probeHttpsEndpoint(metadataEndpoint, {
    allowedHosts: new Set(["api.github.com"]),
    maximumRedirects: 0,
  });
  if (!metadataProbe.reachable) {
    return {
      status: "probe-unreachable",
      installedVersion: targetInstalledVersion,
      resolvedVersion: null,
      origins: ["api.github.com"],
      route: currentRoute,
      reachable: false,
      observedAt: metadataProbe.observedAt,
      requiresAdmin: true,
      requiresGui: true,
      requiresRestart: false,
      artifactCached: false,
    };
  }
  const release = await requestJson({
    hostname: "api.github.com",
    path: "/repos/clash-verge-rev/clash-verge-rev/releases/latest",
    allowedHosts: new Set(["api.github.com"]),
  });
  const resolvedVersion = safeReleaseVersion(release.tag_name);
  if (!resolvedVersion || !Array.isArray(release.assets)) {
    return officialConflictEvidence(currentRoute, metadataProbe.observedAt);
  }
  const candidates = release.assets.filter((asset) =>
    isMatchingClashAsset(asset, platform, architecture),
  );
  if (candidates.length !== 1) {
    return officialConflictEvidence(currentRoute, metadataProbe.observedAt);
  }
  const assetUrl = validateClashAssetUrl(candidates[0].browser_download_url);
  if (!assetUrl) {
    return officialConflictEvidence(currentRoute, metadataProbe.observedAt);
  }
  const observed = await probeHttpsEndpoint(assetUrl, {
    allowedHosts: new Set([
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
    ]),
  });
  const installedVersion =
    typeof targetInstalledVersion === "string" &&
    safeVersionPattern.test(targetInstalledVersion)
      ? targetInstalledVersion
      : null;
  return {
    status:
      installedVersion === resolvedVersion
        ? "current"
        : installedVersion
          ? "outdated"
          : "missing",
    installedVersion,
    resolvedVersion,
    origins: unique(["api.github.com", ...observed.origins]).sort(),
    route: currentRoute,
    reachable: observed.reachable,
    observedAt: observed.observedAt,
    requiresAdmin: true,
    requiresGui: true,
    requiresRestart: false,
    artifactCached: false,
    artifactRequest: {
      artifactId: "clash-verge-rev",
      version: resolvedVersion,
      architecture,
      url: assetUrl.href,
      allowedHosts: [
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
      ],
      sourceMode: "signed-download",
    },
  };
}

function officialConflictEvidence(route, observedAt) {
  return {
    status: "conflict",
    installedVersion: null,
    resolvedVersion: null,
    origins: ["api.github.com"],
    route,
    reachable: true,
    observedAt,
    requiresAdmin: true,
    requiresGui: true,
    requiresRestart: false,
    artifactCached: false,
  };
}

function requestJson({ hostname, path, allowedHosts }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpsRequest(
      {
        hostname,
        path,
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "dawn-forge-preflight/1",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout: 12_000,
      },
      (response) => {
        if (!allowedHosts.has(hostname)) {
          response.resume();
          rejectPromise(new Error("Official metadata host is not allowed."));
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          rejectPromise(
            new Error("Official metadata request failed; URL omitted."),
          );
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 8 * 1024 * 1024) request.destroy();
        });
        response.on("end", () => {
          try {
            resolvePromise(JSON.parse(body));
          } catch {
            rejectPromise(
              new Error("Official metadata response is invalid."),
            );
          }
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("Official metadata request timed out.")),
    );
    request.on("error", () =>
      rejectPromise(new Error("Official metadata request failed; URL omitted.")),
    );
    request.end();
  });
}

function probeHttpsEndpoint(
  initialUrl,
  { allowedHosts, maximumRedirects = 5 } = {},
) {
  const origins = [];
  function visit(url, redirectsRemaining) {
    return new Promise((resolvePromise, rejectPromise) => {
      if (
        url.protocol !== "https:" ||
        !allowedHosts.has(url.hostname.toLowerCase()) ||
        url.username ||
        url.password
      ) {
        rejectPromise(new Error("Official artifact redirect is not allowed."));
        return;
      }
      origins.push(url.hostname.toLowerCase());
      const request = httpsRequest(
        {
          hostname: url.hostname,
          path: `${url.pathname}${url.search}`,
          method: "HEAD",
          headers: {
            Accept: "*/*",
            "User-Agent": "dawn-forge-preflight/1",
          },
          timeout: 12_000,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location;
          response.resume();
          if (
            [301, 302, 303, 307, 308].includes(status) &&
            typeof location === "string"
          ) {
            if (redirectsRemaining === 0) {
              rejectPromise(
                new Error("Official artifact redirected too many times."),
              );
              return;
            }
            let next;
            try {
              next = new URL(location, url);
            } catch {
              rejectPromise(
                new Error("Official artifact redirect is invalid."),
              );
              return;
            }
            visit(next, redirectsRemaining - 1).then(
              resolvePromise,
              rejectPromise,
            );
            return;
          }
          resolvePromise({
            reachable: status >= 200 && status < 500,
            origins: unique(origins),
            observedAt: new Date().toISOString(),
          });
        },
      );
      request.on("timeout", () =>
        request.destroy(new Error("Official artifact probe timed out.")),
      );
      request.on("error", () =>
        resolvePromise({
          reachable: false,
          origins: unique(origins),
          observedAt: new Date().toISOString(),
        }),
      );
      request.end();
    });
  }
  return visit(initialUrl, maximumRedirects);
}

function safeReleaseVersion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  return safeVersionPattern.test(normalized) ? normalized : null;
}

function isMatchingClashAsset(asset, platform, architecture) {
  if (
    !isPlainObject(asset) ||
    typeof asset.name !== "string" ||
    typeof asset.browser_download_url !== "string"
  ) {
    return false;
  }
  const name = asset.name.toLowerCase();
  if (name.endsWith(".sig") || name.endsWith(".sha256")) return false;
  const platformMatches =
    platform === "macos"
      ? name.endsWith(".dmg")
      : name.endsWith(".exe") || name.endsWith(".msi");
  if (!platformMatches) return false;
  const normalizedArchitecture = architecture.toLowerCase();
  const architectureMatches =
    ["arm64", "aarch64"].includes(normalizedArchitecture)
      ? /(?:arm64|aarch64)/.test(name)
      : ["x86_64", "amd64", "x64"].includes(normalizedArchitecture)
        ? /(?:x64|x86_64|amd64)/.test(name) &&
          !/(?:arm64|aarch64)/.test(name)
        : false;
  return architectureMatches;
}

function validateClashAssetUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(
      "/clash-verge-rev/clash-verge-rev/releases/download/",
    )
  ) {
    return null;
  }
  return url;
}

function publicInventory(inventory) {
  return {
    diskAvailableBytes: inventory.diskAvailableBytes,
    adminCapable: inventory.adminCapable,
    commandLineTools: structuredClone(inventory.commandLineTools),
    tools: structuredClone(inventory.tools),
    installedSoftware: isPlainObject(inventory.installedSoftware)
      ? structuredClone(inventory.installedSoftware)
      : {},
  };
}

function publicSnapshotItem(item) {
  return {
    softwareId: item.softwareId,
    source: item.source,
    package: item.package,
    status: item.status,
    installedVersion: item.installedVersion,
    resolvedVersion: item.resolvedVersion,
    origins: unique(item.origins).sort(),
    requiresAdmin: item.requiresAdmin,
    requiresGui: item.requiresGui,
    requiresRestart: item.requiresRestart,
  };
}

function publicProbe(probe) {
  return {
    networkLocation: probe.networkLocation,
    origin: probe.origin,
    route: probe.route,
    reachable: probe.reachable,
    observedAt: probe.observedAt,
  };
}

function validateOrigins(origins) {
  if (
    !Array.isArray(origins) ||
    origins.length === 0 ||
    origins.some(
      (origin) =>
        typeof origin !== "string" ||
        origin !== origin.toLowerCase() ||
        !originPattern.test(origin),
    )
  ) {
    throw new Error(
      "Endpoint origins must be lowercase public hostnames without URL components.",
    );
  }
}

function validObservedAt(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function toUtcTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new TypeError("now must produce a valid date.");
  }
  return date.toISOString();
}

function rejectSecretBearingValue(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectSecretBearingValue(item, `${path}[${index}]`),
    );
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (
        /(?:password|passwd|token|secret|credential|subscription|private.?key|api.?key)/i.test(
          key,
        )
      ) {
        throw new Error(`${path}: secret-like fields are forbidden.`);
      }
      rejectSecretBearingValue(child, path);
    }
    return;
  }
  if (
    typeof value === "string" &&
    (/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value) ||
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value))
  ) {
    throw new Error(`${path}: secret-bearing content is forbidden.`);
  }
}

function createMacosPreflightDriver(request) {
  return `ObjC.import("Foundation");
"use strict";

const request = ${JSON.stringify(request)};
const fm = $.NSFileManager.defaultManager;

function text(data) {
  const value = $.NSString.alloc.initWithDataEncoding(
    data,
    $.NSUTF8StringEncoding
  );
  return value ? ObjC.unwrap(value) : "";
}

function run(executable, args, extraEnvironment) {
  if (!fm.isExecutableFileAtPath(executable)) {
    return { status: 127, stdout: "", stderr: "" };
  }
  const task = $.NSTask.alloc.init;
  const stdoutPipe = $.NSPipe.pipe;
  const stderrPipe = $.NSPipe.pipe;
  task.launchPath = executable;
  task.arguments = args;
  task.standardOutput = stdoutPipe;
  task.standardError = stderrPipe;
  if (extraEnvironment) {
    const environment = ObjC.deepUnwrap(
      $.NSProcessInfo.processInfo.environment
    );
    Object.keys(extraEnvironment).forEach(function (key) {
      environment[key] = extraEnvironment[key];
    });
    task.environment = environment;
  }
  try {
    task.launch;
    task.waitUntilExit;
  } catch (_error) {
    return { status: 127, stdout: "", stderr: "" };
  }
  return {
    status: Number(task.terminationStatus),
    stdout: text(stdoutPipe.fileHandleForReading.readDataToEndOfFile),
    stderr: text(stderrPipe.fileHandleForReading.readDataToEndOfFile)
  };
}

function firstLine(value) {
  return String(value || "").replace(/\\r/g, "").split("\\n")[0].trim();
}

function safeVersion(value) {
  const match = String(value || "").match(/[A-Za-z0-9][A-Za-z0-9.+_~^-]{0,79}/);
  return match ? match[0] : null;
}

function executable(candidates) {
  for (let index = 0; index < candidates.length; index += 1) {
    if (fm.isExecutableFileAtPath(candidates[index])) return candidates[index];
  }
  return null;
}

function publicOrigin(value) {
  try {
    const parsed = $.NSURL.URLWithString(String(value));
    if (!parsed || !parsed.host) return null;
    const hostname = ObjC.unwrap(parsed.host).toLowerCase();
    return /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\\.)+[a-z]{2,63}$/.test(hostname)
      ? hostname
      : null;
  } catch (_error) {
    return null;
  }
}

function emit(value) {
  const output = $(
    JSON.stringify(value) + "\\n"
  ).dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(output);
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function identity() {
  const user = firstLine(run("/usr/bin/id", ["-un"]).stdout);
  const os = firstLine(run("/usr/bin/uname", ["-s"]).stdout);
  const architecture = firstLine(run("/usr/bin/uname", ["-m"]).stdout);
  const ioreg = run(
    "/usr/sbin/ioreg",
    ["-rd1", "-c", "IOPlatformExpertDevice"]
  ).stdout;
  const machine = ioreg.match(/"IOPlatformUUID"\\s*=\\s*"([^"]+)"/);
  return {
    user: user,
    os: os,
    architecture: architecture,
    machineId: machine ? machine[1] : ""
  };
}

function diskAvailableBytes() {
  const lines = run("/bin/df", ["-Pk", "/"]).stdout
    .replace(/\\r/g, "")
    .trim()
    .split("\\n");
  if (lines.length < 2) return 0;
  const fields = lines[lines.length - 1].trim().split(/\\s+/);
  const blocks = Number(fields[3]);
  return Number.isSafeInteger(blocks) && blocks >= 0 ? blocks * 1024 : 0;
}

function tool(path, versionArgs) {
  if (!path) return { present: false, version: null };
  const observed = run(path, versionArgs);
  return {
    present: observed.status === 0,
    version: observed.status === 0 ? safeVersion(firstLine(observed.stdout)) : null
  };
}

function brewMetadata(brewPath, source, packages) {
  if (!brewPath || packages.length === 0) return {};
  const kind = source === "brew-formula" ? "--formula" : "--cask";
  const observed = run(
    brewPath,
    ["info", "--json=v2", kind].concat(packages),
    {
      HOMEBREW_NO_AUTO_UPDATE: "1",
      HOMEBREW_NO_INSTALL_CLEANUP: "1"
    }
  );
  if (observed.status !== 0) return {};
  try {
    const parsed = JSON.parse(observed.stdout);
    const entries = source === "brew-formula"
      ? (parsed.formulae || [])
      : (parsed.casks || []);
    const result = {};
    entries.forEach(function (entry) {
      const key = source === "brew-formula"
        ? (entry.name || entry.full_name)
        : entry.token;
      if (key) result[key] = entry;
    });
    return result;
  } catch (_error) {
    return {};
  }
}

function formulaItem(item, entry) {
  if (!entry) return unresolvedItem(item);
  const installed = Array.isArray(entry.installed) && entry.installed.length > 0
    ? safeVersion(entry.installed[0].version)
    : null;
  const resolved = safeVersion(entry.versions && entry.versions.stable);
  const urls = ["https://formulae.brew.sh/"];
  if (entry.urls && entry.urls.stable && entry.urls.stable.url) {
    urls.push(entry.urls.stable.url);
  }
  const bottleFiles =
    entry.bottle &&
    entry.bottle.stable &&
    entry.bottle.stable.files
      ? Object.values(entry.bottle.stable.files)
      : [];
  bottleFiles.forEach(function (file) {
    if (file && file.url) urls.push(file.url);
  });
  return {
    softwareId: item.softwareId,
    source: item.source,
    package: item.package,
    status: statusFor(item.requestedVersion, installed, resolved),
    installedVersion: installed,
    resolvedVersion: resolved,
    origins: unique(urls.map(publicOrigin)),
    _probeUrls: urls,
    requiresAdmin: false,
    requiresGui: false,
    requiresRestart: false
  };
}

function caskItem(item, entry) {
  if (!entry) return unresolvedItem(item);
  const installedValues = Array.isArray(entry.installed)
    ? entry.installed
    : entry.installed
      ? [entry.installed]
      : [];
  const installed = safeVersion(installedValues[0]);
  const resolved = safeVersion(entry.version);
  const artifacts = Array.isArray(entry.artifacts) ? entry.artifacts : [];
  const keys = [];
  artifacts.forEach(function (artifact) {
    if (artifact && typeof artifact === "object" && !Array.isArray(artifact)) {
      Object.keys(artifact).forEach(function (key) { keys.push(key); });
    }
  });
  const caveats = typeof entry.caveats === "string" ? entry.caveats : "";
  const interactiveInstaller =
    keys.indexOf("pkg") !== -1 || keys.indexOf("installer") !== -1;
  const administratorCaveat =
    /\\b(?:administrator|root|sudo)\\b/i.test(caveats);
  const permissionCaveat =
    /(?:System Settings|System Preferences|Privacy & Security|Full Disk Access|Accessibility|Screen Recording|Input Monitoring|Automation|system extension|network extension|approve|allow)\\b/i.test(caveats);
  const restartCaveat =
    /\\b(?:restart|reboot|log out|log back in)\\b/i.test(caveats);
  return {
    softwareId: item.softwareId,
    source: item.source,
    package: item.package,
    status: statusFor(item.requestedVersion, installed, resolved),
    installedVersion: installed,
    resolvedVersion: resolved,
    origins: unique([
      "formulae.brew.sh",
      publicOrigin(entry.url)
    ]),
    _probeUrls: [
      "https://formulae.brew.sh/",
      entry.url
    ].filter(Boolean),
    requiresAdmin: interactiveInstaller || administratorCaveat,
    requiresGui: interactiveInstaller || permissionCaveat,
    requiresRestart: restartCaveat
  };
}

function statusFor(requested, installed, resolved) {
  if (!resolved) return "conflict";
  if (!installed) return "missing";
  if (requested !== "latest-stable" && installed !== requested) {
    return "conflict";
  }
  return installed === resolved || installed === requested ? "current" : "outdated";
}

function unresolvedItem(item) {
  const origins = defaultOrigins(item.source);
  return {
    softwareId: item.softwareId,
    source: item.source,
    package: item.package,
    status: "conflict",
    installedVersion: null,
    resolvedVersion: null,
    origins: origins,
    _probeUrls: origins.map(function (origin) {
      return "https://" + origin + "/";
    }),
    requiresAdmin: null,
    requiresGui: null,
    requiresRestart: null
  };
}

function defaultOrigins(source) {
  if (source === "brew-formula" || source === "brew-cask") {
    return ["formulae.brew.sh"];
  }
  if (source === "npm-global" || source === "volta-tool") {
    return ["registry.npmjs.org"];
  }
  return [];
}

function npmMetadata(nodePath, requests) {
  if (!nodePath || requests.length === 0) return {};
  const collector = [
    "const https=require('https');",
    "const names=JSON.parse(process.argv[1]);",
    "const one=name=>new Promise(resolve=>{",
    "const req=https.get({hostname:'registry.npmjs.org',path:'/'+encodeURIComponent(name),headers:{accept:'application/json','user-agent':'dawn-forge-preflight/1'}},res=>{",
    "let body='';res.setEncoding('utf8');res.on('data',chunk=>{if(body.length<8388608)body+=chunk});",
    "res.on('end',()=>{try{const data=JSON.parse(body);const version=data['dist-tags']&&data['dist-tags'].latest;const dist=version&&data.versions&&data.versions[version]&&data.versions[version].dist;resolve([name,{version,tarball:dist&&dist.tarball}])}catch(_){resolve([name,null])}})});",
    "req.setTimeout(12000,()=>req.destroy());req.on('error',()=>resolve([name,null]));});",
    "Promise.all(names.map(one)).then(entries=>process.stdout.write(JSON.stringify(Object.fromEntries(entries))));"
  ].join("");
  const observed = run(
    nodePath,
    ["-e", collector, JSON.stringify(requests.map(function (item) {
      return item.package;
    }))]
  );
  if (observed.status !== 0) return {};
  try {
    return JSON.parse(observed.stdout);
  } catch (_error) {
    return {};
  }
}

function globalNpmInventory(npmPath) {
  if (!npmPath) return {};
  const observed = run(npmPath, ["list", "--global", "--depth=0", "--json"]);
  if (observed.status !== 0 && !observed.stdout) return {};
  try {
    const dependencies = JSON.parse(observed.stdout).dependencies || {};
    const result = {};
    Object.keys(dependencies).forEach(function (name) {
      result[name] = safeVersion(dependencies[name] && dependencies[name].version);
    });
    return result;
  } catch (_error) {
    return {};
  }
}

function voltaInventory(voltaPath) {
  if (!voltaPath) return {};
  const observed = run(voltaPath, ["list", "all", "--format", "plain"]);
  if (observed.status !== 0) return {};
  const result = {};
  observed.stdout.replace(/\\r/g, "").split("\\n").forEach(function (line) {
    const match = line.match(/^\\s*([^\\s@]+)@([A-Za-z0-9][A-Za-z0-9.+_~^-]*)/);
    if (match) result[match[1]] = safeVersion(match[2]);
  });
  return result;
}

function npmItem(item, metadata, installed) {
  const entry = metadata[item.package];
  const resolved = entry ? safeVersion(entry.version) : null;
  return {
    softwareId: item.softwareId,
    source: item.source,
    package: item.package,
    status: statusFor(item.requestedVersion, installed || null, resolved),
    installedVersion: installed || null,
    resolvedVersion: resolved,
    origins: unique([
      "registry.npmjs.org",
      entry ? publicOrigin(entry.tarball) : null
    ]),
    _probeUrls: [
      "https://registry.npmjs.org/",
      entry ? entry.tarball : null
    ].filter(Boolean),
    requiresAdmin: false,
    requiresGui: false,
    requiresRestart: false
  };
}

function nodeRuntimeItem(item, installed) {
  const curl = executable(["/usr/bin/curl"]);
  let resolved = null;
  if (curl) {
    const observed = run(curl, [
      "--silent",
      "--show-error",
      "--location",
      "--connect-timeout",
      "3",
      "--max-time",
      "12",
      "--max-filesize",
      "4194304",
      "https://nodejs.org/dist/index.json"
    ]);
    if (observed.status === 0) {
      try {
        const releases = JSON.parse(observed.stdout);
        const selected = releases.find(function (release) {
          return release && release.lts && typeof release.version === "string";
        });
        resolved = selected
          ? safeVersion(selected.version.replace(/^v/, ""))
          : null;
      } catch (_error) {
        resolved = null;
      }
    }
  }
  return {
    softwareId: item.softwareId,
    source: item.source,
    package: item.package,
    status: statusFor(item.requestedVersion, installed || null, resolved),
    installedVersion: installed || null,
    resolvedVersion: resolved,
    origins: ["nodejs.org"],
    _probeUrls: [
      resolved
        ? "https://nodejs.org/dist/v" + resolved + "/"
        : "https://nodejs.org/dist/index.json"
    ],
    requiresAdmin: false,
    requiresGui: false,
    requiresRestart: false
  };
}

function probeOrigins(origins) {
  const curl = executable(["/usr/bin/curl"]);
  return unique(origins).map(function (origin) {
    const observed = curl
      ? run(curl, [
          "--head",
          "--location",
          "--silent",
          "--show-error",
          "--output",
          "/dev/null",
          "--connect-timeout",
          "2",
          "--max-time",
          "4",
          "https://" + origin + "/"
        ])
      : { status: 127 };
    return {
      networkLocation: "target",
      origin: origin,
      route: request.currentRoute,
      reachable: observed.status === 0,
      observedAt: new Date().toISOString()
    };
  });
}

function probeItemEndpoints(items) {
  const targets = {};
  items.forEach(function (item) {
    (item._probeUrls || []).forEach(function (url) {
      const origin = publicOrigin(url);
      if (origin && !targets[origin]) targets[origin] = String(url);
    });
  });
  const curl = executable(["/usr/bin/curl"]);
  const probes = [];
  const redirects = {};
  Object.keys(targets).sort().forEach(function (origin) {
    const observed = curl
      ? run(curl, [
          "--head",
          "--location",
          "--silent",
          "--show-error",
          "--output",
          "/dev/null",
          "--write-out",
          "%{url_effective}",
          "--connect-timeout",
          "2",
          "--max-time",
          "4",
          targets[origin]
        ])
      : { status: 127, stdout: "" };
    const finalOrigin = publicOrigin(observed.stdout.trim());
    const observedAt = new Date().toISOString();
    probes.push({
      networkLocation: "target",
      origin: origin,
      route: request.currentRoute,
      reachable: observed.status === 0,
      observedAt: observedAt
    });
    if (finalOrigin && finalOrigin !== origin) {
      redirects[origin] = finalOrigin;
      probes.push({
        networkLocation: "target",
        origin: finalOrigin,
        route: request.currentRoute,
        reachable: observed.status === 0,
        observedAt: observedAt
      });
    }
  });
  items.forEach(function (item) {
    const expanded = [];
    item.origins.forEach(function (origin) {
      expanded.push(origin);
      if (redirects[origin]) expanded.push(redirects[origin]);
    });
    item.origins = unique(expanded);
    delete item._probeUrls;
  });
  const byOrigin = {};
  probes.forEach(function (probe) {
    byOrigin[probe.origin] = probe;
  });
  return Object.keys(byOrigin).sort().map(function (origin) {
    return byOrigin[origin];
  });
}

function installedSoftware() {
  const result = {};
  if (request.inventorySoftware.indexOf("clash-verge-rev") !== -1) {
    const candidates = [
      "/Applications/Clash Verge.app/Contents/Info.plist",
      "/Applications/Clash Verge Rev.app/Contents/Info.plist"
    ];
    let version = null;
    for (let index = 0; index < candidates.length; index += 1) {
      if (!fm.fileExistsAtPath(candidates[index])) continue;
      const observed = run(
        "/usr/libexec/PlistBuddy",
        ["-c", "Print :CFBundleShortVersionString", candidates[index]]
      );
      if (observed.status === 0) {
        version = safeVersion(firstLine(observed.stdout));
        break;
      }
    }
    result["clash-verge-rev"] = {
      present: version !== null,
      version: version
    };
  }
  return result;
}

const liveIdentity = identity();
if (request.mode === "network-bootstrap") {
  emit({
    protocol: request.protocol,
    profileSha256: request.profileSha256,
    identity: liveIdentity,
    installedSoftware: installedSoftware(),
    probes: probeOrigins(request.origins)
  });
} else if (request.mode === "probe-only") {
  emit({
    protocol: request.protocol,
    profileSha256: request.profileSha256,
    identity: liveIdentity,
    probes: probeOrigins(request.origins)
  });
} else {
  const brewPath = executable([
    "/opt/homebrew/bin/brew",
    "/usr/local/bin/brew"
  ]);
  const nodePath = executable([
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    ObjC.unwrap($.NSHomeDirectory()) + "/.volta/bin/node"
  ]);
  const npmPath = executable([
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
    ObjC.unwrap($.NSHomeDirectory()) + "/.volta/bin/npm"
  ]);
  const voltaPath = executable([
    "/opt/homebrew/bin/volta",
    "/usr/local/bin/volta",
    ObjC.unwrap($.NSHomeDirectory()) + "/.volta/bin/volta"
  ]);
  const formulaRequests = request.software.filter(function (item) {
    return item.source === "brew-formula";
  });
  const caskRequests = request.software.filter(function (item) {
    return item.source === "brew-cask";
  });
  const nodeRequests = request.software.filter(function (item) {
    return item.softwareId === "node-runtime";
  });
  const npmRequests = request.software.filter(function (item) {
    return (
      item.source === "npm-global" ||
      item.source === "volta-tool"
    ) && item.softwareId !== "node-runtime";
  });
  const formulae = brewMetadata(
    brewPath,
    "brew-formula",
    formulaRequests.map(function (item) { return item.package; })
  );
  const casks = brewMetadata(
    brewPath,
    "brew-cask",
    caskRequests.map(function (item) { return item.package; })
  );
  const npm = npmMetadata(nodePath, npmRequests);
  const npmInstalled = globalNpmInventory(npmPath);
  const voltaInstalled = voltaInventory(voltaPath);
  const items = [];
  formulaRequests.forEach(function (item) {
    items.push(formulaItem(item, formulae[item.package]));
  });
  caskRequests.forEach(function (item) {
    items.push(caskItem(item, casks[item.package]));
  });
  npmRequests.forEach(function (item) {
    const installed = item.source === "npm-global"
      ? npmInstalled[item.package]
      : voltaInstalled[item.package];
    items.push(npmItem(item, npm, installed));
  });
  nodeRequests.forEach(function (item) {
    items.push(nodeRuntimeItem(item, voltaInstalled.node));
  });
  const probes = probeItemEndpoints(items);
  const groups = run("/usr/bin/id", ["-Gn"]).stdout.split(/\\s+/);
  emit({
    protocol: request.protocol,
    profileSha256: request.profileSha256,
    identity: liveIdentity,
    inventory: {
      diskAvailableBytes: diskAvailableBytes(),
      adminCapable: groups.indexOf("admin") !== -1,
      commandLineTools: {
        present:
          run("/usr/bin/xcode-select", ["-p"]).status === 0 &&
          run("/usr/bin/clang", ["--version"]).status === 0
      },
      tools: {
        homebrew: tool(brewPath, ["--version"]),
        npm: tool(npmPath, ["--version"]),
        volta: tool(voltaPath, ["--version"])
      },
      installedSoftware: installedSoftware()
    },
    items: items,
    probes: probes
  });
}
`;
}

function createWindowsPreflightDriver(request) {
  const requestBase64 = Buffer.from(
    JSON.stringify(request),
    "utf8",
  ).toString("base64");
  return `$ErrorActionPreference = 'Stop'
$requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${requestBase64}'))
$request = $requestJson | ConvertFrom-Json

function Invoke-ControlledProcess {
  param(
    [Parameter(Mandatory=$true)][string]$FilePath,
    [Parameter(Mandatory=$true)][string[]]$ArgumentList,
    [int]$TimeoutMilliseconds = 30000
  )
  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    return [ordered]@{ Status = 127; Stdout = ''; Stderr = '' }
  }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $FilePath
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  if ($null -ne $start.ArgumentList) {
    foreach ($argument in $ArgumentList) {
      [void]$start.ArgumentList.Add($argument)
    }
  } else {
    $quoted = foreach ($argument in $ArgumentList) {
      ConvertTo-WindowsProcessArgument ([string]$argument)
    }
    $start.Arguments = $quoted -join ' '
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      $process.Kill($true)
      [void]$process.WaitForExit(5000)
      return [ordered]@{ Status = 124; Stdout = ''; Stderr = '' }
    }
    return [ordered]@{
      Status = $process.ExitCode
      Stdout = $stdout.GetAwaiter().GetResult()
      Stderr = $stderr.GetAwaiter().GetResult()
    }
  } catch {
    return [ordered]@{ Status = 127; Stdout = ''; Stderr = '' }
  } finally {
    $process.Dispose()
  }
}

function ConvertTo-WindowsProcessArgument {
  param([string]$Value)
  if ($Value -notmatch '[\\s"]') { return $Value }
  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\\') {
      $slashes += 1
      continue
    }
    if ($character -eq '"') {
      [void]$builder.Append(('\\' * ($slashes * 2 + 1)))
      [void]$builder.Append('"')
      $slashes = 0
      continue
    }
    if ($slashes -gt 0) {
      [void]$builder.Append(('\\' * $slashes))
      $slashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($slashes -gt 0) {
    [void]$builder.Append(('\\' * ($slashes * 2)))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Get-ControlledExecutable {
  param([string[]]$Names)
  foreach ($name in $Names) {
    $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($null -ne $command) { return $command.Source }
  }
  return $null
}

function ConvertTo-SafeVersion {
  param([AllowNull()][string]$Value)
  if ($Value -match '[A-Za-z0-9][A-Za-z0-9.+_~^-]{0,79}') {
    return $Matches[0]
  }
  return $null
}

function Get-LiveIdentity {
  $machineId = (Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid
  return [ordered]@{
    user = [Environment]::UserName
    os = 'Windows'
    architecture = $env:PROCESSOR_ARCHITECTURE
    machineId = $machineId
  }
}

function Test-PublicOrigin {
  param([string]$Origin)
  return $Origin -cmatch '^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\\.)+[a-z]{2,63}$'
}

function Get-PublicOrigin {
  param([AllowNull()][string]$Url)
  try {
    $hostName = ([Uri]$Url).DnsSafeHost.ToLowerInvariant()
    if (Test-PublicOrigin $hostName) { return $hostName }
  } catch {}
  return $null
}

function Get-UniqueOrigins {
  param([object[]]$Origins)
  return @($Origins | Where-Object { $_ -and (Test-PublicOrigin ([string]$_)) } |
    Sort-Object -Unique)
}

function Invoke-OriginProbeBatch {
  param([string[]]$Origins)
  $result = @()
  foreach ($origin in (Get-UniqueOrigins $Origins)) {
    $reachable = $false
    try {
      $response = Invoke-WebRequest -Method Head -Uri ('https://' + $origin + '/') -MaximumRedirection 5 -TimeoutSec 12 -UseBasicParsing
      $reachable = $null -ne $response.StatusCode
    } catch {
      $reachable = $false
    }
    $result += [ordered]@{
      networkLocation = 'target'
      origin = $origin
      route = $request.currentRoute
      reachable = $reachable
      observedAt = [DateTime]::UtcNow.ToString('o')
    }
  }
  return $result
}

function Get-Tool {
  param([AllowNull()][string]$Path, [string[]]$Arguments)
  if (-not $Path) {
    return [ordered]@{ present = $false; version = $null }
  }
  $observed = Invoke-ControlledProcess -FilePath $Path -ArgumentList $Arguments
  return [ordered]@{
    present = $observed.Status -eq 0
    version = if ($observed.Status -eq 0) {
      ConvertTo-SafeVersion (($observed.Stdout -split "\\r?\\n")[0])
    } else { $null }
  }
}

function Get-NpmMetadata {
  param([AllowNull()][string]$NodePath, [object[]]$Items)
  if (-not $NodePath -or $Items.Count -eq 0) { return @{} }
  $collector = @'
const https=require("https");
const names=JSON.parse(process.argv[1]);
const one=name=>new Promise(resolve=>{
 const req=https.get({hostname:"registry.npmjs.org",path:"/"+encodeURIComponent(name),headers:{accept:"application/json","user-agent":"dawn-forge-preflight/1"}},res=>{
  let body="";res.setEncoding("utf8");res.on("data",chunk=>{if(body.length<8388608)body+=chunk});
  res.on("end",()=>{try{const data=JSON.parse(body);const version=data["dist-tags"]&&data["dist-tags"].latest;const dist=version&&data.versions&&data.versions[version]&&data.versions[version].dist;resolve([name,{version,tarball:dist&&dist.tarball}])}catch(_){resolve([name,null])}})
 });req.setTimeout(12000,()=>req.destroy());req.on("error",()=>resolve([name,null]));
});
Promise.all(names.map(one)).then(entries=>process.stdout.write(JSON.stringify(Object.fromEntries(entries))));
'@
  $names = @($Items | ForEach-Object { $_.package }) | ConvertTo-Json -Compress
  $observed = Invoke-ControlledProcess -FilePath $NodePath -ArgumentList @('-e', $collector, $names) -TimeoutMilliseconds 30000
  if ($observed.Status -ne 0) { return @{} }
  try { return $observed.Stdout | ConvertFrom-Json -AsHashtable } catch { return @{} }
}

$identity = Get-LiveIdentity
if ($request.mode -eq 'network-bootstrap') {
  [ordered]@{
    protocol = $request.protocol
    profileSha256 = $request.profileSha256
    identity = $identity
    installedSoftware = [ordered]@{
      'clash-verge-rev' = [ordered]@{ present = $false; version = $null }
    }
    probes = @(Invoke-OriginProbeBatch @($request.origins))
  } | ConvertTo-Json -Depth 20 -Compress
  exit 0
}
if ($request.mode -eq 'probe-only') {
  [ordered]@{
    protocol = $request.protocol
    profileSha256 = $request.profileSha256
    identity = $identity
    probes = @(Invoke-OriginProbeBatch @($request.origins))
  } | ConvertTo-Json -Depth 20 -Compress
  exit 0
}

$nodePath = Get-ControlledExecutable @('node.exe', 'node')
$npmPath = Get-ControlledExecutable @('npm.cmd', 'npm.exe', 'npm')
$voltaPath = Get-ControlledExecutable @('volta.exe', 'volta')
$wingetPath = Get-ControlledExecutable @('winget.exe', 'winget')
$npmItems = @($request.software | Where-Object {
  ($_.source -eq 'npm-global' -or $_.source -eq 'volta-tool') -and
  $_.softwareId -ne 'node-runtime'
})
$npmMetadata = Get-NpmMetadata $nodePath $npmItems
$npmInstalled = @{}
if ($npmPath) {
  $listed = Invoke-ControlledProcess -FilePath $npmPath -ArgumentList @('list', '--global', '--depth=0', '--json')
  try {
    $parsed = $listed.Stdout | ConvertFrom-Json -AsHashtable
    foreach ($entry in $parsed.dependencies.GetEnumerator()) {
      $npmInstalled[$entry.Key] = ConvertTo-SafeVersion $entry.Value.version
    }
  } catch {}
}
$voltaInstalled = @{}
if ($voltaPath) {
  $listed = Invoke-ControlledProcess -FilePath $voltaPath -ArgumentList @('list', 'all', '--format', 'plain')
  foreach ($line in ($listed.Stdout -split "\\r?\\n")) {
    if ($line -match '^\\s*([^\\s@]+)@([A-Za-z0-9][A-Za-z0-9.+_~^-]*)') {
      $voltaInstalled[$Matches[1]] = ConvertTo-SafeVersion $Matches[2]
    }
  }
}

$items = @()
foreach ($item in @($request.software)) {
  if ($item.softwareId -eq 'node-runtime') {
    $resolved = $null
    try {
      $releases = Invoke-RestMethod -Method Get -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 12
      $selected = $releases | Where-Object { $_.lts -and $_.version } |
        Select-Object -First 1
      if ($selected) {
        $resolved = ConvertTo-SafeVersion ([string]$selected.version).TrimStart('v')
      }
    } catch {}
    $installed = $voltaInstalled['node']
    $status = if (-not $resolved) {
      'conflict'
    } elseif (-not $installed) {
      'missing'
    } elseif ($installed -eq $resolved) {
      'current'
    } else {
      'outdated'
    }
    $items += [ordered]@{
      softwareId = $item.softwareId
      source = $item.source
      package = $item.package
      status = $status
      installedVersion = $installed
      resolvedVersion = $resolved
      origins = @('nodejs.org')
      requiresAdmin = $false
      requiresGui = $false
      requiresRestart = $false
    }
    continue
  }
  if ($item.source -eq 'winget') {
    # WinGet has no stable batch JSON metadata contract here. Fail closed
    # instead of parsing localized tables or guessing elevation properties.
    $items += [ordered]@{
      softwareId = $item.softwareId
      source = $item.source
      package = $item.package
      status = 'conflict'
      installedVersion = $null
      resolvedVersion = $null
      origins = @('cdn.winget.microsoft.com')
      requiresAdmin = $null
      requiresGui = $null
      requiresRestart = $null
    }
    continue
  }
  if ($item.source -eq 'npm-global' -or $item.source -eq 'volta-tool') {
    $entry = $npmMetadata[$item.package]
    $resolved = if ($entry) { ConvertTo-SafeVersion $entry.version } else { $null }
    $installed = if ($item.source -eq 'npm-global') {
      $npmInstalled[$item.package]
    } else {
      $voltaInstalled[$item.package]
    }
    $status = if (-not $resolved) {
      'conflict'
    } elseif (-not $installed) {
      'missing'
    } elseif ($installed -eq $resolved) {
      'current'
    } else {
      'outdated'
    }
    $origins = @('registry.npmjs.org')
    if ($entry -and $entry.tarball) {
      $origins += Get-PublicOrigin $entry.tarball
    }
    $items += [ordered]@{
      softwareId = $item.softwareId
      source = $item.source
      package = $item.package
      status = $status
      installedVersion = $installed
      resolvedVersion = $resolved
      origins = @(Get-UniqueOrigins $origins)
      requiresAdmin = $false
      requiresGui = $false
      requiresRestart = $false
    }
  }
}

$originList = @($items | ForEach-Object { $_.origins } | ForEach-Object { $_ })
$systemDrive = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='" + $env:SystemDrive + "'")
$principal = [Security.Principal.WindowsPrincipal]::new(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
[ordered]@{
  protocol = $request.protocol
  profileSha256 = $request.profileSha256
  identity = $identity
  inventory = [ordered]@{
    diskAvailableBytes = [long]$systemDrive.FreeSpace
    adminCapable = $principal.IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator
    )
    commandLineTools = [ordered]@{ present = $true }
    tools = [ordered]@{
      homebrew = [ordered]@{ present = $false; version = $null }
      npm = Get-Tool $npmPath @('--version')
      volta = Get-Tool $voltaPath @('--version')
      winget = Get-Tool $wingetPath @('--version')
    }
    installedSoftware = @{}
  }
  items = $items
  probes = @(Invoke-OriginProbeBatch $originList)
} | ConvertTo-Json -Depth 20 -Compress
`;
}

function unique(values) {
  return [...new Set(values)];
}

function deduplicatePendingProbes(values) {
  const byLocationAndRoute = new Map();
  for (const value of values) {
    const key = `${value.networkLocation}|${value.route}`;
    const current = byLocationAndRoute.get(key) ?? {
      networkLocation: value.networkLocation,
      route: value.route,
      origins: [],
    };
    current.origins = unique([
      ...current.origins,
      ...(value.origins ?? []),
    ]).sort();
    byLocationAndRoute.set(key, current);
  }
  return [...byLocationAndRoute.values()];
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashRequiredLocalFile(path, label) {
  try {
    return createHash("sha256")
      .update(readFileSync(resolve(path)))
      .digest("hex");
  } catch {
    throw new Error(`${label} cannot be read.`);
  }
}

function assertSshTrustFilesUnchanged(prepared) {
  const receipt = prepared.targetIdentityReceipt;
  if (
    hashRequiredLocalFile(prepared.sshConfigPath, "SSH config") !==
      receipt.sshConfigSha256 ||
    hashRequiredLocalFile(
      receipt.knownHostsPath,
      "controlled known_hosts",
    ) !== receipt.knownHostsSha256 ||
    hashRequiredLocalFile(
      receipt.identityFile,
      "SSH identity file",
    ) !== receipt.identityFileSha256
  ) {
    throw new Error("Finalized SSH trust files changed during preflight.");
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function parseCli(argv) {
  const command = argv[0];
  const allowedByCommand = {
    plan: new Set([
      "--profile",
      "--identity-receipt",
      "--controller-route",
      "--target-route",
      "--output-dir",
    ]),
    probe: new Set([
      "--plan-bundle",
      "--controller-route",
      "--target-route",
      "--output-dir",
    ]),
    "network-bootstrap": new Set([
      "--profile",
      "--identity-receipt",
      "--controller-route",
      "--target-route",
      "--output-dir",
    ]),
  };
  const allowedFlags = allowedByCommand[command];
  if (!allowedFlags) {
    throw new Error(
      "Planner command must be plan, probe, or network-bootstrap.",
    );
  }
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowedFlags.has(flag) || typeof value !== "string") {
      throw new Error("Unsupported or incomplete planner CLI arguments.");
    }
    if (Object.prototype.hasOwnProperty.call(values, flag)) {
      throw new Error(`Duplicate planner CLI flag: ${flag}`);
    }
    values[flag] = value;
  }
  for (const flag of allowedFlags) {
    if (!values[flag]) throw new Error(`Missing required flag: ${flag}`);
  }
  return { command, values };
}

function plannerUsage() {
  const script = fileURLToPath(import.meta.url);
  return [
    "Usage:",
    `  node "${script}" network-bootstrap --profile <profile.json> --identity-receipt <identity.json> --controller-route <direct|clash> --target-route direct --output-dir <new-directory>`,
    `  node "${script}" plan --profile <profile.json> --identity-receipt <identity.json> --controller-route <direct|clash> --target-route <direct|clash> --output-dir <new-directory>`,
    `  node "${script}" probe --plan-bundle <existing-directory> --controller-route <direct|clash> --target-route <direct|clash> --output-dir <new-directory>`,
  ].join("\n");
}

async function runCli() {
  const argv = process.argv.slice(2);
  if (
    (argv.length === 1 && ["--help", "help"].includes(argv[0])) ||
    (argv.length === 2 &&
      ["plan", "probe", "network-bootstrap"].includes(argv[0]) &&
      argv[1] === "--help")
  ) {
    process.stdout.write(`${plannerUsage()}\n`);
    return;
  }
  const { command, values } = parseCli(argv);
  let profileRaw;
  let receiptRaw;
  let priorPreflightReceipt;
  let priorPreflightSha256;
  if (command === "plan" || command === "network-bootstrap") {
    profileRaw = readTextFileSafe(values["--profile"], "Profile");
    receiptRaw = readTextFileSafe(
      values["--identity-receipt"],
      "Identity receipt",
    );
  } else {
    const bundlePath = resolve(values["--plan-bundle"]);
    profileRaw = readBundleFile(bundlePath, "profile.json", "Profile");
    receiptRaw = readBundleFile(
      bundlePath,
      "identity.json",
      "Identity receipt",
    );
    const priorRaw = readBundleFile(
      bundlePath,
      "preflight.json",
      "Preflight receipt",
    );
    priorPreflightReceipt = parseJsonSafe(
      priorRaw,
      "Preflight receipt",
    );
    priorPreflightSha256 = sha256(
      JSON.stringify(priorPreflightReceipt),
    );
    const priorPlan = parseJsonSafe(
      readBundleFile(bundlePath, "plan.json", "Plan"),
      "Plan",
    );
    if (
      priorPlan.preflightSha256 !== priorPreflightSha256 ||
      priorPlan.profile?.sha256 !== sha256(profileRaw)
    ) {
      throw new Error("Existing plan bundle digest mismatch.");
    }
    if (priorPlan.status !== "route-probe-required") {
      throw new Error(
        "Existing plan bundle does not require a staged route probe.",
      );
    }
  }
  rejectSecretBearingRaw(profileRaw, "Profile");
  rejectSecretBearingRaw(receiptRaw, "Identity receipt");
  const profile = parseJsonSafe(profileRaw, "Profile");
  const receipt = parseJsonSafe(receiptRaw, "Identity receipt");
  const commonInput = {
    profile,
    profileRaw,
    targetAlias: receipt.alias,
    sshConfigPath: receipt.sshConfigPath,
    targetIdentityReceipt: receipt,
    initialRoutes: {
      controller: values["--controller-route"],
      target: values["--target-route"],
    },
  };
  if (command === "network-bootstrap") {
    const miniPlan = await planNetworkBootstrap(commonInput);
    const published = publishNetworkBootstrapBundle({
      outputDirectory: values["--output-dir"],
      miniPlan,
      profileRaw,
      receiptRaw,
    });
    console.log(
      JSON.stringify({
        status: miniPlan.status,
        bundle: published,
        miniPlanSha256: miniPlan.miniPlanSha256,
      }),
    );
    if (miniPlan.status === "conflict") process.exitCode = 3;
    return;
  }
  const plan = await planInstallation({
    ...commonInput,
    priorPreflightReceipt,
    priorPreflightSha256,
  });
  const published = publishPlanBundle({
    outputDirectory: values["--output-dir"],
    plan,
    profileRaw,
    receiptRaw,
  });
  console.log(
    JSON.stringify({
      status: plan.status,
      bundle: published,
      profileSha256: plan.profile.sha256,
      targetIdentitySha256: plan.target.targetIdentitySha256,
      machineExecutionIdentitySha256:
        plan.target.machineExecutionIdentitySha256,
      preflightSha256: plan.preflightSha256,
      scheduleSha256: plan.schedule?.scheduleSha256 ?? null,
    }),
  );
  if (["conflict", "route-probe-required"].includes(plan.status)) {
    process.exitCode = 3;
  }
}

function readTextFileSafe(path, label) {
  try {
    return readFileSync(resolve(path), "utf8");
  } catch {
    throw new Error(`${label} file cannot be read.`);
  }
}

function readBundleFile(bundlePath, filename, label) {
  const path = resolve(bundlePath, filename);
  if (dirname(path) !== resolve(bundlePath)) {
    throw new Error(`${label} bundle path is invalid.`);
  }
  return readTextFileSafe(path, label);
}

function parseJsonSafe(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} JSON is invalid.`);
  }
}

function rejectSecretBearingRaw(raw, label) {
  if (
    typeof raw !== "string" ||
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(raw) ||
    /[a-z][a-z0-9+.-]*:\/\/[^/\s:@"]+:[^/\s@"]+@/i.test(raw) ||
    /"(?:password|passwd|token|secret|credential|subscription|private.?key|api.?key)"\s*:/i.test(
      raw,
    )
  ) {
    throw new Error(`${label} contains forbidden secret-like content.`);
  }
}

export function publishPlanBundle({
  outputDirectory,
  plan,
  profileRaw,
  receiptRaw,
}) {
  const finalDirectory = resolve(outputDirectory);
  const parentDirectory = dirname(finalDirectory);
  if (
    !existsSync(parentDirectory) ||
    existsSync(finalDirectory) ||
    basename(finalDirectory).length === 0
  ) {
    throw new Error("Plan output directory is not publishable.");
  }
  const temporaryDirectory = join(
    parentDirectory,
    `.${basename(finalDirectory)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  const bundlePlan = {
    ...plan,
    bundle: {
      schemaVersion: 1,
      files: {
        profile: "profile.json",
        identityReceipt: "identity.json",
        preflightReceipt: "preflight.json",
        schedule: plan.schedule ? "schedule.json" : null,
      },
      profileSha256: plan.profile.sha256,
      targetIdentitySha256: plan.target.targetIdentitySha256,
      machineExecutionIdentitySha256:
        plan.target.machineExecutionIdentitySha256,
      preflightSha256: plan.preflightSha256,
      scheduleSha256: plan.schedule?.scheduleSha256 ?? null,
    },
  };
  try {
    mkdirSync(temporaryDirectory, { mode: 0o700 });
    writeDurableNewFile(
      join(temporaryDirectory, "profile.json"),
      profileRaw,
    );
    writeDurableNewFile(
      join(temporaryDirectory, "identity.json"),
      receiptRaw,
    );
    writeDurableNewFile(
      join(temporaryDirectory, "preflight.json"),
      `${JSON.stringify(plan.preflightReceipt, null, 2)}\n`,
    );
    if (plan.schedule) {
      writeDurableNewFile(
        join(temporaryDirectory, "schedule.json"),
        `${JSON.stringify(plan.schedule, null, 2)}\n`,
      );
    }
    writeDurableNewFile(
      join(temporaryDirectory, "plan.json"),
      `${JSON.stringify(bundlePlan, null, 2)}\n`,
    );
    renameSync(temporaryDirectory, finalDirectory);
  } catch {
    try {
      if (existsSync(temporaryDirectory)) {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    } catch {
      // 只清理本次随机生成且尚未发布的临时目录。
    }
    throw new Error("Plan bundle could not be published atomically.");
  }
  return finalDirectory;
}

export function publishNetworkBootstrapBundle({
  outputDirectory,
  miniPlan,
  profileRaw,
  receiptRaw,
}) {
  const finalDirectory = resolve(outputDirectory);
  const parentDirectory = dirname(finalDirectory);
  if (
    !existsSync(parentDirectory) ||
    existsSync(finalDirectory) ||
    basename(finalDirectory).length === 0
  ) {
    throw new Error("Network bootstrap output directory is not publishable.");
  }
  const temporaryDirectory = join(
    parentDirectory,
    `.${basename(finalDirectory)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  try {
    mkdirSync(temporaryDirectory, { mode: 0o700 });
    writeDurableNewFile(
      join(temporaryDirectory, "profile.json"),
      profileRaw,
    );
    writeDurableNewFile(
      join(temporaryDirectory, "identity.json"),
      receiptRaw,
    );
    writeDurableNewFile(
      join(temporaryDirectory, "mini-plan.json"),
      `${JSON.stringify(miniPlan, null, 2)}\n`,
    );
    if (miniPlan.artifactRequest) {
      writeDurableNewFile(
        join(temporaryDirectory, "artifact-request.json"),
        `${JSON.stringify(miniPlan.artifactRequest, null, 2)}\n`,
      );
    }
    renameSync(temporaryDirectory, finalDirectory);
  } catch {
    try {
      if (existsSync(temporaryDirectory)) {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    } catch {
      // 只清理本次随机生成且尚未发布的临时目录。
    }
    throw new Error(
      "Network bootstrap bundle could not be published atomically.",
    );
  }
  return finalDirectory;
}

function writeDurableNewFile(path, content) {
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
