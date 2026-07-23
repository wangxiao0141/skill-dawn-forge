import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const digestPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const forbiddenKeyPattern =
  /^(?:password|passwd|secret|subscription(?:url)?|api[-_]?key|private[-_]?key|credential|authorization|cookie|token)$/i;
const urlPattern = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;
const phaseNames = ["fetch", "install", "verify"];
const reasonCodePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const processTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const lockRecoveryGraceMs = 5_000;
const executionModes = new Set(["automated", "manual-receipt"]);
const manualEvidenceTypes = new Set([
  "macos-bundle-signature",
  "macos-package-receipt",
  "windows-package-receipt",
  "windows-uninstall-entry",
  "cli-version",
]);
const identityKeys = [
  "statePath",
  "runId",
  "scheduleSha256",
  "profileSha256",
  "targetIdentitySha256",
];
const journalIdentityKeys = [
  "runId",
  "scheduleSha256",
  "profileSha256",
  "targetIdentitySha256",
];

export function createRun(identity, options = {}) {
  validateIdentity(identity);
  assertAllowedKeys(identity, identityKeys);
  if (!isPlainObject(options)) throw new TypeError("options must be an object.");
  assertAllowedKeys(options, ["items"], "options");
  const normalizedItems = validateItems(options.items);
  return withMutationLock(identity.statePath, () => {
    if (existsSync(identity.statePath)) {
      throw new Error(
        `Installation run state already exists: ${identity.statePath}`,
      );
    }
    const now = new Date().toISOString();
    const state = {
      schemaVersion: 1,
      runId: identity.runId,
      scheduleSha256: identity.scheduleSha256,
      profileSha256: identity.profileSha256,
      targetIdentitySha256: identity.targetIdentitySha256,
      revision: 1,
      status: "prepared",
      createdAt: now,
      updatedAt: now,
      activeAttempt: null,
      cancel: null,
      lastAttemptOutcome: null,
      items: normalizedItems.map(
        ({ softwareId, batchId, dependsOn, executionMode }) => ({
          softwareId,
          batchId,
          dependsOn,
          executionMode,
          status: "pending",
          phases: Object.fromEntries(
            phaseNames.map((phase) => [phase, { status: "pending" }]),
          ),
        }),
      ),
      summary: {
        total: normalizedItems.length,
        pending: normalizedItems.length,
        inProgress: 0,
        partial: 0,
        completed: 0,
        failed: 0,
        notVerified: 0,
      },
      journal: [
        {
          sequence: 1,
          at: now,
          type: "run-created",
          runId: identity.runId,
          scheduleSha256: identity.scheduleSha256,
          profileSha256: identity.profileSha256,
          targetIdentitySha256: identity.targetIdentitySha256,
        },
      ],
    };
    assertJournalSafe(state);
    atomicWriteJson(identity.statePath, state);
    return structuredClone(state);
  });
}

export function readRun(identity) {
  validateIdentity(identity);
  assertAllowedKeys(identity, identityKeys);
  const state = loadState(identity.statePath);
  assertIdentityMatches(state, identity);
  assertJournalSafe(state);
  return structuredClone(state);
}

export function recordEvent(identity, event, options = {}) {
  validateIdentity(identity);
  assertAllowedKeys(identity, identityKeys);
  if (!isPlainObject(event)) throw new TypeError("event must be an object.");
  assertJournalSafe(event, "event");
  const expectedRevision = validateMutationOptions(options);

  return withMutationLock(identity.statePath, () => {
    const state = loadMutableState(identity, expectedRevision);
    const now = new Date().toISOString();
    const journalEntry = applyEvent(state, event, now);
    state.journal.push({
      sequence: state.journal.length + 1,
      at: now,
      ...journalEntry,
    });
    commitMutation(identity.statePath, state, now);
    return structuredClone(state);
  });
}

export function requestCancel(identity, options = {}) {
  validateIdentity(identity);
  assertAllowedKeys(identity, identityKeys);
  const expectedRevision = validateMutationOptions(options);

  return withMutationLock(identity.statePath, () => {
    const state = loadMutableState(identity, expectedRevision);
    if (state.cancel !== null) return structuredClone(state);
    if (state.status === "completed") {
      throw new Error("A completed installation run cannot be cancelled.");
    }

    const now = new Date().toISOString();
    const target =
      state.activeAttempt === null
        ? {}
        : {
            batchId: state.activeAttempt.batchId,
            attemptId: state.activeAttempt.attemptId,
            ownedProcessToken: state.activeAttempt.ownedProcessToken,
          };
    state.cancel = {
      status: state.activeAttempt === null ? "confirmed" : "pending",
      requestedAt: now,
      ...target,
      ...(state.activeAttempt === null ? { confirmedAt: now } : {}),
    };
    state.journal.push({
      sequence: state.journal.length + 1,
      at: now,
      type: "cancel-requested",
      ...target,
      ...(state.activeAttempt === null ? { status: "confirmed" } : {}),
    });
    commitMutation(identity.statePath, state, now);
    return structuredClone(state);
  });
}

export function recordManualReceipt(identity, receipt, options = {}) {
  validateIdentity(identity);
  assertAllowedKeys(identity, identityKeys);
  validateManualReceipt(receipt);
  const expectedRevision = validateMutationOptions(options);

  return withMutationLock(identity.statePath, () => {
    const state = loadMutableState(identity, expectedRevision);
    const item = state.items.find(
      (candidate) => candidate.softwareId === receipt.softwareId,
    );
    if (!item) {
      throw new Error(`Unknown installation software: ${receipt.softwareId}`);
    }
    if (item.executionMode !== "manual-receipt") {
      throw new Error(
        `Software ${receipt.softwareId} does not use manual-receipt executionMode.`,
      );
    }
    assertBatchRunnable(state, item.batchId);
    assertItemDependenciesCompleted(state, item);
    if (
      item.status === "completed" ||
      Object.values(item.phases).some((phase) => phase.status !== "pending")
    ) {
      throw new Error(
        `Software ${receipt.softwareId} already has installation progress.`,
      );
    }

    const now = new Date().toISOString();
    item.phases.fetch = {
      status: "not-applicable",
      finishedAt: now,
      reasonCode: "manual-receipt",
    };
    item.phases.install = {
      status: "succeeded",
      finishedAt: now,
      source: "manual-receipt",
    };
    item.phases.verify = {
      status: "succeeded",
      finishedAt: now,
      source: "manual-receipt",
      evidenceType: receipt.evidenceType,
      evidenceSha256: receipt.evidenceSha256,
    };
    item.manualReceipt = {
      evidenceType: receipt.evidenceType,
      evidenceSha256: receipt.evidenceSha256,
      recordedAt: now,
    };
    state.journal.push({
      sequence: state.journal.length + 1,
      at: now,
      type: "manual-receipt-recorded",
      softwareId: item.softwareId,
      batchId: item.batchId,
      evidenceType: receipt.evidenceType,
      evidenceSha256: receipt.evidenceSha256,
    });
    commitMutation(identity.statePath, state, now);
    return structuredClone(state);
  });
}

export function assertBatchRunnable(state, batchId) {
  if (!isPlainObject(state) || !Array.isArray(state.items)) {
    throw new TypeError("state must be an installation run state.");
  }
  assertId(batchId, "batchId");
  const batchItems = state.items.filter((item) => item.batchId === batchId);
  if (batchItems.length === 0) {
    throw new Error(`Unknown installation batch: ${batchId}`);
  }
  if (state.activeAttempt !== null) {
    throw new Error(
      `Batch ${batchId} cannot start while an active installation attempt exists.`,
    );
  }
  if (state.cancel !== null) {
    throw new Error(
      `Batch ${batchId} cannot start after cancellation was requested.`,
    );
  }
  const unverifiedPhase = batchItems
    .flatMap((item) =>
      phaseNames.map((phase) => ({
        softwareId: item.softwareId,
        phase,
        state: item.phases?.[phase],
      })),
    )
    .find(({ state: phase }) => phase?.status === "interrupted");
  if (unverifiedPhase !== undefined) {
    throw new Error(
      `Batch ${batchId} is not verified after ${unverifiedPhase.softwareId} ${unverifiedPhase.phase}; automatic retry is forbidden.`,
    );
  }

  const itemsById = new Map(
    state.items.map((item) => [item.softwareId, item]),
  );
  const checkedDependencies = new Set();
  for (const item of batchItems) {
    if (!Array.isArray(item.dependsOn)) {
      throw new Error(`Run state dependency data is invalid for ${item.softwareId}.`);
    }
    for (const dependencyId of item.dependsOn) {
      if (checkedDependencies.has(dependencyId)) continue;
      checkedDependencies.add(dependencyId);
      const dependency = itemsById.get(dependencyId);
      if (!dependency) {
        throw new Error(
          `Run state is missing dependency ${dependencyId} for ${item.softwareId}.`,
        );
      }
      if (dependency.batchId === batchId) continue;
      if (
        dependency.status !== "completed" ||
        dependency.phases?.verify?.status !== "succeeded"
      ) {
        throw new Error(
          `Batch ${batchId} is blocked by dependency ${dependencyId} (${dependency.status}).`,
        );
      }
    }
  }
  return true;
}

function validateMutationOptions(options) {
  if (!isPlainObject(options)) {
    throw new TypeError("mutation options must be an object.");
  }
  assertAllowedKeys(options, ["expectedRevision"], "options");
  if (
    !Number.isSafeInteger(options.expectedRevision) ||
    options.expectedRevision < 1
  ) {
    throw new TypeError(
      "options.expectedRevision is required and must be a positive integer.",
    );
  }
  return options.expectedRevision;
}

function loadMutableState(identity, expectedRevision) {
  const state = loadState(identity.statePath);
  assertIdentityMatches(state, identity);
  assertJournalSafe(state);
  if (state.revision !== expectedRevision) {
    const error = new Error(
      `Installation state revision conflict: expected ${expectedRevision}, actual ${state.revision}.`,
    );
    error.code = "DAWN_FORGE_REVISION_CONFLICT";
    throw error;
  }
  return state;
}

function commitMutation(statePath, state, now) {
  refreshDerivedState(state);
  state.revision += 1;
  state.updatedAt = now;
  assertJournalSafe(state);
  atomicWriteJson(statePath, state);
}

function validateManualReceipt(receipt) {
  if (!isPlainObject(receipt)) {
    throw new TypeError("manual receipt must be an object.");
  }
  assertJournalSafe(receipt, "receipt");
  assertAllowedKeys(
    receipt,
    ["softwareId", "evidenceType", "evidenceSha256"],
    "receipt",
  );
  assertId(receipt.softwareId, "receipt.softwareId");
  if (!manualEvidenceTypes.has(receipt.evidenceType)) {
    throw new TypeError(
      `receipt.evidenceType is an unsupported manual evidence type: ${receipt.evidenceType}`,
    );
  }
  if (!digestPattern.test(receipt.evidenceSha256 ?? "")) {
    throw new TypeError(
      "receipt.evidenceSha256 must be a lowercase SHA-256 digest.",
    );
  }
}

function assertItemDependenciesCompleted(state, item) {
  const itemsById = new Map(
    state.items.map((candidate) => [candidate.softwareId, candidate]),
  );
  for (const dependencyId of item.dependsOn) {
    const dependency = itemsById.get(dependencyId);
    if (
      !dependency ||
      dependency.status !== "completed" ||
      dependency.phases?.verify?.status !== "succeeded"
    ) {
      throw new Error(
        `Manual receipt for ${item.softwareId} is blocked by dependency ${dependencyId} (${dependency?.status ?? "missing"}).`,
      );
    }
  }
}

function validateIdentity(identity) {
  if (!isPlainObject(identity)) throw new TypeError("identity must be an object.");
  if (typeof identity.statePath !== "string" || identity.statePath.length === 0) {
    throw new TypeError("statePath must be a non-empty string.");
  }
  if (!idPattern.test(identity.runId ?? "")) {
    throw new TypeError("runId is invalid.");
  }
  for (const key of [
    "scheduleSha256",
    "profileSha256",
    "targetIdentitySha256",
  ]) {
    if (!digestPattern.test(identity[key] ?? "")) {
      throw new TypeError(`${key} must be a lowercase SHA-256 digest.`);
    }
  }
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypeError("items must be a non-empty array.");
  }
  const softwareIds = new Set();
  const normalizedItems = items.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new TypeError(`items[${index}] must be an object.`);
    }
    assertAllowedKeys(
      item,
      ["softwareId", "batchId", "dependsOn", "executionMode"],
      `items[${index}]`,
    );
    for (const key of ["softwareId", "batchId"]) {
      if (!idPattern.test(item[key] ?? "")) {
        throw new TypeError(`items[${index}].${key} is invalid.`);
      }
    }
    if (softwareIds.has(item.softwareId)) {
      throw new TypeError(`items[${index}].softwareId is duplicated.`);
    }
    softwareIds.add(item.softwareId);
    if (!Array.isArray(item.dependsOn)) {
      throw new TypeError(`items[${index}].dependsOn must be an array.`);
    }
    const dependencies = new Set();
    item.dependsOn.forEach((dependencyId, dependencyIndex) => {
      if (!idPattern.test(dependencyId ?? "")) {
        throw new TypeError(
          `items[${index}].dependsOn[${dependencyIndex}] is invalid.`,
        );
      }
      if (dependencyId === item.softwareId) {
        throw new TypeError(
          `items[${index}].dependsOn self dependency is forbidden.`,
        );
      }
      if (dependencies.has(dependencyId)) {
        throw new TypeError(
          `items[${index}].dependsOn has duplicate dependency ${dependencyId}.`,
        );
      }
      dependencies.add(dependencyId);
    });
    if (!executionModes.has(item.executionMode)) {
      throw new TypeError(
        `items[${index}].executionMode is an unsupported executionMode.`,
      );
    }
    return {
      softwareId: item.softwareId,
      batchId: item.batchId,
      dependsOn: [...item.dependsOn],
      executionMode: item.executionMode,
    };
  });
  for (const [index, item] of normalizedItems.entries()) {
    for (const dependencyId of item.dependsOn) {
      if (!softwareIds.has(dependencyId)) {
        throw new TypeError(
          `items[${index}].dependsOn has unknown dependency ${dependencyId}.`,
        );
      }
    }
  }
  assertAcyclicDependencies(normalizedItems);
  return normalizedItems;
}

function assertAcyclicDependencies(items) {
  const dependenciesById = new Map(
    items.map((item) => [item.softwareId, item.dependsOn]),
  );
  const visiting = new Set();
  const visited = new Set();
  const path = [];

  function visit(softwareId) {
    if (visited.has(softwareId)) return;
    if (visiting.has(softwareId)) {
      const cycleStart = path.indexOf(softwareId);
      const cycle = [...path.slice(cycleStart), softwareId].join(" -> ");
      throw new TypeError(`items dependency cycle detected: ${cycle}.`);
    }
    visiting.add(softwareId);
    path.push(softwareId);
    for (const dependencyId of dependenciesById.get(softwareId)) {
      visit(dependencyId);
    }
    path.pop();
    visiting.delete(softwareId);
    visited.add(softwareId);
  }

  for (const item of items) visit(item.softwareId);
}

function applyEvent(state, event, now) {
  if (
    state.cancel?.status === "pending" &&
    !["cancellation-acknowledged", "attempt-exited"].includes(event.type)
  ) {
    throw new Error(
      "Only an exact attempt exit is allowed while cancellation is pending.",
    );
  }
  switch (event.type) {
    case "attempt-started":
      return applyAttemptStarted(state, event, now);
    case "phase-started":
    case "phase-succeeded":
    case "phase-failed":
    case "phase-interrupted":
    case "phase-not-applicable":
      return applyPhaseEvent(state, event, now);
    case "cancellation-acknowledged":
      return applyCancellationAcknowledged(state, event, now);
    case "attempt-exited":
      return applyAttemptExited(state, event, now);
    default:
      throw new TypeError(`Unsupported installation event type: ${event.type}`);
  }
}

function applyCancellationAcknowledged(state, event, now) {
  assertAllowedKeys(
    event,
    ["type", "attemptId", "ownedProcessToken"],
    "event",
  );
  if (state.cancel?.status !== "pending") {
    throw new Error("There is no pending cancellation to acknowledge.");
  }
  const attempt = requireActiveAttempt(state, event.attemptId);
  if (event.ownedProcessToken !== attempt.ownedProcessToken) {
    throw new Error("Owned process token does not match the active attempt.");
  }
  if (state.cancel.acknowledgedAt !== undefined) {
    throw new Error("Cancellation was already acknowledged.");
  }
  state.cancel = {
    ...state.cancel,
    acknowledgedAt: now,
  };
  return {
    type: event.type,
    attemptId: event.attemptId,
    ownedProcessToken: event.ownedProcessToken,
  };
}

function applyAttemptStarted(state, event, now) {
  assertAllowedKeys(event, [
    "type",
    "batchId",
    "attemptId",
    "ownedProcessToken",
  ], "event");
  assertId(event.batchId, "event.batchId");
  assertId(event.attemptId, "event.attemptId");
  if (!processTokenPattern.test(event.ownedProcessToken ?? "")) {
    throw new TypeError("event.ownedProcessToken is invalid.");
  }
  assertBatchRunnable(state, event.batchId);
  const manualItems = state.items.filter(
    (item) =>
      item.batchId === event.batchId &&
      item.executionMode === "manual-receipt",
  );
  if (manualItems.length > 0) {
    throw new Error(
      `Batch ${event.batchId} requires recordManualReceipt for ${manualItems
        .map((item) => item.softwareId)
        .join(", ")}.`,
    );
  }
  if (state.status === "completed") {
    throw new Error("A completed installation run cannot start an attempt.");
  }
  if (
    state.journal.some(
      (entry) =>
        entry.type === "attempt-started" && entry.attemptId === event.attemptId,
    )
  ) {
    throw new Error(`Installation attempt id was already used: ${event.attemptId}`);
  }

  state.activeAttempt = {
    batchId: event.batchId,
    attemptId: event.attemptId,
    ownedProcessToken: event.ownedProcessToken,
    startedAt: now,
  };
  state.lastAttemptOutcome = null;
  return {
    type: event.type,
    batchId: event.batchId,
    attemptId: event.attemptId,
    ownedProcessToken: event.ownedProcessToken,
  };
}

function applyPhaseEvent(state, event, now) {
  const allowedKeys = ["type", "softwareId", "phase", "attemptId"];
  if (
    ["phase-failed", "phase-interrupted", "phase-not-applicable"].includes(
      event.type,
    )
  ) {
    allowedKeys.push("reasonCode");
  }
  if (event.type === "phase-failed") {
    allowedKeys.push("exitCode");
  }
  assertAllowedKeys(event, allowedKeys, "event");
  const attempt = requireActiveAttempt(state, event.attemptId);
  assertId(event.softwareId, "event.softwareId");
  if (!phaseNames.includes(event.phase)) {
    throw new TypeError("event.phase must be fetch, install, or verify.");
  }
  const item = state.items.find(
    (candidate) => candidate.softwareId === event.softwareId,
  );
  if (!item || item.batchId !== attempt.batchId) {
    throw new Error(
      `Software ${event.softwareId} does not belong to active batch ${attempt.batchId}.`,
    );
  }
  if (item.executionMode !== "automated") {
    throw new Error(
      `Software ${event.softwareId} requires recordManualReceipt.`,
    );
  }

  const phase = item.phases[event.phase];
  if (event.type === "phase-interrupted") {
    if (event.reasonCode !== "receipt-unconfirmed") {
      throw new TypeError(
        "event.reasonCode must be receipt-unconfirmed for phase-interrupted.",
      );
    }
    if (phase.status !== "running" || phase.attemptId !== event.attemptId) {
      throw new Error(
        `${event.phase} is not running under attempt ${event.attemptId}.`,
      );
    }
    item.phases[event.phase] = {
      status: "interrupted",
      attemptId: event.attemptId,
      startedAt: phase.startedAt,
      finishedAt: now,
      reasonCode: event.reasonCode,
    };
  } else if (event.type === "phase-not-applicable") {
    if (event.phase === "verify") {
      throw new Error("The verify phase cannot be not-applicable.");
    }
    if (!reasonCodePattern.test(event.reasonCode ?? "")) {
      throw new TypeError(
        "event.reasonCode is required for phase-not-applicable.",
      );
    }
    const phaseIndex = phaseNames.indexOf(event.phase);
    const previousPhases = phaseNames.slice(0, phaseIndex);
    if (
      previousPhases.some(
        (name) =>
          !["succeeded", "not-applicable"].includes(
            item.phases[name].status,
          ),
      )
    ) {
      throw new Error(
        `Cannot mark ${event.phase} not-applicable before earlier phases finish.`,
      );
    }
    if (phase.status !== "pending") {
      throw new Error(
        `Cannot mark ${event.phase} not-applicable while its status is ${phase.status}.`,
      );
    }
    item.phases[event.phase] = {
      status: "not-applicable",
      attemptId: event.attemptId,
      finishedAt: now,
      reasonCode: event.reasonCode,
    };
  } else if (event.type === "phase-started") {
    const phaseIndex = phaseNames.indexOf(event.phase);
    const previousPhases = phaseNames.slice(0, phaseIndex);
    if (
      previousPhases.some(
        (name) =>
          !["succeeded", "not-applicable"].includes(
            item.phases[name].status,
          ),
      )
    ) {
      throw new Error(`Cannot start ${event.phase} before earlier phases finish.`);
    }
    if (!["pending", "failed"].includes(phase.status)) {
      throw new Error(
        `Cannot start ${event.phase} while its status is ${phase.status}.`,
      );
    }
    item.phases[event.phase] = {
      status: "running",
      attemptId: event.attemptId,
      startedAt: now,
    };
  } else {
    if (phase.status !== "running" || phase.attemptId !== event.attemptId) {
      throw new Error(
        `${event.phase} is not running under attempt ${event.attemptId}.`,
      );
    }
    const result = {
      status: event.type === "phase-succeeded" ? "succeeded" : "failed",
      attemptId: event.attemptId,
      startedAt: phase.startedAt,
      finishedAt: now,
    };
    if (event.type === "phase-failed") {
      validateFailureDetails(event);
      if (event.reasonCode !== undefined) result.reasonCode = event.reasonCode;
      if (event.exitCode !== undefined) result.exitCode = event.exitCode;
    }
    item.phases[event.phase] = result;
  }

  return {
    type: event.type,
    softwareId: event.softwareId,
    phase: event.phase,
    attemptId: event.attemptId,
    ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
  };
}

function applyAttemptExited(state, event, now) {
  assertAllowedKeys(event, [
    "type",
    "attemptId",
    "ownedProcessToken",
    "outcome",
    "reasonCode",
    "exitCode",
  ], "event");
  const attempt = requireActiveAttempt(state, event.attemptId);
  if (event.ownedProcessToken !== attempt.ownedProcessToken) {
    throw new Error("Owned process token does not match the active attempt.");
  }
  if (
    !["succeeded", "failed", "cancelled", "unknown"].includes(event.outcome)
  ) {
    throw new TypeError(
      "event.outcome must be succeeded, failed, cancelled, or unknown.",
    );
  }
  validateFailureDetails(event);
  const activeBatchItems = state.items.filter(
    (item) => item.batchId === attempt.batchId,
  );
  const cancellationExit =
    state.cancel?.status === "pending" &&
    state.cancel.attemptId === attempt.attemptId &&
    state.cancel.ownedProcessToken === attempt.ownedProcessToken;
  if (event.outcome === "succeeded") {
    if (state.cancel !== null) {
      throw new Error("An installation attempt cannot succeed after cancellation.");
    }
    const allVerifiedWithoutFailure = activeBatchItems.every(
      (item) =>
        item.executionMode === "automated" &&
        item.phases.verify.status === "succeeded" &&
        Object.values(item.phases).every(
          (phase) => !["failed", "interrupted"].includes(phase.status),
        ),
    );
    if (!allVerifiedWithoutFailure) {
      throw new Error(
        "A succeeded attempt requires all automated batch items are verified without failed or interrupted phases.",
      );
    }
    if (
      event.reasonCode !== undefined ||
      (event.exitCode !== undefined && event.exitCode !== 0)
    ) {
      throw new Error("A succeeded attempt contains failure evidence.");
    }
  }
  if (event.outcome === "cancelled" && !cancellationExit) {
    throw new Error(
      "A cancelled attempt outcome requires a matching cancellation request.",
    );
  }
  if (event.outcome === "unknown") {
    if (state.cancel !== null) {
      throw new Error(
        "An unknown installation attempt cannot close cancellation state.",
      );
    }
    const hasUnverifiedPhase = activeBatchItems.some((item) =>
      Object.values(item.phases).some(
        (phase) =>
          phase.status === "interrupted" &&
          phase.attemptId === event.attemptId &&
          phase.reasonCode === "receipt-unconfirmed",
      ),
    );
    if (
      !hasUnverifiedPhase ||
      event.reasonCode !== "receipt-unconfirmed"
    ) {
      throw new Error(
        "An unknown attempt requires receipt-unconfirmed phase evidence.",
      );
    }
  }
  if (event.outcome === "failed") {
    const hasFailedPhase = activeBatchItems.some((item) =>
      Object.values(item.phases).some((phase) => phase.status === "failed"),
    );
    const hasExitEvidence =
      event.reasonCode !== undefined ||
      (event.exitCode !== undefined && event.exitCode !== 0);
    if (!hasFailedPhase && !hasExitEvidence) {
      throw new Error(
        "A failed attempt requires failed phase or exit evidence.",
      );
    }
  }
  const runningPhases = [];
  for (const item of state.items) {
    for (const phaseName of phaseNames) {
      const phase = item.phases[phaseName];
      if (
        phase.status === "running" &&
        phase.attemptId === event.attemptId
      ) {
        runningPhases.push({ item, phaseName, phase });
      }
    }
  }
  if (cancellationExit && state.cancel.acknowledgedAt === undefined) {
    throw new Error(
      "A cancellation acknowledgement is required before confirming attempt exit.",
    );
  }
  if (runningPhases.length > 0 && !cancellationExit) {
    throw new Error("Cannot close an attempt while an item phase is running.");
  }
  const interruptedPhases = [];
  if (cancellationExit) {
    for (const { item, phaseName, phase } of runningPhases) {
      item.phases[phaseName] = {
        status: "interrupted",
        attemptId: event.attemptId,
        startedAt: phase.startedAt,
        finishedAt: now,
        reasonCode: "cancelled",
      };
      interruptedPhases.push({
        softwareId: item.softwareId,
        phase: phaseName,
      });
    }
  }
  state.activeAttempt = null;
  state.lastAttemptOutcome = {
    batchId: attempt.batchId,
    attemptId: attempt.attemptId,
    ownedProcessToken: attempt.ownedProcessToken,
    outcome: event.outcome,
    exitedAt: now,
    ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
    ...(interruptedPhases.length === 0 ? {} : { interruptedPhases }),
  };
  if (
    state.cancel?.status === "pending" &&
    state.cancel.attemptId === attempt.attemptId &&
    state.cancel.ownedProcessToken === attempt.ownedProcessToken
  ) {
    state.cancel = {
      ...state.cancel,
      status: "confirmed",
      confirmedAt: now,
      observedOutcome: event.outcome,
    };
  }
  return {
    type: event.type,
    attemptId: event.attemptId,
    ownedProcessToken: event.ownedProcessToken,
    outcome: event.outcome,
    ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
    ...(interruptedPhases.length === 0 ? {} : { interruptedPhases }),
  };
}

function requireActiveAttempt(state, attemptId) {
  if (state.activeAttempt === null) {
    throw new Error("There is no active attempt.");
  }
  if (state.activeAttempt.attemptId !== attemptId) {
    throw new Error(
      `Event attempt ${attemptId} does not match the active attempt.`,
    );
  }
  return state.activeAttempt;
}

function validateFailureDetails(event) {
  if (
    event.reasonCode !== undefined &&
    !reasonCodePattern.test(event.reasonCode)
  ) {
    throw new TypeError("event.reasonCode is invalid.");
  }
  if (
    event.exitCode !== undefined &&
    (!Number.isInteger(event.exitCode) ||
      event.exitCode < -2147483648 ||
      event.exitCode > 2147483647)
  ) {
    throw new TypeError("event.exitCode must be a 32-bit integer.");
  }
}

function refreshDerivedState(state) {
  for (const item of state.items) {
    item.status = deriveItemStatus(item);
  }
  const summary = {
    total: state.items.length,
    pending: 0,
    inProgress: 0,
    partial: 0,
    completed: 0,
    failed: 0,
    notVerified: 0,
  };
  const summaryKey = {
    pending: "pending",
    "in-progress": "inProgress",
    partial: "partial",
    completed: "completed",
    failed: "failed",
    "not-verified": "notVerified",
  };
  for (const item of state.items) summary[summaryKey[item.status]] += 1;
  state.summary = summary;

  if (state.cancel?.status === "pending") state.status = "cancel-pending";
  else if (state.cancel?.status === "confirmed") state.status = "cancelled";
  else if (state.activeAttempt !== null) state.status = "running";
  else if (summary.completed === summary.total) state.status = "completed";
  else {
    const hasFailure =
      state.lastAttemptOutcome?.outcome === "failed" ||
      summary.failed > 0;
    const hasSuccessfulProgress = state.items.some((item) =>
      Object.values(item.phases).some((phase) => phase.status === "succeeded"),
    );
    if (hasFailure) {
      state.status = hasSuccessfulProgress ? "partial" : "failed";
    } else if (summary.pending !== summary.total) state.status = "partial";
    else state.status = "prepared";
  }
}

function deriveItemStatus(item) {
  if (item.phases.verify.status === "succeeded") return "completed";
  const phases = Object.values(item.phases);
  if (phases.some((phase) => phase.status === "interrupted")) {
    return "not-verified";
  }
  if (phases.some((phase) => phase.status === "failed")) return "failed";
  if (phases.some((phase) => phase.status === "running")) return "in-progress";
  if (phases.some((phase) => phase.status === "succeeded")) {
    return "partial";
  }
  return "pending";
}

function assertId(value, path) {
  if (!idPattern.test(value ?? "")) throw new TypeError(`${path} is invalid.`);
}

function assertAllowedKeys(value, allowed, path = "identity") {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${path}.${key} is not allowed.`);
  }
}

function loadState(statePath) {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read installation run state: ${error.message}`);
  }
}

function assertIdentityMatches(state, identity) {
  for (const key of journalIdentityKeys) {
    if (state[key] !== identity[key]) {
      throw new Error(`${key} drift detected; refusing to use installation state.`);
    }
  }
  const creationEntry = state.journal?.[0];
  if (
    creationEntry?.type !== "run-created" ||
    journalIdentityKeys.some((key) => creationEntry[key] !== state[key])
  ) {
    throw new Error(
      "run-created journal identity drift detected; refusing to use installation state.",
    );
  }
}

function assertJournalSafe(value, path = "$") {
  if (typeof value === "string") {
    if (urlPattern.test(value)) {
      throw new Error(`${path}: URLs are forbidden in installation run state.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJournalSafe(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenKeyPattern.test(key) && key !== "ownedProcessToken") {
      throw new Error(`${path}.${key}: secret-like fields are forbidden.`);
    }
    assertJournalSafe(entry, `${path}.${key}`);
  }
}

function withMutationLock(statePath, operation) {
  const directory = dirname(statePath);
  mkdirSync(directory, { recursive: true });
  const lockPath = `${statePath}.lock`;
  let owner;
  try {
    owner = createMutationLock(lockPath);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!quarantineOrphanLock(lockPath)) {
      throw createStateLockedError(lockPath);
    }
    try {
      owner = createMutationLock(lockPath);
    } catch (retryError) {
      if (retryError.code === "EEXIST") {
        throw createStateLockedError(lockPath);
      }
      throw retryError;
    }
  }

  try {
    return operation();
  } finally {
    releaseMutationLock(lockPath, owner);
  }
}

function createMutationLock(lockPath) {
  const owner = {
    schemaVersion: 1,
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) {
      try {
        unlinkSync(lockPath);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      }
    }
    throw error;
  }
  return owner;
}

function quarantineOrphanLock(lockPath) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return false;
  }
  if (
    !isPlainObject(owner) ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    !idPattern.test(owner.nonce ?? "") ||
    typeof owner.createdAt !== "string"
  ) {
    return false;
  }
  const createdAt = Date.parse(owner.createdAt);
  if (
    !Number.isFinite(createdAt) ||
    Date.now() - createdAt <= lockRecoveryGraceMs
  ) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    if (error.code !== "ESRCH") return false;
  }

  const quarantinePath = `${lockPath}.orphan-${owner.nonce}`;
  if (existsSync(quarantinePath)) {
    throw createLockRecoveryRaceError(lockPath);
  }
  try {
    renameSync(lockPath, quarantinePath);
  } catch {
    throw createLockRecoveryRaceError(lockPath);
  }

  let quarantinedOwner;
  try {
    quarantinedOwner = JSON.parse(readFileSync(quarantinePath, "utf8"));
  } catch {
    throw createLockRecoveryRaceError(lockPath);
  }
  if (
    quarantinedOwner.pid !== owner.pid ||
    quarantinedOwner.nonce !== owner.nonce
  ) {
    if (!existsSync(lockPath)) {
      try {
        renameSync(quarantinePath, lockPath);
      } catch {
        // 无法安全恢复时保留 quarantine，继续 fail closed。
      }
    }
    throw createLockRecoveryRaceError(lockPath);
  }
  return true;
}

function createLockRecoveryRaceError(lockPath) {
  const error = new Error(
    `Installation state lock changed during orphan recovery: ${lockPath}`,
  );
  error.code = "DAWN_FORGE_LOCK_RECOVERY_RACE";
  return error;
}

function createStateLockedError(lockPath) {
  let ownerDescription = "an unknown owner";
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    if (
      isPlainObject(owner) &&
      Number.isSafeInteger(owner.pid) &&
      typeof owner.nonce === "string"
    ) {
      ownerDescription = `PID ${owner.pid} with nonce ${owner.nonce}`;
    }
  } catch {
    // 无效锁仍按有效锁处理；保持 fail closed，不自动删除。
  }
  const error = new Error(
    `Installation state is locked by ${ownerDescription}; reread after the owner releases it.`,
  );
  error.code = "DAWN_FORGE_STATE_LOCKED";
  return error;
}

function releaseMutationLock(lockPath, owner) {
  let currentOwner;
  try {
    currentOwner = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    const releaseError = new Error(
      `Cannot verify installation state lock ownership: ${error.message}`,
    );
    releaseError.code = "DAWN_FORGE_LOCK_OWNERSHIP_LOST";
    throw releaseError;
  }
  if (
    currentOwner.pid !== owner.pid ||
    currentOwner.nonce !== owner.nonce
  ) {
    const error = new Error(
      "Installation state lock ownership changed; refusing to remove it.",
    );
    error.code = "DAWN_FORGE_LOCK_OWNERSHIP_LOST";
    throw error;
  }
  unlinkSync(lockPath);
}

function atomicWriteJson(statePath, state) {
  const directory = dirname(statePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(statePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, statePath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
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
