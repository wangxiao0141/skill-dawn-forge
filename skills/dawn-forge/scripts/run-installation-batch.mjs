#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRun,
  assertBatchRunnable,
  readRun,
  recordEvent,
  requestCancel,
} from "./installation-run-state.mjs";
import {
  machineExecutionIdentityDigest,
  targetIdentityDigest,
} from "./target-identity.mjs";

const supportedInstallers = new Set([
  "homebrew-metadata",
  "brew-formula",
  "brew-cask",
  "winget",
  "npm-global",
  "volta-tool",
]);
const manualInstallers = new Set(["official-download", "manual"]);
const supportedRoutes = new Set(["direct", "clash", "local"]);
const phaseNames = ["fetch", "install", "verify"];
const eventPrefix = "__DAWN_FORGE_EVENT__";
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const packagePattern = /^[A-Za-z0-9@+._/-]{1,200}$/;
const finalizedAliasPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const originPattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export async function runInstallationBatch(input, dependencies = {}) {
  const prepared = validateAndPrepare(input);
  const runtime = prepareRuntimeDependencies(dependencies);
  const attemptId = `attempt-${randomUUID()}`;
  const releaseLease = acquireRunLease(prepared, {
    attemptId,
    targetLockRoot: runtime.targetLockRoot,
  });
  try {
    return await runPreparedInstallationBatch(prepared, runtime, attemptId);
  } finally {
    releaseLease();
  }
}

async function runPreparedInstallationBatch(prepared, runtime, attemptId) {
  const {
    spawnProcess,
    stdout,
    stderr,
    signalSource,
  } = runtime;

  const identity = createRunIdentity(prepared);
  let state = openOrCreateRun(identity, prepared.schedule);
  assertBatchRunnable(state, prepared.batch.batchId);
  const executionItems = createExecutionItems(state, prepared.batch);
  if (executionItems.length === 0) {
    throw new Error(
      `Installation batch ${prepared.batch.batchId} is already verified.`,
    );
  }
  const manualReasons = [
    ...(prepared.batch.executionMode === "manual-receipt"
      ? ["manual-installer"]
      : []),
    ...(prepared.batch.requiresAdmin ? ["requires-admin"] : []),
    ...(prepared.batch.requiresGui ? ["requires-gui"] : []),
    ...(prepared.batch.requiresRestart ? ["requires-restart"] : []),
  ];
  if (manualReasons.length > 0) {
    return {
      disposition: "manual-required",
      batchId: prepared.batch.batchId,
      softwareIds: executionItems.map((item) => item.softwareId),
      reasons: manualReasons,
      runIdentity: identity,
      runState: state,
    };
  }
  let mainChild = null;
  let cancelChild = null;
  let cancellationPromise = null;
  let mainInvocation = null;
  let cancellationRequested = false;
  let protocolError = null;
  const eventToken = randomBytes(24).toString("hex");
  const ownedProcessToken = `process-${randomUUID()}`;
  const startRemoteCancellation = () => {
    if (
      cancellationPromise !== null ||
      mainChild === null ||
      mainInvocation === null
    ) {
      return;
    }
    cancellationPromise = runRemoteCancellation({
      spawnProcess,
        invocation: buildCancelInvocation({
          target: prepared.target,
          sshConfig: prepared.sshConfig,
          knownHostsPath: prepared.knownHostsPath,
          identityFile: prepared.identityFile,
          platform: prepared.platform,
          runKey: createRunKey(prepared),
          attemptId,
          eventToken,
          ownedProcessToken,
      }),
      stdout,
      stderr,
      eventToken,
      onCancelChild(child) {
        cancelChild = child;
      },
      onAcknowledged() {
        state = recordEvent(
          identity,
          {
            type: "cancellation-acknowledged",
            attemptId,
            ownedProcessToken,
          },
          { expectedRevision: state.revision },
        );
      },
    }).then((result) => {
      cancelChild = null;
      if (!result.acknowledged && mainChild !== null) {
        try {
          mainChild.kill("SIGTERM");
        } catch {
          // The main SSH may already have disconnected; state remains pending.
        }
      }
      return result;
    });
  };
  const requestCancellation = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    state = requestCancel(identity, { expectedRevision: state.revision });
    startRemoteCancellation();
  };
  const onInterrupt = () => requestCancellation();
  const onTerminate = () => requestCancellation();
  signalSource.on("SIGINT", onInterrupt);
  signalSource.on("SIGTERM", onTerminate);

  try {
    await Promise.resolve();
    if (cancellationRequested) return state;
    state = recordEvent(
      identity,
      {
        type: "attempt-started",
        batchId: prepared.batch.batchId,
        attemptId,
        ownedProcessToken,
      },
      { expectedRevision: state.revision },
    );
    mainInvocation = buildSshInvocation(
      prepared,
      executionItems,
      eventToken,
      createRunKey(prepared),
      attemptId,
      ownedProcessToken,
    );

    try {
      mainChild = spawnProcess("ssh", mainInvocation.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: false,
      });
      if (cancellationRequested && cancellationPromise === null) {
        startRemoteCancellation();
      }
    } catch (error) {
      if (cancellationRequested) return readRun(identity);
      state = recordEvent(
        identity,
        {
          type: "attempt-exited",
          attemptId,
          ownedProcessToken,
          outcome: "failed",
          reasonCode: normalizeReasonCode(error),
        },
        { expectedRevision: state.revision },
      );
      return state;
    }

    const rejectProtocol = (error) => {
      if (protocolError !== null || cancellationRequested) return;
      protocolError = error;
      try {
        mainChild?.kill("SIGTERM");
      } catch {
        // The exact owned child may already have exited.
      }
    };
    const stdoutParser = createLineForwarder(stdout);
    const stderrParser = createProtocolParser({
      destination: stderr,
      eventToken,
      onEvent(event) {
        if (protocolError !== null) {
          return;
        }
        if (event.type === "cancellation-acknowledged") {
          if (!cancellationRequested) {
            rejectProtocol(
              new Error(
                "The main installation channel cannot acknowledge cancellation.",
              ),
            );
          }
          return;
        }
        if (cancellationRequested) return;
        try {
          state = applyRemoteEvent({
            identity,
            state,
            executionItems,
            event,
            attemptId,
            stdout,
          });
        } catch (error) {
          rejectProtocol(error);
        }
      },
    });
    mainChild.stdout?.on("data", (chunk) => stdoutParser.push(chunk));
    mainChild.stderr?.on("data", (chunk) => {
      try {
        stderrParser.push(chunk);
      } catch (error) {
        rejectProtocol(error);
      }
    });

    const processResultPromise = observeChild(mainChild);
    await Promise.resolve();
    if (!cancellationRequested) {
      try {
        mainChild.stdin.on("error", () => {});
        mainChild.stdin.write(mainInvocation.driver);
        mainChild.stdin.end();
      } catch (error) {
        protocolError = error;
        try {
          mainChild.kill("SIGTERM");
        } catch {
          // The exact owned child may already have exited.
        }
      }
    }

    const processResult = await processResultPromise;
    stdoutParser.flush();
    try {
      stderrParser.flush();
    } catch (error) {
      rejectProtocol(error);
    }
    if (cancellationPromise !== null) await cancellationPromise;
    mainChild = null;

    if (cancellationRequested) {
      state = readRun(identity);
      if (state.cancel?.acknowledgedAt !== undefined) {
        state = recordEvent(
          identity,
          {
            type: "attempt-exited",
            attemptId,
            ownedProcessToken,
            outcome: "cancelled",
          },
          { expectedRevision: state.revision },
        );
      }
    } else {
      state = failRunningPhase(identity, state, attemptId);
      const currentBatchItems = state.items.filter(
        (item) => item.batchId === prepared.batch.batchId,
      );
      const allVerified = currentBatchItems.every(
        (item) => item.phases.verify.status === "succeeded",
      );
      if (
        protocolError === null &&
        processResult.error === null &&
        processResult.code === 0 &&
        allVerified
      ) {
        state = recordEvent(
          identity,
          {
            type: "attempt-exited",
            attemptId,
            ownedProcessToken,
            outcome: "succeeded",
          },
          { expectedRevision: state.revision },
        );
      } else {
        const reasonCode =
          protocolError !== null
            ? "protocol-error"
            : processResult.error !== null
              ? normalizeReasonCode(processResult.error)
              : currentBatchItems.some((item) => item.status === "failed")
                ? "item-failed"
                : "incomplete-driver-exit";
        state = recordEvent(
          identity,
          {
            type: "attempt-exited",
            attemptId,
            ownedProcessToken,
            outcome: "failed",
            reasonCode,
            ...(Number.isInteger(processResult.code)
              ? { exitCode: processResult.code }
              : {}),
          },
          { expectedRevision: state.revision },
        );
      }
    }
    return state;
  } finally {
    signalSource.removeListener("SIGINT", onInterrupt);
    signalSource.removeListener("SIGTERM", onTerminate);
  }
}

function createRunIdentity(prepared) {
  const runKey = createRunKey(prepared);
  return {
    statePath: join(prepared.stateDir, `${runKey}.json`),
    runId: `run-${runKey}`,
    scheduleSha256: prepared.schedule.scheduleSha256,
    profileSha256: prepared.profileSha256,
    targetIdentitySha256: prepared.targetIdentitySha256,
  };
}

function createRunKey(prepared) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        scheduleSha256: prepared.schedule.scheduleSha256,
        preflightSha256: prepared.schedule.preflightSha256,
        profileSha256: prepared.profileSha256,
        targetIdentitySha256: prepared.targetIdentitySha256,
        machineExecutionIdentitySha256:
          prepared.machineExecutionIdentitySha256,
        platform: prepared.platform,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

function acquireRunLease(prepared, { attemptId, targetLockRoot }) {
  mkdirSync(targetLockRoot, { recursive: true, mode: 0o700 });
  chmodSync(targetLockRoot, 0o700);
  const leasePath = join(
    targetLockRoot,
    `${prepared.machineExecutionIdentitySha256}.lock`,
  );
  const leaseId = `lease-${randomUUID()}`;
  const leaseRecord = {
    schemaVersion: 1,
    leaseId,
    controllerPid: process.pid,
    attemptId,
    runKey: createRunKey(prepared),
    batchId: prepared.batch.batchId,
    scheduleSha256: prepared.schedule.scheduleSha256,
    preflightSha256: prepared.schedule.preflightSha256,
    profileSha256: prepared.profileSha256,
    targetIdentitySha256: prepared.targetIdentitySha256,
    machineExecutionIdentitySha256:
      prepared.machineExecutionIdentitySha256,
    platform: prepared.platform,
    createdAt: new Date().toISOString(),
  };
  let descriptor;
  let createdLease = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(leasePath, "wx", 0o600);
      createdLease = true;
      writeFileSync(descriptor, `${JSON.stringify(leaseRecord)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        descriptor = undefined;
      }
      if (createdLease) {
        removeLeaseIfOwned(leasePath, leaseId);
        createdLease = false;
      }
      if (
        error.code === "EEXIST" &&
        attempt === 0 &&
        removeConfirmedOrphanLease(leasePath, prepared)
      ) {
        continue;
      }
      if (error.code === "EEXIST") {
        throw new Error(
          `Installation run already has an execution lease: ${leasePath}`,
        );
      }
      throw error;
    }
  }
  return () => {
    removeLeaseIfOwned(leasePath, leaseId);
  };
}

function removeConfirmedOrphanLease(leasePath, prepared) {
  let lease;
  try {
    lease = JSON.parse(readFileSync(leasePath, "utf8"));
  } catch {
    return false;
  }
  if (
    !isPlainObject(lease) ||
    lease.schemaVersion !== 1 ||
    !/^lease-[0-9a-f-]{36}$/.test(lease.leaseId ?? "") ||
    !Number.isSafeInteger(lease.controllerPid) ||
    lease.controllerPid < 1 ||
    !idPattern.test(lease.attemptId ?? "") ||
    !/^[a-f0-9]{32}$/.test(lease.runKey ?? "") ||
    !idPattern.test(lease.batchId ?? "") ||
    !/^[a-f0-9]{64}$/.test(lease.scheduleSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(lease.preflightSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(lease.profileSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(lease.targetIdentitySha256 ?? "") ||
    lease.machineExecutionIdentitySha256 !==
      prepared.machineExecutionIdentitySha256 ||
    !["macos", "windows"].includes(lease.platform) ||
    typeof lease.createdAt !== "string" ||
    !Number.isFinite(Date.parse(lease.createdAt))
  ) {
    return false;
  }
  try {
    process.kill(lease.controllerPid, 0);
    return false;
  } catch (error) {
    if (error.code !== "ESRCH") return false;
  }
  return removeLeaseIfOwned(leasePath, lease.leaseId);
}

function removeLeaseIfOwned(leasePath, leaseId) {
  let current;
  try {
    current = JSON.parse(readFileSync(leasePath, "utf8"));
  } catch (error) {
    return error.code === "ENOENT";
  }
  if (!isPlainObject(current) || current.leaseId !== leaseId) return false;
  try {
    unlinkSync(leasePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

function openOrCreateRun(identity, schedule) {
  if (existsSync(identity.statePath)) return readRun(identity);
  return createRun(identity, {
    items: schedule.batches.flatMap((batch) =>
      batch.items.map((item) => ({
        softwareId: item.softwareId,
        batchId: batch.batchId,
        dependsOn: item.dependsOn,
        executionMode: item.executionMode,
      })),
    ),
  });
}

function createExecutionItems(state, batch) {
  return batch.items.flatMap((item) => {
    const stateItem = state.items.find(
      (candidate) => candidate.softwareId === item.softwareId,
    );
    if (!stateItem || stateItem.batchId !== batch.batchId) {
      throw new Error(`Run state does not contain ${item.softwareId}.`);
    }
    if (stateItem.phases.verify.status === "succeeded") return [];
    const firstIncomplete = phaseNames.findIndex(
      (phase) =>
        !["succeeded", "not-applicable"].includes(
          stateItem.phases[phase].status,
        ),
    );
    return [
      {
        ...item,
        phases: phaseNames.slice(firstIncomplete),
      },
    ];
  });
}

function buildSshInvocation(
  prepared,
  executionItems,
  eventToken,
  runKey,
  attemptId,
  ownedProcessToken,
) {
  const {
    target,
    sshConfig,
    knownHostsPath,
    identityFile,
    platform,
  } = prepared;
  const commonArgs = [
    "-F",
    sshConfig,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "GlobalKnownHostsFile=none",
    "-o",
    `IdentityFile=${identityFile}`,
    "-o",
    "IdentityAgent=none",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "KnownHostsCommand=none",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "CanonicalizeHostname=no",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "HostbasedAuthentication=no",
    "-o",
    "GSSAPIAuthentication=no",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    target,
  ];
  if (platform === "windows") {
    return {
      args: [
        ...commonArgs,
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "-",
      ],
      driver: buildWindowsDriver(
        executionItems,
        eventToken,
        runKey,
        attemptId,
        ownedProcessToken,
      ),
    };
  }
  return {
    args: [...commonArgs, "/bin/sh", "-s"],
    driver: buildMacosDriver(
      executionItems,
      eventToken,
      runKey,
      attemptId,
      ownedProcessToken,
    ),
  };
}

function buildCancelInvocation({
  target,
  sshConfig,
  knownHostsPath,
  identityFile,
  platform,
  runKey,
  attemptId,
  eventToken,
  ownedProcessToken,
}) {
  const commonArgs = [
    "-F",
    sshConfig,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "GlobalKnownHostsFile=none",
    "-o",
    `IdentityFile=${identityFile}`,
    "-o",
    "IdentityAgent=none",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "KnownHostsCommand=none",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "CanonicalizeHostname=no",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "HostbasedAuthentication=no",
    "-o",
    "GSSAPIAuthentication=no",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ServerAliveInterval=2",
    "-o",
    "ServerAliveCountMax=2",
    target,
  ];
  if (platform === "windows") {
    return {
      args: [
        ...commonArgs,
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "-",
      ],
      driver: buildWindowsCancelDriver(
        runKey,
        attemptId,
        eventToken,
        ownedProcessToken,
      ),
    };
  }
  return {
    args: [...commonArgs, "/bin/sh", "-s"],
    driver: buildMacosCancelDriver(
      runKey,
      attemptId,
      eventToken,
      ownedProcessToken,
    ),
  };
}

function buildMacosCancelDriver(
  runKey,
  attemptId,
  eventToken,
  ownedProcessToken,
) {
  return `#!/bin/sh
set -eu
umask 077

# dawn-forge-cancel-driver
run_key='${runKey}'
expected_token='${ownedProcessToken}'
expected_attempt='${attemptId}'
event_token='${eventToken}'
run_dir="$HOME/.dawn-forge/runs"
state_path="$run_dir/$run_key.state"
fifo_path="$run_dir/$run_key.cancel"

[ -f "$state_path" ] || exit 74
[ -p "$fifo_path" ] || exit 74
current_uid=$(id -u)
[ "$(stat -f '%Lp' "$run_dir")" = 700 ] || exit 77
[ "$(stat -f '%Lp' "$state_path")" = 600 ] || exit 77
[ "$(stat -f '%Lp' "$fifo_path")" = 600 ] || exit 77
[ "$(stat -f '%u' "$run_dir")" = "$current_uid" ] || exit 77
[ "$(stat -f '%u' "$state_path")" = "$current_uid" ] || exit 77
[ "$(stat -f '%u' "$fifo_path")" = "$current_uid" ] || exit 77

read_field() {
  awk -F= -v key="$1" '$1 == key { print $2; exit }' "$state_path"
}

receipt_token=$(read_field token)
receipt_attempt=$(read_field attempt_id)
main_pid=$(read_field main_pid)
receipt_status=$(read_field status)
[ "$receipt_token" = "$expected_token" ] || exit 77
[ "$receipt_attempt" = "$expected_attempt" ] || exit 77
[ "$receipt_status" = running ] || exit 77
case "$main_pid" in
  ''|*[!0-9]*) exit 77 ;;
esac

exec 3<>"$fifo_path"
kill -TERM "$main_pid"
if IFS= read -r -t 5 acknowledgement <&3 &&
   [ "$acknowledgement" = "$expected_token" ] &&
   [ "$(read_field status)" = cancelled ]; then
  printf '${eventPrefix}|%s|cancellation-acknowledged|-|-|0\\n' \
    "$event_token" >&2
  rm -f "$state_path" "$fifo_path"
  exit 0
fi
exit 75
`;
}

function buildWindowsCancelDriver(
  runKey,
  attemptId,
  eventToken,
  ownedProcessToken,
) {
  return `$ErrorActionPreference = "Stop"

# dawn-forge-cancel-driver
$RunKey = "${runKey}"
$ExpectedToken = "${ownedProcessToken}"
$ExpectedAttempt = "${attemptId}"
$EventToken = "${eventToken}"
$RunDirectory = Join-Path $env:LOCALAPPDATA "DawnForge\\runs"
$StatePath = Join-Path $RunDirectory "$RunKey.json"

if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
  exit 74
}
$Receipt = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
$CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$StateOwner = (Get-Acl -LiteralPath $StatePath).Owner
if (
  $Receipt.token -ne $ExpectedToken -or
  $Receipt.attemptId -ne $ExpectedAttempt -or
  $Receipt.status -ne "running" -or
  $StateOwner -notin @($CurrentSid, "$env:USERDOMAIN\\$env:USERNAME")
) {
  exit 77
}
foreach ($ProcessId in @($Receipt.childPid, $Receipt.mainPid)) {
  if ($null -ne $ProcessId -and [int]$ProcessId -gt 0) {
    & taskkill.exe /PID ([string]$ProcessId) /T /F 2>$null | Out-Null
  }
}
try {
  $MainProcess = [Diagnostics.Process]::GetProcessById([int]$Receipt.mainPid)
  if (-not $MainProcess.WaitForExit(5000)) {
    exit 75
  }
} catch [ArgumentException] {
  # The exact process already exited.
}
if (
  [int]$Receipt.childPid -gt 0 -and
  $null -ne (
    Get-Process -Id ([int]$Receipt.childPid) -ErrorAction SilentlyContinue
  )
) {
  exit 75
}
$Receipt.status = "cancelled"
$Receipt | ConvertTo-Json -Compress | Set-Content -LiteralPath $StatePath -Encoding UTF8
[Console]::Error.WriteLine(
  "${eventPrefix}|{0}|cancellation-acknowledged|-|-|0",
  $EventToken
)
Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
`;
}

async function runRemoteCancellation({
  spawnProcess,
  invocation,
  stdout,
  stderr,
  eventToken,
  onCancelChild,
  onAcknowledged,
}) {
  let child;
  try {
    child = spawnProcess("ssh", invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    });
  } catch (error) {
    return { acknowledged: false, error };
  }
  onCancelChild(child);
  let sawAcknowledgement = false;
  let protocolError = null;
  const stdoutParser = createLineForwarder(stdout);
  const stderrParser = createProtocolParser({
    destination: stderr,
    eventToken,
    onEvent(event) {
      if (
        event.type !== "cancellation-acknowledged" ||
        sawAcknowledgement ||
        protocolError !== null
      ) {
        protocolError = new Error("Unexpected cancellation protocol event.");
        try {
          child.kill("SIGTERM");
        } catch {
          // The cancellation SSH may already have exited.
        }
        return;
      }
      sawAcknowledgement = true;
    },
  });
  child.stdout?.on("data", (chunk) => stdoutParser.push(chunk));
  child.stderr?.on("data", (chunk) => {
    try {
      stderrParser.push(chunk);
    } catch (error) {
      protocolError = error;
      try {
        child.kill("SIGTERM");
      } catch {
        // The cancellation SSH may already have exited.
      }
    }
  });
  const resultPromise = observeChild(child);
  try {
    child.stdin.on("error", () => {});
    child.stdin.write(invocation.driver);
    child.stdin.end();
  } catch (error) {
    protocolError = error;
    try {
      child.kill("SIGTERM");
    } catch {
      // The cancellation SSH may already have exited.
    }
  }
  const result = await resultPromise;
  stdoutParser.flush();
  try {
    stderrParser.flush();
  } catch (error) {
    protocolError = error;
  }
  let acknowledged =
    sawAcknowledgement &&
    protocolError === null &&
    result.error === null &&
    result.code === 0;
  if (acknowledged) {
    try {
      onAcknowledged();
    } catch (error) {
      protocolError = error;
      acknowledged = false;
    }
  }
  return {
    acknowledged,
    result,
    protocolError,
  };
}

function packageSpec(item) {
  if (
    item.version === "latest-stable" ||
    ["homebrew-metadata", "brew-formula", "brew-cask", "winget"].includes(
      item.installer,
    )
  ) {
    return item.package;
  }
  return `${item.package}@${item.version}`;
}

function buildMacosDriver(
  items,
  eventToken,
  runKey,
  attemptId,
  ownedProcessToken,
) {
  const calls = items
    .map(
      (item) =>
        `run_item '${item.installer}' '${item.softwareId}' '${item.package}' '${packageSpec(item)}' '${item.phases.join(" ")}' || overall_exit=1`,
    )
    .join("\n");
  const markers = items
    .map(
      (item) =>
        `# dawn-forge-item:${item.installer}|${item.softwareId}|${item.package}|${item.version}|${item.phases.join(",")}`,
    )
    .join("\n");
  return `#!/bin/sh
set -u
set -m

# dawn-forge-event-token:${eventToken}
${markers}
event_token='${eventToken}'
run_key='${runKey}'
attempt_id='${attemptId}'
owned_process_token='${ownedProcessToken}'
PATH="$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
umask 077

run_dir="$HOME/.dawn-forge/runs"
state_path="$run_dir/$run_key.state"
fifo_path="$run_dir/$run_key.cancel"
receipt_root="$run_dir/$run_key.receipts"
receipt_dir="$receipt_root/$attempt_id"
mkdir -p "$run_dir"
chmod 700 "$run_dir"
if [ -f "$state_path" ]; then
  stale_main_pid=$(awk -F= '$1 == "main_pid" { print $2; exit }' "$state_path")
  case "$stale_main_pid" in
    ''|*[!0-9]*) exit 73 ;;
  esac
  if kill -0 "$stale_main_pid" 2>/dev/null; then
    exit 73
  fi
  rm -f "$state_path" "$fifo_path"
fi
mkdir -p "$receipt_root" "$receipt_dir"
chmod 700 "$receipt_root" "$receipt_dir"
receipt_identity="$receipt_dir/identity.receipt"
identity_temporary="$receipt_identity.$$"
printf 'attempt_id=%s\\ntoken=%s\\n' \
  "$attempt_id" "$owned_process_token" > "$identity_temporary"
chmod 600 "$identity_temporary"
mv -f "$identity_temporary" "$receipt_identity"
rm -f "$fifo_path"
mkfifo "$fifo_path"
chmod 600 "$fifo_path"
exec 9<>"$fifo_path"

emit_event() {
  printf '${eventPrefix}|%s|%s|%s|%s|%s\\n' \
    "$event_token" "$1" "$2" "$3" "$4" >&2
}

main_started_at=$(ps -p "$$" -o lstart= | sed 's/^ *//;s/ *$//')
active_operation_pid=
active_operation_started_at=
current_software_id=
current_phase=
current_phase_state=idle
write_remote_state() {
  remote_status=$1
  state_temporary="$state_path.$$"
  printf 'attempt_id=%s\\ntoken=%s\\nmain_pid=%s\\nmain_started_at=%s\\nchild_pid=%s\\nchild_started_at=%s\\nsoftware_id=%s\\nphase=%s\\nphase_state=%s\\nstatus=%s\\n' \
    "$attempt_id" "$owned_process_token" "$$" "$main_started_at" \
    "\${active_operation_pid:-0}" "\${active_operation_started_at:-}" \
    "\${current_software_id:-}" "\${current_phase:-}" \
    "\${current_phase_state:-idle}" "$remote_status" \
    > "$state_temporary"
  chmod 600 "$state_temporary"
  mv -f "$state_temporary" "$state_path"
}
write_remote_state running

write_phase_receipt() {
  receipt_software_id=$1
  receipt_phase=$2
  receipt_outcome=$3
  receipt_exit_code=$4
  receipt_finished_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  receipt_path="$receipt_dir/$receipt_software_id.$receipt_phase.receipt"
  receipt_temporary="$receipt_path.$$"
  printf 'attempt_id=%s\\ntoken=%s\\nsoftware_id=%s\\nphase=%s\\noutcome=%s\\nexit_code=%s\\nfinished_at=%s\\n' \
    "$attempt_id" "$owned_process_token" "$receipt_software_id" \
    "$receipt_phase" "$receipt_outcome" "$receipt_exit_code" \
    "$receipt_finished_at" > "$receipt_temporary"
  chmod 600 "$receipt_temporary"
  mv -f "$receipt_temporary" "$receipt_path"
}

acknowledge_cancel() {
  trap - HUP INT TERM
  if [ -n "$active_operation_pid" ]; then
    kill -TERM "-$active_operation_pid" 2>/dev/null ||
      kill -TERM "$active_operation_pid" 2>/dev/null || :
    if kill -0 "$active_operation_pid" 2>/dev/null; then
      kill -KILL "-$active_operation_pid" 2>/dev/null ||
        kill -KILL "$active_operation_pid" 2>/dev/null || :
    fi
    wait "$active_operation_pid" 2>/dev/null || :
    if kill -0 "$active_operation_pid" 2>/dev/null; then
      current_phase_state=termination-unconfirmed
      write_remote_state termination-unconfirmed
      exit 75
    fi
    active_operation_pid=
    active_operation_started_at=
  fi
  current_phase_state=cancelled
  write_remote_state cancelled
  printf '%s\\n' "$owned_process_token" >&9
  exit 130
}
trap acknowledge_cancel HUP INT TERM

run_operation() {
  installer=$1
  phase=$2
  package_name=$3
  package_spec=$4
  case "$installer:$phase" in
    homebrew-metadata:fetch)
      exec brew update-if-needed
      ;;
    homebrew-metadata:install)
      :
      ;;
    homebrew-metadata:verify)
      exec brew config >/dev/null
      ;;
    brew-formula:fetch)
      exec env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 \
        brew fetch --formula "$package_name"
      ;;
    brew-formula:install)
      exec env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 \
        brew install --formula "$package_name"
      ;;
    brew-formula:verify)
      exec brew list --formula --versions "$package_name" >/dev/null
      ;;
    brew-cask:fetch)
      exec env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 \
        brew fetch --cask "$package_name"
      ;;
    brew-cask:install)
      exec env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 \
        brew install --cask "$package_name"
      ;;
    brew-cask:verify)
      exec brew list --cask "$package_name" >/dev/null
      ;;
    npm-global:fetch)
      exec npm cache add "$package_spec"
      ;;
    npm-global:install)
      exec npm install --global "$package_spec"
      ;;
    npm-global:verify)
      exec npm list --global --depth=0 "$package_spec" >/dev/null
      ;;
    volta-tool:fetch)
      exec volta fetch "$package_spec"
      ;;
    volta-tool:install)
      exec volta install "$package_spec"
      ;;
    volta-tool:verify)
      if [ "$package_spec" = "$package_name" ]; then
        exec volta which "$package_name" >/dev/null
      fi
      installed_version=$("$package_name" --version | sed -n '1p')
      [ "$installed_version" = "\${package_spec##*@}" ]
      ;;
    *)
      echo "Unsupported controlled installation operation." >&2
      return 64
      ;;
  esac
}

run_item() {
  item_installer=$1
  software_id=$2
  item_package=$3
  item_package_spec=$4
  item_phases=$5
  for phase in $item_phases; do
    current_software_id=$software_id
    current_phase=$phase
    current_phase_state=starting
    write_remote_state running
    emit_event phase-started "$software_id" "$phase" -
    run_operation "$item_installer" "$phase" "$item_package" "$item_package_spec" &
    active_operation_pid=$!
    active_operation_started_at=$(ps -p "$active_operation_pid" -o lstart= | sed 's/^ *//;s/ *$//')
    current_phase_state=running
    write_remote_state running
    if wait "$active_operation_pid"; then
      write_phase_receipt "$software_id" "$phase" succeeded 0
      active_operation_pid=
      active_operation_started_at=
      current_phase_state=finished
      write_remote_state running
      emit_event phase-succeeded "$software_id" "$phase" 0
    else
      operation_exit=$?
      write_phase_receipt "$software_id" "$phase" failed "$operation_exit"
      active_operation_pid=
      active_operation_started_at=
      current_phase_state=finished
      write_remote_state running
      emit_event phase-failed "$software_id" "$phase" "$operation_exit"
      return "$operation_exit"
    fi
  done
}

overall_exit=0
${calls}
current_software_id=
current_phase=
current_phase_state=finished
write_remote_state finished
exec 9>&-
exit "$overall_exit"
`;
}

function buildWindowsDriver(
  items,
  eventToken,
  runKey,
  attemptId,
  ownedProcessToken,
) {
  const itemDefinitions = items
    .map(
      (item) =>
        `  [pscustomobject]@{ Installer = "${item.installer}"; SoftwareId = "${item.softwareId}"; PackageName = "${item.package}"; PackageSpec = "${packageSpec(item)}"; Version = "${item.version}"; Phases = @(${item.phases.map((phase) => `"${phase}"`).join(", ")}) }`,
    )
    .join(",\n");
  const markers = items
    .map(
      (item) =>
        `# dawn-forge-item:${item.installer}|${item.softwareId}|${item.package}|${item.version}|${item.phases.join(",")}`,
    )
    .join("\n");
  return `$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# dawn-forge-event-token:${eventToken}
${markers}
$EventToken = "${eventToken}"
$RunKey = "${runKey}"
$AttemptId = "${attemptId}"
$OwnedProcessToken = "${ownedProcessToken}"
$Items = @(
${itemDefinitions}
)
$RunDirectory = Join-Path $env:LOCALAPPDATA "DawnForge\\runs"
$StatePath = Join-Path $RunDirectory "$RunKey.json"
$ReceiptRoot = Join-Path $RunDirectory "$RunKey.receipts"
$ReceiptDirectory = Join-Path $ReceiptRoot $AttemptId
$ActiveChildPid = 0
$ActiveChildStartTimeUtcTicks = 0
$CurrentSoftwareId = ""
$CurrentPhase = ""
$CurrentPhaseState = "idle"
$MainStartTimeUtcTicks = (
  Get-Process -Id $PID
).StartTime.ToUniversalTime().Ticks

function Protect-DawnForgePath {
  param([string]$Path, [bool]$IsDirectory)
  $CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($IsDirectory) {
    $Security = [Security.AccessControl.DirectorySecurity]::new()
    $Rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $CurrentSid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
  } else {
    $Security = [Security.AccessControl.FileSecurity]::new()
    $Rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $CurrentSid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.AccessControlType]::Allow
    )
  }
  $Security.SetAccessRuleProtection($true, $false)
  $Security.SetOwner($CurrentSid)
  $Security.AddAccessRule($Rule)
  Set-Acl -LiteralPath $Path -AclObject $Security
}

New-Item -ItemType Directory -Path $RunDirectory -Force | Out-Null
Protect-DawnForgePath $RunDirectory $true
New-Item -ItemType Directory -Path $ReceiptRoot -Force | Out-Null
Protect-DawnForgePath $ReceiptRoot $true
New-Item -ItemType Directory -Path $ReceiptDirectory -Force | Out-Null
Protect-DawnForgePath $ReceiptDirectory $true
$ReceiptIdentityPath = Join-Path $ReceiptDirectory "identity.json"
[ordered]@{
  attemptId = $AttemptId
  token = $OwnedProcessToken
} | ConvertTo-Json -Compress |
  Set-Content -LiteralPath $ReceiptIdentityPath -Encoding UTF8
Protect-DawnForgePath $ReceiptIdentityPath $false
if (Test-Path -LiteralPath $StatePath -PathType Leaf) {
  $StaleReceipt = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  $StaleProcess = Get-Process -Id ([int]$StaleReceipt.mainPid) -ErrorAction SilentlyContinue
  if (
    $null -ne $StaleProcess -and
    $StaleProcess.StartTime.ToUniversalTime().Ticks -eq
      [long]$StaleReceipt.mainStartTimeUtcTicks
  ) {
    throw "A controlled Dawn Forge process is already active."
  }
  Remove-Item -LiteralPath $StatePath -Force
}

function Write-RemoteState {
  param([string]$Status)
  $TemporaryPath = "$StatePath.$PID.tmp"
  [ordered]@{
    attemptId = $AttemptId
    token = $OwnedProcessToken
    mainPid = $PID
    mainStartTimeUtcTicks = $MainStartTimeUtcTicks
    childPid = $script:ActiveChildPid
    childStartTimeUtcTicks = $script:ActiveChildStartTimeUtcTicks
    softwareId = $script:CurrentSoftwareId
    phase = $script:CurrentPhase
    phaseState = $script:CurrentPhaseState
    status = $Status
  } | ConvertTo-Json -Compress |
    Set-Content -LiteralPath $TemporaryPath -Encoding UTF8
  Protect-DawnForgePath $TemporaryPath $false
  Move-Item -LiteralPath $TemporaryPath -Destination $StatePath -Force
}
Write-RemoteState "running"

function Write-PhaseReceipt {
  param(
    [string]$SoftwareId,
    [string]$Phase,
    [string]$Outcome,
    [int]$ExitCode,
    [string]$ReasonCode
  )
  $ReceiptPath = Join-Path $ReceiptDirectory "$SoftwareId.$Phase.json"
  $TemporaryPath = "$ReceiptPath.$PID.tmp"
  [ordered]@{
    attemptId = $AttemptId
    token = $OwnedProcessToken
    softwareId = $SoftwareId
    phase = $Phase
    outcome = $Outcome
    exitCode = $ExitCode
    finishedAt = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    reasonCode = $ReasonCode
  } | ConvertTo-Json -Compress |
    Set-Content -LiteralPath $TemporaryPath -Encoding UTF8
  Protect-DawnForgePath $TemporaryPath $false
  Move-Item -LiteralPath $TemporaryPath -Destination $ReceiptPath -Force
}

function Write-ControlEvent {
  param(
    [string]$Type,
    [string]$SoftwareId,
    [string]$Phase,
    [string]$ExitCode
  )
  [Console]::Error.WriteLine(
    "${eventPrefix}|{0}|{1}|{2}|{3}|{4}",
    $EventToken,
    $Type,
    $SoftwareId,
    $Phase,
    $ExitCode
  )
}

function Invoke-OwnedProcess {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$RedirectStandardOutput
  )
  $ArgumentLine = (
    $Arguments | ForEach-Object {
      if ($_ -match '[\\s"]') {
        '"' + ($_ -replace '"', '\\"') + '"'
      } else {
        $_
      }
    }
  ) -join " "
  $StartParameters = @{
    FilePath = $FilePath
    ArgumentList = $ArgumentLine
    NoNewWindow = $true
    PassThru = $true
  }
  if ($RedirectStandardOutput) {
    $StartParameters.RedirectStandardOutput = $RedirectStandardOutput
  }
  $OwnedProcess = Start-Process @StartParameters
  $script:ActiveChildPid = $OwnedProcess.Id
  $script:ActiveChildStartTimeUtcTicks =
    $OwnedProcess.StartTime.ToUniversalTime().Ticks
  $script:CurrentPhaseState = "running"
  Write-RemoteState "running"
  try {
    $OwnedProcess.WaitForExit()
    $script:OperationExitCode = $OwnedProcess.ExitCode
  } finally {
    $script:ActiveChildPid = 0
    $script:ActiveChildStartTimeUtcTicks = 0
    $script:CurrentPhaseState = "finished"
    Write-RemoteState "running"
  }
}

function Invoke-ControlledOperation {
  param(
    [string]$Installer,
    [string]$Phase,
    [string]$PackageName,
    [string]$PackageSpec,
    [string]$Version
  )
  switch ($Installer) {
    "winget" {
      if ($Phase -eq "verify" -and $Version -ne "latest-stable") {
        $ReceiptPath = Join-Path ([IO.Path]::GetTempPath()) (
          "dawn-forge-winget-{0}.json" -f [Guid]::NewGuid().ToString("N")
        )
        try {
          Invoke-OwnedProcess "winget" @(
            "export", "--output", $ReceiptPath, "--include-versions",
            "--accept-source-agreements", "--disable-interactivity"
          ) $null
          if ($script:OperationExitCode -ne 0) {
            throw "Winget installed-version receipt export failed."
          }
          $Receipt = Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json
          $Installed = @(
            $Receipt.Sources |
              ForEach-Object { $_.Packages } |
              Where-Object {
                $_.PackageIdentifier -ieq $PackageName -and
                $_.Version -eq $Version
              }
          )
          if ($Installed.Count -ne 1) {
            throw "Installed Winget version does not match the approved version."
          }
          return
        } finally {
          Remove-Item -LiteralPath $ReceiptPath -Force -ErrorAction SilentlyContinue
        }
      }
      $WingetArguments = switch ($Phase) {
        "fetch" {
          throw "Winget fetch is metadata-only and must be marked not-applicable."
        }
        "install" {
          @(
            "install", "--id", $PackageName, "--exact",
            "--accept-source-agreements", "--accept-package-agreements",
            "--disable-interactivity", "--silent"
          )
        }
        "verify" {
          @("list", "--id", $PackageName, "--exact", "--disable-interactivity")
        }
        default {
          throw "Unsupported controlled installation phase."
        }
      }
      if ($Version -ne "latest-stable" -and $Phase -eq "install") {
        $WingetArguments += @("--version", $Version)
      }
      Invoke-OwnedProcess "winget" $WingetArguments $null
    }
    "npm-global" {
      switch ($Phase) {
        "fetch" {
          Invoke-OwnedProcess "npm" @("cache", "add", $PackageSpec) $null
        }
        "install" {
          Invoke-OwnedProcess "npm" @("install", "--global", $PackageSpec) $null
        }
        "verify" {
          Invoke-OwnedProcess "npm" @(
            "list", "--global", "--depth=0", $PackageSpec
          ) $null
        }
        default { throw "Unsupported controlled installation phase." }
      }
    }
    "volta-tool" {
      switch ($Phase) {
        "fetch" {
          Invoke-OwnedProcess "volta" @("fetch", $PackageSpec) $null
        }
        "install" {
          Invoke-OwnedProcess "volta" @("install", $PackageSpec) $null
        }
        "verify" {
          if ($PackageSpec -eq $PackageName) {
            Invoke-OwnedProcess "volta" @("which", $PackageName) $null
          } else {
            $VersionPath = Join-Path ([IO.Path]::GetTempPath()) (
              "dawn-forge-version-{0}.txt" -f [Guid]::NewGuid().ToString("N")
            )
            try {
              Invoke-OwnedProcess $PackageName @("--version") $VersionPath
              $InstalledVersion = (
                Get-Content -LiteralPath $VersionPath |
                  Select-Object -First 1
              )
              if (
                $script:OperationExitCode -ne 0 -or
                $InstalledVersion -ne $Version
              ) {
                throw "Installed Volta tool version does not match the approved version."
              }
            } finally {
              Remove-Item -LiteralPath $VersionPath -Force -ErrorAction SilentlyContinue
            }
          }
        }
        default { throw "Unsupported controlled installation phase." }
      }
    }
    default {
      throw "Unsupported controlled installation operation."
    }
  }
}

$OverallExitCode = 0
foreach ($Item in $Items) {
  foreach ($Phase in $Item.Phases) {
    $script:CurrentSoftwareId = $Item.SoftwareId
    $script:CurrentPhase = $Phase
    $script:CurrentPhaseState = "starting"
    Write-RemoteState "running"
    if ($Item.Installer -eq "winget" -and $Phase -eq "fetch") {
      Write-PhaseReceipt $Item.SoftwareId $Phase "not-applicable" 0 "metadata-only"
      $script:CurrentPhaseState = "finished"
      Write-RemoteState "running"
      Write-ControlEvent "phase-not-applicable" $Item.SoftwareId $Phase "metadata-only"
      continue
    }
    Write-ControlEvent "phase-started" $Item.SoftwareId $Phase "-"
    try {
      $script:OperationExitCode = 0
      Invoke-ControlledOperation $Item.Installer $Phase $Item.PackageName $Item.PackageSpec $Item.Version
      $OperationExitCode = $script:OperationExitCode
      if ($null -eq $OperationExitCode) {
        $OperationExitCode = 0
      }
    } catch {
      [Console]::Error.WriteLine($_.Exception.Message)
      $OperationExitCode = 1
    }
    $ReceiptOutcome =
      if ($OperationExitCode -eq 0) { "succeeded" } else { "failed" }
    Write-PhaseReceipt $Item.SoftwareId $Phase $ReceiptOutcome $OperationExitCode ""
    if ($OperationExitCode -eq 0) {
      Write-ControlEvent "phase-succeeded" $Item.SoftwareId $Phase "0"
    } else {
      Write-ControlEvent "phase-failed" $Item.SoftwareId $Phase ([string]$OperationExitCode)
      $OverallExitCode = 1
      break
    }
  }
}
$script:CurrentSoftwareId = ""
$script:CurrentPhase = ""
$script:CurrentPhaseState = "finished"
Write-RemoteState "finished"
exit $OverallExitCode
`;
}

function observeChild(child) {
  return new Promise((resolveProcess) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolveProcess(result);
    };
    child.once("error", (error) =>
      settle({ code: null, signal: null, error }),
    );
    child.once("close", (code, signal) =>
      settle({ code, signal, error: null }),
    );
  });
}

function createProtocolParser({ destination, eventToken, onEvent }) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += String(chunk);
      drain(false);
    },
    flush() {
      drain(true);
    },
  };

  function drain(flushRemainder) {
    for (;;) {
      const match = /[\r\n]/.exec(buffer);
      if (match === null) break;
      const line = buffer.slice(0, match.index);
      let consumed = match.index + 1;
      if (
        buffer[match.index] === "\r" &&
        buffer[match.index + 1] === "\n"
      ) {
        consumed += 1;
      }
      buffer = buffer.slice(consumed);
      handleLine(line, true);
    }
    if (flushRemainder && buffer.length > 0) {
      handleLine(buffer, false);
      buffer = "";
    }
  }

  function handleLine(line, terminated) {
    const parsed = parseProtocolEvent(line, eventToken);
    if (parsed === null) {
      writeSafe(
        destination,
        `${redactOutput(line)}${terminated ? "\n" : ""}`,
      );
    } else {
      onEvent(parsed);
    }
  }
}

function createLineForwarder(destination) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += String(chunk);
      drain(false);
    },
    flush() {
      drain(true);
    },
  };

  function drain(flushRemainder) {
    for (;;) {
      const match = /[\r\n]/.exec(buffer);
      if (match === null) break;
      const line = buffer.slice(0, match.index);
      let consumed = match.index + 1;
      const separator =
        buffer[match.index] === "\r" &&
        buffer[match.index + 1] === "\n"
          ? "\r\n"
          : buffer[match.index];
      if (separator === "\r\n") consumed += 1;
      buffer = buffer.slice(consumed);
      writeSafe(destination, `${redactOutput(line)}${separator}`);
    }
    if (flushRemainder && buffer.length > 0) {
      writeSafe(destination, redactOutput(buffer));
      buffer = "";
    }
  }
}

function parseProtocolEvent(line, eventToken) {
  const parts = line.split("|");
  if (parts[0] !== eventPrefix || parts[1] !== eventToken) return null;
  if (parts.length !== 6) {
    throw new Error("Malformed controlled installation event.");
  }
  const [, , type, softwareId, phase, exitCodeText] = parts;
  if (type === "cancellation-acknowledged") {
    if (softwareId !== "-" || phase !== "-" || exitCodeText !== "0") {
      throw new Error("Invalid cancellation acknowledgement payload.");
    }
    return { type };
  }
  if (type === "phase-not-applicable") {
    if (
      !idPattern.test(softwareId) ||
      !["fetch", "install"].includes(phase) ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(exitCodeText)
    ) {
      throw new Error("Invalid not-applicable phase payload.");
    }
    return {
      type,
      softwareId,
      phase,
      reasonCode: exitCodeText,
      exitCode: null,
    };
  }
  if (
    !["phase-started", "phase-succeeded", "phase-failed"].includes(type) ||
    !idPattern.test(softwareId) ||
    !phaseNames.includes(phase)
  ) {
    throw new Error("Invalid controlled installation event.");
  }
  let exitCode = null;
  if (type === "phase-failed") {
    if (!/^\d{1,10}$/.test(exitCodeText)) {
      throw new Error("Invalid controlled installation exit code.");
    }
    exitCode = Number.parseInt(exitCodeText, 10);
  } else if (
    (type === "phase-started" && exitCodeText !== "-") ||
    (type === "phase-succeeded" && exitCodeText !== "0")
  ) {
    throw new Error("Invalid controlled installation event payload.");
  }
  return { type, softwareId, phase, exitCode };
}

function applyRemoteEvent({
  identity,
  state,
  executionItems,
  event,
  attemptId,
  stdout,
}) {
  const scheduledItem = executionItems.find(
    (item) => item.softwareId === event.softwareId,
  );
  if (!scheduledItem || !scheduledItem.phases.includes(event.phase)) {
    throw new Error("Event referenced software outside the owned batch.");
  }
  const stateEvent = {
    type: event.type,
    softwareId: event.softwareId,
    phase: event.phase,
    attemptId,
    ...(event.type === "phase-failed"
      ? { reasonCode: "remote-exit", exitCode: event.exitCode }
      : {}),
    ...(event.type === "phase-not-applicable"
      ? { reasonCode: event.reasonCode }
      : {}),
  };
  const nextState = recordEvent(identity, stateEvent, {
    expectedRevision: state.revision,
  });
  if (event.type === "phase-started") {
    writeSafe(
      stdout,
      `[${state.activeAttempt.batchId}] ${event.softwareId} ${event.phase}\n`,
    );
  } else {
    writeSafe(
      stdout,
      `[${state.activeAttempt.batchId}] ${event.softwareId} ${event.phase} ${
        event.type === "phase-succeeded"
          ? "succeeded"
          : event.type === "phase-not-applicable"
            ? "not-applicable"
            : "failed"
      }\n`,
    );
  }
  return nextState;
}

function failRunningPhase(identity, state, attemptId) {
  for (const item of state.items) {
    for (const phase of phaseNames) {
      if (
        item.phases[phase].status === "running" &&
        item.phases[phase].attemptId === attemptId
      ) {
        return recordEvent(
          identity,
          {
            type: "phase-failed",
            softwareId: item.softwareId,
            phase,
            attemptId,
            reasonCode: "driver-exited",
          },
          { expectedRevision: state.revision },
        );
      }
    }
  }
  return state;
}

function validateAndPrepare(input) {
  if (!isPlainObject(input)) throw new TypeError("input must be an object.");
  assertAllowedKeys(input, [
    "schedule",
    "batchId",
    "target",
    "sshConfig",
    "platform",
    "route",
    "stateDir",
    "profileSha256",
    "targetIdentitySha256",
    "machineExecutionIdentitySha256",
    "identityReceiptPath",
    "identityReceiptSha256",
  ], "input");
  if (!isPlainObject(input.schedule)) {
    throw new TypeError("schedule must be an object.");
  }
  validateScheduleDigest(input.schedule);
  validateScheduleShape(input.schedule);
  assertId(input.batchId, "batchId");
  if (!finalizedAliasPattern.test(input.target ?? "")) {
    throw new TypeError("target must be a finalized SSH alias, not a host address.");
  }
  if (!["macos", "windows"].includes(input.platform)) {
    throw new TypeError("platform must be macos or windows.");
  }
  if (!supportedRoutes.has(input.route)) {
    throw new TypeError("route must be direct, clash, or local.");
  }
  if (typeof input.stateDir !== "string" || input.stateDir.length === 0) {
    throw new TypeError("stateDir must be a non-empty path.");
  }
  for (const key of [
    "profileSha256",
    "targetIdentitySha256",
    "machineExecutionIdentitySha256",
    "identityReceiptSha256",
  ]) {
    if (!/^[a-f0-9]{64}$/.test(input[key] ?? "")) {
      throw new TypeError(`${key} must be a lowercase SHA-256 digest.`);
    }
  }
  if (
    input.schedule.machineExecutionIdentitySha256 !==
    input.machineExecutionIdentitySha256
  ) {
    throw new Error(
      "Installation schedule machine execution identity binding mismatch.",
    );
  }
  const sshBinding = validateSealedSshBinding(input);
  const batch = input.schedule.batches.find(
    (candidate) => candidate.batchId === input.batchId,
  );
  if (!batch) throw new Error(`Unknown installation batch: ${input.batchId}`);
  if (batch.route !== input.route) {
    throw new Error(
      `Installation route mismatch: batch requires ${batch.route}, received ${input.route}.`,
    );
  }
  validateBatch(batch);
  for (const scheduledBatch of input.schedule.batches) {
    if (
      scheduledBatch.installer === "winget" &&
      input.platform !== "windows"
    ) {
      throw new Error("The winget adapter requires a Windows target.");
    }
    if (
      ["homebrew-metadata", "brew-formula", "brew-cask"].includes(
        scheduledBatch.installer,
      ) &&
      input.platform !== "macos"
    ) {
      throw new Error("The Homebrew adapters require a macOS target.");
    }
  }
  return {
    schedule: input.schedule,
    batch,
    target: input.target,
    sshConfig: sshBinding.sshConfig,
    knownHostsPath: sshBinding.knownHostsPath,
    identityFile: sshBinding.identityFile,
    identityReceiptPath: sshBinding.identityReceiptPath,
    identityReceiptSha256: input.identityReceiptSha256,
    platform: input.platform,
    route: input.route,
    stateDir: resolve(input.stateDir),
    profileSha256: input.profileSha256,
    targetIdentitySha256: input.targetIdentitySha256,
    machineExecutionIdentitySha256:
      input.machineExecutionIdentitySha256,
  };
}

function validateSealedSshBinding(input) {
  if (
    typeof input.identityReceiptPath !== "string" ||
    input.identityReceiptPath.length === 0
  ) {
    throw new TypeError("identityReceiptPath must be a non-empty path.");
  }
  const identityReceiptPath = resolve(input.identityReceiptPath);
  const receiptBytes = readBoundRegularFile(
    identityReceiptPath,
    "Finalized target identity receipt",
  );
  if (sha256(receiptBytes) !== input.identityReceiptSha256) {
    throw new Error("Finalized target identity receipt digest mismatch.");
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    throw new Error("Finalized target identity receipt is not valid JSON.");
  }
  if (
    !isPlainObject(receipt) ||
    receipt.schemaVersion !== 1 ||
    receipt.finalized !== true ||
    receipt.alias !== input.target ||
    receipt.platform !== input.platform ||
    receipt.targetIdentitySha256 !== input.targetIdentitySha256 ||
    receipt.machineExecutionIdentitySha256 !==
      input.machineExecutionIdentitySha256 ||
    !isPlainObject(receipt.identity) ||
    !Array.isArray(receipt.hostKeyFingerprints) ||
    receipt.hostKeyFingerprints.length === 0
  ) {
    throw new Error("Finalized target identity receipt binding mismatch.");
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
    actualTargetIdentitySha256 !== input.targetIdentitySha256 ||
    actualMachineExecutionIdentitySha256 !==
      input.machineExecutionIdentitySha256
  ) {
    throw new Error("Finalized target identity digest recomputation failed.");
  }
  for (const key of [
    "sshConfigSha256",
    "knownHostsSha256",
    "identityFileSha256",
  ]) {
    if (!/^[a-f0-9]{64}$/.test(receipt[key] ?? "")) {
      throw new Error(`Finalized target identity receipt ${key} is invalid.`);
    }
  }
  if (typeof input.sshConfig !== "string" || input.sshConfig.length === 0) {
    throw new TypeError("sshConfig must be a non-empty path.");
  }
  const sshConfig = resolve(input.sshConfig);
  if (!samePath(sshConfig, receipt.sshConfigPath)) {
    throw new Error("Finalized SSH config path binding mismatch.");
  }
  const sshConfigBytes = readBoundRegularFile(
    sshConfig,
    "Finalized SSH config",
  );
  if (sha256(sshConfigBytes) !== receipt.sshConfigSha256) {
    throw new Error("Finalized SSH config digest mismatch.");
  }
  const knownHostsPath = resolve(receipt.knownHostsPath ?? "");
  const knownHostsBytes = readBoundRegularFile(
    knownHostsPath,
    "Controlled known_hosts",
  );
  if (sha256(knownHostsBytes) !== receipt.knownHostsSha256) {
    throw new Error("Controlled known_hosts digest mismatch.");
  }
  const identityFile = resolve(receipt.identityFile ?? "");
  const identityFileBytes = readBoundRegularFile(
    identityFile,
    "Finalized management identity file",
  );
  if (sha256(identityFileBytes) !== receipt.identityFileSha256) {
    throw new Error("Finalized management identity file digest mismatch.");
  }
  const configText = sshConfigBytes.toString("utf8");
  if (!configContainsExactAlias(configText, input.target)) {
    throw new Error(
      `Finalized SSH config does not contain exact alias ${input.target}.`,
    );
  }
  assertSshConfigCannotExecuteLocalCommands(configText, input.target);
  return {
    identityReceiptPath,
    sshConfig,
    knownHostsPath,
    identityFile,
  };
}

function readBoundRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
  return readFileSync(path);
}

function samePath(left, right) {
  if (typeof right !== "string" || right.length === 0) return false;
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateScheduleDigest(schedule) {
  if (!/^[a-f0-9]{64}$/.test(schedule.scheduleSha256 ?? "")) {
    throw new TypeError("scheduleSha256 must be a lowercase SHA-256 digest.");
  }
  const digestPayload = {
    schemaVersion: schedule.schemaVersion,
    preflightSha256: schedule.preflightSha256,
    machineExecutionIdentitySha256:
      schedule.machineExecutionIdentitySha256,
    maxItemsPerBatch: schedule.maxItemsPerBatch,
    initialRoutes: schedule.initialRoutes,
    routeOrder: schedule.routeOrder,
    batches: schedule.batches,
  };
  const actual = createHash("sha256")
    .update(JSON.stringify(digestPayload), "utf8")
    .digest("hex");
  if (actual !== schedule.scheduleSha256) {
    throw new Error("Installation schedule digest mismatch.");
  }
}

function validateScheduleShape(schedule) {
  assertAllowedKeys(
    schedule,
    [
      "schemaVersion",
      "preflightSha256",
      "machineExecutionIdentitySha256",
      "maxItemsPerBatch",
      "initialRoutes",
      "routeOrder",
      "batches",
      "scheduleSha256",
    ],
    "schedule",
  );
  if (schedule.schemaVersion !== 2) {
    throw new TypeError("Unsupported installation schedule schemaVersion.");
  }
  if (!/^[a-f0-9]{64}$/.test(schedule.preflightSha256 ?? "")) {
    throw new TypeError("schedule.preflightSha256 is invalid.");
  }
  if (
    !/^[a-f0-9]{64}$/.test(
      schedule.machineExecutionIdentitySha256 ?? "",
    )
  ) {
    throw new TypeError(
      "schedule.machineExecutionIdentitySha256 is invalid.",
    );
  }
  if (
    !Number.isInteger(schedule.maxItemsPerBatch) ||
    schedule.maxItemsPerBatch < 1 ||
    schedule.maxItemsPerBatch > 3
  ) {
    throw new TypeError("schedule.maxItemsPerBatch must be between 1 and 3.");
  }
  if (
    !isPlainObject(schedule.initialRoutes) ||
    Object.keys(schedule.initialRoutes).length !== 2 ||
    !["controller", "target"].every((location) =>
      ["direct", "clash"].includes(schedule.initialRoutes[location]),
    )
  ) {
    throw new TypeError("schedule.initialRoutes is invalid.");
  }
  if (
    !Array.isArray(schedule.routeOrder) ||
    schedule.routeOrder.length !== 3 ||
    new Set(schedule.routeOrder).size !== 3 ||
    schedule.routeOrder.some((route) => !supportedRoutes.has(route))
  ) {
    throw new TypeError("schedule.routeOrder is invalid.");
  }
  if (!Array.isArray(schedule.batches) || schedule.batches.length === 0) {
    throw new TypeError("schedule.batches must be a non-empty array.");
  }
  const batchIds = new Set();
  const softwareIds = new Set();
  const allItems = [];
  const previousRoutes = { ...schedule.initialRoutes };
  let previousDependencyLevel = -1;
  let homebrewMetadataCount = 0;
  for (const [index, batch] of schedule.batches.entries()) {
    if (!isPlainObject(batch)) {
      throw new TypeError(`schedule.batches[${index}] must be an object.`);
    }
    assertId(batch.batchId, `schedule.batches[${index}].batchId`);
    if (batchIds.has(batch.batchId)) {
      throw new TypeError(`Duplicate installation batch id: ${batch.batchId}`);
    }
    batchIds.add(batch.batchId);
    validateBatch(batch, schedule.maxItemsPerBatch);
    if (batch.sequence !== index + 1) {
      throw new TypeError(
        `schedule.batches[${index}].sequence must be ${index + 1}.`,
      );
    }
    if (batch.dependencyLevel < previousDependencyLevel) {
      throw new TypeError("Installation batches are not dependency ordered.");
    }
    previousDependencyLevel = batch.dependencyLevel;
    const expectedRouteSwitch =
      batch.networkLocation !== "none" &&
      batch.route !== previousRoutes[batch.networkLocation];
    if (batch.requiresRouteSwitch !== expectedRouteSwitch) {
      throw new TypeError(
        `Batch ${batch.batchId}.requiresRouteSwitch is inconsistent.`,
      );
    }
    if (batch.networkLocation !== "none") {
      previousRoutes[batch.networkLocation] = batch.route;
    }
    for (const item of batch.items) {
      if (softwareIds.has(item.softwareId)) {
        throw new TypeError(
          `Duplicate installation software id: ${item.softwareId}`,
        );
      }
      softwareIds.add(item.softwareId);
      allItems.push(item);
      if (item.installer === "homebrew-metadata") {
        homebrewMetadataCount += 1;
      }
    }
  }
  if (homebrewMetadataCount > 1) {
    throw new TypeError(
      "An installation run may contain exactly one homebrew-metadata item.",
    );
  }
  const itemsById = new Map(
    allItems.map((item) => [item.softwareId, item]),
  );
  const computedLevels = new Map();
  const visiting = new Set();
  const computeLevel = (item) => {
    if (computedLevels.has(item.softwareId)) {
      return computedLevels.get(item.softwareId);
    }
    if (visiting.has(item.softwareId)) {
      throw new TypeError(
        `Installation dependency cycle includes ${item.softwareId}.`,
      );
    }
    visiting.add(item.softwareId);
    const dependencyLevels = item.dependsOn.map((dependencyId) => {
      if (dependencyId === item.softwareId) {
        throw new TypeError(
          `Software ${item.softwareId} cannot depend on itself.`,
        );
      }
      const dependency = itemsById.get(dependencyId);
      if (!dependency) {
        throw new TypeError(
          `Software ${item.softwareId} has unknown dependency ${dependencyId}.`,
        );
      }
      return computeLevel(dependency);
    });
    visiting.delete(item.softwareId);
    const level =
      dependencyLevels.length === 0 ? 0 : Math.max(...dependencyLevels) + 1;
    computedLevels.set(item.softwareId, level);
    return level;
  };
  for (const item of allItems) {
    if (computeLevel(item) !== item.dependencyLevel) {
      throw new TypeError(
        `Software ${item.softwareId}.dependencyLevel is inconsistent.`,
      );
    }
  }
}

function validateBatch(batch, maxItemsPerBatch = 3) {
  assertAllowedKeys(
    batch,
    [
      "batchId",
      "sequence",
      "requiresRouteSwitch",
      "dependencyLevel",
      "networkLocation",
      "executionMode",
      "route",
      "installer",
      "requiresAdmin",
      "requiresGui",
      "requiresRestart",
      "items",
    ],
    `batch ${batch.batchId}`,
  );
  if (
    !supportedInstallers.has(batch.installer) &&
    !manualInstallers.has(batch.installer)
  ) {
    throw new TypeError(
      `No controlled adapter or manual handoff exists for installer: ${batch.installer}`,
    );
  }
  if (!supportedRoutes.has(batch.route)) {
    throw new TypeError(`Unsupported route in batch ${batch.batchId}.`);
  }
  if (!["controller", "target", "none"].includes(batch.networkLocation)) {
    throw new TypeError(
      `Unsupported network location in batch ${batch.batchId}.`,
    );
  }
  if (!["automated", "manual-receipt"].includes(batch.executionMode)) {
    throw new TypeError(`Unsupported execution mode in batch ${batch.batchId}.`);
  }
  if (
    !Number.isSafeInteger(batch.sequence) ||
    batch.sequence < 1 ||
    !Number.isSafeInteger(batch.dependencyLevel) ||
    batch.dependencyLevel < 0 ||
    typeof batch.requiresRouteSwitch !== "boolean"
  ) {
    throw new TypeError(`Batch ${batch.batchId} has invalid schedule metadata.`);
  }
  if (
    manualInstallers.has(batch.installer) &&
    batch.executionMode !== "manual-receipt"
  ) {
    throw new TypeError(
      `Batch ${batch.batchId} must use manual-receipt execution mode.`,
    );
  }
  if (
    supportedInstallers.has(batch.installer) &&
    batch.networkLocation !== "target"
  ) {
    throw new Error(
      `Batch ${batch.batchId} is not target-runnable; its network location is ${batch.networkLocation}.`,
    );
  }
  for (const key of ["requiresAdmin", "requiresGui", "requiresRestart"]) {
    if (typeof batch[key] !== "boolean") {
      throw new TypeError(`Batch ${batch.batchId}.${key} must be boolean.`);
    }
  }
  if (
    batch.executionMode === "automated" &&
    [batch.requiresAdmin, batch.requiresGui, batch.requiresRestart].includes(
      true,
    )
  ) {
    throw new TypeError(
      `Batch ${batch.batchId} cannot automate an interactive barrier.`,
    );
  }
  if (
    !Array.isArray(batch.items) ||
    batch.items.length < 1 ||
    batch.items.length > maxItemsPerBatch
  ) {
    throw new TypeError(
      `Batch ${batch.batchId} exceeds the approved batch size.`,
    );
  }
  if (batch.items.length > 1 && batch.installer === "homebrew-metadata") {
    throw new TypeError("Homebrew metadata must be isolated in its own batch.");
  }
  const softwareIds = new Set();
  for (const [index, item] of batch.items.entries()) {
    const path = `batch ${batch.batchId}.items[${index}]`;
    if (!isPlainObject(item)) {
      throw new TypeError(`${path} must be an object.`);
    }
    assertAllowedKeys(
      item,
      [
        "softwareId",
        "name",
        "installer",
        "package",
        "version",
        "route",
        "networkLocation",
        "executionMode",
        "routeEvidence",
        "dependsOn",
        "dependencyLevel",
        "requiresAdmin",
        "requiresGui",
        "requiresRestart",
      ],
      path,
    );
    assertId(item.softwareId, `${path}.softwareId`);
    if (
      typeof item.name !== "string" ||
      item.name.trim().length === 0 ||
      item.name.length > 160 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(item.name)
    ) {
      throw new TypeError(`${path}.name is invalid.`);
    }
    if (softwareIds.has(item.softwareId)) {
      throw new TypeError(`${path}.softwareId is duplicated.`);
    }
    softwareIds.add(item.softwareId);
    if (
      item.installer !== batch.installer ||
      item.route !== batch.route ||
      item.networkLocation !== batch.networkLocation ||
      item.executionMode !== batch.executionMode
    ) {
      throw new TypeError(`${path} is not homogeneous with its batch.`);
    }
    for (const key of ["requiresAdmin", "requiresGui", "requiresRestart"]) {
      if (item[key] !== batch[key]) {
        throw new TypeError(`${path}.${key} is not homogeneous with its batch.`);
      }
    }
    if (item.dependencyLevel !== batch.dependencyLevel) {
      throw new TypeError(
        `${path}.dependencyLevel is not homogeneous with its batch.`,
      );
    }
    validatePackage(item.package, item.installer, `${path}.package`);
    validateVersion(item, path);
    if (
      !Array.isArray(item.dependsOn) ||
      new Set(item.dependsOn).size !== item.dependsOn.length ||
      item.dependsOn.some((dependencyId) => !idPattern.test(dependencyId))
    ) {
      throw new TypeError(`${path}.dependsOn is invalid.`);
    }
    validateRouteEvidence(
      item.routeEvidence,
      item.route,
      item.networkLocation,
      `${path}.routeEvidence`,
    );
  }
}

function validateVersion(item, path) {
  if (
    typeof item.version !== "string" ||
    item.version.length > 80 ||
    !/^[A-Za-z0-9][A-Za-z0-9.+_~^-]*$/.test(item.version)
  ) {
    throw new TypeError(`${path}.version is not a controlled version policy.`);
  }
  if (
    item.version !== "latest-stable" &&
    ["homebrew-metadata", "brew-cask"].includes(item.installer)
  ) {
    throw new Error(
      `${path} has an unsupported Homebrew version pin; plan is invalid.`,
    );
  }
  if (
    item.version !== "latest-stable" &&
    item.installer === "brew-formula" &&
    !item.package.endsWith(`@${item.version}`)
  ) {
    throw new Error(
      `${path} must resolve a Homebrew pin to an explicit versioned formula.`,
    );
  }
}

function validatePackage(packageName, installer, path) {
  if (
    !packagePattern.test(packageName ?? "") ||
    packageName.startsWith("-") ||
    packageName.endsWith("/") ||
    packageName.includes("..") ||
    packageName.includes("//")
  ) {
    throw new TypeError(`${path} is not a controlled package identifier.`);
  }
  if (
    installer === "homebrew-metadata" &&
    packageName !== "homebrew-metadata"
  ) {
    throw new TypeError(`${path} must be homebrew-metadata.`);
  }
  if (
    installer === "volta-tool" &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packageName)
  ) {
    throw new TypeError(
      `${path} must be a simple executable name for Volta verification.`,
    );
  }
}

function validateRouteEvidence(evidence, route, networkLocation, path) {
  if (!isPlainObject(evidence)) {
    throw new TypeError(`${path} must be an object.`);
  }
  assertAllowedKeys(evidence, ["method", "origins", "observedAt"], path);
  if (
    ![
      "target-probe",
      "controller-probe",
      "controller-cache",
      "no-network",
    ].includes(
      evidence.method,
    )
  ) {
    throw new TypeError(`${path}.method is invalid.`);
  }
  if (
    !Array.isArray(evidence.origins) ||
    new Set(evidence.origins).size !== evidence.origins.length ||
    evidence.origins.some(
      (origin) => typeof origin !== "string" || !originPattern.test(origin),
    )
  ) {
    throw new TypeError(`${path}.origins must contain host names only.`);
  }
  if (evidence.method === "no-network") {
    if (
      route !== "local" ||
      networkLocation !== "none" ||
      evidence.origins.length !== 0 ||
      evidence.observedAt !== undefined
    ) {
      throw new TypeError(`${path} is inconsistent with the local route.`);
    }
    return;
  }
  if (
    (evidence.method === "controller-cache" &&
      (route !== "local" || networkLocation !== "none")) ||
    (evidence.method === "target-probe" &&
      (!["direct", "clash"].includes(route) ||
        networkLocation !== "target")) ||
    (evidence.method === "controller-probe" &&
      (!["direct", "clash"].includes(route) ||
        networkLocation !== "controller")) ||
    evidence.origins.length === 0
  ) {
    throw new TypeError(`${path} is inconsistent with route ${route}.`);
  }
  if (
    typeof evidence.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
      evidence.observedAt,
    ) ||
    !Number.isFinite(Date.parse(evidence.observedAt))
  ) {
    throw new TypeError(`${path}.observedAt is required for network evidence.`);
  }
}

function configContainsExactAlias(configText, alias) {
  const lines = String(configText).split(/\r?\n/);
  const startMarker = `# >>> Dawn Forge: ${alias} >>>`;
  const endMarker = `# <<< Dawn Forge: ${alias} <<<`;
  const startIndex = lines.findIndex((line) => line.trim() === startMarker);
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.trim() === endMarker,
  );
  if (startIndex === -1 || endIndex === -1) return false;
  const block = lines.slice(startIndex + 1, endIndex).map((line) => line.trim());
  if (!block.includes(`Host ${alias}`)) return false;
  const requiredDirectives = ["hostname", "user", "identityfile"];
  if (
    requiredDirectives.some(
      (directive) =>
        !block.some((line) =>
          line.toLowerCase().startsWith(`${directive} `),
        ),
    )
  ) {
    return false;
  }
  return block.some(
    (line) => line.toLowerCase() === "identitiesonly yes",
  );
}

function assertSshConfigCannotExecuteLocalCommands(configText, alias) {
  const lines = String(configText).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.length > 0 &&
      !trimmed.startsWith("#") &&
      /^(?:include|match)(?:\s|$)/i.test(trimmed)
    ) {
      throw new Error(
        "Finalized SSH config contains Include or Match and is not safe for unattended execution.",
      );
    }
  }
  const startMarker = `# >>> Dawn Forge: ${alias} >>>`;
  const endMarker = `# <<< Dawn Forge: ${alias} <<<`;
  const startIndex = lines.findIndex((line) => line.trim() === startMarker);
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.trim() === endMarker,
  );
  const safeNoneDirectives = new Set([
    "proxycommand",
    "proxyjump",
    "knownhostscommand",
    "identityagent",
  ]);
  for (const line of lines.slice(startIndex + 1, endIndex)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)\s+(.+)$/.exec(trimmed);
    if (match === null) continue;
    const directive = match[1].toLowerCase();
    const value = match[2].trim().toLowerCase();
    if (
      directive === "localcommand" ||
      (safeNoneDirectives.has(directive) && value !== "none") ||
      (directive === "permitlocalcommand" && value !== "no")
    ) {
      throw new Error(
        `Finalized SSH alias ${alias} contains unsafe ${match[1]}.`,
      );
    }
  }
}

function prepareRuntimeDependencies(dependencies) {
  if (!isPlainObject(dependencies)) {
    throw new TypeError("dependencies must be an object.");
  }
  assertAllowedKeys(
    dependencies,
    [
      "spawnProcess",
      "stdout",
      "stderr",
      "signalSource",
      "targetLockRoot",
    ],
    "dependencies",
  );
  const runtime = {
    spawnProcess: dependencies.spawnProcess ?? spawn,
    stdout: dependencies.stdout ?? process.stdout,
    stderr: dependencies.stderr ?? process.stderr,
    signalSource: dependencies.signalSource ?? process,
    targetLockRoot: resolve(
      dependencies.targetLockRoot ??
        join(homedir(), ".dawn-forge", "locks", "targets"),
    ),
  };
  validateDependencies(runtime);
  return runtime;
}

function validateDependencies({
  spawnProcess,
  stdout,
  stderr,
  signalSource,
  targetLockRoot,
}) {
  if (typeof spawnProcess !== "function") {
    throw new TypeError("spawnProcess must be a function.");
  }
  for (const [name, stream] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ]) {
    if (typeof stream?.write !== "function") {
      throw new TypeError(`${name} must provide write().`);
    }
  }
  if (
    typeof signalSource?.on !== "function" ||
    typeof signalSource?.removeListener !== "function"
  ) {
    throw new TypeError("signalSource must provide on() and removeListener().");
  }
  if (typeof targetLockRoot !== "string" || targetLockRoot.length === 0) {
    throw new TypeError("targetLockRoot must be a non-empty path.");
  }
}

function redactOutput(value) {
  return String(value)
    .replace(
      /\bauthorization\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s]+/gi,
      "authorization=[REDACTED]",
    )
    .replace(
      /\b(password|passwd|secret|api[-_]?key|private[-_]?key|credential|cookie|token)\s*[:=]\s*[^\s]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /([?&](?:access_?token|api_?key|key|secret|signature|subscription|token)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bhttps?:\/\/[^\s]+/gi, "[REDACTED-URL]");
}

function writeSafe(destination, value) {
  try {
    destination.write(value);
  } catch {
    // A closed display stream must not detach or duplicate the owned child.
  }
}

function normalizeReasonCode(error) {
  const code =
    typeof error?.code === "string" ? error.code.toLowerCase() : "spawn-error";
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(code) ? code : "spawn-error";
}

function assertAllowedKeys(value, allowed, path) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(`${path}.${key} is not allowed.`);
    }
  }
}

function assertId(value, path) {
  if (!idPattern.test(value ?? "")) {
    throw new TypeError(`${path} is invalid.`);
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

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  console.error(
    JSON.stringify({
      kind: "internal-only",
      code: "USE_INSTALLATION_RUN",
      message:
        "run-installation-batch.mjs is an internal module; use installation-run.mjs advance.",
    }),
  );
  process.exitCode = 2;
}
