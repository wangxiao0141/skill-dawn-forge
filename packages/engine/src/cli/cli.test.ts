import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { openJournal, type RunSnapshot } from "../journal/index.ts";
import {
  computePlanHash,
  type Plan,
  type RunEvent,
  type Target,
} from "../protocol/index.ts";
import { IdentityConflictError } from "../target/index.ts";
import { resolveCatalogDirectory, runCli } from "./index.ts";

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runDawn(args: readonly string[], homeDirectory?: string): CommandResult {
  const result = spawnSync(process.execPath, ["bin/dawn.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...(homeDirectory
        ? { HOME: homeDirectory, USERPROFILE: homeDirectory }
        : {}),
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function withTempHome(
  callback: (homeDirectory: string) => Promise<void>,
): Promise<void> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "dawn-cli-"));
  try {
    await callback(homeDirectory);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

test("dawn --help 列出全部 V1 子命令并以 0 退出", () => {
  const result = runDawn(["--help"]);

  assert.equal(result.status, 0);
  for (const command of [
    "target bootstrap",
    "target inspect",
    "target revoke",
    "plan",
    "apply",
    "run show",
    "resume",
    "verify",
  ]) {
    assert.match(result.stdout, new RegExp(command));
  }
});

test("未知的命令给出明确说明并以 2 退出", () => {
  const unknown = runDawn(["unknown"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知命令：unknown/);
});

test("dawn apply 在创建 Run 前拒绝错误 approval hash", async () => {
  await withTempHome(async (homeDirectory) => {
    const spec = {
      engineVersion: "1",
      catalogVersion: "v1",
      targetId: "office-mac",
      targetFingerprint: "a".repeat(64),
      profileHash: "b".repeat(64),
      actions: [],
    };
    const plan: Plan = {
      spec,
      planHash: computePlanHash(spec),
      createdAt: "2026-07-23T12:00:00.000Z",
    };
    const planPath = join(homeDirectory, "plan.json");
    writeFileSync(planPath, `${JSON.stringify(plan)}\n`, "utf8");
    let called = false;
    const errors: string[] = [];

    const exitCode = await runCli(
      [
        "apply",
        "--plan",
        planPath,
        "--approve",
        "f".repeat(64),
      ],
      {
        async applyExecutor() {
          called = true;
          throw new Error("不应调用");
        },
        stdout: () => {},
        stderr: (message) => errors.push(message),
      },
    );

    assert.equal(exitCode, 20);
    assert.equal(called, false);
    assert.match(errors.join("\n"), /Plan hash 不匹配/);
  });
});

test("dawn apply --format jsonl 每个事件输出一行并包含 runId", async () => {
  await withTempHome(async (homeDirectory) => {
    const spec = {
      engineVersion: "1",
      catalogVersion: "v1",
      targetId: "office-mac",
      targetFingerprint: "a".repeat(64),
      profileHash: "b".repeat(64),
      actions: [],
    };
    const plan: Plan = {
      spec,
      planHash: computePlanHash(spec),
      createdAt: "2026-07-23T12:00:00.000Z",
    };
    const planPath = join(homeDirectory, "plan.json");
    writeFileSync(planPath, `${JSON.stringify(plan)}\n`, "utf8");
    const output: string[] = [];
    const events: RunEvent[] = [
      {
        timestamp: "2026-07-23T12:00:01.000Z",
        runId: "run-jsonl",
        event: { type: "run-started" },
      },
      {
        timestamp: "2026-07-23T12:00:02.000Z",
        runId: "run-jsonl",
        event: { type: "run-completed", summary: "Run 成功完成。" },
      },
    ];

    const exitCode = await runCli(
      [
        "apply",
        "--plan",
        planPath,
        "--approve",
        plan.planHash,
        "--format",
        "jsonl",
      ],
      {
        async applyExecutor({ emit }) {
          events.forEach(emit);
          return { runId: "run-jsonl", exitCode: 0, events };
        },
        stdout: (message) => output.push(message),
        stderr: (message) => output.push(`error:${message}`),
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(output.length, 2);
    assert.deepEqual(output.map((line) => JSON.parse(line)), events);
    assert.equal(JSON.parse(output[0]).runId, "run-jsonl");
  });
});

test("dawn resume 透传 JSONL 事件和退出码", async () => {
  const output: string[] = [];
  const event: RunEvent = {
    timestamp: "2026-07-23T13:00:00.000Z",
    runId: "run-resume",
    event: { type: "run-started" },
  };

  const exitCode = await runCli(
    ["resume", "--run", "run-resume", "--format", "jsonl"],
    {
      async resumeExecutor({ runId, emit }) {
        assert.equal(runId, "run-resume");
        emit(event);
        return { runId, exitCode: 10, events: [event] };
      },
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(`error:${message}`),
    },
  );

  assert.equal(exitCode, 10);
  assert.deepEqual(output.map((line) => JSON.parse(line)), [event]);
});

test("dawn verify 报告 drift 并透传退出码 50", async () => {
  const output: string[] = [];

  const exitCode = await runCli(
    ["verify", "--run", "run-drift"],
    {
      async verifyExecutor({ runId }) {
        assert.equal(runId, "run-drift");
        return {
          exitCode: 50,
          drift: [{ actionId: "action-node", message: "node is missing" }],
        };
      },
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(`error:${message}`),
    },
  );

  assert.equal(exitCode, 50);
  assert.deepEqual(output, ["action-node: node is missing"]);
});

test("dawn plan 写出 Plan JSON 并打印 planHash", async () => {
  await withTempHome(async (homeDirectory) => {
    const outputPath = join(homeDirectory, "plan.json");
    const plan: Plan = {
      spec: {
        engineVersion: "1",
        catalogVersion: "v1",
        targetId: "office-mac",
        targetFingerprint: "a".repeat(64),
        profileHash: "b".repeat(64),
        actions: [],
      },
      planHash: "c".repeat(64),
      createdAt: "2026-07-23T12:00:00.000Z",
    };
    const calls: unknown[] = [];
    const output: string[] = [];

    const exitCode = await runCli(
      [
        "plan",
        "--target",
        "office-mac",
        "--profile",
        "profile.json",
        "--out",
        outputPath,
      ],
      {
        planBuilder: {
          async create(input) {
            calls.push(input);
            return plan;
          },
        },
        stdout: (message) => output.push(message),
        stderr: (message) => output.push(`error:${message}`),
      },
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [
      { targetId: "office-mac", profilePath: "profile.json" },
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(outputPath, "utf8")),
      plan,
    );
    assert.deepEqual(output, [plan.planHash]);
  });
});

test("Catalog 相对 dawn.mjs 定位，不依赖当前工作目录", async () => {
  await withTempHome(async (homeDirectory) => {
    const skillDirectory = join(homeDirectory, "skill");
    const binDirectory = join(skillDirectory, "bin");
    const catalogDirectory = join(skillDirectory, "catalog");
    mkdirSync(binDirectory, { recursive: true });
    mkdirSync(catalogDirectory, { recursive: true });
    writeFileSync(
      join(catalogDirectory, "catalog.schema.json"),
      "{}\n",
      "utf8",
    );

    assert.equal(
      resolveCatalogDirectory(join(binDirectory, "dawn.mjs")),
      catalogDirectory,
    );
  });
});

test("target CLI 解析 bootstrap、inspect、revoke 并输出身份摘要", async () => {
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
  const calls: unknown[] = [];
  const targetManager = {
    async bootstrap(input: unknown) {
      calls.push(["bootstrap", input]);
      return target;
    },
    async inspect(targetId: string) {
      calls.push(["inspect", targetId]);
      return target;
    },
    async revoke(targetId: string) {
      calls.push(["revoke", targetId]);
    },
  };
  const output: string[] = [];
  const dependencies = {
    targetManager,
    stdout: (message: string) => output.push(message),
    stderr: (message: string) => output.push(`error:${message}`),
  };

  assert.equal(
    await runCli(
      [
        "target",
        "bootstrap",
        "--host",
        "mac-mini.local",
        "--user",
        "wangxiao",
        "--name",
        "Office Mac",
      ],
      dependencies,
    ),
    0,
  );
  assert.equal(
    await runCli(
      ["target", "inspect", "--target", "office-mac"],
      dependencies,
    ),
    0,
  );
  assert.equal(
    await runCli(
      ["target", "revoke", "--target", "office-mac"],
      dependencies,
    ),
    0,
  );

  assert.deepEqual(calls, [
    [
      "bootstrap",
      {
        host: "mac-mini.local",
        user: "wangxiao",
        name: "Office Mac",
      },
    ],
    ["inspect", "office-mac"],
    ["revoke", "office-mac"],
  ]);
  assert.match(output.join("\n"), /machineId: 11111111/);
  assert.match(output.join("\n"), /远端公钥和本地记录均已删除/);
});

test("target CLI 将身份冲突映射为退出码 30", async () => {
  const errors: string[] = [];
  const exitCode = await runCli(
    ["target", "inspect", "--target", "office-mac"],
    {
      targetManager: {
        async bootstrap() {
          throw new Error("not used");
        },
        async inspect() {
          throw new IdentityConflictError(["machineId"]);
        },
        async revoke() {
          throw new Error("not used");
        },
      },
      stdout: () => {},
      stderr: (message) => errors.push(message),
    },
  );

  assert.equal(exitCode, 30);
  assert.match(errors.join("\n"), /machineId/);
});

test("dawn run show 输出 Action 状态和失败信息", async () => {
  await withTempHome(async (homeDirectory) => {
    const runId = "run-show-test";
    const runsDirectory = join(homeDirectory, ".dawn-forge", "runs");
    const failedEvent: RunEvent = {
      timestamp: "2026-07-23T10:01:00.000Z",
      runId,
      event: {
        type: "action-failed",
        actionId: "install-git",
        message: "安装失败",
        critical: true,
      },
    };
    const snapshot: RunSnapshot = {
      schemaVersion: 1,
      runId,
      planHash: "plan-hash",
      createdAt: "2026-07-23T10:00:00.000Z",
      updatedAt: "2026-07-23T10:01:00.000Z",
      actions: [
        {
          actionId: "install-git",
          state: "failed",
          error: "brew 不可用",
        },
      ],
      outcome: "stopped",
    };
    const writer = openJournal(runId, { runsDirectory });
    await writer.commit(
      {
        timestamp: "2026-07-23T10:00:30.000Z",
        runId,
        event: {
          type: "action-started",
          actionId: "install-git",
          message: "开始安装",
        },
      },
      {
        ...snapshot,
        actions: [{ actionId: "install-git", state: "running" }],
        outcome: "in-progress",
      },
    );
    await writer.commit(
      [
        failedEvent,
        {
          timestamp: "2026-07-23T10:01:01.000Z",
          runId,
          event: { type: "run-stopped", reason: "关键 Action 失败" },
        },
      ],
      snapshot,
    );
    writer.close();

    const result = runDawn(["run", "show", "--run", runId], homeDirectory);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Run run-show-test/);
    assert.match(result.stdout, /install-git\s+failed：brew 不可用/);
    assert.match(result.stdout, /Outcome: stopped/);
  });
});

test("dawn run show 对不存在的 runId 以 2 退出", async () => {
  await withTempHome(async (homeDirectory) => {
    const result = runDawn(
      ["run", "show", "--run", "missing-run"],
      homeDirectory,
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /找不到或无法读取 Run：missing-run/);
  });
});

test("dawn run show 将无效 runId 映射为退出码 2", async () => {
  await withTempHome(async (homeDirectory) => {
    const result = runDawn(
      ["run", "show", "--run", "../outside"],
      homeDirectory,
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /runId 无效/);
    assert.doesNotMatch(result.stderr, /at\s+/);
  });
});
