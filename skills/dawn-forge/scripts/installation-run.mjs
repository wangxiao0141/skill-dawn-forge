#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as defaultState from "./installation-run-state.mjs";
import * as defaultBatchRunner from "./run-installation-batch.mjs";
import {
  machineExecutionIdentityDigest,
  targetIdentityDigest,
} from "./target-identity.mjs";

const digestPattern = /^[a-f0-9]{64}$/;
const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const runIdPattern =
  /^run-([A-Za-z0-9][A-Za-z0-9_-]{0,63})-([a-f0-9]{32})$/;
const gateTokenPattern = /^gate-[a-f0-9]{48}$/;
const allowedPlatforms = new Set(["macos", "windows"]);
const allowedRoutes = new Set(["direct", "clash", "local"]);
const manualEvidenceTypes = new Set([
  "macos-bundle-signature",
  "macos-package-receipt",
  "windows-package-receipt",
  "windows-uninstall-entry",
  "cli-version",
]);
const forbiddenKeyPattern =
  /^(?:password|passwd|secret|subscription(?:url)?|api[-_]?key|private[-_]?key|credential|authorization|cookie|token)$/i;
const urlPattern = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ownedRuns = new Map();
const defaultMaxPreflightAgeMs = 30 * 60 * 1000;
const maxFutureClockSkewMs = 5 * 60 * 1000;

export const EXIT_CODES = Object.freeze({
  success: 0,
  error: 1,
  userAction: 2,
  pending: 3,
});

export function prepareInstallationRun(input, dependencies = {}) {
  const runtime = runtimeDependencies(dependencies);
  const prepared = validatePrepareInput(input, runtime);
  const freshness = preflightFreshness(
    prepared.preflightObservedAt,
    runtime,
  );
  if (!freshness.fresh) return replanRequiredResult(freshness);
  const paths = canonicalPaths(
    runtime.homeDirectory,
    prepared.alias,
    prepared.machineExecutionIdentitySha256,
  );
  const runSeedSha256 = createRunSeedSha256(prepared);
  const runId = createRunId(prepared.alias, runSeedSha256);
  const runDirectory = join(paths.runsDirectory, runId);
  const inputsDirectory = join(runDirectory, "inputs");
  const boundPrepared = {
    ...prepared,
    profilePath: join(inputsDirectory, "profile.json"),
    identitySnapshotPath: join(inputsDirectory, "identity.json"),
    preflightReceiptPath: join(inputsDirectory, "preflight.json"),
    schedulePath: join(inputsDirectory, "schedule.json"),
    planPath:
      prepared.planBytes === null
        ? null
        : join(inputsDirectory, "plan.json"),
  };
  const binding = createBinding(boundPrepared, paths);
  assertJournalSafe(binding, "run binding");
  const bindingSha256 = sha256(JSON.stringify(binding));
  const stateDirectory = join(runDirectory, "state");
  const stateRunKey = createStateRunKey({
    scheduleSha256: prepared.schedule.scheduleSha256,
    preflightSha256: prepared.schedule.preflightSha256,
    profileSha256: boundPrepared.profileSha256,
    targetIdentitySha256: boundPrepared.targetIdentitySha256,
    platform: boundPrepared.platform,
  });
  const statePath = join(stateDirectory, `${stateRunKey}.json`);
  const stateRunId = `run-${stateRunKey}`;
  const manifestPath = join(runDirectory, "manifest.json");
  const stateIdentity = {
    statePath,
    runId: stateRunId,
    scheduleSha256: prepared.schedule.scheduleSha256,
    profileSha256: boundPrepared.profileSha256,
    targetIdentitySha256: boundPrepared.targetIdentitySha256,
  };

  mkdirSync(paths.targetDirectory, { recursive: true, mode: 0o700 });
  return withExclusiveFile(paths.identityPrepareLockPath, () =>
    withExclusiveFile(paths.prepareLockPath, () => {
    const existingPointer = readOptionalJson(paths.activeRunPath);
    const existingIdentityPointer = readOptionalJson(
      paths.identityActiveRunPath,
    );
    if (existingPointer !== null) {
      validateActivePointer(existingPointer, {
        expectedAlias: prepared.alias,
      });
    }
    if (existingIdentityPointer !== null) {
      validateActivePointer(existingIdentityPointer, {
        expectedMachineExecutionIdentitySha256:
          prepared.machineExecutionIdentitySha256,
      });
    }
    for (const pointer of [existingPointer, existingIdentityPointer]) {
      if (pointer === null || pointer.runId === runId) continue;
      const active = loadCanonicalManifest(
        pointer.runId,
        runtime.homeDirectory,
      );
      if (
        pointer.bindingSha256 !== active.bindingSha256 ||
        pointer.targetIdentitySha256 !==
          active.target.targetIdentitySha256 ||
        pointer.machineExecutionIdentitySha256 !==
          active.target.machineExecutionIdentitySha256
      ) {
        throw new Error("Active run pointer digest binding is invalid.");
      }
      const activeState = runtime.state.readRun(active.state.identity);
      if (!["completed", "cancelled"].includes(activeState.status)) {
        throw new RunConflictError(
          `Target ${prepared.alias} already has active run ${active.runId}.`,
          {
            targetAlias: prepared.alias,
            activeRunId: active.runId,
            activeAlias: active.target.alias,
          },
        );
      }
    }

    if (existsSync(manifestPath)) {
      const existing = loadManifestByPath(manifestPath);
      assertManifestBinding(existing, {
        runId,
        bindingSha256,
        manifestPath,
      });
      const existingState = runtime.state.readRun(existing.state.identity);
      publishRunPointers(
        paths,
        existing,
        ["completed", "cancelled"].includes(existingState.status)
          ? existingState.status
          : "active",
      );
      return prepareResult(existing, true);
    }

    publishInputSnapshots(boundPrepared);
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const items = boundPrepared.schedule.batches.flatMap((batch) =>
      batch.items.map((item) => ({
        softwareId: item.softwareId,
        batchId: batch.batchId,
        dependsOn: [...item.dependsOn],
        executionMode: batch.executionMode,
      })),
    );
    if (existsSync(statePath)) {
      runtime.state.readRun(stateIdentity);
    } else {
      runtime.state.createRun(stateIdentity, { items });
    }

    const now = runtime.now();
    const manifest = sealManifest({
      schemaVersion: 1,
      runId,
      bindingSha256,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      status: "prepared",
      target: {
        alias: prepared.alias,
        storageAlias: prepared.alias.toLowerCase(),
        platform: boundPrepared.platform,
        targetIdentitySha256: boundPrepared.targetIdentitySha256,
        machineExecutionIdentitySha256:
          boundPrepared.machineExecutionIdentitySha256,
        identityReceiptPath: boundPrepared.identityReceiptPath,
        identityReceiptSha256: boundPrepared.identityReceiptSha256,
        identitySnapshotPath: boundPrepared.identitySnapshotPath,
      },
      profile: {
        path: boundPrepared.profilePath,
        sha256: boundPrepared.profileSha256,
      },
      preflight: {
        path: boundPrepared.preflightReceiptPath,
        fileSha256: boundPrepared.preflightReceiptFileSha256,
        preflightSha256: boundPrepared.preflightSha256,
      },
      schedule: {
        path: boundPrepared.schedulePath,
        fileSha256: boundPrepared.scheduleFileSha256,
        scheduleSha256: boundPrepared.schedule.scheduleSha256,
      },
      plan:
        boundPrepared.planPath === null
          ? null
          : {
              path: boundPrepared.planPath,
              sha256: boundPrepared.planSha256,
            },
      ssh: {
        configPath: boundPrepared.sshConfigPath,
        configSha256: boundPrepared.sshConfigSha256,
        managedBlockSha256: boundPrepared.managedBlockSha256,
        knownHostsPath: boundPrepared.knownHostsPath,
        knownHostsSha256: boundPrepared.knownHostsSha256,
        identityFile: boundPrepared.identityFile,
        identityFileSha256: boundPrepared.identityFileSha256,
        keyFingerprint: boundPrepared.keyFingerprint,
      },
      state: {
        directory: stateDirectory,
        identity: stateIdentity,
      },
      cache: {
        root: paths.cacheRoot,
      },
      routes: {
        controller: prepared.schedule.initialRoutes.controller,
        target: prepared.schedule.initialRoutes.target,
      },
      pendingGate: null,
      cancellation: null,
      lastAdvance: null,
    });
    assertManifestSafe(manifest);
    atomicWriteJson(manifestPath, manifest);
    publishRunPointers(paths, manifest, "active");
    return prepareResult(manifest, false);
    }),
  );
}

export async function advanceInstallationRun(
  runId,
  options = {},
  dependencies = {},
) {
  assertAllowedKeys(options, ["gateToken"], "options");
  if (
    options.gateToken !== undefined &&
    !gateTokenPattern.test(options.gateToken)
  ) {
    throw new TypeError("options.gateToken is invalid.");
  }
  const runtime = runtimeDependencies(dependencies);
  let manifest = loadCanonicalManifest(runId, runtime.homeDirectory);
  assertCurrentTargetRun(manifest, runtime.homeDirectory);
  let state = runtime.state.readRun(manifest.state.identity);

  if (state.status === "completed") {
    updateRunPointersIfOwned(
      manifest,
      state.status,
      runtime.homeDirectory,
    );
    return typedResult("completed", manifest, state);
  }
  if (state.cancel !== null) {
    return cancellationResult(manifest, state);
  }
  if (state.activeAttempt !== null) {
    return typedResult("busy", manifest, state, {
      batchId: state.activeAttempt.batchId,
      attemptId: state.activeAttempt.attemptId,
    });
  }
  const source = verifyBoundSources(manifest);
  if (manifest.startedAt === null) {
    const freshness = preflightFreshness(
      source.preflightReceipt.observedAt,
      runtime,
    );
    if (!freshness.fresh) {
      return typedResult("replan-required", manifest, state, {
        reason: freshness.reason,
        observedAt: freshness.observedAt,
        expiresAt: freshness.expiresAt,
        maxAgeMs: freshness.maxAgeMs,
      });
    }
  }

  if (options.gateToken !== undefined) {
    manifest = consumeRouteGate(manifest, options.gateToken, runtime);
  } else if (manifest.pendingGate?.type === "route-switch") {
    return routeGateResult(manifest);
  }

  const selection = selectNextBatch(source.schedule, state, runtime.state);
  if (selection.kind !== "runnable") {
    return typedResult(selection.kind, manifest, state, selection.details);
  }
  const { batch } = selection;
  const routeGate = requiredRouteGate(manifest, batch, runtime);
  if (routeGate !== null) return routeGate;

  const manualReasons = manualGateReasons(batch);
  if (manualReasons.length > 0) {
    manifest = storeManualGate(manifest, batch, manualReasons, runtime);
    return typedResult("user-action", manifest, state, {
      action: "run-verify-manual",
      stepId: `manual:${manifest.runId}:${batch.batchId}`,
      batchId: batch.batchId,
      softwareIds: batch.items.map((item) => item.softwareId),
      reasons: manualReasons,
      receiptSchema: {
        schemaVersion: 1,
        runId: manifest.runId,
        batchId: batch.batchId,
        targetIdentitySha256: manifest.target.targetIdentitySha256,
        receipts: batch.items.map((item) => ({
          softwareId: item.softwareId,
          evidenceType: "<controlled-evidence-type>",
          evidenceSha256: "<lowercase-sha256>",
        })),
      },
    });
  }

  if (manifest.pendingGate !== null || manifest.startedAt === null) {
    manifest = updateManifest(
      manifest,
      {
        pendingGate: null,
        startedAt: manifest.startedAt ?? runtime.now(),
      },
      runtime,
    );
  }
  const runnerInput = {
    schedule: source.schedule,
    batchId: batch.batchId,
    target: manifest.target.alias,
    sshConfig: manifest.ssh.configPath,
    platform: manifest.target.platform,
    route: batch.route,
    stateDir: manifest.state.directory,
    profileSha256: manifest.profile.sha256,
    targetIdentitySha256: manifest.target.targetIdentitySha256,
    machineExecutionIdentitySha256:
      manifest.target.machineExecutionIdentitySha256,
    identityReceiptPath: manifest.target.identityReceiptPath,
    identityReceiptSha256: manifest.target.identityReceiptSha256,
  };
  if (ownedRuns.has(manifest.runId)) {
    return typedResult("busy", manifest, state, {
      batchId: batch.batchId,
      reason: "owned-run-already-active",
    });
  }
  const signalBridge = createSignalBridge(runtime.signalSource);
  const signalSource = signalBridge.signalSource;
  const ownedRun = {
    runId: manifest.runId,
    stateIdentity: manifest.state.identity,
    signalSource,
  };
  ownedRuns.set(manifest.runId, ownedRun);
  let runnerResult;
  try {
    runnerResult = await runtime.runBatch(runnerInput, {
      ...runtime.runnerDependencies,
      targetLockRoot: join(
        runtime.homeDirectory,
        ".dawn-forge",
        "locks",
        "targets",
      ),
      signalSource,
    });
  } finally {
    if (ownedRuns.get(manifest.runId) === ownedRun) {
      ownedRuns.delete(manifest.runId);
    }
    signalBridge.dispose();
  }
  state = runtime.state.readRun(manifest.state.identity);
  manifest = loadCanonicalManifest(manifest.runId, runtime.homeDirectory);
  manifest = updateManifest(
    manifest,
    {
      status: state.status,
      lastAdvance: {
        batchId: batch.batchId,
        observedStateRevision: state.revision,
        observedStatus: state.status,
        finishedAt: runtime.now(),
      },
    },
    runtime,
  );
  updateRunPointersIfOwned(manifest, state.status, runtime.homeDirectory);
  if (state.cancel !== null) return cancellationResult(manifest, state);
  return typedResult("batch-finished", manifest, state, {
    batchId: batch.batchId,
    status: state.status,
    runnerDisposition: runnerResult?.disposition ?? "completed",
  });
}

export function observeInstallationRun(runId, dependencies = {}) {
  const runtime = runtimeDependencies(dependencies);
  const manifest = loadCanonicalManifest(runId, runtime.homeDirectory);
  const state = runtime.state.readRun(manifest.state.identity);
  return typedResult("observed", manifest, state, {
    freshness: {
      manifestUpdatedAt: manifest.updatedAt,
      stateUpdatedAt: state.updatedAt,
      source: "controller-local-state",
    },
  });
}

export async function cancelInstallationRun(runId, dependencies = {}) {
  const runtime = runtimeDependencies(dependencies);
  let manifest = loadCanonicalManifest(runId, runtime.homeDirectory);
  let state = runtime.state.readRun(manifest.state.identity);
  if (state.status === "completed") {
    updateRunPointersIfOwned(
      manifest,
      state.status,
      runtime.homeDirectory,
    );
    return typedResult("already-complete", manifest, state);
  }
  if (state.activeAttempt !== null && !ownedRuns.has(manifest.runId)) {
    return typedResult("cancel-unavailable", manifest, state, {
      action: "interrupt-owning-advance-session",
      ownership: "foreground-advance-session-only",
      stateChanged: false,
      message:
        "Only the foreground advance process owns this attempt. Send Ctrl-C to that same tool session.",
    });
  }
  if (state.activeAttempt !== null && state.cancel === null) {
    await cancelLocallyOwnedRun({
      runId: manifest.runId,
      stateIdentity: manifest.state.identity,
      batchId: state.activeAttempt.batchId,
      attemptId: state.activeAttempt.attemptId,
      ownedProcessToken: state.activeAttempt.ownedProcessToken,
    });
    state = runtime.state.readRun(manifest.state.identity);
  } else if (state.cancel === null) {
    state = runtime.state.requestCancel(manifest.state.identity, {
      expectedRevision: state.revision,
    });
  }
  if (state.cancel === null) {
    return typedResult("cancel-pending", manifest, state, {
      action: "interrupt-owning-advance-session",
      ownership: "foreground-advance-session-only",
      canConfirmTermination: false,
    });
  }
  manifest = loadCanonicalManifest(manifest.runId, runtime.homeDirectory);
  manifest = updateManifest(
    manifest,
    {
      status: state.status,
      cancellation: {
        requestedAt: state.cancel.requestedAt,
        status: state.cancel.status,
        ...(state.cancel.batchId === undefined
          ? {}
          : {
              batchId: state.cancel.batchId,
              attemptId: state.cancel.attemptId,
              ownedProcessToken: state.cancel.ownedProcessToken,
            }),
      },
    },
    runtime,
  );
  updateRunPointersIfOwned(manifest, state.status, runtime.homeDirectory);
  return cancellationResult(manifest, state);
}

export async function verifyManualInstallation(runId, dependencies = {}) {
  const runtime = runtimeDependencies(dependencies);
  let manifest = loadCanonicalManifest(runId, runtime.homeDirectory);
  assertCurrentTargetRun(manifest, runtime.homeDirectory);
  const source = verifyBoundSources(manifest);
  let state = runtime.state.readRun(manifest.state.identity);
  if (manifest.startedAt === null) {
    const freshness = preflightFreshness(
      source.preflightReceipt.observedAt,
      runtime,
    );
    if (!freshness.fresh) {
      return typedResult("replan-required", manifest, state, {
        reason: freshness.reason,
        observedAt: freshness.observedAt,
        expiresAt: freshness.expiresAt,
        maxAgeMs: freshness.maxAgeMs,
      });
    }
  }
  if (manifest.pendingGate?.type !== "manual-complete") {
    throw new Error("The run has no pending manual-complete gate.");
  }
  if (state.activeAttempt !== null || state.cancel !== null) {
    return typedResult("manual-pending", manifest, state, {
      reason: "run-not-idle",
      batchId: manifest.pendingGate.batchId,
    });
  }
  const batch = source.schedule.batches.find(
    (candidate) => candidate.batchId === manifest.pendingGate.batchId,
  );
  if (batch === undefined) {
    throw new Error("Manual gate batch is missing from the schedule.");
  }
  const adapters = batch.items.map((item) =>
    selectManualVerificationAdapter(item, batch, manifest.target.platform),
  );
  const unsupported = adapters.filter((adapter) => adapter.supported !== true);
  if (unsupported.length > 0) {
    return typedResult("manual-pending", manifest, state, {
      reason: "unsupported-manual-verifier",
      batchId: batch.batchId,
      softwareIds: unsupported.map((adapter) => adapter.softwareId),
      action: "user-attestation-and-controlled-adapter-required",
      releasesDependencies: false,
    });
  }

  const receiptPath = canonicalManualReceiptPath(manifest, batch.batchId);
  if (existsSync(receiptPath)) {
    if (
      manifest.pendingGate.verificationReceiptPath === receiptPath &&
      digestPattern.test(
        manifest.pendingGate.verificationReceiptSha256 ?? "",
      )
    ) {
      const existing = parseJsonFile(
        receiptPath,
        "manual verification receipt",
      );
      validateGeneratedManualReceipt(existing, manifest, batch);
      if (
        sha256(readFileSync(receiptPath)) !==
        manifest.pendingGate.verificationReceiptSha256
      ) {
        throw new Error("Manual verification receipt file drift detected.");
      }
      return recordVerifiedManualCompletion(
        manifest.runId,
        runtime,
      );
    }
    throw new Error(
      "An unbound manual verification receipt already exists; refusing to overwrite it.",
    );
  }

  const verification = await runtime.verifyManualBatch({
    runId: manifest.runId,
    bindingSha256: manifest.bindingSha256,
    batch,
    adapters,
    target: {
      alias: manifest.target.alias,
      platform: manifest.target.platform,
      targetIdentitySha256: manifest.target.targetIdentitySha256,
    },
    ssh: {
      configPath: manifest.ssh.configPath,
      knownHostsPath: manifest.ssh.knownHostsPath,
      identityFile: manifest.ssh.identityFile,
    },
  });
  const normalized = normalizeManualVerification(
    verification,
    manifest,
    batch,
    adapters,
    runtime,
  );
  if (normalized.kind === "manual-pending") {
    return typedResult("manual-pending", manifest, state, normalized);
  }
  const receipt = sealManualReceipt({
    schemaVersion: 1,
    protocol: "dawn-forge-manual-verification-v1",
    verifiedAt: runtime.now(),
    runId: manifest.runId,
    bindingSha256: manifest.bindingSha256,
    batchId: batch.batchId,
    targetIdentitySha256: manifest.target.targetIdentitySha256,
    scheduleSha256: manifest.schedule.scheduleSha256,
    preflightSha256: manifest.preflight.preflightSha256,
    receipts: normalized.receipts,
  });
  assertJournalSafe(receipt, "manual verification receipt");
  atomicPublishJsonExclusive(receiptPath, receipt);
  const receiptSha256 = sha256(readFileSync(receiptPath));
  manifest = updateManifest(
    manifest,
    {
      startedAt: manifest.startedAt ?? runtime.now(),
      pendingGate: {
        ...manifest.pendingGate,
        verificationReceiptPath: receiptPath,
        verificationReceiptSha256: receiptSha256,
        verifiedAt: receipt.verifiedAt,
      },
    },
    runtime,
  );
  return recordVerifiedManualCompletion(manifest.runId, runtime);
}

function recordVerifiedManualCompletion(runId, runtime) {
  let manifest = loadCanonicalManifest(runId, runtime.homeDirectory);
  assertCurrentTargetRun(manifest, runtime.homeDirectory);
  const source = verifyBoundSources(manifest);
  let state = runtime.state.readRun(manifest.state.identity);
  if (manifest.pendingGate?.type !== "manual-complete") {
    throw new Error("The run has no pending manual-complete gate.");
  }
  const batchId = manifest.pendingGate.batchId;
  const canonicalReceiptPath = canonicalManualReceiptPath(
    manifest,
    batchId,
  );
  if (
    manifest.pendingGate.verificationReceiptPath !== canonicalReceiptPath ||
    !digestPattern.test(
      manifest.pendingGate.verificationReceiptSha256 ?? "",
    )
  ) {
    throw new Error(
      "Manual completion requires a receipt generated by verify-manual.",
    );
  }
  const receipt = parseJsonFile(
    canonicalReceiptPath,
    "manual verification receipt",
  );
  const batch = source.schedule.batches.find(
    (candidate) => candidate.batchId === batchId,
  );
  if (batch === undefined) {
    throw new Error("Manual verification batch is missing.");
  }
  validateGeneratedManualReceipt(receipt, manifest, batch);
  if (
    sha256(readFileSync(canonicalReceiptPath)) !==
    manifest.pendingGate.verificationReceiptSha256
  ) {
    throw new Error("Manual verification receipt file drift detected.");
  }

  for (const entry of receipt.receipts) {
    state = runtime.state.recordManualReceipt(
      manifest.state.identity,
      {
        softwareId: entry.softwareId,
        evidenceType: entry.evidenceType,
        evidenceSha256: entry.evidenceSha256,
      },
      { expectedRevision: state.revision },
    );
  }
  manifest = updateManifest(
    manifest,
    {
      status: state.status,
      pendingGate: null,
      lastAdvance: {
        batchId,
        observedStateRevision: state.revision,
        observedStatus: state.status,
        finishedAt: runtime.now(),
      },
    },
    runtime,
  );
  updateRunPointersIfOwned(manifest, state.status, runtime.homeDirectory);
  return typedResult("manual-recorded", manifest, state, {
    batchId,
    softwareIds: receipt.receipts.map((entry) => entry.softwareId),
    receiptSha256: sha256(readFileSync(canonicalReceiptPath)),
  });
}

export class RunConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "RunConflictError";
    this.code = "RUN_CONFLICT";
    this.details = details;
  }
}

class PlanBindingError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "PlanBindingError";
    this.code = code;
    this.details = details;
  }
}

function runtimeDependencies(dependencies) {
  if (!isPlainObject(dependencies)) {
    throw new TypeError("dependencies must be an object.");
  }
  assertAllowedKeys(
    dependencies,
    [
      "homeDirectory",
      "now",
      "state",
      "runBatch",
      "verifyManualBatch",
      "runnerDependencies",
      "signalSource",
      "maxPreflightAgeMs",
    ],
    "dependencies",
  );
  const state = dependencies.state ?? defaultState;
  for (const method of [
    "createRun",
    "readRun",
    "requestCancel",
    "recordManualReceipt",
    "assertBatchRunnable",
  ]) {
    if (typeof state[method] !== "function") {
      throw new TypeError(`dependencies.state.${method} must be a function.`);
    }
  }
  const runBatch =
    dependencies.runBatch ?? defaultBatchRunner.runInstallationBatch;
  if (typeof runBatch !== "function") {
    throw new TypeError("dependencies.runBatch must be a function.");
  }
  const verifyManualBatch =
    dependencies.verifyManualBatch ?? runFixedManualVerification;
  if (typeof verifyManualBatch !== "function") {
    throw new TypeError("dependencies.verifyManualBatch must be a function.");
  }
  const homeDirectory = resolve(dependencies.homeDirectory ?? homedir());
  const now =
    dependencies.now ?? (() => new Date().toISOString());
  if (typeof now !== "function") {
    throw new TypeError("dependencies.now must be a function.");
  }
  const maxPreflightAgeMs =
    dependencies.maxPreflightAgeMs ?? defaultMaxPreflightAgeMs;
  if (
    !Number.isSafeInteger(maxPreflightAgeMs) ||
    maxPreflightAgeMs < 60_000 ||
    maxPreflightAgeMs > 24 * 60 * 60 * 1000
  ) {
    throw new TypeError(
      "dependencies.maxPreflightAgeMs must be between one minute and 24 hours.",
    );
  }
  const signalSource = dependencies.signalSource ?? process;
  if (
    typeof signalSource?.on !== "function" ||
    typeof signalSource?.removeListener !== "function"
  ) {
    throw new TypeError(
      "dependencies.signalSource must provide on() and removeListener().",
    );
  }
  return {
    homeDirectory,
    now,
    state,
    runBatch,
    verifyManualBatch,
    runnerDependencies: dependencies.runnerDependencies ?? {},
    signalSource,
    maxPreflightAgeMs,
  };
}

function validatePrepareInput(input, runtime) {
  if (!isPlainObject(input)) throw new TypeError("input must be an object.");
  const keys = Object.keys(input);
  if (keys.length === 1 && keys[0] === "planBundlePath") {
    return validatePlanBundle(input.planBundlePath, runtime);
  }
  assertAllowedKeys(
    input,
    [
      "profilePath",
      "identityReceiptPath",
      "preflightReceiptPath",
      "schedulePath",
    ],
    "input",
  );
  return validatePrepareFiles(
    {
      profilePath: resolveRequiredPath(input.profilePath, "profilePath"),
      identityReceiptPath: resolveRequiredPath(
        input.identityReceiptPath,
        "identityReceiptPath",
      ),
      preflightReceiptPath: resolveRequiredPath(
        input.preflightReceiptPath,
        "preflightReceiptPath",
      ),
      schedulePath: resolveRequiredPath(input.schedulePath, "schedulePath"),
      planPath: null,
    },
    runtime,
  );
}

function validatePlanBundle(planBundlePath, runtime) {
  const bundleDirectory = resolveRequiredPath(
    planBundlePath,
    "planBundlePath",
  );
  const planPath = join(bundleDirectory, "plan.json");
  const plan = parseJsonFile(planPath, "plan bundle");
  assertJournalSafe(plan, "plan bundle");
  if (
    !["planned", "manual-gate"].includes(plan.status) ||
    plan.bundle?.schemaVersion !== 1 ||
    plan.bundle?.files?.profile !== "profile.json" ||
    plan.bundle?.files?.identityReceipt !== "identity.json" ||
    plan.bundle?.files?.preflightReceipt !== "preflight.json" ||
    plan.bundle?.files?.schedule !== "schedule.json"
  ) {
    throw new Error("Plan bundle is not ready for installation.");
  }
  const profilePath = join(bundleDirectory, "profile.json");
  const bundledIdentityPath = join(bundleDirectory, "identity.json");
  const preflightReceiptPath = join(bundleDirectory, "preflight.json");
  const schedulePath = join(bundleDirectory, "schedule.json");
  for (const [path, label] of [
    [profilePath, "bundle profile"],
    [bundledIdentityPath, "bundle identity receipt"],
    [preflightReceiptPath, "bundle preflight receipt"],
    [schedulePath, "bundle schedule"],
  ]) {
    resolveRequiredPath(path, label);
  }
  const bundledIdentityBytes = readFileSync(bundledIdentityPath);
  const bundledReceipt = parseJson(
    bundledIdentityBytes,
    "bundle target identity receipt",
  );
  const identity = validateIdentityReceipt(bundledReceipt);
  const identityReceiptPath = join(
    runtime.homeDirectory,
    ".dawn-forge",
    "targets",
    identity.alias.toLowerCase(),
    "identity.json",
  );
  resolveRequiredPath(identityReceiptPath, "canonical target identity receipt");
  const canonicalIdentityBytes = readFileSync(identityReceiptPath);
  if (sha256(canonicalIdentityBytes) !== sha256(bundledIdentityBytes)) {
    throw new Error("Bundle identity receipt differs from the canonical receipt.");
  }
  const prepared = validatePrepareFiles(
    {
      profilePath,
      identityReceiptPath,
      preflightReceiptPath,
      schedulePath,
      planPath,
    },
    runtime,
  );
  const planBytes = readFileSync(planPath);
  if (
    plan.bundle.profileSha256 !== prepared.profileSha256 ||
    plan.bundle.targetIdentitySha256 !== prepared.targetIdentitySha256 ||
    plan.bundle.machineExecutionIdentitySha256 !==
      prepared.machineExecutionIdentitySha256 ||
    plan.bundle.preflightSha256 !== prepared.preflightSha256 ||
    plan.bundle.scheduleSha256 !== prepared.schedule.scheduleSha256 ||
    plan.profile?.sha256 !== prepared.profileSha256 ||
    plan.target?.alias !== prepared.alias ||
    plan.target?.targetIdentitySha256 !== prepared.targetIdentitySha256 ||
    plan.target?.machineExecutionIdentitySha256 !==
      prepared.machineExecutionIdentitySha256 ||
    plan.preflightSha256 !== prepared.preflightSha256 ||
    plan.schedule?.scheduleSha256 !== prepared.schedule.scheduleSha256
  ) {
    throw new Error("Plan bundle digest binding mismatch.");
  }
  const unboundControllerCacheItems = prepared.schedule.batches
    .flatMap((batch) => batch.items)
    .filter((item) => item.routeEvidence.method === "controller-cache");
  if (unboundControllerCacheItems.length > 0) {
    throw new PlanBindingError(
      "UNBOUND_ARTIFACT_CACHE",
      "Plan bundle contains controller-cache actions without canonical artifact metadata bindings.",
      {
        softwareIds: [
          ...new Set(
            unboundControllerCacheItems.map((item) => item.softwareId),
          ),
        ].sort(),
      },
    );
  }
  return {
    ...prepared,
    planBytes,
    planSha256: sha256(planBytes),
  };
}

function validatePrepareFiles(files, runtime) {
  const {
    profilePath,
    identityReceiptPath,
    preflightReceiptPath,
    schedulePath,
    planPath,
  } = files;
  const profileBytes = readFileSync(profilePath);
  const identityReceiptBytes = readFileSync(identityReceiptPath);
  const preflightReceiptBytes = readFileSync(preflightReceiptPath);
  const scheduleBytes = readFileSync(schedulePath);
  const receipt = parseJson(identityReceiptBytes, "target identity receipt");
  const preflightReceipt = parseJson(
    preflightReceiptBytes,
    "preflight receipt",
  );
  const schedule = parseJson(scheduleBytes, "installation schedule");
  validateSchedule(schedule);
  assertJournalSafe(preflightReceipt, "preflight receipt");
  const preflightSha256 = sha256(JSON.stringify(preflightReceipt));
  if (preflightSha256 !== schedule.preflightSha256) {
    throw new Error("Preflight receipt digest does not match the schedule.");
  }
  const identity = validateIdentityReceipt(receipt);
  if (
    schedule.machineExecutionIdentitySha256 !==
    identity.machineExecutionIdentitySha256
  ) {
    throw new Error(
      "Installation schedule machine execution identity binding mismatch.",
    );
  }
  validatePreflightReceipt(preflightReceipt, {
    profileSha256: sha256(profileBytes),
    targetIdentitySha256: identity.targetIdentitySha256,
    machineExecutionIdentitySha256:
      identity.machineExecutionIdentitySha256,
    identityFileSha256: receipt.identityFileSha256,
    sshConfigSha256: receipt.sshConfigSha256,
    knownHostsSha256: receipt.knownHostsSha256,
    platform: identity.platform,
    initialRoutes: schedule.initialRoutes,
  });
  const expectedReceiptPath = join(
    runtime.homeDirectory,
    ".dawn-forge",
    "targets",
    identity.alias.toLowerCase(),
    "identity.json",
  );
  if (!samePath(identityReceiptPath, expectedReceiptPath)) {
    throw new Error(
      `Target identity receipt is not canonical: expected ${expectedReceiptPath}.`,
    );
  }
  const sshConfigPath = resolveRequiredPath(
    receipt.sshConfigPath,
    "identityReceipt.sshConfigPath",
  );
  const sshConfigBytes = readFileSync(sshConfigPath);
  if (sha256(sshConfigBytes) !== receipt.sshConfigSha256) {
    throw new Error("Finalized SSH config digest mismatch.");
  }
  const knownHostsPath = resolveRequiredPath(
    receipt.knownHostsPath,
    "identityReceipt.knownHostsPath",
  );
  const knownHostsBytes = readFileSync(knownHostsPath);
  if (sha256(knownHostsBytes) !== receipt.knownHostsSha256) {
    throw new Error("Controlled known_hosts digest mismatch.");
  }
  const identityFile = resolveRequiredPath(
    receipt.identityFile,
    "identityReceipt.identityFile",
  );
  const identityFileBytes = readFileSync(identityFile);
  if (sha256(identityFileBytes) !== receipt.identityFileSha256) {
    throw new Error("Finalized management identity file digest mismatch.");
  }
  const managedBlock = extractManagedAliasBlock(
    sshConfigBytes.toString("utf8"),
    identity.alias,
  );
  return {
    alias: identity.alias,
    platform: identity.platform,
    targetIdentitySha256: identity.targetIdentitySha256,
    machineExecutionIdentitySha256:
      identity.machineExecutionIdentitySha256,
    profilePath,
    profileSha256: sha256(profileBytes),
    identityReceiptPath,
    identityReceiptSha256: sha256(identityReceiptBytes),
    preflightReceiptPath,
    preflightReceiptFileSha256: sha256(preflightReceiptBytes),
    preflightSha256,
    preflightObservedAt: preflightReceipt.observedAt,
    schedulePath,
    scheduleFileSha256: sha256(scheduleBytes),
    schedule,
    sshConfigPath,
    sshConfigSha256: receipt.sshConfigSha256,
    knownHostsPath,
    knownHostsSha256: receipt.knownHostsSha256,
    identityFile,
    identityFileSha256: receipt.identityFileSha256,
    keyFingerprint: receipt.keyFingerprint,
    managedBlockSha256: sha256(managedBlock),
    profileBytes,
    identityReceiptBytes,
    preflightReceiptBytes,
    scheduleBytes,
    planBytes: planPath === null ? null : readFileSync(planPath),
    planSha256:
      planPath === null ? null : sha256(readFileSync(planPath)),
  };
}

function validateIdentityReceipt(receipt) {
  if (!isPlainObject(receipt)) {
    throw new TypeError("Target identity receipt must be an object.");
  }
  if (receipt.schemaVersion !== 1 || receipt.finalized !== true) {
    throw new Error("Target identity receipt is not finalized.");
  }
  if (!aliasPattern.test(receipt.alias ?? "")) {
    throw new TypeError("Target identity receipt alias is invalid.");
  }
  if (!allowedPlatforms.has(receipt.platform)) {
    throw new TypeError("Target identity receipt platform is invalid.");
  }
  if (
    !digestPattern.test(receipt.targetIdentitySha256 ?? "") ||
    !digestPattern.test(receipt.machineExecutionIdentitySha256 ?? "")
  ) {
    throw new TypeError("Target identity receipt digest is invalid.");
  }
  for (const key of [
    "sshConfigSha256",
    "knownHostsSha256",
    "identityFileSha256",
  ]) {
    if (!digestPattern.test(receipt[key] ?? "")) {
      throw new TypeError(`Target identity receipt ${key} is invalid.`);
    }
  }
  if (
    typeof receipt.keyFingerprint !== "string" ||
    !receipt.keyFingerprint.startsWith("SHA256:")
  ) {
    throw new TypeError("Target management key fingerprint is invalid.");
  }
  if (!isPlainObject(receipt.identity)) {
    throw new TypeError("Target identity details are missing.");
  }
  for (const key of ["user", "os", "architecture", "machineId"]) {
    if (
      typeof receipt.identity[key] !== "string" ||
      receipt.identity[key].length === 0
    ) {
      throw new TypeError(`Target identity ${key} is invalid.`);
    }
  }
  if (
    !Array.isArray(receipt.hostKeyFingerprints) ||
    receipt.hostKeyFingerprints.length === 0 ||
    receipt.hostKeyFingerprints.some(
      (value) => typeof value !== "string" || !value.startsWith("SHA256:"),
    )
  ) {
    throw new TypeError("Target host-key fingerprints are invalid.");
  }
  const actualTargetIdentitySha256 = targetIdentityDigest({
    platform: receipt.platform,
    user: receipt.identity.user,
    os: receipt.identity.os,
    architecture: receipt.identity.architecture,
    machineId: receipt.identity.machineId,
    hostKeyFingerprints: receipt.hostKeyFingerprints,
  });
  const actualMachineExecutionIdentitySha256 =
    machineExecutionIdentityDigest({
      platform: receipt.platform,
      machineId: receipt.identity.machineId,
      hostKeyFingerprints: receipt.hostKeyFingerprints,
    });
  if (
    actualTargetIdentitySha256 !== receipt.targetIdentitySha256 ||
    actualMachineExecutionIdentitySha256 !==
      receipt.machineExecutionIdentitySha256
  ) {
    throw new Error("Target identity receipt digest mismatch.");
  }
  return {
    alias: receipt.alias,
    platform: receipt.platform,
    targetIdentitySha256: receipt.targetIdentitySha256,
    machineExecutionIdentitySha256:
      receipt.machineExecutionIdentitySha256,
  };
}

function validatePreflightReceipt(receipt, expected) {
  if (
    !isPlainObject(receipt) ||
    receipt.schemaVersion !== 1 ||
    receipt.protocol !== "dawn-forge-preflight-v1" ||
    receipt.profileSha256 !== expected.profileSha256 ||
    receipt.targetIdentitySha256 !== expected.targetIdentitySha256 ||
    receipt.machineExecutionIdentitySha256 !==
      expected.machineExecutionIdentitySha256 ||
    receipt.sshTrust?.identityFileSha256 !==
      expected.identityFileSha256 ||
    receipt.sshTrust?.sshConfigSha256 !== expected.sshConfigSha256 ||
    receipt.sshTrust?.knownHostsSha256 !== expected.knownHostsSha256 ||
    receipt.target?.platform !== expected.platform ||
    !isPlainObject(receipt.initialRoutes) ||
    receipt.initialRoutes.controller !== expected.initialRoutes.controller ||
    receipt.initialRoutes.target !== expected.initialRoutes.target
  ) {
    throw new Error("Preflight receipt binding does not match this run.");
  }
  if (
    typeof receipt.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
      receipt.observedAt,
    ) ||
    !Number.isFinite(Date.parse(receipt.observedAt))
  ) {
    throw new TypeError("Preflight receipt timestamp is invalid.");
  }
}

function validateSchedule(schedule) {
  if (!isPlainObject(schedule) || schedule.schemaVersion !== 2) {
    throw new TypeError("Unsupported installation schedule.");
  }
  if (!digestPattern.test(schedule.scheduleSha256 ?? "")) {
    throw new TypeError("Installation schedule digest is invalid.");
  }
  if (
    !digestPattern.test(
      schedule.machineExecutionIdentitySha256 ?? "",
    )
  ) {
    throw new TypeError(
      "Installation schedule machine execution identity is invalid.",
    );
  }
  const payload = {
    schemaVersion: schedule.schemaVersion,
    preflightSha256: schedule.preflightSha256,
    machineExecutionIdentitySha256:
      schedule.machineExecutionIdentitySha256,
    maxItemsPerBatch: schedule.maxItemsPerBatch,
    initialRoutes: schedule.initialRoutes,
    routeOrder: schedule.routeOrder,
    batches: schedule.batches,
  };
  if (sha256(JSON.stringify(payload)) !== schedule.scheduleSha256) {
    throw new Error("Installation schedule digest mismatch.");
  }
  if (!digestPattern.test(schedule.preflightSha256 ?? "")) {
    throw new TypeError("Installation schedule preflight digest is invalid.");
  }
  if (
    !isPlainObject(schedule.initialRoutes) ||
    !["controller", "target"].every((location) =>
      ["direct", "clash"].includes(schedule.initialRoutes[location]),
    )
  ) {
    throw new TypeError("Installation schedule initial routes are invalid.");
  }
  if (!Array.isArray(schedule.batches) || schedule.batches.length === 0) {
    throw new TypeError("Installation schedule has no batches.");
  }
  const batchIds = new Set();
  const softwareIds = new Set();
  for (const batch of schedule.batches) {
    if (
      !isPlainObject(batch) ||
      !idPattern.test(batch.batchId ?? "") ||
      batchIds.has(batch.batchId) ||
      !allowedRoutes.has(batch.route) ||
      !["automated", "manual-receipt"].includes(batch.executionMode) ||
      !["controller", "target", "none"].includes(batch.networkLocation) ||
      !Array.isArray(batch.items) ||
      batch.items.length < 1 ||
      batch.items.length > 3
    ) {
      throw new TypeError("Installation schedule batch is invalid.");
    }
    batchIds.add(batch.batchId);
    for (const item of batch.items) {
      if (
        !isPlainObject(item) ||
        !idPattern.test(item.softwareId ?? "") ||
        softwareIds.has(item.softwareId) ||
        !Array.isArray(item.dependsOn) ||
        typeof item.package !== "string" ||
        item.package.startsWith("-") ||
        item.package.includes("..") ||
        !/^[A-Za-z0-9@+._/-]{1,200}$/.test(item.package) ||
        typeof item.version !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9.+_~^-]{0,79}$/.test(item.version)
      ) {
        throw new TypeError("Installation schedule item is invalid.");
      }
      softwareIds.add(item.softwareId);
    }
  }
}

function createBinding(prepared, paths) {
  return {
    schemaVersion: 1,
    alias: prepared.alias.toLowerCase(),
    platform: prepared.platform,
    targetIdentitySha256: prepared.targetIdentitySha256,
    machineExecutionIdentitySha256:
      prepared.machineExecutionIdentitySha256,
    identityReceiptPath: comparablePath(prepared.identityReceiptPath),
    identityReceiptSha256: prepared.identityReceiptSha256,
    identitySnapshotPath: comparablePath(prepared.identitySnapshotPath),
    profilePath: comparablePath(prepared.profilePath),
    profileSha256: prepared.profileSha256,
    preflightReceiptPath: comparablePath(prepared.preflightReceiptPath),
    preflightReceiptFileSha256: prepared.preflightReceiptFileSha256,
    preflightSha256: prepared.preflightSha256,
    schedulePath: comparablePath(prepared.schedulePath),
    scheduleFileSha256: prepared.scheduleFileSha256,
    scheduleSha256: prepared.schedule.scheduleSha256,
    planPath:
      prepared.planPath === null
        ? null
        : comparablePath(prepared.planPath),
    planSha256: prepared.planSha256,
    sshConfigPath: comparablePath(prepared.sshConfigPath),
    sshConfigSha256: prepared.sshConfigSha256,
    managedBlockSha256: prepared.managedBlockSha256,
    knownHostsPath: comparablePath(prepared.knownHostsPath),
    knownHostsSha256: prepared.knownHostsSha256,
    identityFile: comparablePath(prepared.identityFile),
    identityFileSha256: prepared.identityFileSha256,
    keyFingerprint: prepared.keyFingerprint,
    cacheRoot: comparablePath(paths.cacheRoot),
  };
}

function createRunSeedSha256(prepared) {
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      alias: prepared.alias.toLowerCase(),
      platform: prepared.platform,
      targetIdentitySha256: prepared.targetIdentitySha256,
      machineExecutionIdentitySha256:
        prepared.machineExecutionIdentitySha256,
      identityReceiptSha256: prepared.identityReceiptSha256,
      profileSha256: prepared.profileSha256,
      preflightSha256: prepared.preflightSha256,
      scheduleSha256: prepared.schedule.scheduleSha256,
      sshConfigSha256: prepared.sshConfigSha256,
      knownHostsSha256: prepared.knownHostsSha256,
      identityFileSha256: prepared.identityFileSha256,
      keyFingerprint: prepared.keyFingerprint,
      planSha256: prepared.planSha256,
    }),
  );
}

function publishInputSnapshots(prepared) {
  const snapshots = [
    [prepared.profilePath, prepared.profileBytes, prepared.profileSha256],
    [
      prepared.identitySnapshotPath,
      prepared.identityReceiptBytes,
      prepared.identityReceiptSha256,
    ],
    [
      prepared.preflightReceiptPath,
      prepared.preflightReceiptBytes,
      prepared.preflightReceiptFileSha256,
    ],
    [
      prepared.schedulePath,
      prepared.scheduleBytes,
      prepared.scheduleFileSha256,
    ],
    ...(prepared.planPath === null
      ? []
      : [[prepared.planPath, prepared.planBytes, prepared.planSha256]]),
  ];
  for (const [path, bytes, expectedSha256] of snapshots) {
    if (existsSync(path)) {
      if (sha256(readFileSync(path)) !== expectedSha256) {
        throw new Error(`Canonical run input snapshot drift detected: ${path}`);
      }
      continue;
    }
    atomicPublishBytesExclusive(path, bytes);
  }
}

function canonicalPaths(
  homeDirectory,
  alias,
  machineExecutionIdentitySha256,
) {
  const root = join(homeDirectory, ".dawn-forge");
  const targetDirectory = join(root, "targets", alias.toLowerCase());
  const identityDirectory = join(
    root,
    "targets-by-identity",
    machineExecutionIdentitySha256,
  );
  return {
    root,
    cacheRoot: join(root, "artifacts"),
    targetDirectory,
    runsDirectory: join(targetDirectory, "runs"),
    activeRunPath: join(targetDirectory, "active-run.json"),
    prepareLockPath: join(targetDirectory, ".prepare-run.lock"),
    identityDirectory,
    identityActiveRunPath: join(identityDirectory, "active.json"),
    identityPrepareLockPath: join(identityDirectory, ".prepare-run.lock"),
  };
}

function createRunId(alias, bindingSha256) {
  return `run-${alias.toLowerCase()}-${bindingSha256.slice(0, 32)}`;
}

function createStateRunKey(binding) {
  return sha256(
    JSON.stringify({
      scheduleSha256: binding.scheduleSha256,
      preflightSha256: binding.preflightSha256,
      profileSha256: binding.profileSha256,
      targetIdentitySha256: binding.targetIdentitySha256,
      platform: binding.platform,
    }),
  ).slice(0, 32);
}

function parseRunId(runId) {
  const match = runIdPattern.exec(runId ?? "");
  if (match === null) throw new TypeError("runId is invalid.");
  return { runId, storageAlias: match[1].toLowerCase() };
}

function loadCanonicalManifest(runId, homeDirectory) {
  const parsed = parseRunId(runId);
  return loadManifestByPath(
    join(
      homeDirectory,
      ".dawn-forge",
      "targets",
      parsed.storageAlias,
      "runs",
      runId,
      "manifest.json",
    ),
  );
}

function loadManifestByPath(manifestPath) {
  const manifest = parseJsonFile(manifestPath, "installation run manifest");
  validateManifest(manifest, manifestPath);
  return manifest;
}

function validateManifest(manifest, manifestPath) {
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 1) {
    throw new TypeError("Unsupported installation run manifest.");
  }
  assertAllowedKeys(
    manifest,
    [
      "schemaVersion",
      "runId",
      "bindingSha256",
      "revision",
      "createdAt",
      "updatedAt",
      "startedAt",
      "status",
      "target",
      "profile",
      "preflight",
      "schedule",
      "plan",
      "ssh",
      "state",
      "cache",
      "routes",
      "pendingGate",
      "cancellation",
      "lastAdvance",
      "manifestSha256",
    ],
    "manifest",
  );
  assertAllowedKeys(
    manifest.target,
    [
      "alias",
      "storageAlias",
      "platform",
      "targetIdentitySha256",
      "machineExecutionIdentitySha256",
      "identityReceiptPath",
      "identityReceiptSha256",
      "identitySnapshotPath",
    ],
    "manifest.target",
  );
  assertAllowedKeys(manifest.profile, ["path", "sha256"], "manifest.profile");
  assertAllowedKeys(
    manifest.preflight,
    ["path", "fileSha256", "preflightSha256"],
    "manifest.preflight",
  );
  assertAllowedKeys(
    manifest.schedule,
    ["path", "fileSha256", "scheduleSha256"],
    "manifest.schedule",
  );
  if (manifest.plan !== null) {
    assertAllowedKeys(manifest.plan, ["path", "sha256"], "manifest.plan");
    if (!digestPattern.test(manifest.plan.sha256 ?? "")) {
      throw new TypeError("Installation plan snapshot binding is invalid.");
    }
  }
  assertAllowedKeys(
    manifest.ssh,
    [
      "configPath",
      "configSha256",
      "managedBlockSha256",
      "knownHostsPath",
      "knownHostsSha256",
      "identityFile",
      "identityFileSha256",
      "keyFingerprint",
    ],
    "manifest.ssh",
  );
  assertAllowedKeys(
    manifest.state,
    ["directory", "identity"],
    "manifest.state",
  );
  assertAllowedKeys(
    manifest.state.identity,
    [
      "statePath",
      "runId",
      "scheduleSha256",
      "profileSha256",
      "targetIdentitySha256",
    ],
    "manifest.state.identity",
  );
  assertAllowedKeys(manifest.cache, ["root"], "manifest.cache");
  assertAllowedKeys(
    manifest.routes,
    ["controller", "target"],
    "manifest.routes",
  );
  if (
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 1 ||
    (manifest.startedAt !== null &&
      (typeof manifest.startedAt !== "string" ||
        !Number.isFinite(Date.parse(manifest.startedAt)))) ||
    !["direct", "clash"].includes(manifest.routes.controller) ||
    !["direct", "clash"].includes(manifest.routes.target)
  ) {
    throw new TypeError("Installation run mutable metadata is invalid.");
  }
  validateManifestGate(manifest.pendingGate);
  validateManifestCancellation(manifest.cancellation);
  validateManifestAdvance(manifest.lastAdvance);
  if (!digestPattern.test(manifest.manifestSha256 ?? "")) {
    throw new TypeError("Installation run manifest digest is invalid.");
  }
  const { manifestSha256, ...payload } = manifest;
  if (sha256(JSON.stringify(payload)) !== manifestSha256) {
    throw new Error("Installation run manifest digest mismatch.");
  }
  const parsedRunId = parseRunId(manifest.runId);
  if (
    !aliasPattern.test(manifest.target?.alias ?? "") ||
    !allowedPlatforms.has(manifest.target?.platform) ||
    !digestPattern.test(manifest.target?.targetIdentitySha256 ?? "") ||
    !digestPattern.test(
      manifest.target?.machineExecutionIdentitySha256 ?? "",
    ) ||
    !digestPattern.test(manifest.target?.identityReceiptSha256 ?? "") ||
    !digestPattern.test(manifest.bindingSha256 ?? "") ||
    !digestPattern.test(manifest.profile?.sha256 ?? "") ||
    !digestPattern.test(manifest.preflight?.fileSha256 ?? "") ||
    !digestPattern.test(manifest.preflight?.preflightSha256 ?? "") ||
    !digestPattern.test(manifest.schedule?.scheduleSha256 ?? "") ||
    !digestPattern.test(manifest.schedule?.fileSha256 ?? "") ||
    !digestPattern.test(manifest.ssh?.configSha256 ?? "") ||
    !digestPattern.test(manifest.ssh?.managedBlockSha256 ?? "") ||
    !digestPattern.test(manifest.ssh?.knownHostsSha256 ?? "") ||
    !digestPattern.test(manifest.ssh?.identityFileSha256 ?? "") ||
    typeof manifest.ssh?.keyFingerprint !== "string" ||
    !manifest.ssh.keyFingerprint.startsWith("SHA256:") ||
    !isPlainObject(manifest.state?.identity)
  ) {
    throw new TypeError("Installation run manifest binding is invalid.");
  }
  const expectedPath = join(
    dirname(dirname(manifestPath)),
    manifest.runId,
    "manifest.json",
  );
  if (!samePath(manifestPath, expectedPath)) {
    throw new Error("Installation run manifest path does not match its runId.");
  }
  if (
    manifest.target.storageAlias !== parsedRunId.storageAlias ||
    manifest.target.alias.toLowerCase() !== parsedRunId.storageAlias
  ) {
    throw new Error("Installation run target alias binding is invalid.");
  }
  const expectedStateRunKey = createStateRunKey({
    scheduleSha256: manifest.schedule.scheduleSha256,
    preflightSha256: manifest.preflight.preflightSha256,
    profileSha256: manifest.profile.sha256,
    targetIdentitySha256: manifest.target.targetIdentitySha256,
    platform: manifest.target.platform,
  });
  const expectedStatePath = join(
    manifest.state.directory,
    `${expectedStateRunKey}.json`,
  );
  if (
    !samePath(manifest.state.identity.statePath, expectedStatePath) ||
    manifest.state.identity.runId !== `run-${expectedStateRunKey}` ||
    manifest.state.identity.scheduleSha256 !==
      manifest.schedule.scheduleSha256 ||
    manifest.state.identity.profileSha256 !== manifest.profile.sha256 ||
    manifest.state.identity.targetIdentitySha256 !==
      manifest.target.targetIdentitySha256 ||
    !samePath(
      manifest.state.directory,
      join(dirname(manifestPath), "state"),
    )
  ) {
    throw new Error("Installation state path binding is invalid.");
  }
  const homeRoot = dirname(
    dirname(dirname(dirname(dirname(dirname(manifestPath))))),
  );
  const expectedReceiptPath = join(
    homeRoot,
    ".dawn-forge",
    "targets",
    manifest.target.storageAlias,
    "identity.json",
  );
  if (
    !samePath(manifest.cache.root, join(homeRoot, ".dawn-forge", "artifacts")) ||
    !samePath(manifest.target.identityReceiptPath, expectedReceiptPath)
  ) {
    throw new Error("Installation canonical path binding is invalid.");
  }
  const inputsDirectory = join(dirname(manifestPath), "inputs");
  if (
    !samePath(
      manifest.target.identitySnapshotPath,
      join(inputsDirectory, "identity.json"),
    ) ||
    !samePath(manifest.profile.path, join(inputsDirectory, "profile.json")) ||
    !samePath(
      manifest.preflight.path,
      join(inputsDirectory, "preflight.json"),
    ) ||
    !samePath(manifest.schedule.path, join(inputsDirectory, "schedule.json")) ||
    (manifest.plan !== null &&
      !samePath(manifest.plan.path, join(inputsDirectory, "plan.json")))
  ) {
    throw new Error("Canonical run input snapshot path binding is invalid.");
  }
  const expectedBinding = bindingFromManifest(manifest);
  const expectedBindingSha256 = sha256(JSON.stringify(expectedBinding));
  const expectedRunSeedSha256 = createRunSeedSha256({
    alias: manifest.target.alias,
    platform: manifest.target.platform,
    targetIdentitySha256: manifest.target.targetIdentitySha256,
    machineExecutionIdentitySha256:
      manifest.target.machineExecutionIdentitySha256,
    identityReceiptSha256: manifest.target.identityReceiptSha256,
    profileSha256: manifest.profile.sha256,
    preflightSha256: manifest.preflight.preflightSha256,
    schedule: { scheduleSha256: manifest.schedule.scheduleSha256 },
    sshConfigSha256: manifest.ssh.configSha256,
    knownHostsSha256: manifest.ssh.knownHostsSha256,
    identityFileSha256: manifest.ssh.identityFileSha256,
    keyFingerprint: manifest.ssh.keyFingerprint,
    planSha256: manifest.plan?.sha256 ?? null,
  });
  if (
    manifest.bindingSha256 !== expectedBindingSha256 ||
    manifest.runId !==
      createRunId(manifest.target.alias, expectedRunSeedSha256)
  ) {
    throw new Error("Installation run immutable binding digest mismatch.");
  }
  assertManifestSafe(manifest);
}

function validateManifestGate(gate) {
  if (gate === null) return;
  if (!isPlainObject(gate)) {
    throw new TypeError("manifest.pendingGate is invalid.");
  }
  if (gate.type === "route-switch") {
    assertAllowedKeys(
      gate,
      [
        "type",
        "gateToken",
        "batchId",
        "location",
        "requiredRoute",
        "issuedAt",
      ],
      "manifest.pendingGate",
    );
    if (
      !gateTokenPattern.test(gate.gateToken ?? "") ||
      !idPattern.test(gate.batchId ?? "") ||
      !["controller", "target"].includes(gate.location) ||
      !["direct", "clash"].includes(gate.requiredRoute)
    ) {
      throw new TypeError("Route gate binding is invalid.");
    }
    return;
  }
  if (gate.type === "manual-complete") {
    assertAllowedKeys(
      gate,
      [
        "type",
        "batchId",
        "softwareIds",
        "reasons",
        "issuedAt",
        "verificationReceiptPath",
        "verificationReceiptSha256",
        "verifiedAt",
      ],
      "manifest.pendingGate",
    );
    if (
      !idPattern.test(gate.batchId ?? "") ||
      !Array.isArray(gate.softwareIds) ||
      gate.softwareIds.length < 1 ||
      gate.softwareIds.some((softwareId) => !idPattern.test(softwareId)) ||
      !Array.isArray(gate.reasons) ||
      gate.reasons.some(
        (reason) =>
          ![
            "manual-receipt",
            "requires-admin",
            "requires-gui",
            "requires-restart",
          ].includes(reason),
      ) ||
      ((gate.verificationReceiptPath !== undefined ||
        gate.verificationReceiptSha256 !== undefined ||
        gate.verifiedAt !== undefined) &&
        (typeof gate.verificationReceiptPath !== "string" ||
          !digestPattern.test(gate.verificationReceiptSha256 ?? "") ||
          typeof gate.verifiedAt !== "string"))
    ) {
      throw new TypeError("Manual gate binding is invalid.");
    }
    return;
  }
  throw new TypeError("manifest.pendingGate type is invalid.");
}

function validateManifestCancellation(cancellation) {
  if (cancellation === null) return;
  assertAllowedKeys(
    cancellation,
    [
      "requestedAt",
      "status",
      "batchId",
      "attemptId",
      "ownedProcessToken",
      "confirmedAt",
    ],
    "manifest.cancellation",
  );
  if (!["pending", "confirmed"].includes(cancellation.status)) {
    throw new TypeError("manifest.cancellation status is invalid.");
  }
}

function validateManifestAdvance(lastAdvance) {
  if (lastAdvance === null) return;
  assertAllowedKeys(
    lastAdvance,
    [
      "batchId",
      "observedStateRevision",
      "observedStatus",
      "finishedAt",
    ],
    "manifest.lastAdvance",
  );
  if (
    !idPattern.test(lastAdvance.batchId ?? "") ||
    !Number.isSafeInteger(lastAdvance.observedStateRevision) ||
    lastAdvance.observedStateRevision < 1
  ) {
    throw new TypeError("manifest.lastAdvance is invalid.");
  }
}

function bindingFromManifest(manifest) {
  return {
    schemaVersion: 1,
    alias: manifest.target.storageAlias,
    platform: manifest.target.platform,
    targetIdentitySha256: manifest.target.targetIdentitySha256,
    machineExecutionIdentitySha256:
      manifest.target.machineExecutionIdentitySha256,
    identityReceiptPath: comparablePath(
      manifest.target.identityReceiptPath,
    ),
    identityReceiptSha256: manifest.target.identityReceiptSha256,
    identitySnapshotPath: comparablePath(
      manifest.target.identitySnapshotPath,
    ),
    profilePath: comparablePath(manifest.profile.path),
    profileSha256: manifest.profile.sha256,
    preflightReceiptPath: comparablePath(manifest.preflight.path),
    preflightReceiptFileSha256: manifest.preflight.fileSha256,
    preflightSha256: manifest.preflight.preflightSha256,
    schedulePath: comparablePath(manifest.schedule.path),
    scheduleFileSha256: manifest.schedule.fileSha256,
    scheduleSha256: manifest.schedule.scheduleSha256,
    planPath:
      manifest.plan === null ? null : comparablePath(manifest.plan.path),
    planSha256: manifest.plan?.sha256 ?? null,
    sshConfigPath: comparablePath(manifest.ssh.configPath),
    sshConfigSha256: manifest.ssh.configSha256,
    managedBlockSha256: manifest.ssh.managedBlockSha256,
    knownHostsPath: comparablePath(manifest.ssh.knownHostsPath),
    knownHostsSha256: manifest.ssh.knownHostsSha256,
    identityFile: comparablePath(manifest.ssh.identityFile),
    identityFileSha256: manifest.ssh.identityFileSha256,
    keyFingerprint: manifest.ssh.keyFingerprint,
    cacheRoot: comparablePath(manifest.cache.root),
  };
}

function assertManifestBinding(manifest, expected) {
  if (
    manifest.runId !== expected.runId ||
    manifest.bindingSha256 !== expected.bindingSha256 ||
    !samePath(
      join(
        dirname(dirname(expected.manifestPath)),
        manifest.runId,
        "manifest.json",
      ),
      expected.manifestPath,
    )
  ) {
    throw new Error("Existing installation run manifest binding conflict.");
  }
}

function verifyBoundSources(manifest) {
  const profileBytes = readFileSync(manifest.profile.path);
  if (sha256(profileBytes) !== manifest.profile.sha256) {
    throw new Error("Profile digest drift detected; refusing to advance.");
  }
  const scheduleBytes = readFileSync(manifest.schedule.path);
  if (sha256(scheduleBytes) !== manifest.schedule.fileSha256) {
    throw new Error("Schedule file digest drift detected; refusing to advance.");
  }
  const schedule = parseJson(scheduleBytes, "installation schedule");
  validateSchedule(schedule);
  if (schedule.scheduleSha256 !== manifest.schedule.scheduleSha256) {
    throw new Error("Schedule binding drift detected; refusing to advance.");
  }
  const preflightBytes = readFileSync(manifest.preflight.path);
  if (sha256(preflightBytes) !== manifest.preflight.fileSha256) {
    throw new Error("Preflight receipt file drift detected; refusing to advance.");
  }
  const preflightReceipt = parseJson(preflightBytes, "preflight receipt");
  assertJournalSafe(preflightReceipt, "preflight receipt");
  if (
    sha256(JSON.stringify(preflightReceipt)) !==
      manifest.preflight.preflightSha256 ||
    schedule.preflightSha256 !== manifest.preflight.preflightSha256
  ) {
    throw new Error("Preflight receipt binding drift detected.");
  }
  const receiptBytes = readFileSync(manifest.target.identityReceiptPath);
  if (sha256(receiptBytes) !== manifest.target.identityReceiptSha256) {
    throw new Error(
      "Target identity receipt drift detected; refusing to advance.",
    );
  }
  const identitySnapshotBytes = readFileSync(
    manifest.target.identitySnapshotPath,
  );
  if (
    sha256(identitySnapshotBytes) !== manifest.target.identityReceiptSha256 ||
    sha256(identitySnapshotBytes) !== sha256(receiptBytes)
  ) {
    throw new Error("Canonical target identity snapshot drift detected.");
  }
  const receipt = parseJson(receiptBytes, "target identity receipt");
  const identity = validateIdentityReceipt(receipt);
  if (
    identity.alias !== manifest.target.alias ||
    identity.platform !== manifest.target.platform ||
    identity.targetIdentitySha256 !== manifest.target.targetIdentitySha256 ||
    identity.machineExecutionIdentitySha256 !==
      manifest.target.machineExecutionIdentitySha256
  ) {
    throw new Error("Target identity binding drift detected.");
  }
  validatePreflightReceipt(preflightReceipt, {
    profileSha256: manifest.profile.sha256,
    targetIdentitySha256: manifest.target.targetIdentitySha256,
    machineExecutionIdentitySha256:
      manifest.target.machineExecutionIdentitySha256,
    identityFileSha256: manifest.ssh.identityFileSha256,
    sshConfigSha256: manifest.ssh.configSha256,
    knownHostsSha256: manifest.ssh.knownHostsSha256,
    platform: manifest.target.platform,
    initialRoutes: schedule.initialRoutes,
  });
  const sshConfigBytes = readFileSync(manifest.ssh.configPath);
  if (sha256(sshConfigBytes) !== manifest.ssh.configSha256) {
    throw new Error("Finalized SSH config digest drift detected.");
  }
  const managedBlock = extractManagedAliasBlock(
    sshConfigBytes.toString("utf8"),
    manifest.target.alias,
  );
  if (sha256(managedBlock) !== manifest.ssh.managedBlockSha256) {
    throw new Error("Finalized SSH alias binding drift detected.");
  }
  if (
    sha256(readFileSync(manifest.ssh.knownHostsPath)) !==
    manifest.ssh.knownHostsSha256
  ) {
    throw new Error("Controlled known_hosts digest drift detected.");
  }
  if (
    !existsSync(manifest.ssh.identityFile) ||
    sha256(readFileSync(manifest.ssh.identityFile)) !==
      manifest.ssh.identityFileSha256
  ) {
    throw new Error("Finalized management identity file digest drift detected.");
  }
  if (
    manifest.plan !== null &&
    sha256(readFileSync(manifest.plan.path)) !== manifest.plan.sha256
  ) {
    throw new Error("Canonical plan snapshot digest drift detected.");
  }
  return { schedule, preflightReceipt };
}

function preflightFreshness(observedAt, runtime) {
  const observedMs = Date.parse(observedAt);
  const nowValue = runtime.now();
  const nowMs =
    nowValue instanceof Date
      ? nowValue.getTime()
      : Date.parse(String(nowValue));
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs)) {
    throw new TypeError("Cannot evaluate preflight receipt freshness.");
  }
  const ageMs = nowMs - observedMs;
  const expiresAt = new Date(
    observedMs + runtime.maxPreflightAgeMs,
  ).toISOString();
  if (ageMs < -maxFutureClockSkewMs) {
    return {
      fresh: false,
      reason: "preflight-clock-skew",
      observedAt,
      expiresAt,
      maxAgeMs: runtime.maxPreflightAgeMs,
    };
  }
  if (ageMs > runtime.maxPreflightAgeMs) {
    return {
      fresh: false,
      reason: "preflight-expired",
      observedAt,
      expiresAt,
      maxAgeMs: runtime.maxPreflightAgeMs,
    };
  }
  return {
    fresh: true,
    observedAt,
    expiresAt,
    maxAgeMs: runtime.maxPreflightAgeMs,
  };
}

function replanRequiredResult(freshness) {
  return {
    kind: "replan-required",
    reason: freshness.reason,
    observedAt: freshness.observedAt,
    expiresAt: freshness.expiresAt,
    maxAgeMs: freshness.maxAgeMs,
    message:
      "受控 preflight 证据已过期或控制机时间异常；必须重新生成计划，不会自动联网刷新。",
  };
}

function selectNextBatch(schedule, state, stateApi) {
  for (const batch of [...schedule.batches].sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    const stateItems = state.items.filter(
      (item) => item.batchId === batch.batchId,
    );
    if (stateItems.length !== batch.items.length) {
      return {
        kind: "blocked",
        details: {
          reason: "state-schedule-mismatch",
          batchId: batch.batchId,
        },
      };
    }
    if (
      stateItems.every(
        (item) =>
          item.status === "completed" &&
          item.phases?.verify?.status === "succeeded",
      )
    ) {
      continue;
    }
    if (
      stateItems.some(
        (item) =>
          item.status === "failed" ||
          item.phases?.fetch?.status === "failed" ||
          item.phases?.install?.status === "failed" ||
          item.phases?.verify?.status === "failed",
      )
    ) {
      return {
        kind: "blocked",
        details: {
          reason: "failed-batch-requires-review",
          batchId: batch.batchId,
        },
      };
    }
    try {
      stateApi.assertBatchRunnable(state, batch.batchId);
    } catch (error) {
      return {
        kind: "blocked",
        details: {
          reason: "dependency-not-complete",
          batchId: batch.batchId,
          message: error.message,
        },
      };
    }
    return { kind: "runnable", batch };
  }
  return { kind: "completed", details: {} };
}

function requiredRouteGate(manifest, batch, runtime) {
  if (batch.networkLocation === "none" || batch.route === "local") return null;
  const currentRoute = manifest.routes[batch.networkLocation];
  if (currentRoute === batch.route) return null;
  let gate = manifest.pendingGate;
  if (
    gate?.type !== "route-switch" ||
    gate.batchId !== batch.batchId ||
    gate.location !== batch.networkLocation ||
    gate.requiredRoute !== batch.route
  ) {
    gate = {
      type: "route-switch",
      gateToken: createGateToken(manifest, batch, runtime.now()),
      batchId: batch.batchId,
      location: batch.networkLocation,
      requiredRoute: batch.route,
      issuedAt: runtime.now(),
    };
    manifest = updateManifest(manifest, { pendingGate: gate }, runtime);
  }
  return routeGateResult(manifest);
}

function routeGateResult(manifest) {
  return {
    kind: "user-action",
    action: "switch-route",
    stepId: manifest.pendingGate.gateToken,
    runId: manifest.runId,
    batchId: manifest.pendingGate.batchId,
    location: manifest.pendingGate.location,
    requiredRoute: manifest.pendingGate.requiredRoute,
    gateToken: manifest.pendingGate.gateToken,
    message:
      "切换对应位置的网络路由后，仅使用该 gateToken 再次 advance；不会重填 runner 参数。",
  };
}

function consumeRouteGate(manifest, gateToken, runtime) {
  const gate = manifest.pendingGate;
  if (
    gate?.type !== "route-switch" ||
    gate.gateToken !== gateToken
  ) {
    throw new Error("Route gate token does not match the pending user action.");
  }
  return updateManifest(
    manifest,
    {
      routes: {
        ...manifest.routes,
        [gate.location]: gate.requiredRoute,
      },
      pendingGate: null,
    },
    runtime,
  );
}

function manualGateReasons(batch) {
  return [
    ...(batch.executionMode === "manual-receipt"
      ? ["manual-receipt"]
      : []),
    ...(batch.requiresAdmin ? ["requires-admin"] : []),
    ...(batch.requiresGui ? ["requires-gui"] : []),
    ...(batch.requiresRestart ? ["requires-restart"] : []),
  ];
}

function storeManualGate(manifest, batch, reasons, runtime) {
  const existing = manifest.pendingGate;
  if (
    existing?.type === "manual-complete" &&
    existing.batchId === batch.batchId
  ) {
    return manifest;
  }
  return updateManifest(
    manifest,
    {
      startedAt: manifest.startedAt ?? runtime.now(),
      pendingGate: {
        type: "manual-complete",
        batchId: batch.batchId,
        softwareIds: batch.items.map((item) => item.softwareId),
        reasons,
        issuedAt: runtime.now(),
      },
    },
    runtime,
  );
}

function selectManualVerificationAdapter(item, batch, platform) {
  const base = {
    softwareId: item.softwareId,
    package: item.package,
    version: item.version,
  };
  if (batch.requiresRestart) {
    return {
      ...base,
      supported: false,
      reason: "restart-and-replan-required",
    };
  }
  if (platform === "macos") {
    if (item.installer === "brew-formula") {
      return {
        ...base,
        supported: true,
        adapter: "homebrew-formula",
        evidenceType: "cli-version",
      };
    }
    if (item.installer === "brew-cask") {
      return {
        ...base,
        supported: true,
        adapter: "macos-brew-cask",
        evidenceType: "macos-bundle-signature",
      };
    }
    if (item.installer === "homebrew-metadata") {
      return {
        ...base,
        supported: true,
        adapter: "homebrew-installation",
        evidenceType: "cli-version",
      };
    }
    if (
      item.installer === "official-download" &&
      ["clash-verge-rev", "clash-verge"].includes(item.package)
    ) {
      return {
        ...base,
        supported: true,
        adapter: "macos-clash-bundle",
        evidenceType: "macos-bundle-signature",
      };
    }
    if (
      item.installer === "manual" &&
      [
        "command-line-tools",
        "xcode-command-line-tools",
        "clt",
      ].includes(item.package)
    ) {
      return {
        ...base,
        supported: true,
        adapter: "macos-clt-receipt",
        evidenceType: "macos-package-receipt",
      };
    }
    if (item.installer === "npm-global") {
      return {
        ...base,
        supported: true,
        adapter: "npm-global",
        evidenceType: "cli-version",
      };
    }
    if (item.installer === "volta-tool") {
      return {
        ...base,
        supported: true,
        adapter: "volta-tool",
        evidenceType: "cli-version",
      };
    }
  }
  if (
    platform === "windows" &&
    ["winget", "official-download"].includes(item.installer)
  ) {
    return {
      ...base,
      supported: true,
      adapter: "windows-package-receipt",
      evidenceType: "windows-package-receipt",
    };
  }
  return {
    ...base,
    supported: false,
    reason: "user-attestation-does-not-release-dependencies",
  };
}

function normalizeManualVerification(
  verification,
  manifest,
  batch,
  adapters,
  runtime,
) {
  assertJournalSafe(verification, "manual verifier result");
  if (!isPlainObject(verification)) {
    throw new TypeError("Manual verifier result must be an object.");
  }
  assertAllowedKeys(
    verification,
    ["status", "results", "reason"],
    "manual verifier result",
  );
  if (verification.status === "pending") {
    return {
      kind: "manual-pending",
      reason: normalizeReason(verification.reason),
      batchId: batch.batchId,
      releasesDependencies: false,
    };
  }
  if (
    verification.status !== "verified" ||
    !Array.isArray(verification.results)
  ) {
    throw new Error("Manual verifier did not return a controlled result.");
  }
  const adapterById = new Map(
    adapters.map((adapter) => [adapter.softwareId, adapter]),
  );
  const resultsById = new Map();
  for (const result of verification.results) {
    if (!isPlainObject(result)) {
      throw new TypeError("Manual verifier item result must be an object.");
    }
    assertAllowedKeys(
      result,
      [
        "softwareId",
        "adapter",
        "status",
        "observedVersion",
        "evidence",
        "reason",
      ],
      "manual verifier item",
    );
    const expected = adapterById.get(result.softwareId);
    if (
      expected === undefined ||
      result.adapter !== expected.adapter ||
      resultsById.has(result.softwareId)
    ) {
      throw new Error("Manual verifier returned an unbound item.");
    }
    resultsById.set(result.softwareId, result);
  }
  const pending = adapters.filter(
    (adapter) => resultsById.get(adapter.softwareId)?.status !== "verified",
  );
  if (pending.length > 0) {
    return {
      kind: "manual-pending",
      reason: "verification-incomplete",
      batchId: batch.batchId,
      softwareIds: pending.map((adapter) => adapter.softwareId),
      releasesDependencies: false,
    };
  }
  return {
    kind: "verified",
    receipts: adapters.map((adapter) => {
      const result = resultsById.get(adapter.softwareId);
      if (!isPlainObject(result.evidence)) {
        throw new TypeError("Manual verifier evidence must be an object.");
      }
      const observedVersion =
        result.observedVersion === undefined
          ? null
          : String(result.observedVersion);
      if (
        observedVersion !== null &&
        (observedVersion.length < 1 ||
          observedVersion.length > 160 ||
          /[\u0000-\u001f\u007f-\u009f]/u.test(observedVersion))
      ) {
        throw new TypeError("Manual verifier observed version is invalid.");
      }
      const evidence = {
        schemaVersion: 1,
        protocol: "dawn-forge-manual-evidence-v1",
        runId: manifest.runId,
        bindingSha256: manifest.bindingSha256,
        batchId: batch.batchId,
        softwareId: adapter.softwareId,
        adapter: adapter.adapter,
        expectedVersion: adapter.version,
        observedVersion,
        verifiedAt: runtime.now(),
        claims: result.evidence,
      };
      assertJournalSafe(evidence, "manual evidence");
      return {
        softwareId: adapter.softwareId,
        adapter: adapter.adapter,
        evidenceType: adapter.evidenceType,
        evidenceSha256: sha256(JSON.stringify(evidence)),
        ...(observedVersion === null ? {} : { observedVersion }),
      };
    }),
  };
}

function sealManualReceipt(receipt) {
  return {
    ...receipt,
    verificationSha256: sha256(JSON.stringify(receipt)),
  };
}

function validateGeneratedManualReceipt(receipt, manifest, batch) {
  if (!isPlainObject(receipt)) {
    throw new TypeError("Manual verification receipt must be an object.");
  }
  assertAllowedKeys(
    receipt,
    [
      "schemaVersion",
      "protocol",
      "verifiedAt",
      "runId",
      "bindingSha256",
      "batchId",
      "targetIdentitySha256",
      "scheduleSha256",
      "preflightSha256",
      "receipts",
      "verificationSha256",
    ],
    "manual verification receipt",
  );
  const { verificationSha256, ...payload } = receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.protocol !== "dawn-forge-manual-verification-v1" ||
    receipt.runId !== manifest.runId ||
    receipt.bindingSha256 !== manifest.bindingSha256 ||
    receipt.batchId !== batch.batchId ||
    receipt.targetIdentitySha256 !== manifest.target.targetIdentitySha256 ||
    receipt.scheduleSha256 !== manifest.schedule.scheduleSha256 ||
    receipt.preflightSha256 !== manifest.preflight.preflightSha256 ||
    !digestPattern.test(verificationSha256 ?? "") ||
    sha256(JSON.stringify(payload)) !== verificationSha256 ||
    !Array.isArray(receipt.receipts)
  ) {
    throw new Error("Manual verification receipt binding mismatch.");
  }
  assertJournalSafe(receipt, "manual verification receipt");
  const expected = batch.items.map((item) => item.softwareId).sort();
  const actual = receipt.receipts.map((entry) => entry.softwareId).sort();
  if (
    expected.length !== actual.length ||
    expected.some((softwareId, index) => softwareId !== actual[index])
  ) {
    throw new Error("Manual verification receipt software set mismatch.");
  }
  const expectedAdapters = new Map(
    batch.items.map((item) => {
      const adapter = selectManualVerificationAdapter(
        item,
        batch,
        manifest.target.platform,
      );
      return [item.softwareId, adapter];
    }),
  );
  for (const entry of receipt.receipts) {
    if (!isPlainObject(entry)) {
      throw new TypeError("Manual receipt entry must be an object.");
    }
    assertAllowedKeys(
      entry,
      [
        "softwareId",
        "adapter",
        "evidenceType",
        "evidenceSha256",
        "observedVersion",
      ],
      "manual verification receipt entry",
    );
    const expectedAdapter = expectedAdapters.get(entry.softwareId);
    if (
      expectedAdapter?.supported !== true ||
      entry.adapter !== expectedAdapter.adapter ||
      entry.evidenceType !== expectedAdapter.evidenceType ||
      !manualEvidenceTypes.has(entry.evidenceType) ||
      !digestPattern.test(entry.evidenceSha256 ?? "")
    ) {
      throw new TypeError("Manual verification evidence is invalid.");
    }
  }
}

function canonicalManualReceiptPath(manifest, batchId) {
  return join(
    dirname(manifest.state.directory),
    "receipts",
    `${batchId}.json`,
  );
}

function runFixedManualVerification(request) {
  const driver =
    request.target.platform === "macos"
      ? buildMacosManualVerificationDriver(request.adapters)
      : buildWindowsManualVerificationDriver(request.adapters);
  const args = [
    "-F",
    request.ssh.configPath,
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
    `UserKnownHostsFile=${request.ssh.knownHostsPath}`,
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ConnectionAttempts=1",
    request.target.alias,
    ...(request.target.platform === "macos"
      ? ["/bin/sh", "-s"]
      : [
          "powershell.exe",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "-",
        ]),
  ];
  const result = spawnSync("ssh", args, {
    encoding: "utf8",
    input: driver,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      status: "pending",
      reason: "verification-transport-failed",
    };
  }
  return parseManualVerificationProtocol(result.stdout, request.adapters);
}

function buildMacosManualVerificationDriver(adapters) {
  const operations = adapters
    .map((adapter) => {
      const softwareId = shellQuote(adapter.softwareId);
      const packageName = shellQuote(adapter.package);
      const expectedVersion = shellQuote(adapter.version);
      const adapterName = shellQuote(adapter.adapter);
      let commands;
      switch (adapter.adapter) {
        case "homebrew-formula":
          commands = `
version_line="$(HOMEBREW_NO_AUTO_UPDATE=1 brew list --formula --versions ${packageName} 2>&1)" &&
prefix="$(HOMEBREW_NO_AUTO_UPDATE=1 brew --prefix ${packageName} 2>&1)" &&
test -d "$prefix" &&
printf '%s\\n%s\\n' "$version_line" "$prefix" >"$evidence"`;
          break;
        case "homebrew-installation":
          commands = `
version_line="$(brew --version 2>&1 | /usr/bin/head -n 1)" &&
prefix="$(brew --prefix 2>&1)" &&
test -d "$prefix" &&
printf '%s\\n%s\\n' "$version_line" "$prefix" >"$evidence"`;
          break;
        case "macos-brew-cask":
          commands = `
version_line="$(HOMEBREW_NO_AUTO_UPDATE=1 brew list --cask --versions ${packageName} 2>&1)" &&
listing="$(HOMEBREW_NO_AUTO_UPDATE=1 brew list --cask ${packageName} 2>&1)" &&
app="$(printf '%s\\n' "$listing" | /usr/bin/sed -n 's#^\\(.*\\.app\\)/.*#\\1#p; /\\.app$/p' | /usr/bin/head -n 1)" &&
test -n "$app" &&
test -d "$app" &&
/usr/sbin/spctl --assess --type execute "$app" >>"$evidence" 2>&1 &&
/usr/bin/codesign --verify --deep --strict "$app" >>"$evidence" 2>&1 &&
/usr/bin/mdls -name kMDItemCFBundleIdentifier -name kMDItemVersion "$app" >>"$evidence" 2>&1 &&
printf '%s\\n%s\\n' "$version_line" "$app" >>"$evidence"`;
          break;
        case "macos-clash-bundle":
          commands = `
app='' &&
for candidate in '/Applications/Clash Verge.app' '/Applications/Clash Verge Rev.app'; do
  if test -d "$candidate"; then app="$candidate"; break; fi
done &&
test -n "$app" &&
/usr/sbin/spctl --assess --type execute "$app" >>"$evidence" 2>&1 &&
/usr/bin/codesign --verify --deep --strict "$app" >>"$evidence" 2>&1 &&
version_line="$(/usr/bin/mdls -raw -name kMDItemVersion "$app" 2>&1)" &&
/usr/bin/mdls -name kMDItemCFBundleIdentifier "$app" >>"$evidence" 2>&1 &&
printf '%s\\n%s\\n' "$version_line" "$app" >>"$evidence"`;
          break;
        case "macos-clt-receipt":
          commands = `
/usr/sbin/pkgutil --pkg-info=com.apple.pkg.CLTools_Executables >"$evidence" 2>&1 &&
/usr/bin/xcode-select -p >>"$evidence" 2>&1 &&
version_line="$(/usr/bin/clang --version 2>&1 | /usr/bin/head -n 1)" &&
printf '%s\\n' "$version_line" >>"$evidence"`;
          break;
        case "npm-global":
          commands = `
version_line="$(npm list -g --depth=0 ${packageName} 2>&1)" &&
printf '%s\\n' "$version_line" >"$evidence"`;
          break;
        case "volta-tool":
          commands = `
version_line="$(volta list ${packageName} 2>&1)" &&
printf '%s\\n' "$version_line" >"$evidence"`;
          break;
        default:
          commands = "false";
      }
      return `
verify_one ${softwareId} ${adapterName} ${expectedVersion} <<'__DF_COMMAND__'
${commands}
__DF_COMMAND__`;
    })
    .join("\n");
  return `#!/bin/sh
set -u
umask 077
tmp_root="$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/dawn-forge-verify.XXXXXX")" || exit 70
trap '/bin/rm -rf "$tmp_root"' EXIT HUP INT TERM
verify_one() {
  software_id="$1"
  adapter="$2"
  expected_version="$3"
  command_file="$tmp_root/$software_id.command"
  evidence="$tmp_root/$software_id.evidence"
  /bin/cat >"$command_file"
  : >"$evidence"
  version_line="$expected_version"
  if . "$command_file"; then
    if test "$expected_version" != 'latest-stable' &&
       ! printf '%s\\n' "$version_line" | /usr/bin/grep -F -- "$expected_version" >/dev/null 2>&1; then
      printf '__DAWN_FORGE_MANUAL_V1__|%s|%s|pending|-|-\\n' "$software_id" "$adapter"
      return
    fi
    evidence_sha="$(/usr/bin/shasum -a 256 "$evidence" | /usr/bin/awk '{print $1}')"
    version_b64="$(printf '%s' "$version_line" | /usr/bin/base64 | /usr/bin/tr -d '\\r\\n')"
    printf '__DAWN_FORGE_MANUAL_V1__|%s|%s|verified|%s|%s\\n' "$software_id" "$adapter" "$version_b64" "$evidence_sha"
  else
    printf '__DAWN_FORGE_MANUAL_V1__|%s|%s|pending|-|-\\n' "$software_id" "$adapter"
  fi
}
${operations}
exit 0
`;
}

function buildWindowsManualVerificationDriver(adapters) {
  const operations = adapters
    .map((adapter) => {
      const softwareId = powershellQuote(adapter.softwareId);
      const packageName = powershellQuote(adapter.package);
      const adapterName = powershellQuote(adapter.adapter);
      const expectedVersion = powershellQuote(adapter.version);
      return `
Invoke-Verification -SoftwareId ${softwareId} -Adapter ${adapterName} -ExpectedVersion ${expectedVersion} -Body {
  $winget = & winget list --id ${packageName} --exact --accept-source-agreements --disable-interactivity 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'package-not-found' }
  $registry = @(
    'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
  ) | ForEach-Object {
    Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -or $_.PSChildName }
  } | Select-Object DisplayName, DisplayVersion, Publisher, PSChildName
  @($winget; $registry | ConvertTo-Json -Compress) -join [Environment]::NewLine
}`;
    })
    .join("\n");
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path ([IO.Path]::GetTempPath()) ('dawn-forge-verify-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
  function Invoke-Verification {
    param(
      [string]$SoftwareId,
      [string]$Adapter,
      [string]$ExpectedVersion,
      [scriptblock]$Body
    )
    $evidence = Join-Path $root ($SoftwareId + '.txt')
    try {
      $output = & $Body
      if (
        $ExpectedVersion -ne 'latest-stable' -and
        ([string]$output).IndexOf($ExpectedVersion, [StringComparison]::OrdinalIgnoreCase) -lt 0
      ) {
        throw 'version-mismatch'
      }
      [IO.File]::WriteAllText($evidence, [string]$output, [Text.UTF8Encoding]::new($false))
      $hash = (Get-FileHash -LiteralPath $evidence -Algorithm SHA256).Hash.ToLowerInvariant()
      $version = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ExpectedVersion))
      [Console]::Out.WriteLine("__DAWN_FORGE_MANUAL_V1__|$SoftwareId|$Adapter|verified|$version|$hash")
    } catch {
      [Console]::Out.WriteLine("__DAWN_FORGE_MANUAL_V1__|$SoftwareId|$Adapter|pending|-|-")
    }
  }
${operations}
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
`;
}

function parseManualVerificationProtocol(stdout, adapters) {
  const byId = new Map(adapters.map((adapter) => [adapter.softwareId, adapter]));
  const results = [];
  for (const line of String(stdout).replaceAll("\r", "").split("\n")) {
    if (!line.startsWith("__DAWN_FORGE_MANUAL_V1__|")) continue;
    const fields = line.split("|");
    if (fields.length !== 6) {
      return { status: "pending", reason: "verification-protocol-invalid" };
    }
    const [, softwareId, adapter, status, versionBase64, evidenceSha256] =
      fields;
    const expected = byId.get(softwareId);
    if (
      expected === undefined ||
      adapter !== expected.adapter ||
      !["verified", "pending"].includes(status)
    ) {
      return { status: "pending", reason: "verification-protocol-invalid" };
    }
    if (status === "pending") {
      results.push({ softwareId, adapter, status });
      continue;
    }
    if (!digestPattern.test(evidenceSha256)) {
      return { status: "pending", reason: "verification-protocol-invalid" };
    }
    let observedVersion;
    try {
      observedVersion = Buffer.from(versionBase64, "base64").toString("utf8");
    } catch {
      return { status: "pending", reason: "verification-protocol-invalid" };
    }
    results.push({
      softwareId,
      adapter,
      status,
      observedVersion,
      evidence: { remoteEvidenceSha256: evidenceSha256 },
    });
  }
  if (results.length !== adapters.length) {
    return { status: "pending", reason: "verification-protocol-incomplete" };
  }
  return {
    status: results.every((result) => result.status === "verified")
      ? "verified"
      : "pending",
    results,
    ...(results.every((result) => result.status === "verified")
      ? {}
      : { reason: "verification-incomplete" }),
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeReason(reason) {
  return typeof reason === "string" &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(reason)
    ? reason
    : "verification-incomplete";
}

function updateManifest(manifest, patch, runtime) {
  const next = sealManifest({
    ...manifest,
    ...patch,
    revision: manifest.revision + 1,
    updatedAt: runtime.now(),
    manifestSha256: undefined,
  });
  assertManifestSafe(next);
  const manifestPath = manifestPathFor(next, runtime.homeDirectory);
  return withExclusiveFile(join(dirname(manifestPath), ".manifest.lock"), () => {
    const current = loadManifestByPath(manifestPath);
    if (
      current.revision !== manifest.revision ||
      current.manifestSha256 !== manifest.manifestSha256
    ) {
      throw new Error("Installation run manifest revision conflict.");
    }
    atomicWriteJson(manifestPath, next);
    return next;
  });
}

function sealManifest(value) {
  const { manifestSha256: _oldDigest, ...payload } = value;
  return {
    ...payload,
    manifestSha256: sha256(JSON.stringify(payload)),
  };
}

function manifestPathFor(manifest, homeDirectory) {
  return join(
    homeDirectory,
    ".dawn-forge",
    "targets",
    manifest.target.storageAlias,
    "runs",
    manifest.runId,
    "manifest.json",
  );
}

function prepareResult(manifest, reused) {
  return {
    kind: "prepared",
    runId: manifest.runId,
    reused,
    manifestPath: join(dirname(manifest.state.directory), "manifest.json"),
    statePath: manifest.state.identity.statePath,
    targetAlias: manifest.target.alias,
    platform: manifest.target.platform,
    profileSha256: manifest.profile.sha256,
    scheduleSha256: manifest.schedule.scheduleSha256,
    targetIdentitySha256: manifest.target.targetIdentitySha256,
    machineExecutionIdentitySha256:
      manifest.target.machineExecutionIdentitySha256,
    cacheRoot: manifest.cache.root,
  };
}

function typedResult(kind, manifest, state, extra = {}) {
  return {
    kind,
    runId: manifest.runId,
    status: state.status,
    stateRevision: state.revision,
    summary: state.summary,
    activeAttempt:
      state.activeAttempt === null
        ? null
        : {
            batchId: state.activeAttempt.batchId,
            attemptId: state.activeAttempt.attemptId,
          },
    cancellation:
      state.cancel === null
        ? null
        : {
            status: state.cancel.status,
            requestedAt: state.cancel.requestedAt,
            ...(state.cancel.confirmedAt === undefined
              ? {}
              : { confirmedAt: state.cancel.confirmedAt }),
          },
    pendingGate: manifest.pendingGate,
    ...extra,
  };
}

function cancellationResult(manifest, state) {
  if (state.cancel?.status === "confirmed" && state.activeAttempt === null) {
    return typedResult("cancelled", manifest, state);
  }
  return typedResult("cancel-pending", manifest, state, {
    action: "interrupt-owning-advance-session",
    ownership: "foreground-advance-session-only",
    canConfirmTermination: false,
    instruction:
      "Send Ctrl-C to the same foreground advance session; a separate cancel process is not a supported cancellation path.",
    message:
      "取消意图已持久化，但尚未从 owned process 获得精确退出证明。",
  });
}

function assertCurrentTargetRun(manifest, homeDirectory) {
  const paths = canonicalPaths(
    homeDirectory,
    manifest.target.alias,
    manifest.target.machineExecutionIdentitySha256,
  );
  for (const [path, expectedAlias] of [
    [paths.activeRunPath, manifest.target.alias],
    [paths.identityActiveRunPath, undefined],
  ]) {
    const pointer = parseJsonFile(path, "active run pointer");
    validateActivePointer(pointer, {
      expectedAlias,
      expectedTargetIdentitySha256:
        manifest.target.targetIdentitySha256,
      expectedMachineExecutionIdentitySha256:
        manifest.target.machineExecutionIdentitySha256,
    });
    if (
      pointer.runId !== manifest.runId ||
      pointer.bindingSha256 !== manifest.bindingSha256 ||
      pointer.targetIdentitySha256 !==
        manifest.target.targetIdentitySha256 ||
      pointer.machineExecutionIdentitySha256 !==
        manifest.target.machineExecutionIdentitySha256
    ) {
      throw new RunConflictError(
        `Run ${manifest.runId} is no longer active for target identity ${manifest.target.targetIdentitySha256.slice(0, 12)}.`,
        {
          targetAlias: manifest.target.alias,
          activeRunId: pointer.runId,
        },
      );
    }
  }
}

function publishRunPointers(paths, manifest, status) {
  const pointer = {
    schemaVersion: 1,
    runId: manifest.runId,
    bindingSha256: manifest.bindingSha256,
    targetIdentitySha256: manifest.target.targetIdentitySha256,
    machineExecutionIdentitySha256:
      manifest.target.machineExecutionIdentitySha256,
    storageAlias: manifest.target.storageAlias,
    status,
  };
  atomicWriteJson(paths.identityActiveRunPath, pointer);
  atomicWriteJson(paths.activeRunPath, pointer);
}

function updateRunPointersIfOwned(manifest, stateStatus, homeDirectory) {
  const paths = canonicalPaths(
    homeDirectory,
    manifest.target.alias,
    manifest.target.machineExecutionIdentitySha256,
  );
  for (const path of [paths.identityActiveRunPath, paths.activeRunPath]) {
    const pointer = readOptionalJson(path);
    if (
      pointer === null ||
      pointer.runId !== manifest.runId ||
      pointer.bindingSha256 !== manifest.bindingSha256
    ) {
      return;
    }
  }
  publishRunPointers(
    paths,
    manifest,
    ["completed", "cancelled"].includes(stateStatus)
      ? stateStatus
      : "active",
  );
}

function validateActivePointer(pointer, options) {
  if (
    !isPlainObject(pointer) ||
    pointer.schemaVersion !== 1 ||
    !digestPattern.test(pointer.bindingSha256 ?? "") ||
    !digestPattern.test(pointer.targetIdentitySha256 ?? "") ||
    !digestPattern.test(pointer.machineExecutionIdentitySha256 ?? "") ||
    !["active", "completed", "cancelled"].includes(pointer.status)
  ) {
    throw new Error("Active run pointer is invalid.");
  }
  assertAllowedKeys(
    pointer,
    [
      "schemaVersion",
      "runId",
      "bindingSha256",
      "targetIdentitySha256",
      "machineExecutionIdentitySha256",
      "storageAlias",
      "status",
    ],
    "active run pointer",
  );
  const parsed = parseRunId(pointer.runId);
  if (
    pointer.storageAlias !== parsed.storageAlias ||
    (options.expectedAlias !== undefined &&
      parsed.storageAlias !== options.expectedAlias.toLowerCase()) ||
    (options.expectedTargetIdentitySha256 !== undefined &&
      pointer.targetIdentitySha256 !==
        options.expectedTargetIdentitySha256) ||
    (options.expectedMachineExecutionIdentitySha256 !== undefined &&
      pointer.machineExecutionIdentitySha256 !==
        options.expectedMachineExecutionIdentitySha256)
  ) {
    throw new Error("Active run pointer target binding is invalid.");
  }
}

function createSignalBridge(source) {
  const signalSource = new EventEmitter();
  const onInterrupt = () => signalSource.emit("SIGINT");
  const onTerminate = () => signalSource.emit("SIGTERM");
  source.on("SIGINT", onInterrupt);
  source.on("SIGTERM", onTerminate);
  return {
    signalSource,
    dispose() {
      source.removeListener("SIGINT", onInterrupt);
      source.removeListener("SIGTERM", onTerminate);
    },
  };
}

async function cancelLocallyOwnedRun(request) {
  const owned = ownedRuns.get(request.runId);
  if (owned === undefined) return { delivered: false };
  for (const key of [
    "runId",
    "scheduleSha256",
    "profileSha256",
    "targetIdentitySha256",
  ]) {
    if (owned.stateIdentity[key] !== request.stateIdentity[key]) {
      return { delivered: false };
    }
  }
  if (
    !samePath(
      owned.stateIdentity.statePath,
      request.stateIdentity.statePath,
    )
  ) {
    return { delivered: false };
  }
  owned.signalSource.emit("SIGTERM");
  return { delivered: true };
}

function createGateToken(manifest, batch, issuedAt) {
  return `gate-${sha256(
    JSON.stringify({
      runId: manifest.runId,
      revision: manifest.revision,
      batchId: batch.batchId,
      location: batch.networkLocation,
      route: batch.route,
      issuedAt,
      nonce: randomBytes(16).toString("hex"),
    }),
  ).slice(0, 48)}`;
}

function extractManagedAliasBlock(configText, alias) {
  const start = `# >>> Dawn Forge: ${alias} >>>`;
  const end = `# <<< Dawn Forge: ${alias} <<<`;
  const lines = String(configText).replaceAll("\r\n", "\n").split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === start);
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.trim() === end,
  );
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Finalized SSH config has no managed alias ${alias}.`);
  }
  const block = lines.slice(startIndex, endIndex + 1).join("\n");
  if (
    !lines
      .slice(startIndex + 1, endIndex)
      .some((line) => line.trim() === `Host ${alias}`)
  ) {
    throw new Error(`Finalized SSH config alias ${alias} is incomplete.`);
  }
  return block;
}

function withExclusiveFile(lockPath, action) {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  let descriptor;
  let owned = false;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    owned = true;
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new RunConflictError("Another prepare operation owns the target lock.", {
        lockPath,
      });
    }
    throw error;
  }
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return action();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (owned) {
      try {
        unlinkSync(lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

function atomicWriteJson(path, value) {
  assertJournalSafe(value, "JSON state");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(path),
    `.${path.split(/[\\/]/).at(-1)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Nothing was published.
    }
    throw error;
  }
}

function atomicPublishJsonExclusive(path, value) {
  assertJournalSafe(value, "exclusive JSON receipt");
  try {
    atomicPublishBytesExclusive(
      path,
      Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    );
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        "Canonical manual verification receipt already exists.",
      );
    }
    throw error;
  }
}

function atomicPublishBytesExclusive(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(path),
    `.${path.split(/[\\/]/).at(-1)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function assertManifestSafe(manifest) {
  assertJournalSafe(manifest, "manifest");
}

function assertJournalSafe(value, path) {
  if (typeof value === "string") {
    if (urlPattern.test(value)) {
      throw new Error(`${path} contains a URL, which is forbidden in run state.`);
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
      throw new Error(`${path} contains control characters.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJournalSafe(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeyPattern.test(key)) {
        throw new Error(`${path}.${key} is a forbidden secret-bearing field.`);
      }
      assertJournalSafe(child, `${path}.${key}`);
    }
  }
}

function parseJsonFile(path, label) {
  return parseJson(readFileSync(path), label);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${label}: ${error.message}`);
  }
}

function readOptionalJson(path) {
  if (!existsSync(path)) return null;
  return parseJsonFile(path, "active run pointer");
}

function resolveRequiredPath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty path.`);
  }
  const path = resolve(value);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  return path;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function comparablePath(path) {
  const canonical = resolve(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertAllowedKeys(value, allowed, path) {
  if (!isPlainObject(value)) throw new TypeError(`${path} must be an object.`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(`${path}.${key} is not allowed.`);
    }
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

export function parseInstallationRunCli(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === undefined) return { help: true };
  const specs = {
    prepare: {
      "--plan": "planBundlePath",
    },
    advance: {
      "--run-id": "runId",
      "--gate-token": "gateToken",
    },
    observe: { "--run-id": "runId" },
    "verify-manual": { "--run-id": "runId" },
  };
  const spec = specs[command];
  if (spec === undefined) throw new Error(`Unknown subcommand: ${command}`);
  if (rest.length % 2 !== 0) {
    throw new Error(`Incomplete argument: ${rest.at(-1)}`);
  }
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!(flag in spec)) throw new Error(`Unknown argument for ${command}: ${flag}`);
    if (values[flag] !== undefined) throw new Error(`Duplicate argument: ${flag}`);
    values[flag] = value;
  }
  const required =
    command === "advance"
      ? ["--run-id"]
      : Object.keys(spec);
  for (const flag of required) {
    if (values[flag] === undefined) throw new Error(`Missing argument: ${flag}`);
  }
  return {
    command,
    values: Object.fromEntries(
      Object.entries(values).map(([flag, value]) => [spec[flag], value]),
    ),
  };
}

function resultExitCode(result) {
  if (["user-action", "replan-required"].includes(result.kind)) {
    return EXIT_CODES.userAction;
  }
  if (
    ["cancel-pending", "busy", "blocked", "manual-pending"].includes(
      result.kind,
    )
  ) {
    return EXIT_CODES.pending;
  }
  if (
    result.kind === "batch-finished" &&
    !["completed", "prepared", "partial"].includes(result.status)
  ) {
    return EXIT_CODES.error;
  }
  return EXIT_CODES.success;
}

async function runCli() {
  const parsed = parseInstallationRunCli(process.argv.slice(2));
  if (parsed.help) {
    console.log(`Usage:
  node "${fileURLToPath(import.meta.url)}" prepare --plan <canonical-plan-bundle>
  node "${fileURLToPath(import.meta.url)}" advance --run-id <run-id> [--gate-token <gate-token>]
  node "${fileURLToPath(import.meta.url)}" observe --run-id <run-id>
  node "${fileURLToPath(import.meta.url)}" verify-manual --run-id <run-id>`);
    return;
  }
  let result;
  switch (parsed.command) {
    case "prepare":
      result = prepareInstallationRun(parsed.values);
      break;
    case "advance":
      result = await advanceInstallationRun(parsed.values.runId, {
        ...(parsed.values.gateToken === undefined
          ? {}
          : { gateToken: parsed.values.gateToken }),
      });
      break;
    case "observe":
      result = observeInstallationRun(parsed.values.runId);
      break;
    case "verify-manual":
      result = await verifyManualInstallation(parsed.values.runId);
      break;
    default:
      throw new Error("Unreachable subcommand.");
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = resultExitCode(result);
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  runCli().catch((error) => {
    console.error(
      JSON.stringify({
        kind: "error",
        code: error.code ?? "RUN_ERROR",
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      }),
    );
    process.exitCode = EXIT_CODES.error;
  });
}
