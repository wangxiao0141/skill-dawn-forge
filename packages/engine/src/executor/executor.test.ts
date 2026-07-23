import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readRun } from "../journal/index.ts";
import {
  computePlanHash,
  type Action,
  type Plan,
} from "../protocol/index.ts";
import type { SshExecutor } from "../providers/interface.ts";
import {
  executePlan,
  PlanApprovalError,
  readApprovedPlan,
} from "./index.ts";

interface SshResponse {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

class QueueSshExecutor implements SshExecutor {
  readonly commands: string[] = [];
  readonly #responses: SshResponse[];

  constructor(responses: readonly SshResponse[]) {
    this.#responses = [...responses];
  }

  async run(command: string): Promise<SshResponse> {
    this.commands.push(command);
    const response = this.#responses.shift();
    assert.ok(response, `没有为 SSH command 准备响应：${command}`);
    return response;
  }
}

function response(
  exitCode: number,
  stdout = "",
  stderr = "",
): SshResponse {
  return { stdout, stderr, exitCode };
}

function action(
  packageId: string,
  options: Partial<Action> = {},
): Action {
  return {
    actionId: `action-${packageId}`,
    type: "install",
    packageId,
    provider: "homebrew",
    params: { formula: packageId },
    critical: false,
    dependsOn: [],
    ...options,
  };
}

function plan(actions: readonly Action[]): Plan {
  const spec = {
    engineVersion: "1",
    catalogVersion: "v1",
    targetId: "office-mac",
    targetFingerprint: "a".repeat(64),
    profileHash: "b".repeat(64),
    actions,
  };
  return {
    spec,
    planHash: computePlanHash(spec),
    createdAt: "2026-07-23T12:00:00.000Z",
  };
}

function clock(): () => Date {
  let tick = 0;
  return () =>
    new Date(Date.parse("2026-07-23T12:00:00.000Z") + tick++ * 1_000);
}

async function withRunsDirectory(
  callback: (runsDirectory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "dawn-executor-"));
  try {
    await callback(join(directory, "runs"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("readApprovedPlan 在执行前拒绝不匹配的 approval hash", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const planPath = join(runsDirectory, "..", "plan.json");
    const value = plan([action("node")]);
    await writeFile(planPath, `${JSON.stringify(value)}\n`, "utf8");

    assert.throws(
      () => readApprovedPlan(planPath, "f".repeat(64)),
      (error: unknown) =>
        error instanceof PlanApprovalError && error.exitCode === 20,
    );

    const tampered = {
      ...value,
      spec: { ...value.spec, profileHash: "c".repeat(64) },
    };
    await writeFile(planPath, `${JSON.stringify(tampered)}\n`, "utf8");
    assert.throws(
      () => readApprovedPlan(planPath, value.planHash),
      PlanApprovalError,
    );
  });
});

test("Executor 成功时按顺序提交 JSONL 事件并持久化 Plan", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const value = plan([action("node"), action("gh")]);
    const ssh = new QueueSshExecutor([
      response(1),
      response(0),
      response(0, "node 24.0.0\n"),
      response(0, "gh 2.75.0\n"),
    ]);

    const result = await executePlan({
      plan: value,
      ssh,
      runsDirectory,
      runId: "run-success",
      now: clock(),
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      result.events.map(({ event }) => event.type),
      [
        "run-started",
        "action-started",
        "action-succeeded",
        "action-started",
        "action-succeeded",
        "run-completed",
      ],
    );
    for (const event of result.events) {
      const line = JSON.stringify(event);
      assert.doesNotMatch(line, /\r|\n/);
      assert.deepEqual(JSON.parse(line), event);
    }
    assert.deepEqual(ssh.commands, [
      "brew list --versions node",
      "brew install node",
      "brew list --versions node",
      "brew list --versions gh",
    ]);
    const persistedPlan = JSON.parse(
      await readFile(join(runsDirectory, "run-success", "plan.json"), "utf8"),
    );
    assert.deepEqual(persistedPlan, value);
    const run = readRun("run-success", { runsDirectory });
    assert.equal(run.snapshot.outcome, "completed");
    assert.deepEqual(
      run.snapshot.actions.map(({ state }) => state),
      ["succeeded", "succeeded"],
    );
  });
});

test("关键 Action 失败后立即停止，后续 Action 保持 pending", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const value = plan([
      action("node", { critical: true }),
      action("gh"),
    ]);
    const ssh = new QueueSshExecutor([
      response(1),
      response(1, "", "install failed"),
    ]);

    const result = await executePlan({
      plan: value,
      ssh,
      runsDirectory,
      runId: "run-critical",
      now: clock(),
    });

    assert.equal(result.exitCode, 40);
    assert.deepEqual(
      result.events.map(({ event }) => event.type),
      [
        "run-started",
        "action-started",
        "action-failed",
        "run-stopped",
      ],
    );
    assert.deepEqual(ssh.commands, [
      "brew list --versions node",
      "brew install node",
    ]);
    const run = readRun("run-critical", { runsDirectory });
    assert.equal(run.snapshot.outcome, "stopped");
    assert.deepEqual(
      run.snapshot.actions.map(({ state }) => state),
      ["failed", "pending"],
    );
  });
});

test("非关键失败只阻塞传递下游，独立 Action 继续执行", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const value = plan([
      action("node"),
      action("typescript", {
        dependsOn: ["action-node"],
      }),
      action("gh"),
    ]);
    const ssh = new QueueSshExecutor([
      response(1),
      response(1, "", "install failed"),
      response(1),
      response(0),
      response(0, "gh 2.75.0\n"),
    ]);

    const result = await executePlan({
      plan: value,
      ssh,
      runsDirectory,
      runId: "run-partial",
      now: clock(),
    });

    assert.equal(result.exitCode, 40);
    assert.deepEqual(
      result.events.map(({ event }) => event.type),
      [
        "run-started",
        "action-started",
        "action-failed",
        "action-blocked",
        "action-started",
        "action-succeeded",
        "run-completed",
      ],
    );
    assert.ok(
      ssh.commands.every((command) => !command.includes("typescript")),
    );
    const run = readRun("run-partial", { runsDirectory });
    assert.equal(run.snapshot.outcome, "completed");
    assert.deepEqual(
      run.snapshot.actions.map(({ state }) => state),
      ["failed", "blocked", "succeeded"],
    );
  });
});

test("输出失败不会把已经成功并持久化的 Action 改写为 failed", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const value = plan([action("node")]);
    const ssh = new QueueSshExecutor([
      response(0, "node 24.0.0\n"),
    ]);

    await assert.rejects(
      executePlan({
        plan: value,
        ssh,
        runsDirectory,
        runId: "run-output-failure",
        now: clock(),
        emit(event) {
          if (event.event.type === "action-succeeded") {
            throw new Error("stdout closed");
          }
        },
      }),
      /stdout closed/,
    );

    const run = readRun("run-output-failure", { runsDirectory });
    assert.equal(run.snapshot.outcome, "in-progress");
    assert.deepEqual(
      run.snapshot.actions.map(({ state }) => state),
      ["succeeded"],
    );
    assert.deepEqual(
      run.events.map(({ event }) => event.type),
      ["run-started", "action-started", "action-succeeded"],
    );
  });
});
