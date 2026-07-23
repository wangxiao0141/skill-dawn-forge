import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { openJournal, type RunSnapshot } from "../journal/index.ts";
import type { RunEvent, Target } from "../protocol/index.ts";
import { IdentityConflictError } from "../target/index.ts";
import { runCli } from "./index.ts";

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

test("尚未实现和未知的命令给出明确说明并以 2 退出", () => {
  const unimplemented = runDawn(["plan"]);
  assert.equal(unimplemented.status, 2);
  assert.match(unimplemented.stderr, /尚未实现：plan/);

  const unknown = runDawn(["unknown"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知命令：unknown/);
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
