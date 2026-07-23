import assert from "node:assert/strict";
import {
  createInstallationSchedule,
  validateResolvedActions,
} from "../skills/dawn-forge/scripts/installation-batches.mjs";

const observedAt = "2026-07-23T12:00:00.000Z";
const initialRoutes = { controller: "direct", target: "direct" };
const preflightSha256 = "a".repeat(64);
const machineExecutionIdentitySha256 = "b".repeat(64);
const evidence = (route, origin) => ({
  method: "target-probe",
  origins: [origin],
  observedAt,
});

const actions = [
  {
    softwareId: "homebrew-metadata",
    name: "Homebrew metadata",
    installer: "homebrew-metadata",
    package: "homebrew-metadata",
    version: "latest-stable",
    route: "clash",
    networkLocation: "target",
    executionMode: "automated",
    routeEvidence: evidence("clash", "formulae.brew.sh"),
    dependsOn: [],
  },
  ...["snipaste", "wetype", "wechat", "feishu", "tencent-meeting"].map(
    (softwareId) => ({
      softwareId,
      name: softwareId,
      installer: "brew-cask",
      package: softwareId,
      version: "latest-stable",
      route: "direct",
      networkLocation: "target",
      executionMode: "automated",
      routeEvidence: evidence("direct", "example.cn"),
      dependsOn: ["homebrew-metadata"],
    }),
  ),
  ...[
    "iterm2",
    "google-chrome",
    "visual-studio-code",
    "chatgpt",
    "orbstack",
    "stats",
    "maccy",
    "cc-switch",
  ].map((softwareId) => ({
    softwareId,
    name: softwareId,
    installer: "brew-cask",
    package: softwareId,
    version: "latest-stable",
    route: "clash",
    networkLocation: "target",
    executionMode: "automated",
    routeEvidence: evidence("clash", "github.com"),
    dependsOn: ["homebrew-metadata"],
  })),
];

assert.deepEqual(validateResolvedActions(actions), []);

const schedule = createInstallationSchedule(actions, {
  initialRoutes,
  preflightSha256,
  machineExecutionIdentitySha256,
});
assert.equal(schedule.schemaVersion, 2);
assert.equal(schedule.maxItemsPerBatch, 3);
assert.match(schedule.scheduleSha256, /^[a-f0-9]{64}$/);
assert.deepEqual(
  schedule.batches.map((batch) => ({
    installer: batch.installer,
    route: batch.route,
    count: batch.items.length,
  })),
  [
    { installer: "homebrew-metadata", route: "clash", count: 1 },
    { installer: "brew-cask", route: "direct", count: 3 },
    { installer: "brew-cask", route: "direct", count: 2 },
    { installer: "brew-cask", route: "clash", count: 3 },
    { installer: "brew-cask", route: "clash", count: 3 },
    { installer: "brew-cask", route: "clash", count: 2 },
  ],
);

for (const batch of schedule.batches) {
  assert.ok(batch.items.length >= 1 && batch.items.length <= 3);
  assert.ok(batch.items.every((item) => item.route === batch.route));
  assert.ok(batch.items.every((item) => item.installer === batch.installer));
}

assert.equal(schedule.batches[0].requiresRouteSwitch, true);
assert.equal(schedule.batches[1].requiresRouteSwitch, true);
assert.equal(schedule.batches[2].requiresRouteSwitch, false);
assert.equal(schedule.batches[3].requiresRouteSwitch, true);

const clashFirstSchedule = createInstallationSchedule(actions, {
  routeOrder: ["clash", "direct", "local"],
  initialRoutes: { controller: "direct", target: "clash" },
  preflightSha256,
  machineExecutionIdentitySha256,
});
assert.deepEqual(
  clashFirstSchedule.batches.map((batch) => batch.route),
  ["clash", "clash", "clash", "clash", "direct", "direct"],
);
assert.equal(
  clashFirstSchedule.batches.filter((batch) => batch.requiresRouteSwitch).length,
  1,
);

assert.throws(
  () =>
    createInstallationSchedule(actions, {
      maxItemsPerBatch: 4,
      initialRoutes,
      preflightSha256,
      machineExecutionIdentitySha256,
    }),
  /between 1 and 3/,
);

const invalidActions = structuredClone(actions);
invalidActions[1].route = "unknown";
assert.match(validateResolvedActions(invalidActions).join("\n"), /unsupported route/);

const missingRouteEvidence = structuredClone(actions);
delete missingRouteEvidence[1].routeEvidence;
assert.match(
  validateResolvedActions(missingRouteEvidence).join("\n"),
  /routeEvidence: must be an object/,
);

const missingVersion = structuredClone(actions);
delete missingVersion[1].version;
assert.match(
  validateResolvedActions(missingVersion).join("\n"),
  /version: required safe resolved version policy/,
);

const secretBearingOrigin = structuredClone(actions);
secretBearingOrigin[1].routeEvidence.origins = [
  "https://user:password@example.cn/download",
];
assert.match(
  validateResolvedActions(secretBearingOrigin).join("\n"),
  /without scheme, path, or credentials/,
);

const routeWithoutMatchingEvidence = structuredClone(actions);
routeWithoutMatchingEvidence[1].route = "local";
assert.match(
  validateResolvedActions(routeWithoutMatchingEvidence).join("\n"),
  /probe evidence requires direct or clash route/,
);

const cachedLocalAction = {
  softwareId: "cached-installer",
  name: "Cached installer",
  installer: "official-download",
  package: "cached-installer",
  version: "1.2.3",
  route: "local",
  networkLocation: "none",
  executionMode: "manual-receipt",
  routeEvidence: {
    method: "controller-cache",
    origins: ["downloads.example.com"],
  observedAt,
  },
  dependsOn: [],
  requiresGui: true,
};
assert.match(
  validateResolvedActions([cachedLocalAction]).join("\n"),
  /canonical network-bootstrap artifact pipeline|unsupported route evidence method/,
);

const controllerDownload = {
  softwareId: "controller-download",
  name: "Controller download",
  installer: "official-download",
  package: "controller-download",
  version: "1.2.3",
  route: "clash",
  networkLocation: "controller",
  executionMode: "manual-receipt",
  routeEvidence: {
    method: "controller-probe",
    origins: ["downloads.example.com"],
    observedAt,
  },
  dependsOn: [],
  requiresGui: true,
};
assert.match(
  validateResolvedActions([controllerDownload]).join("\n"),
  /canonical network-bootstrap artifact pipeline/,
);

const wrongProbeLocation = structuredClone(controllerDownload);
wrongProbeLocation.routeEvidence.method = "target-probe";
assert.match(
  validateResolvedActions([wrongProbeLocation]).join("\n"),
  /target-probe requires networkLocation target/,
);

assert.throws(
  () => createInstallationSchedule(actions),
  /initialRoutes must explicitly contain controller and target routes/,
);

assert.throws(
  () => createInstallationSchedule(actions, { initialRoutes }),
  /preflightSha256 must be a lowercase SHA-256 digest/,
);

assert.throws(
  () =>
    createInstallationSchedule(actions, {
      initialRoutes,
      preflightSha256,
    }),
  /machineExecutionIdentitySha256 must be a lowercase SHA-256 digest/,
);

const unsafeAutomatedGui = structuredClone(actions);
unsafeAutomatedGui[1].requiresGui = true;
assert.match(
  validateResolvedActions(unsafeAutomatedGui).join("\n"),
  /automated actions cannot require admin, GUI, or restart/,
);

const missingDependency = structuredClone(actions);
missingDependency[1].dependsOn = ["missing-action"];
assert.match(
  validateResolvedActions(missingDependency).join("\n"),
  /unknown dependency missing-action/,
);

const dependencyCycle = structuredClone(actions);
dependencyCycle[0].dependsOn = [dependencyCycle[1].softwareId];
assert.match(
  validateResolvedActions(dependencyCycle).join("\n"),
  /dependency cycle/,
);

console.log("Installation batch planner tests passed.");
