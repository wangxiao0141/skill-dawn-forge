import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  planNetworkBootstrap,
  planInstallation,
  publishNetworkBootstrapBundle,
  publishPlanBundle,
} from "../skills/dawn-forge/scripts/plan-installation.mjs";
import {
  machineExecutionIdentityDigest,
  targetIdentityDigest,
} from "../skills/dawn-forge/scripts/target-identity.mjs";

const observedAt = "2026-07-23T18:00:00.000Z";
const profilePath = resolve("profiles/mac-mini-personal-dev.json");
const profileRaw = readFileSync(profilePath, "utf8");
const profile = JSON.parse(profileRaw);
const profileSha256 = createHash("sha256").update(profileRaw, "utf8").digest("hex");
const fixtureDirectory = mkdtempSync(join(tmpdir(), "dawn-forge-plan-"));
const sshConfigPath = join(fixtureDirectory, "config");
const knownHostsPath = join(fixtureDirectory, "known_hosts");
const identityFile = join(fixtureDirectory, "id_ed25519");
writeFileSync(sshConfigPath, "Host mini\n  HostName mac-mini.local\n", "utf8");
writeFileSync(
  knownHostsPath,
  "mac-mini.local ssh-ed25519 AAAAC3NzaFakePublicKey\n",
  "utf8",
);
writeFileSync(identityFile, "fake-private-key-not-used-by-tests\n", "utf8");

test("plans the real macOS profile through one bounded SSH preflight", async () => {
  const calls = [];
  const snapshot = completeMacSnapshot();
  const result = await planInstallation(
    {
      profile,
      profileRaw,
      targetAlias: "mini",
      sshConfigPath,
      targetIdentityReceipt: identityReceipt(),
      initialRoutes: { controller: "direct", target: "clash" },
    },
    {
      now: () => new Date(observedAt),
      spawnProcess(executable, args, options) {
        calls.push({ executable, args, options });
        return {
          status: 0,
          stdout: JSON.stringify(snapshot),
          stderr: "",
        };
      },
      probeControllerSoftware: async () => ({
        status: "current",
        installedVersion: "2.4.3",
        resolvedVersion: "2.4.3",
        origins: ["github.com", "objects.githubusercontent.com"],
        reachable: true,
        observedAt,
        requiresAdmin: true,
        requiresGui: true,
        requiresRestart: false,
        artifactCached: false,
      }),
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "ssh");
  assert.deepEqual(calls[0].args.slice(0, 2), [
    "-F",
    resolve(sshConfigPath),
  ]);
  for (const option of [
    "BatchMode=yes",
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    "StrictHostKeyChecking=yes",
    "ConnectTimeout=8",
    "ConnectionAttempts=1",
    "ClearAllForwardings=yes",
    "ForwardAgent=no",
    "ForwardX11=no",
    "PermitLocalCommand=no",
    "ControlMaster=no",
    "CanonicalizeHostname=no",
  ]) {
    assert.ok(calls[0].args.includes(option), `missing SSH option ${option}`);
  }
  assert.equal(calls[0].args.at(-2), "mini");
  assert.match(calls[0].args.at(-1), /osascript/);
  assertOption(calls[0].args, "-i", resolve(identityFile));
  assertOption(
    calls[0].args,
    "-o",
    `UserKnownHostsFile=${resolve(knownHostsPath)}`,
  );
  assert.equal(calls[0].options.timeout, 120_000);
  assert.equal(calls[0].options.killSignal, "SIGTERM");
  assert.doesNotMatch(
    calls[0].options.input,
    /managed metadata adapter unavailable|nohup|\bsleep\b/i,
  );
  assert.match(calls[0].options.input, /HOMEBREW_NO_AUTO_UPDATE/);
  assert.doesNotMatch(calls[0].options.input, /keys\.indexOf\("app"\)/);
  assert.doesNotThrow(() => new Function(calls[0].options.input));

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.profile.sha256, profileSha256);
  assert.equal(
    result.target.targetIdentitySha256,
    identityReceipt().targetIdentitySha256,
  );
  assert.equal(result.schedule.schemaVersion, 2);
  assert.equal(
    result.schedule.machineExecutionIdentitySha256,
    identityReceipt().machineExecutionIdentitySha256,
  );
  assert.match(result.preflightSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.schedule.preflightSha256, result.preflightSha256);
  assert.ok(result.schedule.batches.every((batch) => batch.items.length <= 3));

  assert.equal(
    result.decisions.find(
      (item) => item.softwareId === "clash-verge-rev",
    ).disposition,
    "skip",
  );
  const caskActions = result.resolvedActions.filter(
    (action) => action.installer === "brew-cask",
  );
  assert.ok(caskActions.length > 0);
  assert.ok(
    caskActions.every(
      (action) =>
        action.executionMode === "automated" &&
        action.requiresGui === false,
    ),
  );

  const metadata = result.resolvedActions.find(
    (action) => action.softwareId === "homebrew-metadata",
  );
  assert.ok(metadata);
  assert.deepEqual(metadata.dependsOn, []);

  const git = result.resolvedActions.find((action) => action.softwareId === "git");
  assert.deepEqual(git.dependsOn, ["homebrew-metadata"]);
  assert.equal(git.routeEvidence.method, "target-probe");
  assert.equal(git.networkLocation, "target");

  const codex = result.resolvedActions.find(
    (action) => action.softwareId === "codex",
  );
  assert.deepEqual(codex.dependsOn, []);

  const pnpm = result.resolvedActions.find(
    (action) => action.softwareId === "pnpm",
  );
  assert.deepEqual(pnpm.dependsOn, ["volta"]);
});

test("unknown required metadata fails closed without a runnable action", async () => {
  const snapshot = completeMacSnapshot();
  snapshot.items = snapshot.items.filter(
    (item) => item.softwareId !== "google-chrome",
  );
  const result = await runWithSnapshot(snapshot);

  assert.equal(result.status, "conflict");
  assert.equal(
    result.decisions.find((item) => item.softwareId === "google-chrome")
      .disposition,
    "conflict",
  );
  assert.equal(
    result.resolvedActions.some(
      (item) => item.softwareId === "google-chrome",
    ),
    false,
  );
  assert.equal(result.schedule, null);
});

test("stages an alternate target route probe without repeating inventory metadata", async () => {
  const firstSnapshot = completeMacSnapshot();
  firstSnapshot.probes = firstSnapshot.probes.map((probe) => ({
    ...probe,
    route: "direct",
    reachable: false,
  }));
  const first = await runWithSnapshot(firstSnapshot, {
    input: {
      initialRoutes: { controller: "direct", target: "direct" },
    },
  });

  assert.equal(first.status, "route-probe-required");
  assert.equal(first.schedule, null);
  assert.deepEqual(
    first.pendingRouteProbes.find(
      (probe) => probe.networkLocation === "target",
    ).route,
    "clash",
  );

  const requestedDrivers = [];
  const alternateProbes = [
    ...new Set(first.preflightReceipt.targetMetadata.flatMap((item) => item.origins)),
  ].map((origin) => ({
    networkLocation: "target",
    origin,
    route: "clash",
    reachable: true,
    observedAt,
  }));
  const second = await runWithSnapshot(null, {
    input: {
      initialRoutes: { controller: "direct", target: "clash" },
      priorPreflightReceipt: first.preflightReceipt,
      priorPreflightSha256: first.preflightSha256,
    },
    dependencies: {
      spawnProcess(_executable, _args, options) {
        requestedDrivers.push(options.input);
        return {
          status: 0,
          stdout: JSON.stringify({
            protocol: "dawn-forge-preflight-v1",
            profileSha256,
            identity: identityReceipt().identity,
            probes: alternateProbes,
          }),
          stderr: "",
        };
      },
    },
  });

  assert.equal(requestedDrivers.length, 1);
  assert.match(requestedDrivers[0], /probe-only/);
  assert.equal(second.status, "planned");
  assert.ok(second.schedule);
  assert.equal(
    second.resolvedActions.find((item) => item.softwareId === "git").route,
    "clash",
  );
});

test("synthesizes a controlled Node runtime when npm is absent", async () => {
  const snapshot = completeMacSnapshot();
  snapshot.inventory.tools.npm = { present: false, version: null };
  snapshot.inventory.tools.volta = { present: false, version: null };
  snapshot.items.push({
    softwareId: "node-runtime",
    source: "volta-tool",
    package: "node",
    status: "missing",
    installedVersion: null,
    resolvedVersion: "24.4.1",
    origins: ["registry.npmjs.org"],
    requiresAdmin: false,
    requiresGui: false,
    requiresRestart: false,
  });

  const result = await runWithSnapshot(snapshot);
  const runtime = result.resolvedActions.find(
    (action) => action.softwareId === "node-runtime",
  );
  assert.deepEqual(runtime.dependsOn, ["volta"]);
  for (const softwareId of ["codex", "claude-code", "openspec"]) {
    assert.deepEqual(
      result.resolvedActions.find(
        (action) => action.softwareId === softwareId,
      ).dependsOn,
      ["node-runtime"],
    );
  }
});

test("stages controller metadata without repeating target SSH", async () => {
  const snapshot = completeMacSnapshot();
  snapshot.inventory.installedSoftware["clash-verge-rev"].version =
    "2.3.0";
  const unreachable = await runWithSnapshot(snapshot, {
    dependencies: {
      probeControllerSoftware: async () => ({
        status: "probe-unreachable",
        installedVersion: "2.3.0",
        resolvedVersion: null,
        origins: ["api.github.com", "github.com"],
        route: "direct",
        reachable: false,
        observedAt,
        requiresAdmin: true,
        requiresGui: true,
        requiresRestart: false,
        artifactCached: false,
      }),
    },
  });
  assert.equal(unreachable.status, "route-probe-required");
  assert.equal(
    unreachable.pendingRouteProbes.find(
      (probe) => probe.networkLocation === "controller",
    ).route,
    "clash",
  );

  let sshCalls = 0;
  const resumed = await runWithSnapshot(null, {
    input: {
      initialRoutes: { controller: "clash", target: "clash" },
      priorPreflightReceipt: unreachable.preflightReceipt,
      priorPreflightSha256: unreachable.preflightSha256,
    },
    dependencies: {
      spawnProcess() {
        sshCalls += 1;
        throw new Error("target SSH must not repeat");
      },
      probeControllerSoftware: async () => ({
        status: "outdated",
        installedVersion: "2.3.0",
        resolvedVersion: "2.4.3",
        origins: ["api.github.com", "github.com"],
        route: "clash",
        reachable: true,
        observedAt,
        requiresAdmin: true,
        requiresGui: true,
        requiresRestart: false,
        artifactCached: false,
      }),
    },
  });
  assert.equal(sshCalls, 0);
  assert.equal(resumed.status, "conflict");
  assert.equal(
    resumed.resolvedActions.some(
      (action) => action.softwareId === "clash-verge-rev",
    ),
    false,
  );
});

test("full plan refuses an unbound controller artifact without probing or scheduling it", async () => {
  const snapshot = completeMacSnapshot();
  snapshot.inventory.installedSoftware["clash-verge-rev"] = {
    present: false,
    version: null,
  };
  let controllerProbeCalls = 0;
  const result = await runWithSnapshot(snapshot, {
    dependencies: {
      probeControllerSoftware: async () => {
        controllerProbeCalls += 1;
        return {
          status: "missing",
          installedVersion: null,
          resolvedVersion: "2.4.3",
          origins: ["api.github.com", "github.com"],
          route: "local",
          reachable: true,
          observedAt,
          requiresAdmin: true,
          requiresGui: true,
          requiresRestart: false,
          artifactCached: true,
        };
      },
    },
  });

  assert.equal(controllerProbeCalls, 0);
  assert.equal(result.status, "conflict");
  assert.equal(result.schedule, null);
  assert.equal(
    result.decisions.find(
      (item) => item.softwareId === "clash-verge-rev",
    ).reason,
    "canonical-artifact-request-unavailable-in-full-plan",
  );
  assert.equal(
    result.resolvedActions.some(
      (action) =>
        action.softwareId === "clash-verge-rev" ||
        action.routeEvidence.method === "controller-cache",
    ),
    false,
  );
});

test("publishes a canonical bundle without manual JSON extraction", async () => {
  const plan = await runWithSnapshot(completeMacSnapshot());
  const parent = mkdtempSync(join(tmpdir(), "dawn-forge-bundle-"));
  const outputDirectory = join(parent, "plan-001");
  const published = publishPlanBundle({
    outputDirectory,
    plan,
    profileRaw,
    receiptRaw: JSON.stringify(identityReceipt()),
  });

  assert.equal(published, resolve(outputDirectory));
  for (const filename of [
    "profile.json",
    "identity.json",
    "preflight.json",
    "schedule.json",
    "plan.json",
  ]) {
    assert.equal(existsSync(join(published, filename)), true);
  }
  const bundlePlan = JSON.parse(
    readFileSync(join(published, "plan.json"), "utf8"),
  );
  assert.equal(
    bundlePlan.bundle.files.preflightReceipt,
    "preflight.json",
  );
  assert.equal(
    bundlePlan.bundle.machineExecutionIdentitySha256,
    identityReceipt().machineExecutionIdentitySha256,
  );
  assert.equal(
    createHash("sha256")
      .update(
        JSON.stringify(
          JSON.parse(readFileSync(join(published, "preflight.json"), "utf8")),
        ),
      )
      .digest("hex"),
    bundlePlan.preflightSha256,
  );
  assert.doesNotMatch(
    readFileSync(join(published, "plan.json"), "utf8"),
    /https?:\/\//,
  );
});

test("creates a minimal confirmed-network bootstrap plan without full inventory", async () => {
  const calls = [];
  const result = await planNetworkBootstrap(
    {
      profile,
      profileRaw,
      targetAlias: "mini",
      sshConfigPath,
      targetIdentityReceipt: identityReceipt(),
      initialRoutes: { controller: "direct", target: "direct" },
    },
    {
      now: () => new Date(observedAt),
      spawnProcess(_executable, args, options) {
        calls.push({ args, options });
        return {
          status: 0,
          stdout: JSON.stringify({
            protocol: "dawn-forge-network-bootstrap-v1",
            profileSha256,
            identity: identityReceipt().identity,
            installedSoftware: {
              "clash-verge-rev": { present: false, version: null },
            },
            probes: [{
              networkLocation: "target",
              origin: "api.github.com",
              route: "direct",
              reachable: false,
              observedAt,
            }],
          }),
          stderr: "",
        };
      },
      probeControllerSoftware: async () => ({
        status: "missing",
        installedVersion: null,
        resolvedVersion: "2.4.3",
        origins: ["api.github.com", "github.com"],
        route: "direct",
        reachable: true,
        observedAt,
        requiresAdmin: true,
        requiresGui: true,
        requiresRestart: false,
        artifactCached: false,
        artifactRequest: {
          artifactId: "clash-verge-rev",
          version: "2.4.3",
          architecture: "arm64",
          url: "https://github.com/clash-verge-rev/clash-verge-rev/releases/download/v2.4.3/Clash.Verge_2.4.3_aarch64.dmg",
          allowedHosts: [
            "github.com",
            "release-assets.githubusercontent.com",
          ],
          sourceMode: "signed-download",
        },
      }),
    },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].options.input, /network-bootstrap/);
  assert.equal(result.status, "confirmation-required");
  assert.match(result.miniPlanSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    result.machineExecutionIdentitySha256,
    identityReceipt().machineExecutionIdentitySha256,
  );
  assert.equal(result.action.softwareId, "clash-verge-rev");
  assert.equal(result.action.executionMode, "manual-receipt");
  assert.equal(result.artifactRequest.architecture, "arm64");

  const parent = mkdtempSync(
    join(tmpdir(), "dawn-forge-network-bundle-"),
  );
  const published = publishNetworkBootstrapBundle({
    outputDirectory: join(parent, "network-001"),
    miniPlan: result,
    profileRaw,
    receiptRaw: JSON.stringify(identityReceipt()),
  });
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(published, "artifact-request.json"), "utf8"),
    ),
    result.artifactRequest,
  );
});

test("required missing Clash uses the same mini-plan when target direct access works", async () => {
  let controllerProbeCalls = 0;
  const result = await planNetworkBootstrap(
    {
      profile,
      profileRaw,
      targetAlias: "mini",
      sshConfigPath,
      targetIdentityReceipt: identityReceipt(),
      initialRoutes: { controller: "direct", target: "direct" },
    },
    {
      now: () => new Date(observedAt),
      spawnProcess() {
        return {
          status: 0,
          stdout: JSON.stringify({
            protocol: "dawn-forge-network-bootstrap-v1",
            profileSha256,
            identity: identityReceipt().identity,
            installedSoftware: {
              "clash-verge-rev": { present: false, version: null },
            },
            probes: [{
              networkLocation: "target",
              origin: "api.github.com",
              route: "direct",
              reachable: true,
              observedAt,
            }],
          }),
          stderr: "",
        };
      },
      probeControllerSoftware: async () => {
        controllerProbeCalls += 1;
        return {
          status: "missing",
          installedVersion: null,
          resolvedVersion: "2.4.3",
          origins: ["api.github.com", "github.com"],
          route: "direct",
          reachable: true,
          observedAt,
          requiresAdmin: true,
          requiresGui: true,
          requiresRestart: false,
          artifactCached: false,
          artifactRequest: {
            artifactId: "clash-verge-rev",
            version: "2.4.3",
            architecture: "arm64",
            url: "https://github.com/clash-verge-rev/clash-verge-rev/releases/download/v2.4.3/Clash.Verge_2.4.3_aarch64.dmg",
            allowedHosts: [
              "github.com",
              "release-assets.githubusercontent.com",
            ],
            sourceMode: "signed-download",
          },
        };
      },
    },
  );

  assert.equal(controllerProbeCalls, 1);
  assert.equal(result.targetDirectProbe.reachable, true);
  assert.equal(result.status, "confirmation-required");
  assert.equal(result.artifactRequest.artifactId, "clash-verge-rev");
});

test("optional Clash produces no artifact request or target probe", async () => {
  const optionalProfile = structuredClone(profile);
  optionalProfile.software.find(
    (item) => item.id === "clash-verge-rev",
  ).required = false;
  const optionalRaw = JSON.stringify(optionalProfile, null, 2);
  let sshCalls = 0;
  const result = await planNetworkBootstrap(
    {
      profile: optionalProfile,
      profileRaw: optionalRaw,
      targetAlias: "mini",
      sshConfigPath,
      targetIdentityReceipt: identityReceipt(),
      initialRoutes: { controller: "direct", target: "direct" },
    },
    {
      now: () => new Date(observedAt),
      spawnProcess() {
        sshCalls += 1;
        throw new Error("optional Clash must not probe the target");
      },
    },
  );

  assert.equal(sshCalls, 0);
  assert.equal(result.status, "not-required");
  assert.equal(result.artifactRequest, null);
});

test("refuses SSH trust-file drift before spawning preflight", async () => {
  const receipt = identityReceipt();
  receipt.sshConfigSha256 = "f".repeat(64);
  let spawned = false;
  await assert.rejects(
    planInstallation(
      {
        profile,
        profileRaw,
        targetAlias: "mini",
        sshConfigPath,
        targetIdentityReceipt: receipt,
        initialRoutes: { controller: "direct", target: "direct" },
      },
      {
        spawnProcess() {
          spawned = true;
          throw new Error("must not spawn");
        },
      },
    ),
    /SSH trust files changed/,
  );
  assert.equal(spawned, false);
});

test("requires the canonical machine identity and SSH key digest before preflight", async () => {
  for (const field of [
    "machineExecutionIdentitySha256",
    "identityFileSha256",
  ]) {
    const receipt = identityReceipt();
    delete receipt[field];
    let spawned = false;
    await assert.rejects(
      planInstallation(
        {
          profile,
          profileRaw,
          targetAlias: "mini",
          sshConfigPath,
          targetIdentityReceipt: receipt,
          initialRoutes: { controller: "direct", target: "direct" },
        },
        {
          spawnProcess() {
            spawned = true;
            throw new Error("must not spawn");
          },
        },
      ),
      new RegExp(field),
    );
    assert.equal(spawned, false);
  }
});

test("Windows collector is a parseable bounded PowerShell script", async () => {
  const windowsProfile = {
    schemaVersion: 1,
    id: "windows-preflight-test",
    name: "Windows preflight test",
    platform: "windows",
    software: [
      {
        id: "git",
        name: "Git",
        source: "winget",
        package: "Git.Git",
        required: true,
      },
    ],
    settings: {},
    manualTasks: [],
  };
  const windowsProfileRaw = JSON.stringify(windowsProfile, null, 2);
  const windowsProfileSha256 = createHash("sha256")
    .update(windowsProfileRaw)
    .digest("hex");
  const receipt = windowsIdentityReceipt();
  let driver;
  const result = await planInstallation(
    {
      profile: windowsProfile,
      profileRaw: windowsProfileRaw,
      targetAlias: "mini",
      sshConfigPath,
      targetIdentityReceipt: receipt,
      initialRoutes: { controller: "direct", target: "direct" },
    },
    {
      spawnProcess(_executable, _args, options) {
        driver = options.input;
        return {
          status: 0,
          stdout: JSON.stringify({
            protocol: "dawn-forge-preflight-v1",
            profileSha256: windowsProfileSha256,
            identity: receipt.identity,
            inventory: {
              diskAvailableBytes: 100_000_000_000,
              adminCapable: true,
              commandLineTools: { present: true },
              tools: {
                homebrew: { present: false, version: null },
                npm: { present: false, version: null },
                volta: { present: false, version: null },
              },
              installedSoftware: {},
            },
            items: [{
              softwareId: "git",
              source: "winget",
              package: "Git.Git",
              status: "conflict",
              installedVersion: null,
              resolvedVersion: null,
              origins: ["cdn.winget.microsoft.com"],
              requiresAdmin: null,
              requiresGui: null,
              requiresRestart: null,
            }],
            probes: [{
              networkLocation: "target",
              origin: "cdn.winget.microsoft.com",
              route: "direct",
              reachable: true,
              observedAt,
            }],
          }),
          stderr: "",
        };
      },
    },
  );
  assert.equal(result.status, "conflict");
  assert.doesNotMatch(
    driver,
    /managed metadata adapter unavailable|Start-Job|nohup|\bsleep\b/i,
  );
  const parsed = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$source=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{\"$($_.Extent.StartLineNumber):$($_.Extent.StartColumnNumber) $($_.Message)\"};exit 1}",
    ],
    {
      encoding: "utf8",
      input: driver,
      windowsHide: true,
    },
  );
  if (parsed.error?.code === "EPERM") {
    assert.match(driver, /Invoke-ControlledProcess[\s\S]+ConvertTo-Json/);
    return;
  }
  assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
});

function identityReceipt() {
  const hostKeyFingerprints = [
    "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ];
  const identity = {
    user: "wangxiao",
    os: "Darwin",
    architecture: "arm64",
    machineId: "FAKE-MACHINE-ID",
  };
  const identityInput = {
    platform: "macos",
    user: identity.user,
    os: identity.os,
    architecture: identity.architecture,
    machineId: identity.machineId,
    hostKeyFingerprints,
  };
  const targetIdentitySha256 = targetIdentityDigest(identityInput);
  return {
    finalized: true,
    platform: "macos",
    alias: "mini",
    user: "wangxiao",
    targetIdentitySha256,
    machineExecutionIdentitySha256:
      machineExecutionIdentityDigest(identityInput),
    identity,
    identityFile,
    identityFileSha256: fileSha256(identityFile),
    hostKeyFingerprints,
    sshConfigPath,
    sshConfigSha256: fileSha256(sshConfigPath),
    knownHostsPath,
    knownHostsSha256: fileSha256(knownHostsPath),
  };
}

function windowsIdentityReceipt() {
  const hostKeyFingerprints = [
    "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ];
  const identity = {
    user: "wangxiao",
    os: "Windows",
    architecture: "AMD64",
    machineId: "FAKE-WINDOWS-MACHINE-ID",
  };
  return {
    finalized: true,
    platform: "windows",
    alias: "mini",
    user: "wangxiao",
    targetIdentitySha256: targetIdentityDigest({
      platform: "windows",
      user: identity.user,
      os: identity.os,
      architecture: identity.architecture,
      machineId: identity.machineId,
      hostKeyFingerprints,
    }),
    machineExecutionIdentitySha256:
      machineExecutionIdentityDigest({
        platform: "windows",
        machineId: identity.machineId,
        hostKeyFingerprints,
      }),
    identity,
    identityFile,
    identityFileSha256: fileSha256(identityFile),
    hostKeyFingerprints,
    sshConfigPath,
    sshConfigSha256: fileSha256(sshConfigPath),
    knownHostsPath,
    knownHostsSha256: fileSha256(knownHostsPath),
  };
}

function completeMacSnapshot() {
  const targetSources = new Set([
    "brew-formula",
    "brew-cask",
    "npm-global",
    "volta-tool",
  ]);
  const items = profile.software
    .filter((software) => targetSources.has(software.source))
    .map((software) => ({
      softwareId: software.id,
      source: software.source,
      package: software.package,
      status: "missing",
      installedVersion: null,
      resolvedVersion: `${software.id}-1.0.0`,
      origins:
        software.source === "npm-global" || software.source === "volta-tool"
          ? ["registry.npmjs.org"]
          : ["formulae.brew.sh", "ghcr.io"],
      requiresAdmin: false,
      requiresGui: false,
      requiresRestart: false,
    }));
  return {
    protocol: "dawn-forge-preflight-v1",
    profileSha256,
    identity: {
      user: "wangxiao",
      os: "Darwin",
      architecture: "arm64",
      machineId: "FAKE-MACHINE-ID",
    },
    inventory: {
      diskAvailableBytes: 500_000_000_000,
      adminCapable: true,
      commandLineTools: { present: true },
      tools: {
        homebrew: { present: true, version: "4.5.0" },
        npm: { present: true, version: "11.4.2" },
        volta: { present: false, version: null },
      },
      installedSoftware: {
        "clash-verge-rev": {
          present: true,
          version: "2.4.3",
        },
      },
    },
    items,
    probes: [
      ...new Set(items.flatMap((item) => item.origins)),
    ].map((origin) => ({
      networkLocation: "target",
      origin,
      route: "clash",
      reachable: true,
      observedAt,
    })),
  };
}

async function runWithSnapshot(snapshot, overrides = {}) {
  return planInstallation(
    {
      profile,
      profileRaw,
      targetAlias: "mini",
      sshConfigPath,
      targetIdentityReceipt: identityReceipt(),
      initialRoutes: { controller: "direct", target: "clash" },
      ...overrides.input,
    },
    {
      now: () => new Date(observedAt),
      spawnProcess: () => ({
        status: 0,
        stdout: JSON.stringify(snapshot),
        stderr: "",
      }),
      probeControllerSoftware: async () => ({
        status: "current",
        installedVersion: "2.4.3",
        resolvedVersion: "2.4.3",
        origins: ["github.com", "objects.githubusercontent.com"],
        reachable: true,
        observedAt,
        requiresAdmin: true,
        requiresGui: true,
        requiresRestart: false,
        artifactCached: false,
      }),
      ...overrides.dependencies,
    },
  );
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertOption(args, name, value) {
  const index = args.findIndex(
    (entry, entryIndex) =>
      entry === name && args[entryIndex + 1] === value,
  );
  assert.notEqual(index, -1, `missing ${name} ${value}`);
}
