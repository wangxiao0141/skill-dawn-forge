import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInstallationSchedule } from "../skills/dawn-forge/scripts/installation-batches.mjs";
import {
  machineExecutionIdentityDigest,
  targetIdentityDigest,
} from "../skills/dawn-forge/scripts/target-identity.mjs";
import {
  advanceInstallationRun,
  cancelInstallationRun,
  observeInstallationRun,
  parseInstallationRunCli,
  prepareInstallationRun,
  RunConflictError,
  verifyManualInstallation,
} from "../skills/dawn-forge/scripts/installation-run.mjs";

const temporaryRoots = [];

try {
  testPrepareIsCanonicalIdempotentAndTargetExclusive();
  testIdentityReceiptExecutionBindingsFailClosed();
  testCanonicalPlanBundlePrepare();
  testUnboundControllerCachePlanIsRejected();
  await testDigestDriftFailsBeforeRunner();
  await testExpiredPreflightRequiresLocalReplan();
  await testStartedRunDoesNotExpireOnWallClock();
  await testRouteGateControlsRunnerArguments();
  await testManualGateRequiresBoundEvidenceReceipt();
  await testUnknownManualAdapterCannotReleaseDependencies();
  testDefaultStateModuleIntegration();
  testObserveReadsOnlyManifestAndState();
  await testCancelPersistsIntentAndUsesOnlyOwnedHandle();
  await testInProcessOwnedCancellationHandshake();
  await testForegroundSignalBridgeReachesOwnedRunner();
  testStrictCliAndNoPollingOrDetachedWork();
  console.log("Installation run orchestrator tests passed.");
} finally {
  for (const root of temporaryRoots) {
    assert.ok(root.startsWith(resolve(tmpdir())));
    rmSync(root, { recursive: true, force: true });
  }
}

function testPrepareIsCanonicalIdempotentAndTargetExclusive() {
  const fixture = makeFixture({
    actions: [automatedAction("wechat", "direct")],
  });
  const first = prepareInstallationRun(fixture.input, fixture.dependencies);
  assert.equal(first.kind, "prepared");
  assert.equal(first.reused, false);
  assert.equal(fixture.state.calls.createRun, 1);
  assert.equal(
    first.manifestPath,
    join(
      fixture.homeDirectory,
      ".dawn-forge",
      "targets",
      "mini",
      "runs",
      first.runId,
      "manifest.json",
    ),
  );
  assert.match(first.runId, /^run-mini-[a-f0-9]{32}$/);

  const second = prepareInstallationRun(fixture.input, fixture.dependencies);
  assert.equal(second.runId, first.runId);
  assert.equal(second.reused, true);
  assert.equal(fixture.state.calls.createRun, 1);

  const manifestText = readFileSync(first.manifestPath, "utf8");
  assert.doesNotMatch(manifestText, /https?:\/\//i);
  assert.doesNotMatch(
    manifestText,
    /"(?:password|secret|subscriptionUrl|token)"\s*:/i,
  );

  const alternateProfile = join(fixture.homeDirectory, "profile-alt.json");
  writeJson(alternateProfile, { id: "different-profile", software: [] });
  const alternatePreflight = JSON.parse(
    readFileSync(fixture.input.preflightReceiptPath, "utf8"),
  );
  alternatePreflight.profileSha256 = sha256(readFileSync(alternateProfile));
  const alternatePreflightPath = join(
    fixture.homeDirectory,
    "preflight-alt.json",
  );
  writeJson(alternatePreflightPath, alternatePreflight);
  const alternateSchedule = JSON.parse(
    readFileSync(fixture.input.schedulePath, "utf8"),
  );
  alternateSchedule.preflightSha256 = sha256(
    JSON.stringify(alternatePreflight),
  );
  delete alternateSchedule.scheduleSha256;
  alternateSchedule.scheduleSha256 = sha256(
    JSON.stringify(alternateSchedule),
  );
  const alternateSchedulePath = join(fixture.homeDirectory, "schedule-alt.json");
  writeJson(alternateSchedulePath, alternateSchedule);
  assert.throws(
    () =>
      prepareInstallationRun(
        {
          ...fixture.input,
          profilePath: alternateProfile,
          preflightReceiptPath: alternatePreflightPath,
          schedulePath: alternateSchedulePath,
        },
        fixture.dependencies,
      ),
    (error) =>
      error instanceof RunConflictError &&
      error.code === "RUN_CONFLICT" &&
      error.details.activeRunId === first.runId,
  );

  const copiedReceipt = join(fixture.homeDirectory, "copied-identity.json");
  writeFileSync(
    copiedReceipt,
    readFileSync(fixture.input.identityReceiptPath),
  );
  assert.throws(
    () =>
      prepareInstallationRun(
        { ...fixture.input, identityReceiptPath: copiedReceipt },
        fixture.dependencies,
      ),
    /not canonical/i,
  );

  const secondAlias = "same-machine";
  const secondConfigBlock = [
    `# >>> Dawn Forge: ${secondAlias} >>>`,
    `Host ${secondAlias}`,
    "  HostName mac-mini.local",
    "  User wangxiao",
    `  IdentityFile ${join(fixture.homeDirectory, ".ssh", "id_ed25519")}`,
    "  IdentitiesOnly yes",
    `# <<< Dawn Forge: ${secondAlias} <<<`,
    "",
  ].join("\n");
  writeFile(
    fixture.sshConfigPath,
    `${readFileSync(fixture.sshConfigPath, "utf8")}${secondConfigBlock}`,
  );
  const secondReceipt = JSON.parse(
    readFileSync(fixture.input.identityReceiptPath, "utf8"),
  );
  secondReceipt.alias = secondAlias;
  secondReceipt.sshConfigSha256 = sha256(
    readFileSync(fixture.sshConfigPath),
  );
  secondReceipt.sshConfig.path = fixture.sshConfigPath;
  const secondReceiptPath = join(
    fixture.homeDirectory,
    ".dawn-forge",
    "targets",
    secondAlias,
    "identity.json",
  );
  writeJson(secondReceiptPath, secondReceipt);
  const secondPreflight = JSON.parse(
    readFileSync(fixture.input.preflightReceiptPath, "utf8"),
  );
  secondPreflight.sshTrust.sshConfigSha256 =
    secondReceipt.sshConfigSha256;
  const secondPreflightPath = join(
    fixture.homeDirectory,
    "preflight-same-machine.json",
  );
  writeJson(secondPreflightPath, secondPreflight);
  const secondSchedule = JSON.parse(
    readFileSync(fixture.input.schedulePath, "utf8"),
  );
  secondSchedule.preflightSha256 = sha256(
    JSON.stringify(secondPreflight),
  );
  delete secondSchedule.scheduleSha256;
  secondSchedule.scheduleSha256 = sha256(
    JSON.stringify(secondSchedule),
  );
  const secondSchedulePath = join(
    fixture.homeDirectory,
    "schedule-same-machine.json",
  );
  writeJson(secondSchedulePath, secondSchedule);
  assert.throws(
    () =>
      prepareInstallationRun(
        {
          ...fixture.input,
          identityReceiptPath: secondReceiptPath,
          preflightReceiptPath: secondPreflightPath,
          schedulePath: secondSchedulePath,
        },
        fixture.dependencies,
      ),
    (error) =>
      error instanceof RunConflictError &&
      error.details.activeRunId === first.runId &&
      error.details.activeAlias === "mini",
  );
}

function testIdentityReceiptExecutionBindingsFailClosed() {
  for (const [index, field] of [
    "machineExecutionIdentitySha256",
    "identityFileSha256",
  ].entries()) {
    const fixture = makeFixture({
      actions: [automatedAction(`missing-binding-${index}`, "direct")],
    });
    const receipt = JSON.parse(
      readFileSync(fixture.input.identityReceiptPath, "utf8"),
    );
    delete receipt[field];
    writeJson(fixture.input.identityReceiptPath, receipt);
    assert.throws(
      () => prepareInstallationRun(fixture.input, fixture.dependencies),
      /identity receipt .* is invalid/i,
    );
    assert.equal(fixture.state.calls.createRun, 0);
  }
}

function testCanonicalPlanBundlePrepare() {
  const fixture = makeFixture({
    actions: [automatedAction("ripgrep", "direct")],
  });
  const bundleDirectory = join(fixture.homeDirectory, "plan-bundle");
  writeFixturePlanBundle(fixture, bundleDirectory);
  const prepared = prepareInstallationRun(
    { planBundlePath: bundleDirectory },
    fixture.dependencies,
  );
  assert.equal(prepared.kind, "prepared");
  assert.equal(
    dirname(dirname(prepared.statePath)),
    dirname(prepared.manifestPath),
  );
  const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8"));
  assert.equal(
    manifest.profile.path,
    join(dirname(prepared.manifestPath), "inputs", "profile.json"),
  );
  assert.equal(
    manifest.plan.path,
    join(dirname(prepared.manifestPath), "inputs", "plan.json"),
  );
  assert.deepEqual(
    parseInstallationRunCli(["prepare", "--plan", bundleDirectory]),
    {
      command: "prepare",
      values: { planBundlePath: bundleDirectory },
    },
  );
}

function testUnboundControllerCachePlanIsRejected() {
  const fixture = makeFixture({
    actions: [automatedAction("clash-verge-rev", "direct")],
  });
  const schedule = JSON.parse(
    readFileSync(fixture.input.schedulePath, "utf8"),
  );
  schedule.batches[0].items[0].routeEvidence.method =
    "controller-cache";
  delete schedule.scheduleSha256;
  schedule.scheduleSha256 = sha256(JSON.stringify(schedule));
  writeJson(fixture.input.schedulePath, schedule);
  const bundleDirectory = join(
    fixture.homeDirectory,
    "unbound-cache-plan-bundle",
  );
  writeFixturePlanBundle(fixture, bundleDirectory);
  assert.throws(
    () =>
      prepareInstallationRun(
        { planBundlePath: bundleDirectory },
        fixture.dependencies,
      ),
    (error) =>
      error.code === "UNBOUND_ARTIFACT_CACHE" &&
      error.details.softwareIds.join(",") === "clash-verge-rev",
  );
  assert.equal(fixture.state.calls.createRun, 0);
}

function writeFixturePlanBundle(fixture, bundleDirectory) {
  mkdirSync(bundleDirectory);
  for (const [source, name] of [
    [fixture.input.profilePath, "profile.json"],
    [fixture.input.identityReceiptPath, "identity.json"],
    [fixture.input.preflightReceiptPath, "preflight.json"],
    [fixture.input.schedulePath, "schedule.json"],
  ]) {
    writeFileSync(join(bundleDirectory, name), readFileSync(source));
  }
  const profileSha256 = sha256(
    readFileSync(join(bundleDirectory, "profile.json")),
  );
  const preflight = JSON.parse(
    readFileSync(join(bundleDirectory, "preflight.json"), "utf8"),
  );
  const schedule = JSON.parse(
    readFileSync(join(bundleDirectory, "schedule.json"), "utf8"),
  );
  writeJson(join(bundleDirectory, "plan.json"), {
    schemaVersion: 1,
    status: "planned",
    profile: { sha256: profileSha256 },
    target: {
      alias: "mini",
      targetIdentitySha256: fixture.targetIdentitySha256,
      machineExecutionIdentitySha256:
        fixture.machineExecutionIdentitySha256,
    },
    preflightSha256: sha256(JSON.stringify(preflight)),
    schedule,
    bundle: {
      schemaVersion: 1,
      files: {
        profile: "profile.json",
        identityReceipt: "identity.json",
        preflightReceipt: "preflight.json",
        schedule: "schedule.json",
      },
      profileSha256,
      targetIdentitySha256: fixture.targetIdentitySha256,
      machineExecutionIdentitySha256:
        fixture.machineExecutionIdentitySha256,
      preflightSha256: sha256(JSON.stringify(preflight)),
      scheduleSha256: schedule.scheduleSha256,
    },
  });
}

async function testDigestDriftFailsBeforeRunner() {
  const fixture = makeFixture({
    actions: [automatedAction("feishu", "direct")],
  });
  const prepared = prepareInstallationRun(fixture.input, fixture.dependencies);
  writeJson(
    join(dirname(dirname(prepared.statePath)), "inputs", "profile.json"),
    {
    id: "profile",
    software: [],
    changedAfterPrepare: true,
    },
  );
  await assert.rejects(
    advanceInstallationRun(prepared.runId, {}, fixture.dependencies),
    /profile digest drift/i,
  );
  assert.equal(fixture.runner.calls.length, 0);
}

async function testExpiredPreflightRequiresLocalReplan() {
  const expiredPrepareFixture = makeFixture({
    actions: [automatedAction("google-chrome", "direct")],
  });
  const expiredPrepare = prepareInstallationRun(
    expiredPrepareFixture.input,
    {
      ...expiredPrepareFixture.dependencies,
      now: () => "2026-07-23T12:31:00.001Z",
    },
  );
  assert.deepEqual(
    {
      kind: expiredPrepare.kind,
      reason: expiredPrepare.reason,
      maxAgeMs: expiredPrepare.maxAgeMs,
    },
    {
      kind: "replan-required",
      reason: "preflight-expired",
      maxAgeMs: 30 * 60 * 1000,
    },
  );
  assert.equal(expiredPrepareFixture.state.calls.createRun, 0);
  assert.equal(expiredPrepareFixture.runner.calls.length, 0);

  const fixture = makeFixture({
    actions: [automatedAction("stats", "direct")],
  });
  const prepared = prepareInstallationRun(fixture.input, fixture.dependencies);
  const result = await advanceInstallationRun(prepared.runId, {}, {
    ...fixture.dependencies,
    now: () => "2026-07-23T12:31:00.001Z",
  });
  assert.equal(result.kind, "replan-required");
  assert.equal(result.reason, "preflight-expired");
  assert.equal(fixture.runner.calls.length, 0);
}

async function testStartedRunDoesNotExpireOnWallClock() {
  const second = automatedAction("ripgrep", "direct");
  second.installer = "brew-formula";
  const fixture = makeFixture({
    actions: [automatedAction("google-chrome", "direct"), second],
  });
  const prepared = prepareInstallationRun(fixture.input, fixture.dependencies);
  const firstResult = await advanceInstallationRun(
    prepared.runId,
    {},
    fixture.dependencies,
  );
  assert.equal(firstResult.kind, "batch-finished");
  assert.equal(firstResult.status, "partial");
  assert.equal(fixture.runner.calls.length, 1);

  const continued = await advanceInstallationRun(prepared.runId, {}, {
    ...fixture.dependencies,
    now: () => "2026-07-23T20:00:00.000Z",
  });
  assert.equal(continued.kind, "batch-finished");
  assert.equal(continued.status, "completed");
  assert.equal(fixture.runner.calls.length, 2);
  const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8"));
  assert.equal(manifest.startedAt.startsWith("2026-07-23T12:00:"), true);
}

async function testRouteGateControlsRunnerArguments() {
  const fixture = makeFixture({
    initialRoutes: { controller: "direct", target: "direct" },
    actions: [automatedAction("chatgpt", "clash")],
  });
  const prepared = prepareInstallationRun(fixture.input, fixture.dependencies);
  const gate = await advanceInstallationRun(
    prepared.runId,
    {},
    fixture.dependencies,
  );
  assert.deepEqual(
    {
      kind: gate.kind,
      action: gate.action,
      location: gate.location,
      requiredRoute: gate.requiredRoute,
    },
    {
      kind: "user-action",
      action: "switch-route",
      location: "target",
      requiredRoute: "clash",
    },
  );
  assert.match(gate.gateToken, /^gate-[a-f0-9]{48}$/);
  assert.equal(fixture.runner.calls.length, 0);

  await assert.rejects(
    advanceInstallationRun(
      prepared.runId,
      { gateToken: `gate-${"0".repeat(48)}` },
      fixture.dependencies,
    ),
    /does not match/i,
  );
  assert.equal(fixture.runner.calls.length, 0);

  const result = await advanceInstallationRun(
    prepared.runId,
    { gateToken: gate.gateToken },
    fixture.dependencies,
  );
  assert.equal(result.kind, "batch-finished");
  assert.equal(result.status, "completed");
  assert.equal(fixture.runner.calls.length, 1);
  assert.deepEqual(
    {
      batchId: fixture.runner.calls[0].input.batchId,
      target: fixture.runner.calls[0].input.target,
      platform: fixture.runner.calls[0].input.platform,
      route: fixture.runner.calls[0].input.route,
      sshConfig: fixture.runner.calls[0].input.sshConfig,
      stateDir: fixture.runner.calls[0].input.stateDir,
      machineExecutionIdentitySha256:
        fixture.runner.calls[0].input.machineExecutionIdentitySha256,
      identityReceiptPath:
        fixture.runner.calls[0].input.identityReceiptPath,
    },
    {
      batchId: "batch-001",
      target: "mini",
      platform: "macos",
      route: "clash",
      sshConfig: fixture.sshConfigPath,
      stateDir: dirname(prepared.statePath),
      machineExecutionIdentitySha256:
        fixture.machineExecutionIdentitySha256,
      identityReceiptPath: fixture.input.identityReceiptPath,
    },
  );
  assert.equal(
    fixture.runner.calls[0].dependencies.signalSource.constructor.name,
    "EventEmitter",
  );
}

async function testManualGateRequiresBoundEvidenceReceipt() {
  const fixture = makeFixture({
    actions: [
      {
        softwareId: "clash-verge-rev",
        name: "Clash Verge Rev",
        installer: "brew-cask",
        package: "clash-verge-rev",
        version: "2.4.2",
        route: "direct",
        networkLocation: "target",
        executionMode: "manual-receipt",
        routeEvidence: {
          method: "target-probe",
          origins: ["formulae.brew.sh"],
          observedAt: "2026-07-23T12:00:00.000Z",
        },
        dependsOn: [],
        requiresGui: true,
      },
    ],
  });
  const prepared = prepareInstallationRun(fixture.input, fixture.dependencies);
  const gate = await advanceInstallationRun(
    prepared.runId,
    {},
    fixture.dependencies,
  );
  assert.equal(gate.kind, "user-action");
  assert.equal(gate.action, "run-verify-manual");
  assert.equal(gate.stepId, `manual:${prepared.runId}:batch-001`);
  assert.deepEqual(gate.reasons, ["manual-receipt", "requires-gui"]);
  assert.equal(fixture.runner.calls.length, 0);

  const receiptPath = join(fixture.homeDirectory, "manual-receipt.json");
  writeJson(receiptPath, {
    schemaVersion: 1,
    runId: prepared.runId,
    batchId: "batch-001",
    targetIdentitySha256: prepared.targetIdentitySha256,
    receipts: [
      {
        softwareId: "clash-verge-rev",
        evidenceType: "macos-bundle-signature",
        evidenceSha256: "d".repeat(64),
      },
    ],
  });
  const verifierCalls = [];
  const verified = await verifyManualInstallation(prepared.runId, {
    ...fixture.dependencies,
    verifyManualBatch: async (request) => {
      verifierCalls.push(request);
      return {
        status: "verified",
        results: [
          {
            softwareId: "clash-verge-rev",
            adapter: "macos-brew-cask",
            status: "verified",
            observedVersion: "2.4.2",
            evidence: {
              gatekeeper: "accepted",
              codeSignature: "valid",
              bundleIdentifier: "com.clash-verge-rev",
            },
          },
        ],
      };
    },
  });
  assert.equal(verified.kind, "manual-recorded");
  assert.equal(verified.status, "completed");
  assert.equal(verifierCalls.length, 1);
  assert.equal(
    readFileSync(
      join(
        dirname(dirname(prepared.statePath)),
        "receipts",
        "batch-001.json",
      ),
      "utf8",
    ).length > 0,
    true,
  );
  assert.equal(fixture.state.calls.recordManualReceipt, 1);
  assert.equal(fixture.runner.calls.length, 0);
}

async function testUnknownManualAdapterCannotReleaseDependencies() {
  const fixture = makeFixture({
    actions: [
      {
        softwareId: "account-setup",
        name: "Account setup",
        installer: "manual",
        package: "account-setup",
        version: "latest-stable",
        route: "local",
        networkLocation: "none",
        executionMode: "manual-receipt",
        routeEvidence: {
          method: "no-network",
          origins: [],
        },
        dependsOn: [],
        requiresGui: true,
      },
    ],
  });
  const prepared = prepareInstallationRun(fixture.input, fixture.dependencies);
  const gate = await advanceInstallationRun(
    prepared.runId,
    {},
    fixture.dependencies,
  );
  assert.equal(gate.action, "run-verify-manual");
  let verifierCalls = 0;
  const result = await verifyManualInstallation(prepared.runId, {
    ...fixture.dependencies,
    verifyManualBatch: async () => {
      verifierCalls += 1;
      return { status: "verified", results: [] };
    },
  });
  assert.equal(result.kind, "manual-pending");
  assert.equal(result.reason, "unsupported-manual-verifier");
  assert.equal(result.releasesDependencies, false);
  assert.equal(verifierCalls, 0);
  assert.equal(fixture.state.calls.recordManualReceipt, 0);
}

function testDefaultStateModuleIntegration() {
  const fixture = makeFixture({
    actions: [automatedAction("iterm2", "direct")],
  });
  const dependencies = {
    homeDirectory: fixture.homeDirectory,
    now: fixture.dependencies.now,
    runBatch: fixture.runner.runBatch,
  };
  const prepared = prepareInstallationRun(fixture.input, dependencies);
  const observed = observeInstallationRun(prepared.runId, dependencies);
  assert.equal(observed.kind, "observed");
  assert.equal(observed.status, "prepared");
  assert.equal(observed.summary.total, 1);
  assert.equal(observed.summary.pending, 1);
  assert.equal(
    JSON.parse(readFileSync(prepared.statePath, "utf8")).items[0]
      .executionMode,
    "automated",
  );
}

function testObserveReadsOnlyManifestAndState() {
  const fixture = makeFixture({
    actions: [automatedAction("maccy", "direct")],
  });
  const prepared = prepareInstallationRun(fixture.input, fixture.dependencies);
  const readsBefore = fixture.state.calls.readRun;
  writeFileSync(fixture.input.profilePath, "not-json-anymore", "utf8");
  writeFileSync(fixture.input.schedulePath, "not-json-anymore", "utf8");

  const observed = observeInstallationRun(
    prepared.runId,
    fixture.dependencies,
  );
  assert.equal(observed.kind, "observed");
  assert.equal(observed.freshness.source, "controller-local-state");
  assert.equal(fixture.state.calls.readRun, readsBefore + 1);
  assert.equal(fixture.runner.calls.length, 0);
  assert.equal(fixture.state.calls.requestCancel, 0);
  assert.equal(fixture.state.calls.recordManualReceipt, 0);
}

async function testCancelPersistsIntentAndUsesOnlyOwnedHandle() {
  const fixture = makeFixture({
    actions: [automatedAction("orbstack", "direct")],
  });
  const prepared = prepareInstallationRun(fixture.input, fixture.dependencies);
  const stored = fixture.state.mutable(prepared.statePath);
  stored.status = "running";
  stored.activeAttempt = {
    batchId: "batch-001",
    attemptId: "attempt-owned",
    ownedProcessToken: "process-owned",
    startedAt: "2026-07-23T12:00:00.000Z",
  };
  stored.revision += 1;
  const pending = await cancelInstallationRun(
    prepared.runId,
    fixture.dependencies,
  );
  assert.equal(pending.kind, "cancel-unavailable");
  assert.equal(pending.status, "running");
  assert.equal(pending.action, "interrupt-owning-advance-session");
  assert.equal(pending.ownership, "foreground-advance-session-only");
  assert.equal(pending.stateChanged, false);
  assert.equal(fixture.state.calls.requestCancel, 0);
  assert.equal(stored.cancel, null);

  const idleFixture = makeFixture({
    actions: [automatedAction("stats", "direct")],
  });
  const idlePrepared = prepareInstallationRun(
    idleFixture.input,
    idleFixture.dependencies,
  );
  const cancelled = await cancelInstallationRun(
    idlePrepared.runId,
    idleFixture.dependencies,
  );
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.status, "cancelled");
}

async function testInProcessOwnedCancellationHandshake() {
  const fixture = makeFixture({
    actions: [automatedAction("visual-studio-code", "direct")],
  });
  let announceStarted;
  const started = new Promise((resolveStarted) => {
    announceStarted = resolveStarted;
  });
  const order = [];
  const dependencies = {
    ...fixture.dependencies,
    runBatch: async (input, runnerDependencies) => {
      const statePath = join(
        input.stateDir,
        `${stateRunKey(input)}.json`,
      );
      const stored = fixture.state.mutable(statePath);
      stored.activeAttempt = {
        batchId: input.batchId,
        attemptId: "attempt-live",
        ownedProcessToken: "process-live",
        startedAt: "2026-07-23T12:02:00.000Z",
      };
      stored.status = "running";
      stored.revision += 1;
      announceStarted();
      return new Promise((resolveRunner) => {
        runnerDependencies.signalSource.on("SIGTERM", () => {
          assert.equal(
            stored.cancel,
            null,
            "the owned runner, not a stale orchestrator revision, writes intent",
          );
          stored.cancel = {
            status: "pending",
            requestedAt: "2026-07-23T12:02:01.000Z",
            batchId: input.batchId,
            attemptId: "attempt-live",
            ownedProcessToken: "process-live",
          };
          order.push("intent");
          order.push("owned-process-signal");
          stored.cancel = {
            ...stored.cancel,
            status: "confirmed",
            confirmedAt: "2026-07-23T12:02:02.000Z",
          };
          stored.activeAttempt = null;
          stored.status = "cancelled";
          stored.revision += 1;
          resolveRunner(structuredClone(stored));
        });
      });
    },
  };
  const prepared = prepareInstallationRun(fixture.input, dependencies);
  const advancing = advanceInstallationRun(prepared.runId, {}, dependencies);
  await started;
  const cancelled = await cancelInstallationRun(
    prepared.runId,
    dependencies,
  );
  const advanceResult = await advancing;
  assert.deepEqual(order, ["intent", "owned-process-signal"]);
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(advanceResult.kind, "cancelled");
  assert.equal(fixture.state.calls.requestCancel, 0);
}

async function testForegroundSignalBridgeReachesOwnedRunner() {
  const fixture = makeFixture({
    actions: [automatedAction("visual-studio-code", "direct")],
  });
  const prepared = prepareInstallationRun(fixture.input, fixture.dependencies);
  let announceReady;
  const ready = new Promise((resolveReady) => {
    announceReady = resolveReady;
  });
  let received = 0;
  const dependencies = {
    ...fixture.dependencies,
    runBatch(input, runnerDependencies) {
      return new Promise((resolveRunner) => {
        runnerDependencies.signalSource.once("SIGINT", async () => {
          received += 1;
          resolveRunner(
            await fixture.runner.runBatch(input, runnerDependencies),
          );
        });
        announceReady();
      });
    },
  };
  const advancing = advanceInstallationRun(
    prepared.runId,
    {},
    dependencies,
  );
  await ready;
  dependencies.signalSource.emit("SIGINT");
  const result = await advancing;
  assert.equal(result.kind, "batch-finished");
  assert.equal(received, 1);
  assert.equal(dependencies.signalSource.listenerCount("SIGINT"), 0);
  assert.equal(dependencies.signalSource.listenerCount("SIGTERM"), 0);
}

function testStrictCliAndNoPollingOrDetachedWork() {
  assert.deepEqual(
    parseInstallationRunCli(["observe", "--run-id", `run-mini-${"a".repeat(32)}`]),
    {
      command: "observe",
      values: { runId: `run-mini-${"a".repeat(32)}` },
    },
  );
  assert.throws(
    () =>
      parseInstallationRunCli([
        "advance",
        "--run-id",
        `run-mini-${"a".repeat(32)}`,
        "--target",
        "attacker",
      ]),
    /unknown argument/i,
  );
  assert.throws(
    () => parseInstallationRunCli(["cancel", "--run-id"]),
    /unknown subcommand/i,
  );

  const source = readFileSync(
    new URL(
      "../skills/dawn-forge/scripts/installation-run.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /\b(?:setTimeout|setInterval|sleep)\s*\(/);
  assert.doesNotMatch(source, /\bdetached\s*:/);
  assert.doesNotMatch(source, /\b(?:ssh|brew|winget|pgrep)\b.*\bobserve\b/i);

  for (const script of [
    "../skills/dawn-forge/scripts/installation-batches.mjs",
    "../skills/dawn-forge/scripts/run-installation-batch.mjs",
  ]) {
    const scriptPath = fileURLToPath(new URL(script, import.meta.url));
    const internalSource = readFileSync(scriptPath, "utf8");
    assert.match(internalSource, /"USE_INSTALLATION_RUN"/);
    assert.doesNotMatch(internalSource, /function\s+runCli\s*\(/);
    const direct = spawnSync(
      process.execPath,
      [scriptPath],
      { encoding: "utf8", windowsHide: true },
    );
    if (["ENOENT", "EPERM"].includes(direct.error?.code)) continue;
    assert.equal(direct.status, 2);
    assert.deepEqual(JSON.parse(direct.stderr), {
      kind: "internal-only",
      code: "USE_INSTALLATION_RUN",
      message:
        script.includes("installation-batches")
          ? "installation-batches.mjs is an internal module; use plan-installation.mjs and installation-run.mjs."
          : "run-installation-batch.mjs is an internal module; use installation-run.mjs advance.",
    });
  }
}

function makeFixture({
  actions,
  initialRoutes = { controller: "direct", target: "direct" },
}) {
  const homeDirectory = resolve(
    mkdtempSync(join(tmpdir(), "dawn-forge-installation-run-")),
  );
  temporaryRoots.push(homeDirectory);
  const sshConfigPath = join(homeDirectory, ".ssh", "config");
  const identityFile = join(homeDirectory, ".ssh", "id_ed25519");
  const knownHostsPath = join(
    homeDirectory,
    ".ssh",
    "dawn-forge-known-hosts",
  );
  writeFile(
    sshConfigPath,
    [
      "# >>> Dawn Forge: mini >>>",
      "Host mini",
      "  HostName mac-mini.local",
      "  User wangxiao",
      `  IdentityFile ${join(homeDirectory, ".ssh", "id_ed25519")}`,
      "  IdentitiesOnly yes",
      "# <<< Dawn Forge: mini <<<",
      "",
    ].join("\n"),
  );
  writeFile(identityFile, "fixture-private-key");
  writeFile(
    knownHostsPath,
    "mac-mini.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture\n",
  );
  const identity = {
    user: "wangxiao",
    os: "Darwin",
    architecture: "arm64",
    machineId: "11111111-2222-3333-4444-555555555555",
  };
  const hostKeyFingerprints = [
    "SHA256:ZF4i/P0s7JMXTiebWcxawuCgI0UZ+TV+rtxjWZFEwUQ",
  ];
  const targetIdentitySha256 = targetIdentityDigest({
    platform: "macos",
    user: identity.user,
    os: identity.os,
    architecture: identity.architecture,
    machineId: identity.machineId,
    hostKeyFingerprints,
  });
  const machineExecutionIdentitySha256 = machineExecutionIdentityDigest({
    platform: "macos",
    machineId: identity.machineId,
    hostKeyFingerprints,
  });
  const identityReceiptPath = join(
    homeDirectory,
    ".dawn-forge",
    "targets",
    "mini",
    "identity.json",
  );
  writeJson(identityReceiptPath, {
    schemaVersion: 1,
    finalizedAt: "2026-07-23T11:00:00.000Z",
    finalized: true,
    platform: "macos",
    host: "mac-mini.local",
    user: "wangxiao",
    alias: "mini",
    identityFile,
    identityFileSha256: sha256(readFileSync(identityFile)),
    keyFingerprint: "SHA256:controller",
    hostKeyFingerprints,
    sshConfigPath,
    sshConfigSha256: sha256(readFileSync(sshConfigPath)),
    knownHostsPath,
    knownHostsSha256: sha256(readFileSync(knownHostsPath)),
    targetIdentitySha256,
    machineExecutionIdentitySha256,
    identity,
    sshConfig: {
      path: sshConfigPath,
      changed: false,
      backup: null,
    },
  });
  const profilePath = join(homeDirectory, "profile.json");
  writeJson(profilePath, { id: "profile", platform: "macos", software: [] });
  const preflightReceipt = {
    schemaVersion: 1,
    protocol: "dawn-forge-preflight-v1",
    observedAt: "2026-07-23T12:00:00.000Z",
    profileSha256: sha256(readFileSync(profilePath)),
    targetIdentitySha256,
    machineExecutionIdentitySha256,
    initialRoutes,
    target: { platform: "macos", architecture: "arm64" },
    sshTrust: {
      identityFileSha256: sha256(readFileSync(identityFile)),
      sshConfigSha256: sha256(readFileSync(sshConfigPath)),
      knownHostsSha256: sha256(readFileSync(knownHostsPath)),
    },
    inventory: {},
    targetMetadata: [],
    targetProbes: [],
    controllerProbes: [],
  };
  const preflightReceiptPath = join(homeDirectory, "preflight.json");
  writeJson(preflightReceiptPath, preflightReceipt);
  const schedule = createInstallationSchedule(actions, {
    initialRoutes,
    preflightSha256: sha256(JSON.stringify(preflightReceipt)),
    machineExecutionIdentitySha256,
  });
  const schedulePath = join(homeDirectory, "schedule.json");
  writeJson(schedulePath, schedule);
  const state = createMockState();
  const runner = createMockRunner(state);
  let tick = 0;
  const dependencies = {
    homeDirectory,
    now: () =>
      `2026-07-23T12:00:${String(tick++).padStart(2, "0")}.000Z`,
    state,
    runBatch: runner.runBatch,
    signalSource: new EventEmitter(),
  };
  return {
    homeDirectory,
    sshConfigPath,
    targetIdentitySha256,
    machineExecutionIdentitySha256,
    input: {
      profilePath,
      identityReceiptPath,
      preflightReceiptPath,
      schedulePath,
    },
    dependencies,
    state,
    runner,
  };
}

function automatedAction(softwareId, route) {
  return {
    softwareId,
    name: softwareId,
    installer: "brew-cask",
    package: softwareId,
    version: "latest-stable",
    route,
    networkLocation: "target",
    executionMode: "automated",
    routeEvidence: {
      method: "target-probe",
      origins: ["formulae.brew.sh"],
      observedAt: "2026-07-23T12:00:00.000Z",
    },
    dependsOn: [],
  };
}

function createMockState() {
  const states = new Map();
  const calls = {
    createRun: 0,
    readRun: 0,
    requestCancel: 0,
    recordManualReceipt: 0,
    assertBatchRunnable: 0,
  };
  const clone = (value) => structuredClone(value);
  function refresh(state) {
    const completed = state.items.filter(
      (item) => item.phases.verify.status === "succeeded",
    ).length;
    state.summary = {
      total: state.items.length,
      pending: state.items.length - completed,
      inProgress: 0,
      partial: 0,
      completed,
      failed: 0,
      notVerified: 0,
    };
    if (state.cancel?.status === "pending") state.status = "cancel-pending";
    else if (state.cancel?.status === "confirmed") state.status = "cancelled";
    else if (state.activeAttempt !== null) state.status = "running";
    else if (completed === state.items.length) state.status = "completed";
    else state.status = "prepared";
  }
  return {
    calls,
    createRun(identity, options) {
      calls.createRun += 1;
      if (states.has(identity.statePath)) throw new Error("state exists");
      const now = "2026-07-23T12:00:00.000Z";
      const state = {
        schemaVersion: 1,
        ...identity,
        revision: 1,
        status: "prepared",
        createdAt: now,
        updatedAt: now,
        activeAttempt: null,
        cancel: null,
        lastAttemptOutcome: null,
        items: options.items.map((item) => ({
          ...clone(item),
          status: "pending",
          phases: {
            fetch: { status: "pending" },
            install: { status: "pending" },
            verify: { status: "pending" },
          },
        })),
        summary: {
          total: options.items.length,
          pending: options.items.length,
          inProgress: 0,
          partial: 0,
          completed: 0,
          failed: 0,
          notVerified: 0,
        },
      };
      states.set(identity.statePath, state);
      return clone(state);
    },
    readRun(identity) {
      calls.readRun += 1;
      const state = states.get(identity.statePath);
      if (!state) throw new Error("state missing");
      for (const key of [
        "runId",
        "scheduleSha256",
        "profileSha256",
        "targetIdentitySha256",
      ]) {
        if (state[key] !== identity[key]) throw new Error(`${key} drift`);
      }
      return clone(state);
    },
    requestCancel(identity, options) {
      calls.requestCancel += 1;
      const state = states.get(identity.statePath);
      assert.equal(options.expectedRevision, state.revision);
      if (state.cancel === null) {
        state.cancel =
          state.activeAttempt === null
            ? {
                status: "confirmed",
                requestedAt: "2026-07-23T12:01:00.000Z",
                confirmedAt: "2026-07-23T12:01:00.000Z",
              }
            : {
                status: "pending",
                requestedAt: "2026-07-23T12:01:00.000Z",
                batchId: state.activeAttempt.batchId,
                attemptId: state.activeAttempt.attemptId,
                ownedProcessToken: state.activeAttempt.ownedProcessToken,
              };
        state.revision += 1;
        refresh(state);
      }
      return clone(state);
    },
    recordManualReceipt(identity, receipt, options) {
      calls.recordManualReceipt += 1;
      const state = states.get(identity.statePath);
      assert.equal(options.expectedRevision, state.revision);
      const item = state.items.find(
        (candidate) => candidate.softwareId === receipt.softwareId,
      );
      item.phases = {
        fetch: { status: "not-applicable" },
        install: { status: "succeeded" },
        verify: {
          status: "succeeded",
          evidenceType: receipt.evidenceType,
          evidenceSha256: receipt.evidenceSha256,
        },
      };
      item.status = "completed";
      state.revision += 1;
      refresh(state);
      return clone(state);
    },
    assertBatchRunnable(state, batchId) {
      calls.assertBatchRunnable += 1;
      if (state.activeAttempt !== null || state.cancel !== null) {
        throw new Error("run is not idle");
      }
      const byId = new Map(
        state.items.map((item) => [item.softwareId, item]),
      );
      for (const item of state.items.filter(
        (candidate) => candidate.batchId === batchId,
      )) {
        for (const dependencyId of item.dependsOn) {
          if (byId.get(dependencyId)?.status !== "completed") {
            throw new Error(`dependency ${dependencyId} not complete`);
          }
        }
      }
      return true;
    },
    mutable(statePath) {
      return states.get(statePath);
    },
  };
}

function createMockRunner(state) {
  const calls = [];
  return {
    calls,
    async runBatch(input, dependencies) {
      calls.push({ input: structuredClone(input), dependencies });
      const statePath = join(
        input.stateDir,
        `${stateRunKey(input)}.json`,
      );
      const stored = state.mutable(statePath);
      for (const item of stored.items.filter(
        (candidate) => candidate.batchId === input.batchId,
      )) {
        item.phases = {
          fetch: { status: "succeeded" },
          install: { status: "succeeded" },
          verify: { status: "succeeded" },
        };
        item.status = "completed";
      }
      stored.revision += 1;
      const completed = stored.items.filter(
        (item) => item.status === "completed",
      ).length;
      stored.summary = {
        total: stored.items.length,
        pending: stored.items.length - completed,
        inProgress: 0,
        partial: 0,
        completed,
        failed: 0,
        notVerified: 0,
      };
      stored.status =
        completed === stored.items.length ? "completed" : "partial";
      return structuredClone(stored);
    },
  };
}

function writeJson(path, value) {
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stateRunKey(input) {
  return sha256(
    JSON.stringify({
      scheduleSha256: input.schedule.scheduleSha256,
      preflightSha256: input.schedule.preflightSha256,
      profileSha256: input.profileSha256,
      targetIdentitySha256: input.targetIdentitySha256,
      platform: input.platform,
    }),
  ).slice(0, 32);
}
