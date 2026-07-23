import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createInstallationSchedule } from "../skills/dawn-forge/scripts/installation-batches.mjs";
import { runInstallationBatch } from "../skills/dawn-forge/scripts/run-installation-batch.mjs";
import {
  machineExecutionIdentityDigest,
  targetIdentityDigest,
} from "../skills/dawn-forge/scripts/target-identity.mjs";

const temporaryRoots = [];
const targetLockRoot = makeTemporaryDirectory();

try {
  await testOrderedVisiblePhasesAndFailureIsolation();
  await testRouteMismatchFailsClosed();
  await testControlledInstallerScripts();
  await testVersionPinsAndExecutionGates();
  await testDependencyAndLeaseGates();
  await testTargetLeaseCannotBeBypassedByStateDirectory();
  await testCancellationTargetsOnlyTheOwnedChild();
  await testWindowsCancellationUsesProtectedReceipt();
  await testMissingRemoteCancellationAckStaysPending();
  testSourceHasNoFixedWaitOrDetachedProcess();
  console.log("Installation batch runner tests passed.");
} finally {
  for (const root of temporaryRoots) {
    assert.ok(root.startsWith(resolve(tmpdir())));
    rmSync(root, { recursive: true, force: true });
  }
}

async function testOrderedVisiblePhasesAndFailureIsolation() {
  const stateDir = makeTemporaryDirectory();
  const schedule = makeSchedule([
    action("first-app", "brew-cask", "first-app", "direct"),
    action("second-app", "brew-cask", "second-app", "direct"),
    action("third-app", "brew-cask", "third-app", "direct"),
  ]);
  const output = captureOutput();
  const fake = createFakeSsh({
    resultFor({ phase, packageName }) {
      return packageName === "first-app" && phase === "install"
        ? { code: 23, stdout: "first install failed\n" }
        : packageName === "second-app" && phase === "fetch"
          ? {
              code: 0,
              stdout:
                "Authorization: Bearer should-not-leak\nhttps://att.example.invalid/private?token=also-secret\n",
            }
        : { code: 0, stdout: `${packageName} ${phase} ok\n` };
    },
  });

  const result = await runInstallationBatch(
    {
      schedule,
      batchId: "batch-001",
      route: "direct",
      stateDir,
      ...connectionIdentity(stateDir, "tester-mac"),
    },
    {
      spawnProcess: fake.spawnProcess,
      stdout: output.stdout,
      stderr: output.stderr,
      signalSource: new EventEmitter(),
      targetLockRoot,
    },
  );

  assert.equal(result.status, "partial");
  assert.equal(result.lastAttemptOutcome.outcome, "failed");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(
    fake.operations.map(({ installer, phase, packageName }) => [
      installer,
      phase,
      packageName,
    ]),
    [
      ["brew-cask", "fetch", "first-app"],
      ["brew-cask", "install", "first-app"],
      ["brew-cask", "fetch", "second-app"],
      ["brew-cask", "install", "second-app"],
      ["brew-cask", "verify", "second-app"],
      ["brew-cask", "fetch", "third-app"],
      ["brew-cask", "install", "third-app"],
      ["brew-cask", "verify", "third-app"],
    ],
  );
  assert.match(output.text(), /\[batch-001\] first-app fetch/);
  assert.match(output.text(), /\[batch-001\] second-app verify/);
  assert.match(output.text(), /\[batch-001\] third-app verify/);
  assert.match(output.text(), /second-app verify ok/);
  assert.match(output.text(), /authorization=\[REDACTED\]/i);
  assert.match(output.text(), /\[REDACTED-URL\]/);
  assert.doesNotMatch(output.text(), /should-not-leak|also-secret|att\.example/);

  const first = result.items.find((item) => item.softwareId === "first-app");
  const second = result.items.find((item) => item.softwareId === "second-app");
  const third = result.items.find((item) => item.softwareId === "third-app");
  assert.equal(first.phases.fetch.status, "succeeded");
  assert.equal(first.phases.install.status, "failed");
  assert.equal(first.phases.verify.status, "pending");
  assert.equal(second.status, "completed");
  assert.equal(third.status, "completed");
  assert.equal(result.summary.completed, 2);
  assert.equal(result.summary.failed, 1);
  assert.equal(fake.activeChildren.size, 0);

  const stateFiles = readdirSync(stateDir).filter(
    (name) => name !== "identity.json" && name.endsWith(".json"),
  );
  assert.equal(stateFiles.length, 1);
  const persisted = JSON.parse(
    readFileSync(join(stateDir, stateFiles[0]), "utf8"),
  );
  assert.equal(persisted.status, "partial");
  assert.equal(persisted.activeAttempt, null);
  assert.equal(persisted.items[1].status, "completed");
}

async function testRouteMismatchFailsClosed() {
  const stateDir = makeTemporaryDirectory();
  const schedule = makeSchedule([
    action("route-test", "brew-formula", "jq", "clash"),
  ]);
  const fake = createFakeSsh();

  await assert.rejects(
    runInstallationBatch(
      {
        schedule,
        batchId: "batch-001",
        route: "direct",
        stateDir,
        ...connectionIdentity(stateDir, "tester-mac"),
      },
      {
        spawnProcess: fake.spawnProcess,
        stdout: captureOutput().stdout,
        stderr: captureOutput().stderr,
        signalSource: new EventEmitter(),
        targetLockRoot,
      },
    ),
    /route mismatch/i,
  );
  assert.equal(fake.calls.length, 0);
  assert.ok(
    readdirSync(stateDir).every(
      (name) => name === "identity.json" || !name.endsWith(".json"),
    ),
  );
}

async function testControlledInstallerScripts() {
  const cases = [
    {
      installer: "homebrew-metadata",
      packageName: "homebrew-metadata",
      expected: /brew update-if-needed/,
    },
    {
      installer: "brew-formula",
      packageName: "jq",
      expected: /brew fetch --formula/,
    },
    {
      installer: "brew-cask",
      packageName: "maccy",
      expected: /brew fetch --cask/,
    },
    {
      installer: "winget",
      packageName: "Microsoft.PowerToys",
      expected: /phase-not-applicable/,
    },
    {
      installer: "npm-global",
      packageName: "@openai/codex",
      expected: /npm cache add/,
    },
    {
      installer: "volta-tool",
      packageName: "pnpm",
      expected: /volta fetch/,
    },
    {
      installer: "npm-global",
      packageName: "@openai/codex",
      platform: "windows",
      expected: /Invoke-OwnedProcess "npm" @\("cache", "add"/,
    },
    {
      installer: "volta-tool",
      packageName: "pnpm",
      platform: "windows",
      expected: /Invoke-OwnedProcess "volta" @\("fetch"/,
    },
  ];

  for (const testCase of cases) {
    const stateDir = makeTemporaryDirectory();
    const route = testCase.installer === "winget" ? "direct" : "clash";
    const platform =
      testCase.platform ??
      (testCase.installer === "winget" ? "windows" : "macos");
    const schedule = makeSchedule(
      [
        action(
          `${testCase.installer}-test`,
          testCase.installer,
          testCase.packageName,
          route,
        ),
      ],
      platform,
    );
    const fake = createFakeSsh();

    const result = await runInstallationBatch(
      {
        schedule,
        batchId: "batch-001",
        route,
        stateDir,
        ...connectionIdentity(
          stateDir,
          platform === "windows" ? "tester-windows" : "tester-mac",
          platform,
        ),
      },
      {
        spawnProcess: fake.spawnProcess,
        stdout: captureOutput().stdout,
        stderr: captureOutput().stderr,
        signalSource: new EventEmitter(),
        targetLockRoot,
      },
    );

    assert.equal(result.status, "completed");
    assert.equal(result.lastAttemptOutcome.outcome, "succeeded");
    assert.equal(fake.calls.length, 1);
    assert.match(fake.calls[0].stdin, testCase.expected);
    if (platform === "windows") {
      assert.match(fake.calls[0].stdin, /\$_ -match '\[\\s"\]'/);
      assertPowerShellParses(fake.calls[0].stdin);
    }
    assert.ok(
      fake.calls.every(
        (call) =>
          call.command === "ssh" &&
          call.options.detached === false &&
          call.options.stdio.join(",") === "pipe,pipe,pipe",
      ),
    );
    if (testCase.installer.startsWith("brew-")) {
      assert.match(fake.calls[0].stdin, /HOMEBREW_NO_AUTO_UPDATE=1/);
      assert.match(fake.calls[0].stdin, /HOMEBREW_NO_INSTALL_CLEANUP=1/);
    }
    assert.ok(!fake.calls[0].args.includes(testCase.packageName));
    assert.ok(fake.calls[0].args.includes("-F"));
    assert.ok(fake.calls[0].args.includes("BatchMode=yes"));
    assert.ok(fake.calls[0].args.includes("IdentitiesOnly=yes"));
    assert.ok(fake.calls[0].args.includes("StrictHostKeyChecking=yes"));
  }

  const manualStateDir = makeTemporaryDirectory();
  const manualAction = action(
    "clash-verge-rev",
    "manual",
    "clash-verge-rev",
    "direct",
  );
  manualAction.networkLocation = "controller";
  manualAction.routeEvidence = {
    method: "controller-probe",
    origins: ["example.com"],
    observedAt: "2026-07-23T12:00:00.000Z",
  };
  const manualSchedule = makeSchedule([manualAction]);
  const manualFake = createFakeSsh();
  const manualResult = await runInstallationBatch(
    {
      schedule: manualSchedule,
      batchId: "batch-001",
      route: "direct",
      stateDir: manualStateDir,
      ...connectionIdentity(manualStateDir, "tester-mac"),
    },
    {
      spawnProcess: manualFake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource: new EventEmitter(),
      targetLockRoot,
    },
  );
  assert.equal(manualResult.disposition, "manual-required");
  assert.deepEqual(manualResult.softwareIds, ["clash-verge-rev"]);
  assert.equal(manualResult.runState.status, "prepared");
  assert.equal(manualFake.calls.length, 0);

  const profile = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../profiles/mac-mini-personal-dev.json", import.meta.url),
      ),
      "utf8",
    ),
  );
  const coveredProfileSources = new Set([
    "auto",
    "brew-formula",
    "brew-cask",
    "npm-global",
    "volta-tool",
    "official-download",
    "manual",
  ]);
  assert.ok(
    profile.software.every((item) => coveredProfileSources.has(item.source)),
  );

  const stateDir = makeTemporaryDirectory();
  const unsafeSchedule = makeSchedule([
    action("unsafe-test", "brew-cask", "safe-name", "direct"),
  ]);
  unsafeSchedule.batches[0].installer = "manual";
  unsafeSchedule.batches[0].items[0].installer = "manual";
  const fake = createFakeSsh();
  await assert.rejects(
    runInstallationBatch(
      {
        schedule: unsafeSchedule,
        batchId: "batch-001",
        route: "direct",
        stateDir,
        ...connectionIdentity(stateDir, "tester-mac"),
      },
      {
        spawnProcess: fake.spawnProcess,
        stdout: captureOutput().stdout,
        stderr: captureOutput().stderr,
        signalSource: new EventEmitter(),
        targetLockRoot,
      },
    ),
    /schedule digest|unsupported installer/i,
  );
  assert.equal(fake.calls.length, 0);
}

async function testCancellationTargetsOnlyTheOwnedChild() {
  const stateDir = makeTemporaryDirectory();
  const schedule = makeSchedule([
    action("cancel-test", "brew-cask", "cancel-test", "direct"),
    action("must-not-start", "brew-cask", "must-not-start", "direct"),
  ]);
  const signalSource = new EventEmitter();
  let activeChild;
  const fake = createFakeSsh({
    holdOpen: true,
    onDriverReady(child) {
      activeChild = child;
      queueMicrotask(() => signalSource.emit("SIGINT"));
    },
  });

  const result = await runInstallationBatch(
    {
      schedule,
      batchId: "batch-001",
      route: "direct",
      stateDir,
      ...connectionIdentity(stateDir, "tester-mac"),
    },
    {
      spawnProcess: fake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource,
      targetLockRoot,
    },
  );

  assert.equal(result.status, "cancelled");
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].kind, "main");
  assert.equal(fake.calls[1].kind, "cancel");
  assert.match(fake.calls[0].stdin, /chmod 600 "\$state_temporary"/);
  assert.match(
    fake.calls[0].stdin,
    /kill -TERM "-\$active_operation_pid"[\s\S]*wait "\$active_operation_pid"/,
  );
  assert.doesNotMatch(
    fake.calls[0].stdin,
    /cancellation-acknowledged/,
  );
  assert.match(fake.calls[1].stdin, /# dawn-forge-cancel-driver/);
  assert.match(
    fake.calls[1].stdin,
    /\[ "\$receipt_token" = "\$expected_token" \] \|\| exit 77/,
  );
  assert.match(fake.calls[1].stdin, /IFS= read -r -t 5 acknowledgement/);
  assert.match(fake.calls[1].stdin, /cancellation-acknowledged/);
  assert.ok(fake.calls[1].args.includes("ConnectionAttempts=1"));
  assert.deepEqual(activeChild.killSignals, []);
  assert.equal(result.cancel.status, "confirmed");
  assert.equal(result.activeAttempt, null);
  assert.equal(fake.activeChildren.size, 0);
  assert.equal(
    result.items.find((item) => item.softwareId === "must-not-start").status,
    "pending",
  );
}

async function testTargetLeaseCannotBeBypassedByStateDirectory() {
  const firstStateDir = makeTemporaryDirectory();
  const secondStateDir = makeTemporaryDirectory();
  const sharedLockRoot = makeTemporaryDirectory();
  const schedule = makeSchedule([
    action("exclusive-target", "brew-formula", "jq", "direct"),
  ]);
  const signalSource = new EventEmitter();
  let markReady;
  const ready = new Promise((resolveReady) => {
    markReady = resolveReady;
  });
  const firstFake = createFakeSsh({
    holdOpen: true,
    onDriverReady() {
      markReady();
    },
  });
  const firstRun = runInstallationBatch(
    {
      schedule,
      batchId: "batch-001",
      route: "direct",
      stateDir: firstStateDir,
      ...connectionIdentity(firstStateDir, "first-alias"),
    },
    {
      spawnProcess: firstFake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource,
      targetLockRoot: sharedLockRoot,
    },
  );
  await ready;
  const lockFiles = readdirSync(sharedLockRoot);
  assert.deepEqual(lockFiles, [
    `${machineIdentityForPlatform("macos").machineExecutionIdentitySha256}.lock`,
  ]);
  const lockRecord = JSON.parse(
    readFileSync(join(sharedLockRoot, lockFiles[0]), "utf8"),
  );
  assert.equal(lockRecord.scheduleSha256, schedule.scheduleSha256);
  assert.equal(lockRecord.preflightSha256, schedule.preflightSha256);
  assert.equal(lockRecord.profileSha256, "b".repeat(64));
  assert.match(lockRecord.attemptId, /^attempt-[0-9a-f-]{36}$/);

  const secondFake = createFakeSsh();
  await assert.rejects(
    runInstallationBatch(
      {
        schedule,
        batchId: "batch-001",
        route: "direct",
        stateDir: secondStateDir,
        ...connectionIdentity(secondStateDir, "second-alias"),
      },
      {
        spawnProcess: secondFake.spawnProcess,
        stdout: captureOutput().stdout,
        stderr: captureOutput().stderr,
        signalSource: new EventEmitter(),
        targetLockRoot: sharedLockRoot,
      },
    ),
    /execution lease/,
  );
  assert.equal(secondFake.calls.length, 0);

  signalSource.emit("SIGINT");
  const firstResult = await firstRun;
  assert.equal(firstResult.status, "cancelled");
  assert.ok(
    readdirSync(sharedLockRoot).every((name) => !name.endsWith(".lock")),
  );
}

async function testWindowsCancellationUsesProtectedReceipt() {
  const stateDir = makeTemporaryDirectory();
  const signalSource = new EventEmitter();
  let activeChild;
  const fake = createFakeSsh({
    holdOpen: true,
    onDriverReady(child) {
      activeChild = child;
      queueMicrotask(() => signalSource.emit("SIGTERM"));
    },
  });
  const result = await runInstallationBatch(
    {
      schedule: makeSchedule([
        action(
          "windows-cancel-test",
          "winget",
          "Microsoft.PowerToys",
          "direct",
        ),
      ]),
      batchId: "batch-001",
      route: "direct",
      stateDir,
      ...connectionIdentity(stateDir, "tester-windows", "windows"),
    },
    {
      spawnProcess: fake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource,
      targetLockRoot,
    },
  );

  assert.equal(result.status, "cancelled");
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[0].stdin, /Protect-DawnForgePath \$TemporaryPath/);
  assert.match(fake.calls[0].stdin, /childPid = \$script:ActiveChildPid/);
  assert.match(fake.calls[1].stdin, /# dawn-forge-cancel-driver/);
  assert.match(
    fake.calls[1].stdin,
    /taskkill\.exe \/PID \(\[string\]\$ProcessId\) \/T \/F/,
  );
  assert.match(fake.calls[1].stdin, /WaitForExit\(5000\)/);
  assert.match(fake.calls[1].stdin, /cancellation-acknowledged/);
  assert.deepEqual(activeChild.killSignals, []);
  assertPowerShellParses(fake.calls[0].stdin);
  assertPowerShellParses(fake.calls[1].stdin);
}

async function testMissingRemoteCancellationAckStaysPending() {
  const stateDir = makeTemporaryDirectory();
  const schedule = makeSchedule([
    action("no-ack-test", "brew-cask", "no-ack-test", "direct"),
  ]);
  const signalSource = new EventEmitter();
  const fake = createFakeSsh({
    holdOpen: true,
    acknowledgeCancellation: false,
    onDriverReady() {
      queueMicrotask(() => signalSource.emit("SIGTERM"));
    },
  });

  const result = await runInstallationBatch(
    {
      schedule,
      batchId: "batch-001",
      route: "direct",
      stateDir,
      ...connectionIdentity(stateDir, "tester-mac"),
    },
    {
      spawnProcess: fake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource,
      targetLockRoot,
    },
  );

  assert.equal(result.status, "cancel-pending");
  assert.equal(result.cancel.acknowledgedAt, undefined);
  assert.notEqual(result.activeAttempt, null);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[0].child.killSignals, ["SIGTERM"]);

  const wrongTokenDir = makeTemporaryDirectory();
  const wrongTokenSignals = new EventEmitter();
  const wrongTokenFake = createFakeSsh({
    holdOpen: true,
    acknowledgeCancellation: "wrong-token",
    onDriverReady() {
      queueMicrotask(() => wrongTokenSignals.emit("SIGINT"));
    },
  });
  const wrongToken = await runInstallationBatch(
    {
      schedule: makeSchedule([
        action("wrong-token-test", "brew-cask", "wrong-token-test", "direct"),
      ]),
      batchId: "batch-001",
      route: "direct",
      stateDir: wrongTokenDir,
      ...connectionIdentity(wrongTokenDir, "tester-mac"),
    },
    {
      spawnProcess: wrongTokenFake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource: wrongTokenSignals,
      targetLockRoot,
    },
  );
  assert.equal(wrongToken.status, "cancel-pending");
  assert.equal(wrongToken.cancel.acknowledgedAt, undefined);
  assert.equal(wrongTokenFake.calls.length, 2);
  assert.deepEqual(wrongTokenFake.calls[0].child.killSignals, ["SIGTERM"]);

  const failedAckDir = makeTemporaryDirectory();
  const failedAckSignals = new EventEmitter();
  const failedAckFake = createFakeSsh({
    holdOpen: true,
    acknowledgeCancellation: "ack-then-fail",
    onDriverReady() {
      queueMicrotask(() => failedAckSignals.emit("SIGINT"));
    },
  });
  const failedAck = await runInstallationBatch(
    {
      schedule: makeSchedule([
        action("failed-ack-test", "brew-cask", "failed-ack-test", "direct"),
      ]),
      batchId: "batch-001",
      route: "direct",
      stateDir: failedAckDir,
      ...connectionIdentity(failedAckDir, "tester-mac"),
    },
    {
      spawnProcess: failedAckFake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource: failedAckSignals,
      targetLockRoot,
    },
  );
  assert.equal(failedAck.status, "cancel-pending");
  assert.equal(failedAck.cancel.acknowledgedAt, undefined);

  const mainAckDir = makeTemporaryDirectory();
  const mainAckSignals = new EventEmitter();
  const mainAckFake = createFakeSsh({
    holdOpen: true,
    acknowledgeCancellation: false,
    onDriverReady(child) {
      queueMicrotask(() => {
        mainAckSignals.emit("SIGTERM");
        child.stderr.write(
          `__DAWN_FORGE_EVENT__|${child.eventToken}|cancellation-acknowledged|-|-|0\n`,
        );
      });
    },
  });
  const mainAck = await runInstallationBatch(
    {
      schedule: makeSchedule([
        action("main-ack-test", "brew-cask", "main-ack-test", "direct"),
      ]),
      batchId: "batch-001",
      route: "direct",
      stateDir: mainAckDir,
      ...connectionIdentity(mainAckDir, "tester-mac"),
    },
    {
      spawnProcess: mainAckFake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource: mainAckSignals,
      targetLockRoot,
    },
  );
  assert.equal(mainAck.status, "cancel-pending");
  assert.equal(mainAck.cancel.acknowledgedAt, undefined);

  const beforeSpawnDir = makeTemporaryDirectory();
  const beforeSpawnSignals = new EventEmitter();
  const originalOn = beforeSpawnSignals.on.bind(beforeSpawnSignals);
  beforeSpawnSignals.on = (event, listener) => {
    originalOn(event, listener);
    if (event === "SIGINT") listener();
    return beforeSpawnSignals;
  };
  const beforeSpawnFake = createFakeSsh();
  const beforeSpawn = await runInstallationBatch(
    {
      schedule: makeSchedule([
        action("before-spawn", "brew-cask", "before-spawn", "direct"),
      ]),
      batchId: "batch-001",
      route: "direct",
      stateDir: beforeSpawnDir,
      ...connectionIdentity(beforeSpawnDir, "tester-mac"),
    },
    {
      spawnProcess: beforeSpawnFake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource: beforeSpawnSignals,
      targetLockRoot,
    },
  );
  assert.equal(beforeSpawn.status, "cancelled");
  assert.equal(beforeSpawnFake.calls.length, 0);
}

async function testVersionPinsAndExecutionGates() {
  const npmStateDir = makeTemporaryDirectory();
  const npmAction = action(
    "codex-pinned",
    "npm-global",
    "@openai/codex",
    "clash",
  );
  npmAction.version = "1.2.3";
  const npmFake = createFakeSsh();
  const npmResult = await runInstallationBatch(
    {
      schedule: makeSchedule([npmAction]),
      batchId: "batch-001",
      route: "clash",
      stateDir: npmStateDir,
      ...connectionIdentity(npmStateDir, "tester-mac"),
    },
    {
      spawnProcess: npmFake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource: new EventEmitter(),
      targetLockRoot,
    },
  );
  assert.equal(npmResult.status, "completed");
  assert.match(npmFake.calls[0].stdin, /@openai\/codex@1\.2\.3/);
  assert.match(
    npmFake.calls[0].stdin,
    /npm list --global --depth=0 "\$package_spec"/,
  );

  const wingetStateDir = makeTemporaryDirectory();
  const wingetAction = action(
    "winget-pinned",
    "winget",
    "Microsoft.PowerToys",
    "direct",
  );
  wingetAction.version = "0.95.1";
  const wingetFake = createFakeSsh();
  const wingetResult = await runInstallationBatch(
    {
      schedule: makeSchedule([wingetAction]),
      batchId: "batch-001",
      route: "direct",
      stateDir: wingetStateDir,
      ...connectionIdentity(wingetStateDir, "tester-windows", "windows"),
    },
    {
      spawnProcess: wingetFake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource: new EventEmitter(),
      targetLockRoot,
    },
  );
  assert.equal(wingetResult.status, "completed");
  assert.match(
    wingetFake.calls[0].stdin,
    /\$Phase -eq "install"[\s\S]*"--version", \$Version/,
  );
  assert.match(
    wingetFake.calls[0].stdin,
    /Invoke-OwnedProcess "winget" @\([\s\S]*"export", "--output"/,
  );
  assert.doesNotMatch(
    wingetFake.calls[0].stdin,
    /"list"[^\r\n]*"--version"/,
  );
  assert.equal(
    wingetResult.items[0].phases.fetch.status,
    "not-applicable",
  );

  const invalidStateDir = makeTemporaryDirectory();
  const invalidCask = action(
    "pinned-cask",
    "brew-cask",
    "maccy",
    "direct",
  );
  invalidCask.version = "1.0.0";
  const invalidFake = createFakeSsh();
  await assert.rejects(
    runInstallationBatch(
      {
        schedule: makeSchedule([invalidCask]),
        batchId: "batch-001",
        route: "direct",
        stateDir: invalidStateDir,
        ...connectionIdentity(invalidStateDir, "tester-mac"),
      },
      {
        spawnProcess: invalidFake.spawnProcess,
        stdout: captureOutput().stdout,
        stderr: captureOutput().stderr,
        signalSource: new EventEmitter(),
        targetLockRoot,
      },
    ),
    /unsupported Homebrew version pin/,
  );
  assert.equal(invalidFake.calls.length, 0);

  const wrongLocationDir = makeTemporaryDirectory();
  const wrongLocation = action(
    "wrong-location",
    "npm-global",
    "@openai/codex",
    "direct",
  );
  wrongLocation.networkLocation = "controller";
  wrongLocation.routeEvidence = {
    method: "controller-probe",
    origins: ["example.com"],
    observedAt: "2026-07-23T12:00:00.000Z",
  };
  await assert.rejects(
    runInstallationBatch({
      schedule: makeSchedule([wrongLocation]),
      batchId: "batch-001",
      route: "direct",
      stateDir: wrongLocationDir,
      ...connectionIdentity(wrongLocationDir, "tester-mac"),
    }),
    /not target-runnable/,
  );

  const duplicateMetadataDir = makeTemporaryDirectory();
  const duplicateMetadataFake = createFakeSsh();
  await assert.rejects(
    runInstallationBatch(
      {
        schedule: makeSchedule([
          action(
            "homebrew-metadata-direct",
            "homebrew-metadata",
            "homebrew-metadata",
            "direct",
          ),
          action(
            "homebrew-metadata-clash",
            "homebrew-metadata",
            "homebrew-metadata",
            "clash",
          ),
        ]),
        batchId: "batch-001",
        route: "direct",
        stateDir: duplicateMetadataDir,
        ...connectionIdentity(duplicateMetadataDir, "tester-mac"),
      },
      {
        spawnProcess: duplicateMetadataFake.spawnProcess,
        stdout: captureOutput().stdout,
        stderr: captureOutput().stderr,
        signalSource: new EventEmitter(),
        targetLockRoot,
      },
    ),
    /exactly one homebrew-metadata/,
  );
  assert.equal(duplicateMetadataFake.calls.length, 0);

  const unsafeVoltaDir = makeTemporaryDirectory();
  const unsafeVoltaFake = createFakeSsh();
  await assert.rejects(
    runInstallationBatch(
      {
        schedule: makeSchedule([
          action("unsafe-volta", "volta-tool", "@scope/tool", "clash"),
        ]),
        batchId: "batch-001",
        route: "clash",
        stateDir: unsafeVoltaDir,
        ...connectionIdentity(unsafeVoltaDir, "tester-mac"),
      },
      {
        spawnProcess: unsafeVoltaFake.spawnProcess,
        stdout: captureOutput().stdout,
        stderr: captureOutput().stderr,
        signalSource: new EventEmitter(),
        targetLockRoot,
      },
    ),
    /simple executable name/,
  );
  assert.equal(unsafeVoltaFake.calls.length, 0);
}

async function testDependencyAndLeaseGates() {
  const stateDir = makeTemporaryDirectory();
  const prerequisite = action(
    "prerequisite",
    "brew-formula",
    "jq",
    "direct",
  );
  const dependent = action(
    "dependent",
    "brew-formula",
    "ripgrep",
    "direct",
  );
  dependent.dependsOn = ["prerequisite"];
  const schedule = makeSchedule([dependent, prerequisite]);
  const blockedFake = createFakeSsh();

  await assert.rejects(
    runInstallationBatch(
      {
        schedule,
        batchId: "batch-002",
        route: "direct",
        stateDir,
        ...connectionIdentity(stateDir, "tester-mac"),
      },
      {
        spawnProcess: blockedFake.spawnProcess,
        stdout: captureOutput().stdout,
        stderr: captureOutput().stderr,
        signalSource: new EventEmitter(),
        targetLockRoot,
      },
    ),
    /blocked by dependency/,
  );
  assert.equal(blockedFake.calls.length, 0);

  const prerequisiteFake = createFakeSsh();
  await runInstallationBatch(
    {
      schedule,
      batchId: "batch-001",
      route: "direct",
      stateDir,
      ...connectionIdentity(stateDir, "tester-mac"),
    },
    {
      spawnProcess: prerequisiteFake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource: new EventEmitter(),
      targetLockRoot,
    },
  );
  const dependentFake = createFakeSsh();
  const completed = await runInstallationBatch(
    {
      schedule,
      batchId: "batch-002",
      route: "direct",
      stateDir,
      ...connectionIdentity(stateDir, "tester-mac"),
    },
    {
      spawnProcess: dependentFake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource: new EventEmitter(),
      targetLockRoot,
    },
  );
  assert.equal(completed.status, "completed");
  assert.equal(prerequisiteFake.calls.length, 1);
  assert.equal(dependentFake.calls.length, 1);

  const leaseDir = makeTemporaryDirectory();
  const leaseLockRoot = makeTemporaryDirectory();
  const leaseSchedule = makeSchedule([
    action("lease-test", "brew-formula", "jq", "direct"),
  ]);
  const macMachineIdentity =
    machineIdentityForPlatform("macos").machineExecutionIdentitySha256;
  writeFileSync(
    join(leaseLockRoot, `${macMachineIdentity}.lock`),
    "{}\n",
    "utf8",
  );
  const leaseFake = createFakeSsh();
  await assert.rejects(
    runInstallationBatch(
      {
        schedule: leaseSchedule,
        batchId: "batch-001",
        route: "direct",
        stateDir: leaseDir,
        ...connectionIdentity(leaseDir, "tester-mac"),
      },
      {
        spawnProcess: leaseFake.spawnProcess,
        stdout: captureOutput().stdout,
        stderr: captureOutput().stderr,
        signalSource: new EventEmitter(),
        targetLockRoot: leaseLockRoot,
      },
    ),
    /execution lease/,
  );
  assert.equal(leaseFake.calls.length, 0);

  const orphanDir = makeTemporaryDirectory();
  const orphanLockRoot = makeTemporaryDirectory();
  const orphanSchedule = makeSchedule([
    action("orphan-test", "brew-formula", "jq", "direct"),
  ]);
  writeFileSync(
    join(orphanLockRoot, `${macMachineIdentity}.lock`),
    `${JSON.stringify({
      schemaVersion: 1,
      leaseId: "lease-00000000-0000-4000-8000-000000000000",
      controllerPid: 2_147_483_647,
      attemptId: "attempt-dead-controller",
      runKey: "d".repeat(32),
      batchId: "batch-001",
      scheduleSha256: orphanSchedule.scheduleSha256,
      preflightSha256: orphanSchedule.preflightSha256,
      profileSha256: "b".repeat(64),
      targetIdentitySha256: "c".repeat(64),
      machineExecutionIdentitySha256: macMachineIdentity,
      platform: "macos",
      createdAt: "2026-07-23T12:00:00.000Z",
    })}\n`,
    "utf8",
  );
  const orphanFake = createFakeSsh();
  const recovered = await runInstallationBatch(
    {
      schedule: orphanSchedule,
      batchId: "batch-001",
      route: "direct",
      stateDir: orphanDir,
      ...connectionIdentity(orphanDir, "tester-mac"),
    },
    {
      spawnProcess: orphanFake.spawnProcess,
      stdout: captureOutput().stdout,
      stderr: captureOutput().stderr,
      signalSource: new EventEmitter(),
      targetLockRoot: orphanLockRoot,
    },
  );
  assert.equal(recovered.status, "completed");
  assert.equal(orphanFake.calls.length, 1);
  assert.ok(
    readdirSync(orphanLockRoot).every((name) => !name.endsWith(".lock")),
  );
}

function testSourceHasNoFixedWaitOrDetachedProcess() {
  const source = readFileSync(
    fileURLToPath(
      new URL(
        "../skills/dawn-forge/scripts/run-installation-batch.mjs",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /\b(?:sleep|nohup)\b/i);
  assert.doesNotMatch(source, /detached\s*:\s*true/);
  assert.doesNotMatch(source, /\.unref\s*\(/);
  assert.doesNotMatch(source, /setTimeout\s*\(/);
  assert.match(
    source,
    /join\(homedir\(\), "\.dawn-forge", "locks", "targets"\)/,
  );
  assert.match(
    source,
    /`\$\{prepared\.machineExecutionIdentitySha256\}\.lock`/,
  );
  assert.doesNotMatch(
    source,
    /target-\$\{prepared\.(?:targetIdentitySha256|machineExecutionIdentitySha256)\.slice/,
  );
}

function action(softwareId, installer, packageName, route) {
  return {
    softwareId,
    name: softwareId,
    installer,
    package: packageName,
    version: "latest-stable",
    route,
    networkLocation: route === "local" ? "none" : "target",
    executionMode: ["official-download", "manual"].includes(installer)
      ? "manual-receipt"
      : "automated",
    routeEvidence:
      route === "local"
        ? { method: "no-network", origins: [] }
        : {
            method: "target-probe",
            origins: ["example.com"],
            observedAt: "2026-07-23T12:00:00.000Z",
          },
    dependsOn: [],
  };
}

function makeSchedule(actions, requestedPlatform) {
  const platform =
    requestedPlatform ??
    (actions.some((item) => item.installer === "winget")
      ? "windows"
      : "macos");
  return createInstallationSchedule(actions, {
    initialRoutes: { controller: "direct", target: "direct" },
    preflightSha256: "a".repeat(64),
    machineExecutionIdentitySha256:
      machineIdentityForPlatform(platform).machineExecutionIdentitySha256,
  });
}

function connectionIdentity(stateDir, target, platform = "macos") {
  const sshConfig = join(stateDir, "ssh_config");
  const knownHostsPath = join(stateDir, "known_hosts");
  const identityFile = join(stateDir, "id_test");
  const identityReceiptPath = join(stateDir, "identity.json");
  const identity = machineIdentityForPlatform(platform);
  writeFileSync(knownHostsPath, "test-host.local ssh-ed25519 AAAATEST\n", "utf8");
  writeFileSync(identityFile, "fake-private-key\n", "utf8");
  writeFileSync(
    sshConfig,
    [
      `# >>> Dawn Forge: ${target} >>>`,
      `Host ${target}`,
      "  HostName test-host.local",
      "  User tester",
      "  IdentityFile ~/.ssh/id_test",
      "  IdentitiesOnly yes",
      `# <<< Dawn Forge: ${target} <<<`,
      "",
    ].join("\n"),
    "utf8",
  );
  const receipt = {
    schemaVersion: 1,
    finalized: true,
    alias: target,
    platform,
    targetIdentitySha256: identity.targetIdentitySha256,
    machineExecutionIdentitySha256:
      identity.machineExecutionIdentitySha256,
    identity: identity.identity,
    hostKeyFingerprints: identity.hostKeyFingerprints,
    sshConfigPath: sshConfig,
    sshConfigSha256: fileSha256(sshConfig),
    knownHostsPath,
    knownHostsSha256: fileSha256(knownHostsPath),
    identityFile,
    identityFileSha256: fileSha256(identityFile),
  };
  writeFileSync(identityReceiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
  return {
    target,
    sshConfig,
    platform,
    profileSha256: "b".repeat(64),
    targetIdentitySha256: identity.targetIdentitySha256,
    machineExecutionIdentitySha256:
      identity.machineExecutionIdentitySha256,
    identityReceiptPath,
    identityReceiptSha256: fileSha256(identityReceiptPath),
  };
}

function machineIdentityForPlatform(platform) {
  const hostKeyFingerprints = [
    "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ];
  const identity = {
    user: "tester",
    os: platform === "windows" ? "Windows" : "Darwin",
    architecture: platform === "windows" ? "AMD64" : "arm64",
    machineId: `fixture-${platform}-machine`,
  };
  return {
    identity,
    hostKeyFingerprints,
    targetIdentitySha256: targetIdentityDigest({
      platform,
      ...identity,
      hostKeyFingerprints,
    }),
    machineExecutionIdentitySha256: machineExecutionIdentityDigest({
      platform,
      machineId: identity.machineId,
      hostKeyFingerprints,
    }),
  };
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function makeTemporaryDirectory() {
  const root = resolve(mkdtempSync(join(tmpdir(), "dawn-forge-batch-runner-")));
  temporaryRoots.push(root);
  return root;
}

function captureOutput() {
  const chunks = [];
  const writer = {
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    },
  };
  return {
    stdout: writer,
    stderr: writer,
    text: () => chunks.join(""),
  };
}

function assertPowerShellParses(source) {
  if (process.platform !== "win32") return;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$Source = [Console]::In.ReadToEnd(); [void][scriptblock]::Create($Source)",
    ],
    {
      input: source,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (["ENOENT", "EPERM"].includes(result.error?.code)) return;
  assert.equal(
    result.status,
    0,
    `Generated PowerShell did not parse:\n${result.stderr || result.stdout}`,
  );
}

function createFakeSsh({
  resultFor = () => ({ code: 0 }),
  holdOpen = false,
  onSpawn = () => {},
  onDriverReady = () => {},
  acknowledgeCancellation = true,
} = {}) {
  let nextPid = 4100;
  const calls = [];
  const operations = [];
  const activeChildren = new Set();

  function spawnProcess(command, args, options) {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killSignals = [];
    const call = {
      child,
      command,
      args: [...args],
      options: { ...options, stdio: [...options.stdio] },
      stdin: "",
    };
    calls.push(call);
    activeChildren.add(child);

    child.kill = (signal) => {
      child.killSignals.push(signal);
      queueMicrotask(() => {
        finish(null, signal);
      });
      return true;
    };
    child.stdin = {
      write(chunk) {
        call.stdin += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
        return true;
      },
      end() {
        if (call.stdin.includes("# dawn-forge-cancel-driver")) {
          call.kind = "cancel";
          queueMicrotask(() => {
            const token = /\$?event_token\s*=\s*['"]([a-f0-9]+)['"]|EventToken = "([a-f0-9]+)"/i.exec(
              call.stdin,
            );
            const eventToken = token?.[1] ?? token?.[2];
            assert.ok(eventToken);
            const mainCall = calls.find(
              (candidate) =>
                candidate.kind === "main" &&
                activeChildren.has(candidate.child),
            );
            if (
              acknowledgeCancellation === true ||
              acknowledgeCancellation === "ack-then-fail"
            ) {
              assert.ok(mainCall);
              mainCall.child.stdout.end();
              mainCall.child.stderr.end();
              finishChild(mainCall.child, 130, null);
              emitEvent(
                eventToken,
                "cancellation-acknowledged",
                "-",
                "-",
                "0",
              );
              child.stdout.end();
              child.stderr.end();
              finish(
                acknowledgeCancellation === "ack-then-fail" ? 75 : 0,
                null,
              );
            } else {
              if (acknowledgeCancellation === "wrong-token") {
                emitEvent(
                  "0".repeat(eventToken.length),
                  "cancellation-acknowledged",
                  "-",
                  "-",
                  "0",
                );
              }
              child.stdout.end();
              child.stderr.end();
              finish(77, null);
            }
          });
          return;
        }
        call.kind = "main";
        if (holdOpen) {
          child.eventToken = /# dawn-forge-event-token:([a-f0-9]+)/.exec(
            call.stdin,
          )?.[1];
          assert.ok(child.eventToken);
          onDriverReady(child, call);
          return;
        }
        queueMicrotask(() => {
          const token = /# dawn-forge-event-token:([a-f0-9]+)/.exec(
            call.stdin,
          )?.[1];
          assert.ok(token, "fake SSH must receive a controlled event token");
          const items = [
            ...call.stdin.matchAll(
              /^# dawn-forge-item:([^|\r\n]+)\|([^|\r\n]+)\|([^|\r\n]+)\|([^|\r\n]+)\|([^|\r\n]+)$/gm,
            ),
          ].map((match) => ({
            installer: match[1],
            softwareId: match[2],
            packageName: match[3],
            version: match[4],
            phases: match[5].split(","),
          }));
          assert.ok(items.length >= 1 && items.length <= 3);
          let overallCode = 0;
          for (const item of items) {
            for (const phase of item.phases) {
              const operation = {
                installer: item.installer,
                softwareId: item.softwareId,
                packageName: item.packageName,
                phase,
              };
              operations.push(operation);
              if (item.installer === "winget" && phase === "fetch") {
                emitEvent(
                  token,
                  "phase-not-applicable",
                  item.softwareId,
                  phase,
                  "metadata-only",
                );
                continue;
              }
              emitEvent(
                token,
                "phase-started",
                item.softwareId,
                phase,
                "-",
              );
              const result = resultFor(operation);
              if (result.stdout) child.stdout.write(result.stdout);
              if (result.stderr) child.stderr.write(result.stderr);
              if ((result.code ?? 0) === 0) {
                emitEvent(
                  token,
                  "phase-succeeded",
                  item.softwareId,
                  phase,
                  "0",
                );
              } else {
                emitEvent(
                  token,
                  "phase-failed",
                  item.softwareId,
                  phase,
                  String(result.code),
                );
                overallCode = 1;
                break;
              }
            }
          }
          child.stdout.end();
          child.stderr.end();
          finish(overallCode, null);
        });
      },
      on() {},
    };
    onSpawn(child, call);
    return child;

    function finish(code, signal) {
      finishChild(child, code, signal);
    }

    function emitEvent(token, type, softwareId, phase, exitCode) {
      child.stderr.write(
        `__DAWN_FORGE_EVENT__|${token}|${type}|${softwareId}|${phase}|${exitCode}\n`,
      );
    }
  }

  return { spawnProcess, calls, operations, activeChildren };

  function finishChild(child, code, signal) {
    if (!activeChildren.delete(child)) return;
    child.emit("close", code, signal);
  }
}
