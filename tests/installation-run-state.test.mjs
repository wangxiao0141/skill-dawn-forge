import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertBatchRunnable,
  createRun,
  readRun,
  recordEvent as recordEventWithCas,
  recordManualReceipt as recordManualReceiptWithCas,
  requestCancel as requestCancelWithCas,
} from "../skills/dawn-forge/scripts/installation-run-state.mjs";

const tempRoot = resolve(mkdtempSync(join(tmpdir(), "dawn-forge-run-state-")));
const statePath = join(tempRoot, "run.json");
const identity = {
  statePath,
  runId: "run-20260723-001",
  scheduleSha256: "a".repeat(64),
  profileSha256: "b".repeat(64),
  targetIdentitySha256: "e".repeat(64),
};

function recordEvent(runIdentity, event) {
  const state = readRun(runIdentity);
  return recordEventWithCas(runIdentity, event, {
    expectedRevision: state.revision,
  });
}

function requestCancel(runIdentity) {
  const state = readRun(runIdentity);
  return requestCancelWithCas(runIdentity, {
    expectedRevision: state.revision,
  });
}

function recordManualReceipt(runIdentity, receipt) {
  const state = readRun(runIdentity);
  return recordManualReceiptWithCas(runIdentity, receipt, {
    expectedRevision: state.revision,
  });
}

try {
  const created = createRun(identity, {
    items: [
      {
        softwareId: "wechat",
        batchId: "batch-001",
        dependsOn: [],
        executionMode: "automated",
      },
      {
        softwareId: "feishu",
        batchId: "batch-001",
        dependsOn: [],
        executionMode: "automated",
      },
    ],
  });

  assert.equal(created.status, "prepared");
  assert.equal(created.revision, 1);
  assert.deepEqual(created.summary, {
    total: 2,
    pending: 2,
    inProgress: 0,
    partial: 0,
    completed: 0,
    failed: 0,
    notVerified: 0,
  });
  assert.ok(readdirSync(tempRoot).every((name) => !name.endsWith(".tmp")));

  const observed = readRun(identity);
  assert.equal(observed.runId, identity.runId);
  assert.equal(observed.scheduleSha256, identity.scheduleSha256);
  assert.equal(observed.profileSha256, identity.profileSha256);
  assert.equal(
    observed.targetIdentitySha256,
    identity.targetIdentitySha256,
  );
  assert.deepEqual(observed.items[0].phases, {
    fetch: { status: "pending" },
    install: { status: "pending" },
    verify: { status: "pending" },
  });

  assert.throws(
    () =>
      recordEvent(identity, {
        type: "phase-started",
        softwareId: "wechat",
        phase: "install",
        attemptId: "attempt-001",
      }),
    /active attempt/,
  );

  recordEvent(identity, {
    type: "attempt-started",
    batchId: "batch-001",
    attemptId: "attempt-001",
    ownedProcessToken: "process-9f32a6fd",
  });
  let state = readRun(identity);
  assert.deepEqual(state.activeAttempt, {
    batchId: "batch-001",
    attemptId: "attempt-001",
    ownedProcessToken: "process-9f32a6fd",
    startedAt: state.activeAttempt.startedAt,
  });
  assert.equal(state.status, "running");

  for (const phase of ["fetch", "install", "verify"]) {
    recordEvent(identity, {
      type: "phase-started",
      softwareId: "wechat",
      phase,
      attemptId: "attempt-001",
    });
    state = readRun(identity);
    assert.notEqual(
      state.items.find((item) => item.softwareId === "wechat").status,
      "completed",
    );
    recordEvent(identity, {
      type: "phase-succeeded",
      softwareId: "wechat",
      phase,
      attemptId: "attempt-001",
    });
  }

  state = readRun(identity);
  assert.equal(
    state.items.find((item) => item.softwareId === "wechat").status,
    "completed",
  );

  for (const phase of ["fetch", "install", "verify"]) {
    recordEvent(identity, {
      type: "phase-started",
      softwareId: "feishu",
      phase,
      attemptId: "attempt-001",
    });
    recordEvent(identity, {
      type: phase === "verify" ? "phase-failed" : "phase-succeeded",
      softwareId: "feishu",
      phase,
      attemptId: "attempt-001",
      ...(phase === "verify"
        ? { reasonCode: "bundle-not-found", exitCode: 1 }
        : {}),
    });
  }

  recordEvent(identity, {
    type: "attempt-exited",
    attemptId: "attempt-001",
    ownedProcessToken: "process-9f32a6fd",
    outcome: "failed",
    exitCode: 1,
    reasonCode: "verification-failed",
  });

  state = readRun(identity);
  assert.equal(state.activeAttempt, null);
  assert.equal(state.status, "partial");
  assert.deepEqual(state.summary, {
    total: 2,
    pending: 0,
    inProgress: 0,
    partial: 0,
    completed: 1,
    failed: 1,
    notVerified: 0,
  });
  assert.equal(
    state.items.find((item) => item.softwareId === "feishu").phases.install
      .status,
    "succeeded",
  );
  assert.equal(
    state.items.find((item) => item.softwareId === "feishu").phases.verify
      .status,
    "failed",
  );

  const cancellationIdentity = {
    ...identity,
    statePath: join(tempRoot, "cancel.json"),
    runId: "run-20260723-002",
  };
  createRun(cancellationIdentity, {
    items: [
      {
        softwareId: "wechat",
        batchId: "batch-002",
        dependsOn: [],
        executionMode: "automated",
      },
      {
        softwareId: "feishu",
        batchId: "batch-002",
        dependsOn: [],
        executionMode: "automated",
      },
    ],
  });
  recordEvent(cancellationIdentity, {
    type: "attempt-started",
    batchId: "batch-002",
    attemptId: "attempt-002",
    ownedProcessToken: "process-4d7c2a10",
  });
  for (const phase of ["fetch", "install", "verify"]) {
    recordEvent(cancellationIdentity, {
      type: "phase-started",
      softwareId: "wechat",
      phase,
      attemptId: "attempt-002",
    });
    recordEvent(cancellationIdentity, {
      type: "phase-succeeded",
      softwareId: "wechat",
      phase,
      attemptId: "attempt-002",
    });
  }
  recordEvent(cancellationIdentity, {
    type: "phase-started",
    softwareId: "feishu",
    phase: "fetch",
    attemptId: "attempt-002",
  });

  const cancelPending = requestCancel(cancellationIdentity);
  assert.equal(cancelPending.status, "cancel-pending");
  assert.equal(cancelPending.cancel.status, "pending");
  assert.deepEqual(
    {
      batchId: cancelPending.cancel.batchId,
      attemptId: cancelPending.cancel.attemptId,
      ownedProcessToken: cancelPending.cancel.ownedProcessToken,
    },
    {
      batchId: "batch-002",
      attemptId: "attempt-002",
      ownedProcessToken: "process-4d7c2a10",
    },
  );

  assert.throws(
    () =>
      recordEvent(cancellationIdentity, {
        type: "phase-succeeded",
        softwareId: "feishu",
        phase: "fetch",
        attemptId: "attempt-002",
      }),
    /cancellation is pending/,
  );
  assert.throws(
    () =>
      recordEvent(cancellationIdentity, {
        type: "phase-failed",
        softwareId: "feishu",
        phase: "fetch",
        attemptId: "attempt-002",
        reasonCode: "cancel-requested",
      }),
    /cancellation is pending/,
  );
  assert.equal(readRun(cancellationIdentity).status, "cancel-pending");

  assert.throws(
    () =>
      recordEvent(cancellationIdentity, {
        type: "attempt-exited",
        attemptId: "attempt-002",
        ownedProcessToken: "process-wrong",
        outcome: "cancelled",
      }),
    /does not match/,
  );
  assert.equal(readRun(cancellationIdentity).status, "cancel-pending");

  assert.throws(
    () =>
      recordEvent(cancellationIdentity, {
        type: "attempt-exited",
        attemptId: "attempt-002",
        ownedProcessToken: "process-4d7c2a10",
        outcome: "cancelled",
      }),
    /cancellation acknowledgement is required/,
  );
  assert.equal(readRun(cancellationIdentity).status, "cancel-pending");

  assert.throws(
    () =>
      recordEvent(cancellationIdentity, {
        type: "cancellation-acknowledged",
        attemptId: "attempt-002",
        ownedProcessToken: "process-wrong",
      }),
    /does not match/,
  );
  const acknowledged = recordEvent(cancellationIdentity, {
    type: "cancellation-acknowledged",
    attemptId: "attempt-002",
    ownedProcessToken: "process-4d7c2a10",
  });
  assert.equal(acknowledged.status, "cancel-pending");
  assert.match(acknowledged.cancel.acknowledgedAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.throws(
    () =>
      recordEvent(cancellationIdentity, {
        type: "attempt-exited",
        attemptId: "attempt-002",
        ownedProcessToken: "process-4d7c2a10",
        outcome: "succeeded",
      }),
    /cannot succeed after cancellation/,
  );
  recordEvent(cancellationIdentity, {
    type: "attempt-exited",
    attemptId: "attempt-002",
    ownedProcessToken: "process-4d7c2a10",
    outcome: "cancelled",
  });
  const cancelled = readRun(cancellationIdentity);
  assert.equal(cancelled.activeAttempt, null);
  assert.equal(cancelled.cancel.status, "confirmed");
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.summary, {
    total: 2,
    pending: 0,
    inProgress: 0,
    partial: 0,
    completed: 1,
    failed: 0,
    notVerified: 1,
  });
  assert.equal(
    cancelled.items.find((item) => item.softwareId === "wechat").status,
    "completed",
  );
  assert.equal(
    cancelled.items.find((item) => item.softwareId === "feishu").status,
    "not-verified",
  );
  assert.equal(
    cancelled.items.find((item) => item.softwareId === "feishu").phases.fetch
      .status,
    "interrupted",
  );
  assert.throws(
    () => assertBatchRunnable(cancelled, "batch-002"),
    /after cancellation was requested/,
  );

  const failedOnlyIdentity = {
    ...identity,
    statePath: join(tempRoot, "failed-only.json"),
    runId: "run-20260723-failed-only",
  };
  createRun(failedOnlyIdentity, {
    items: [
      {
        softwareId: "wechat",
        batchId: "batch-failed-only",
        dependsOn: [],
        executionMode: "automated",
      },
    ],
  });
  recordEvent(failedOnlyIdentity, {
    type: "attempt-started",
    batchId: "batch-failed-only",
    attemptId: "attempt-failed-only",
    ownedProcessToken: "process-failed-only",
  });
  recordEvent(failedOnlyIdentity, {
    type: "phase-started",
    softwareId: "wechat",
    phase: "fetch",
    attemptId: "attempt-failed-only",
  });
  recordEvent(failedOnlyIdentity, {
    type: "phase-failed",
    softwareId: "wechat",
    phase: "fetch",
    attemptId: "attempt-failed-only",
    reasonCode: "download-failed",
  });
  recordEvent(failedOnlyIdentity, {
    type: "attempt-exited",
    attemptId: "attempt-failed-only",
    ownedProcessToken: "process-failed-only",
    outcome: "failed",
    reasonCode: "download-failed",
  });
  assert.equal(readRun(failedOnlyIdentity).status, "failed");

  const invariantIdentity = {
    ...identity,
    statePath: join(tempRoot, "attempt-invariants.json"),
    runId: "run-20260723-attempt-invariants",
  };
  createRun(invariantIdentity, {
    items: [
      {
        softwareId: "wechat",
        batchId: "batch-invariants",
        dependsOn: [],
        executionMode: "automated",
      },
    ],
  });
  recordEvent(invariantIdentity, {
    type: "attempt-started",
    batchId: "batch-invariants",
    attemptId: "attempt-invariants",
    ownedProcessToken: "process-invariants",
  });
  assert.throws(
    () =>
      recordEvent(invariantIdentity, {
        type: "attempt-exited",
        attemptId: "attempt-invariants",
        ownedProcessToken: "process-invariants",
        outcome: "succeeded",
      }),
    /all automated batch items are verified/,
  );
  assert.throws(
    () =>
      recordEvent(invariantIdentity, {
        type: "attempt-exited",
        attemptId: "attempt-invariants",
        ownedProcessToken: "process-invariants",
        outcome: "cancelled",
      }),
    /requires a matching cancellation/,
  );
  assert.throws(
    () =>
      recordEvent(invariantIdentity, {
        type: "attempt-exited",
        attemptId: "attempt-invariants",
        ownedProcessToken: "process-invariants",
        outcome: "failed",
      }),
    /requires failed phase or exit evidence/,
  );
  recordEvent(invariantIdentity, {
    type: "attempt-exited",
    attemptId: "attempt-invariants",
    ownedProcessToken: "process-invariants",
    outcome: "failed",
    reasonCode: "driver-exited",
  });

  const dagIdentity = {
    ...identity,
    statePath: join(tempRoot, "dag.json"),
    runId: "run-20260723-dag",
  };
  let dagState = createRun(dagIdentity, {
    items: [
      {
        softwareId: "winget-base",
        batchId: "batch-dag-001",
        dependsOn: [],
        executionMode: "automated",
      },
      {
        softwareId: "developer-app",
        batchId: "batch-dag-002",
        dependsOn: ["winget-base"],
        executionMode: "automated",
      },
      {
        softwareId: "developer-plugin",
        batchId: "batch-dag-003",
        dependsOn: ["developer-app"],
        executionMode: "automated",
      },
    ],
  });
  assert.deepEqual(
    dagState.items.map((item) => ({
      softwareId: item.softwareId,
      dependsOn: item.dependsOn,
    })),
    [
      { softwareId: "winget-base", dependsOn: [] },
      { softwareId: "developer-app", dependsOn: ["winget-base"] },
      { softwareId: "developer-plugin", dependsOn: ["developer-app"] },
    ],
  );
  assert.equal(assertBatchRunnable(dagState, "batch-dag-001"), true);
  assert.throws(
    () => assertBatchRunnable(dagState, "batch-dag-002"),
    /blocked by dependency winget-base \(pending\)/,
  );
  assert.throws(
    () => assertBatchRunnable(dagState, "batch-does-not-exist"),
    /Unknown installation batch/,
  );
  assert.throws(
    () =>
      recordEvent(dagIdentity, {
        type: "attempt-started",
        batchId: "batch-dag-002",
        attemptId: "attempt-bypass",
        ownedProcessToken: "process-bypass",
      }),
    /blocked by dependency winget-base \(pending\)/,
  );

  recordEvent(dagIdentity, {
    type: "attempt-started",
    batchId: "batch-dag-001",
    attemptId: "attempt-dag-001",
    ownedProcessToken: "process-dag-001",
  });
  assert.throws(
    () => assertBatchRunnable(readRun(dagIdentity), "batch-dag-001"),
    /active installation attempt/,
  );
  assert.throws(
    () =>
      recordEvent(dagIdentity, {
        type: "phase-not-applicable",
        softwareId: "winget-base",
        phase: "verify",
        attemptId: "attempt-dag-001",
        reasonCode: "metadata-only",
      }),
    /verify phase cannot be not-applicable/,
  );
  dagState = recordEvent(dagIdentity, {
    type: "phase-not-applicable",
    softwareId: "winget-base",
    phase: "fetch",
    attemptId: "attempt-dag-001",
    reasonCode: "metadata-only",
  });
  assert.equal(
    dagState.items.find((item) => item.softwareId === "winget-base").phases
      .fetch.status,
    "not-applicable",
  );
  assert.notEqual(
    dagState.items.find((item) => item.softwareId === "winget-base").status,
    "completed",
  );
  for (const phase of ["install", "verify"]) {
    recordEvent(dagIdentity, {
      type: "phase-started",
      softwareId: "winget-base",
      phase,
      attemptId: "attempt-dag-001",
    });
    recordEvent(dagIdentity, {
      type: "phase-succeeded",
      softwareId: "winget-base",
      phase,
      attemptId: "attempt-dag-001",
    });
  }
  dagState = recordEvent(dagIdentity, {
    type: "attempt-exited",
    attemptId: "attempt-dag-001",
    ownedProcessToken: "process-dag-001",
    outcome: "succeeded",
  });
  assert.equal(assertBatchRunnable(dagState, "batch-dag-002"), true);
  assert.throws(
    () => assertBatchRunnable(dagState, "batch-dag-003"),
    /blocked by dependency developer-app \(pending\)/,
  );

  const invalidGraphCases = [
    {
      name: "omitted",
      items: [{ softwareId: "app", batchId: "batch-invalid" }],
      expected: /dependsOn must be an array/,
    },
    {
      name: "execution-mode",
      items: [
        {
          softwareId: "app",
          batchId: "batch-invalid",
          dependsOn: [],
          executionMode: "manual",
        },
      ],
      expected: /unsupported executionMode/,
    },
    {
      name: "missing",
      items: [
        {
          softwareId: "app",
          batchId: "batch-invalid",
          dependsOn: ["missing"],
          executionMode: "automated",
        },
      ],
      expected: /unknown dependency missing/,
    },
    {
      name: "self",
      items: [
        {
          softwareId: "app",
          batchId: "batch-invalid",
          dependsOn: ["app"],
          executionMode: "automated",
        },
      ],
      expected: /self dependency is forbidden/,
    },
    {
      name: "duplicate",
      items: [
        {
          softwareId: "base",
          batchId: "batch-invalid-001",
          dependsOn: [],
          executionMode: "automated",
        },
        {
          softwareId: "app",
          batchId: "batch-invalid-002",
          dependsOn: ["base", "base"],
          executionMode: "automated",
        },
      ],
      expected: /duplicate dependency base/,
    },
    {
      name: "cycle",
      items: [
        {
          softwareId: "left",
          batchId: "batch-invalid-001",
          dependsOn: ["right"],
          executionMode: "automated",
        },
        {
          softwareId: "right",
          batchId: "batch-invalid-002",
          dependsOn: ["left"],
          executionMode: "automated",
        },
      ],
      expected: /dependency cycle detected/,
    },
  ];
  for (const { name, items, expected } of invalidGraphCases) {
    assert.throws(
      () =>
        createRun(
          {
            ...identity,
            statePath: join(tempRoot, `invalid-graph-${name}.json`),
            runId: `run-invalid-graph-${name}`,
          },
          { items },
        ),
      expected,
    );
  }

  const casIdentity = {
    ...identity,
    statePath: join(tempRoot, "cas.json"),
    runId: "run-20260723-cas",
  };
  const casCreated = createRun(casIdentity, {
    items: [
      {
        softwareId: "wechat",
        batchId: "batch-cas",
        dependsOn: [],
        executionMode: "automated",
      },
    ],
  });
  assert.throws(
    () =>
      recordEventWithCas(casIdentity, {
        type: "attempt-started",
        batchId: "batch-cas",
        attemptId: "attempt-cas",
        ownedProcessToken: "process-cas",
      }),
    /expectedRevision is required/,
  );
  const casStarted = recordEventWithCas(
    casIdentity,
    {
      type: "attempt-started",
      batchId: "batch-cas",
      attemptId: "attempt-cas",
      ownedProcessToken: "process-cas",
    },
    { expectedRevision: casCreated.revision },
  );
  assert.equal(casStarted.revision, casCreated.revision + 1);
  assert.equal(existsSync(`${casIdentity.statePath}.lock`), false);
  assert.throws(
    () =>
      recordEventWithCas(
        casIdentity,
        {
          type: "phase-started",
          softwareId: "wechat",
          phase: "fetch",
          attemptId: "attempt-cas",
        },
        { expectedRevision: casCreated.revision },
      ),
    (error) =>
      error.code === "DAWN_FORGE_REVISION_CONFLICT" &&
      /revision conflict: expected 1, actual 2/.test(error.message),
  );
  assert.equal(readRun(casIdentity).revision, casStarted.revision);

  const externalLockPath = `${casIdentity.statePath}.lock`;
  writeFileSync(
    externalLockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      nonce: "live-lock-nonce",
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
  assert.throws(
    () =>
      recordEventWithCas(
        casIdentity,
        {
          type: "phase-started",
          softwareId: "wechat",
          phase: "fetch",
          attemptId: "attempt-cas",
        },
        { expectedRevision: casStarted.revision },
      ),
    (error) =>
      error.code === "DAWN_FORGE_STATE_LOCKED" &&
      new RegExp(`PID ${process.pid}`).test(error.message),
  );
  assert.equal(readRun(casIdentity).revision, casStarted.revision);
  rmSync(externalLockPath, { force: true });

  const definitelyDeadPid = 2147483647;
  assert.throws(
    () => process.kill(definitelyDeadPid, 0),
    (error) => error.code === "ESRCH",
  );
  writeFileSync(
    externalLockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: definitelyDeadPid,
      nonce: "young-dead-lock-nonce",
      createdAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  assert.throws(
    () =>
      recordEventWithCas(
        casIdentity,
        {
          type: "phase-started",
          softwareId: "wechat",
          phase: "fetch",
          attemptId: "attempt-cas",
        },
        { expectedRevision: casStarted.revision },
      ),
    (error) => error.code === "DAWN_FORGE_STATE_LOCKED",
  );
  rmSync(externalLockPath, { force: true });

  const raceNonce = "race-lock-nonce";
  const raceQuarantinePath = `${externalLockPath}.orphan-${raceNonce}`;
  writeFileSync(
    externalLockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: definitelyDeadPid,
      nonce: raceNonce,
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
  mkdirSync(raceQuarantinePath);
  writeFileSync(join(raceQuarantinePath, "claimed"), "claimed\n", "utf8");
  assert.throws(
    () =>
      recordEventWithCas(
        casIdentity,
        {
          type: "phase-started",
          softwareId: "wechat",
          phase: "fetch",
          attemptId: "attempt-cas",
        },
        { expectedRevision: casStarted.revision },
      ),
    (error) => error.code === "DAWN_FORGE_LOCK_RECOVERY_RACE",
  );
  assert.equal(readRun(casIdentity).revision, casStarted.revision);
  assert.equal(existsSync(externalLockPath), true);
  rmSync(externalLockPath, { force: true });
  rmSync(raceQuarantinePath, { recursive: true, force: true });

  const deadNonce = "dead-lock-nonce";
  const deadQuarantinePath = `${externalLockPath}.orphan-${deadNonce}`;
  writeFileSync(
    externalLockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: definitelyDeadPid,
      nonce: deadNonce,
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
  const recovered = recordEventWithCas(
    casIdentity,
    {
      type: "phase-started",
      softwareId: "wechat",
      phase: "fetch",
      attemptId: "attempt-cas",
    },
    { expectedRevision: casStarted.revision },
  );
  assert.equal(recovered.revision, casStarted.revision + 1);
  assert.equal(existsSync(deadQuarantinePath), true);
  assert.equal(existsSync(externalLockPath), false);

  const manualIdentity = {
    ...identity,
    statePath: join(tempRoot, "manual-receipt.json"),
    runId: "run-20260723-manual-receipt",
  };
  let manualState = createRun(manualIdentity, {
    items: [
      {
        softwareId: "manual-app",
        batchId: "batch-manual",
        dependsOn: [],
        executionMode: "manual-receipt",
      },
    ],
  });
  assert.throws(
    () =>
      recordEvent(manualIdentity, {
        type: "attempt-started",
        batchId: "batch-manual",
        attemptId: "attempt-manual",
        ownedProcessToken: "process-manual",
      }),
    /requires recordManualReceipt/,
  );
  assert.throws(
    () =>
      recordManualReceipt(manualIdentity, {
        softwareId: "manual-app",
        evidenceType: "user-said-done",
        evidenceSha256: "9".repeat(64),
      }),
    /unsupported manual evidence type/,
  );
  assert.throws(
    () =>
      recordManualReceipt(manualIdentity, {
        softwareId: "manual-app",
        evidenceType: "macos-bundle-signature",
        evidenceSha256: "9".repeat(64),
        rawEvidence: "https://secret.invalid/receipt",
      }),
    /URLs are forbidden/,
  );
  manualState = recordManualReceipt(manualIdentity, {
    softwareId: "manual-app",
    evidenceType: "macos-bundle-signature",
    evidenceSha256: "9".repeat(64),
  });
  const manualItem = manualState.items.find(
    (item) => item.softwareId === "manual-app",
  );
  assert.equal(manualItem.status, "completed");
  assert.equal(manualItem.phases.install.source, "manual-receipt");
  assert.equal(manualItem.phases.verify.status, "succeeded");
  assert.deepEqual(manualItem.manualReceipt, {
    evidenceType: "macos-bundle-signature",
    evidenceSha256: "9".repeat(64),
    recordedAt: manualItem.manualReceipt.recordedAt,
  });
  assert.equal(manualState.status, "completed");
  assert.doesNotMatch(
    readFileSync(manualIdentity.statePath, "utf8"),
    /https?:\/\//,
  );

  const bytesBeforeRead = readFileSync(statePath, "utf8");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("readRun must not access the network.");
  };
  try {
    readRun(identity);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(readFileSync(statePath, "utf8"), bytesBeforeRead);

  assert.throws(
    () =>
      readRun({
        ...identity,
        scheduleSha256: "c".repeat(64),
      }),
    /scheduleSha256 drift detected/,
  );
  assert.throws(
    () =>
      recordEvent(
        { ...identity, profileSha256: "d".repeat(64) },
        {
          type: "attempt-started",
          batchId: "batch-001",
          attemptId: "attempt-drift",
          ownedProcessToken: "process-drift",
        },
      ),
    /profileSha256 drift detected/,
  );
  assert.throws(
    () =>
      readRun({
        ...identity,
        targetIdentitySha256: "f".repeat(64),
      }),
    /targetIdentitySha256 drift detected/,
  );
  assert.throws(
    () =>
      recordEvent(
        { ...identity, targetIdentitySha256: "f".repeat(64) },
        {
          type: "attempt-started",
          batchId: "batch-001",
          attemptId: "attempt-wrong-target",
          ownedProcessToken: "process-wrong-target",
        },
      ),
    /targetIdentitySha256 drift detected/,
  );
  assert.equal(readFileSync(statePath, "utf8"), bytesBeforeRead);

  const journalIdentity = {
    ...identity,
    statePath: join(tempRoot, "journal-identity.json"),
    runId: "run-20260723-journal-identity",
  };
  createRun(journalIdentity, {
    items: [
      {
        softwareId: "wechat",
        batchId: "batch-journal-identity",
        dependsOn: [],
        executionMode: "automated",
      },
    ],
  });
  const alteredJournalIdentityState = JSON.parse(
    readFileSync(journalIdentity.statePath, "utf8"),
  );
  alteredJournalIdentityState.targetIdentitySha256 = "f".repeat(64);
  writeFileSync(
    journalIdentity.statePath,
    `${JSON.stringify(alteredJournalIdentityState, null, 2)}\n`,
    "utf8",
  );
  assert.throws(
    () =>
      readRun({
        ...journalIdentity,
        targetIdentitySha256: "f".repeat(64),
      }),
    /run-created journal identity drift/,
  );

  const rejectedSecretPath = join(tempRoot, "rejected-secret.json");
  assert.throws(
    () =>
      createRun(
        {
          ...identity,
          statePath: rejectedSecretPath,
          runId: "run-20260723-003",
        },
        {
          items: [
            {
              softwareId: "clash-verge-rev",
              batchId: "batch-003",
              dependsOn: [],
              executionMode: "automated",
              subscriptionUrl: "https://secret.invalid/subscription",
            },
          ],
        },
      ),
    /subscriptionUrl is not allowed/,
  );
  assert.equal(existsSync(rejectedSecretPath), false);

  const rejectedConfigPath = join(tempRoot, "rejected-config-secret.json");
  assert.throws(
    () =>
      createRun(
        {
          ...identity,
          statePath: rejectedConfigPath,
          runId: "run-20260723-004",
        },
        {
          items: [
            {
              softwareId: "wechat",
              batchId: "batch-004",
              dependsOn: [],
              executionMode: "automated",
            },
          ],
          apiKey: "must-not-be-accepted",
        },
      ),
    /options\.apiKey is not allowed/,
  );
  assert.equal(existsSync(rejectedConfigPath), false);

  const safeJournalIdentity = {
    ...identity,
    statePath: join(tempRoot, "safe-journal.json"),
    runId: "run-20260723-005",
  };
  createRun(safeJournalIdentity, {
    items: [
      {
        softwareId: "clash-verge-rev",
        batchId: "batch-004",
        dependsOn: [],
        executionMode: "automated",
      },
    ],
  });
  assert.throws(
    () =>
      recordEvent(safeJournalIdentity, {
        type: "attempt-started",
        batchId: "batch-004",
        attemptId: "attempt-secret",
        ownedProcessToken: "https://secret.invalid/process",
      }),
    /URLs are forbidden/,
  );
  assert.doesNotMatch(
    readFileSync(safeJournalIdentity.statePath, "utf8"),
    /secret\.invalid/,
  );

  const unverifiedIdentity = {
    ...identity,
    statePath: join(tempRoot, "receipt-unconfirmed.json"),
    runId: "run-20260723-receipt-unconfirmed",
  };
  createRun(unverifiedIdentity, {
    items: [
      {
        softwareId: "receipt-window",
        batchId: "batch-receipt-window",
        dependsOn: [],
        executionMode: "automated",
      },
    ],
  });
  recordEvent(unverifiedIdentity, {
    type: "attempt-started",
    batchId: "batch-receipt-window",
    attemptId: "attempt-receipt-window",
    ownedProcessToken: "process-receipt-window",
  });
  recordEvent(unverifiedIdentity, {
    type: "phase-started",
    softwareId: "receipt-window",
    phase: "fetch",
    attemptId: "attempt-receipt-window",
  });
  assert.throws(
    () =>
      recordEvent(unverifiedIdentity, {
        type: "phase-interrupted",
        softwareId: "receipt-window",
        phase: "fetch",
        attemptId: "attempt-receipt-window",
        reasonCode: "driver-exited",
      }),
    /receipt-unconfirmed/,
  );
  recordEvent(unverifiedIdentity, {
    type: "phase-interrupted",
    softwareId: "receipt-window",
    phase: "fetch",
    attemptId: "attempt-receipt-window",
    reasonCode: "receipt-unconfirmed",
  });
  recordEvent(unverifiedIdentity, {
    type: "attempt-exited",
    attemptId: "attempt-receipt-window",
    ownedProcessToken: "process-receipt-window",
    outcome: "unknown",
    reasonCode: "receipt-unconfirmed",
  });
  const unverifiedState = readRun(unverifiedIdentity);
  assert.equal(unverifiedState.status, "partial");
  assert.equal(unverifiedState.activeAttempt, null);
  assert.equal(unverifiedState.lastAttemptOutcome.outcome, "unknown");
  assert.equal(unverifiedState.items[0].status, "not-verified");
  assert.equal(
    unverifiedState.items[0].phases.fetch.reasonCode,
    "receipt-unconfirmed",
  );
  assert.throws(
    () => assertBatchRunnable(unverifiedState, "batch-receipt-window"),
    /automatic retry is forbidden/,
  );
  assert.ok(readdirSync(tempRoot).every((name) => !name.endsWith(".lock")));

  console.log("Installation run state tests passed.");
} finally {
  assert.ok(tempRoot.startsWith(resolve(tmpdir())));
  rmSync(tempRoot, { recursive: true, force: true });
}
