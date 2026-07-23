import assert from "node:assert/strict";
import test from "node:test";

import type { InspectorSnapshot } from "../inspector/index.ts";
import type { Target } from "../protocol/index.ts";
import {
  PlannerInputError,
  createPlan,
  type CatalogEntry,
  type Profile,
} from "./index.ts";

const target: Target = {
  targetId: "office-mac",
  displayName: "Office Mac",
  platform: "macos",
  locators: { sshAlias: "dawn-office-mac" },
  identityEvidence: {
    sshHostKeyFingerprint: "SHA256:host-a",
    machineId: "11111111-2222-3333-4444-555555555555",
    architecture: "arm64",
    remoteUser: "wangxiao",
  },
  targetFingerprint: "a".repeat(64),
  registeredAt: "2026-07-23T12:00:00.000Z",
};

const snapshot: InspectorSnapshot = {
  platform: "macos",
  remoteUser: "wangxiao",
  freeDiskBytes: 100_000_000_000,
  homebrew: {
    installed: true,
    version: "Homebrew 4.4.0",
    formulae: ["gh"],
    casks: ["visual-studio-code"],
  },
  git: {
    installed: true,
    version: "2.50.1",
  },
};

const catalog: CatalogEntry[] = [
  {
    id: "homebrew",
    provider: "homebrew",
    params: {},
    critical: true,
    dependsOn: [],
  },
  {
    id: "git",
    provider: "git",
    params: {},
    critical: false,
    dependsOn: ["homebrew"],
  },
  {
    id: "node",
    provider: "homebrew",
    params: { formula: "node" },
    critical: false,
    dependsOn: ["homebrew"],
  },
  {
    id: "gh",
    provider: "homebrew",
    params: { formula: "gh" },
    critical: false,
    dependsOn: ["homebrew"],
  },
  {
    id: "vscode",
    provider: "homebrew",
    params: { formula: "visual-studio-code", cask: true },
    critical: false,
    dependsOn: ["homebrew"],
  },
];

const profile: Profile = {
  schemaVersion: 1,
  platform: "macos",
  catalogVersion: "v1",
  packages: [
    { id: "homebrew", state: "present" },
    { id: "git", state: "present" },
    { id: "node", state: "present" },
    { id: "gh", state: "absent" },
    { id: "vscode", state: "present" },
  ],
};

test("Planner 生成 install、skip、conflict、显式依赖和拓扑顺序", () => {
  const plan = createPlan({
    target,
    snapshot,
    profile,
    catalog,
    now: new Date("2026-07-23T12:00:00.000Z"),
  });
  const actions = new Map(
    plan.spec.actions.map((action) => [action.packageId, action]),
  );

  assert.equal(actions.get("homebrew")?.type, "skip");
  assert.equal(actions.get("git")?.type, "skip");
  assert.equal(actions.get("node")?.type, "install");
  assert.equal(actions.get("gh")?.type, "conflict");
  assert.equal(actions.get("vscode")?.type, "skip");
  assert.equal(actions.get("homebrew")?.critical, true);
  assert.deepEqual(actions.get("git")?.dependsOn, ["action-homebrew"]);
  assert.deepEqual(actions.get("node")?.dependsOn, ["action-homebrew"]);
  assert.ok(
    plan.spec.actions.findIndex((action) => action.packageId === "homebrew") <
      plan.spec.actions.findIndex((action) => action.packageId === "git"),
  );
});

test("Planner 将缺失的 Homebrew 本体分类为 manual", () => {
  const plan = createPlan({
    target,
    snapshot: {
      ...snapshot,
      homebrew: { installed: false, formulae: [], casks: [] },
    },
    profile: {
      ...profile,
      packages: [{ id: "homebrew", state: "present" }],
    },
    catalog,
    now: new Date("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(plan.spec.actions[0].type, "manual");
});

test("absent Action 不展开或保留安装依赖", () => {
  const plan = createPlan({
    target,
    snapshot,
    profile: {
      ...profile,
      packages: [{ id: "gh", state: "absent" }],
    },
    catalog,
    now: new Date("2026-07-23T12:00:00.000Z"),
  });

  assert.deepEqual(
    plan.spec.actions.map((action) => ({
      packageId: action.packageId,
      type: action.type,
      dependsOn: action.dependsOn,
    })),
    [{ packageId: "gh", type: "conflict", dependsOn: [] }],
  );
});

test("相同 Target、Profile 和快照产生相同 planHash", () => {
  const first = createPlan({
    target,
    snapshot,
    profile,
    catalog,
    now: new Date("2026-07-23T12:00:00.000Z"),
  });
  const second = createPlan({
    target,
    snapshot,
    profile,
    catalog,
    now: new Date("2026-07-24T12:00:00.000Z"),
  });

  assert.equal(first.planHash, second.planHash);
  assert.notEqual(first.createdAt, second.createdAt);
});

test("Planner 拒绝 Catalog 循环依赖", () => {
  const cyclic = catalog.map((entry) =>
    entry.id === "homebrew"
      ? { ...entry, dependsOn: ["git"] }
      : entry,
  );
  assert.throws(
    () =>
      createPlan({
        target,
        snapshot,
        profile,
        catalog: cyclic,
        now: new Date(),
      }),
    (error) =>
      error instanceof PlannerInputError &&
      error.exitCode === 2 &&
      /循环依赖/.test(error.message),
  );
});

test("Planner 拒绝 Catalog 缺失依赖", () => {
  const missing = catalog.map((entry) =>
    entry.id === "git"
      ? { ...entry, dependsOn: ["missing"] }
      : entry,
  );
  assert.throws(
    () =>
      createPlan({
        target,
        snapshot,
        profile,
        catalog: missing,
        now: new Date(),
      }),
    (error) =>
      error instanceof PlannerInputError &&
      error.exitCode === 2 &&
      /不存在的 Catalog 依赖/.test(error.message),
  );
});
