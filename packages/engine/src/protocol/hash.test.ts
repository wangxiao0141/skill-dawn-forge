import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  computePlanHash,
  computeTargetFingerprint,
  ExitCode,
  type IdentityEvidence,
  type PlanSpec,
} from "./index.ts";

const evidence: IdentityEvidence = {
  sshHostKeyFingerprint: "SHA256:example",
  machineId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  architecture: "arm64",
  remoteUser: "alice",
};

const spec: PlanSpec = {
  engineVersion: "1.0.0",
  catalogVersion: "2026-07",
  targetId: "target-1",
  targetFingerprint: computeTargetFingerprint(evidence),
  profileHash: "profile-hash",
  actions: [
    {
      actionId: "install-git",
      type: "install",
      packageId: "git",
      provider: "homebrew-formula",
      params: { options: { force: false }, version: "2.50.1" },
      critical: false,
      dependsOn: [],
    },
  ],
};

test("planHash 不受对象字段插入顺序影响", () => {
  const reordered = {
    actions: [
      {
        dependsOn: [],
        critical: false,
        params: { version: "2.50.1", options: { force: false } },
        provider: "homebrew-formula",
        packageId: "git",
        type: "install" as const,
        actionId: "install-git",
      },
    ],
    profileHash: "profile-hash",
    targetFingerprint: spec.targetFingerprint,
    targetId: "target-1",
    catalogVersion: "2026-07",
    engineVersion: "1.0.0",
  };

  assert.equal(computePlanHash(spec), computePlanHash(reordered));
});

test("planHash 遵循 RFC 8785 对整数式属性名的排序规则", () => {
  const specWithIntegerLikeParams: PlanSpec = {
    engineVersion: "1",
    catalogVersion: "1",
    targetId: "t",
    targetFingerprint: "f",
    profileHash: "h",
    actions: [
      {
        actionId: "a",
        type: "install",
        packageId: "p",
        provider: "x",
        params: { "10": "ten", "2": "two" },
        critical: false,
        dependsOn: [],
      },
    ],
  };

  assert.equal(
    computePlanHash(specWithIntegerLikeParams),
    "c070c02dc6c8e68494c212e138021f7f67bfbde0b03a1e6a3bc20990b04b0214",
  );
});

test("任意 Action 执行语义变化都会改变 planHash", () => {
  const action = spec.actions[0];
  const changes: Array<[string, PlanSpec]> = [
    ["packageId", { ...spec, actions: [{ ...action, packageId: "node" }] }],
    [
      "provider",
      { ...spec, actions: [{ ...action, provider: "manual-action" }] },
    ],
    [
      "params",
      {
        ...spec,
        actions: [{ ...action, params: { version: "2.50.2" } }],
      },
    ],
    [
      "dependsOn",
      { ...spec, actions: [{ ...action, dependsOn: ["install-homebrew"] }] },
    ],
    ["critical", { ...spec, actions: [{ ...action, critical: true }] }],
  ];

  for (const [field, changedSpec] of changes) {
    assert.notEqual(
      computePlanHash(spec),
      computePlanHash(changedSpec),
      `${field} 必须受 planHash 约束`,
    );
  }
});

test("planHash 排除 spec 中的 createdAt 时间戳", () => {
  const first = {
    ...spec,
    createdAt: "2026-07-23T10:00:00.000Z",
  };
  const second = {
    ...first,
    createdAt: "2026-07-23T11:00:00.000Z",
  };

  assert.equal(computePlanHash(first), computePlanHash(spec));
  assert.equal(computePlanHash(second), computePlanHash(spec));
});

test("targetFingerprint 对字段顺序稳定并覆盖身份语义", () => {
  const reordered: IdentityEvidence = {
    remoteUser: "alice",
    architecture: "arm64",
    machineId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    sshHostKeyFingerprint: "SHA256:example",
  };

  assert.equal(
    computeTargetFingerprint(evidence),
    computeTargetFingerprint(reordered),
  );
  assert.notEqual(
    computeTargetFingerprint(evidence),
    computeTargetFingerprint({ ...evidence, remoteUser: "bob" }),
  );
});

test("协议哈希在不同 Node.js 进程中保持稳定", () => {
  const script = `
    import { computePlanHash } from "./src/protocol/index.ts";
    const spec = ${JSON.stringify(spec)};
    process.stdout.write(computePlanHash(spec));
  `;
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", script],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, computePlanHash(spec));
});

test("JCS 哈希拒绝 I-JSON 数据模型之外的值", () => {
  const action = spec.actions[0];

  assert.throws(
    () =>
      computePlanHash({
        ...spec,
        actions: [{ ...action, params: { value: Number.NaN } }],
      }),
    /非有限数值/,
  );
  assert.throws(
    () =>
      computePlanHash({
        ...spec,
        actions: [{ ...action, params: { value: "\ud800" } }],
      }),
    /未配对的 Unicode surrogate/,
  );
});

test("ExitCode 导出完整的 CLI 退出码契约", () => {
  assert.deepEqual(ExitCode, {
    Success: 0,
    ParamError: 2,
    NeedsUser: 10,
    PlanInvalid: 20,
    IdentityConflict: 30,
    ActionFailed: 40,
    VerifyDrift: 50,
    LockConflict: 60,
  });
});

test("协议哈希是 64 位小写十六进制字符串", () => {
  const lowercaseSha256 = /^[0-9a-f]{64}$/;

  assert.match(computePlanHash(spec), lowercaseSha256);
  assert.match(computeTargetFingerprint(evidence), lowercaseSha256);
});
