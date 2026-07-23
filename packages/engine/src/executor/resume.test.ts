import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  resumeRun,
  verifyRun,
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
    const value = this.#responses.shift();
    assert.ok(value, `没有为 SSH command 准备响应：${command}`);
    return value;
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

function clock(start = "2026-07-23T12:00:00.000Z"): () => Date {
  let tick = 0;
  return () => new Date(Date.parse(start) + tick++ * 1_000);
}

async function withRunsDirectory(
  callback: (runsDirectory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "dawn-resume-"));
  try {
    await callback(join(directory, "runs"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("manual Action 暂停后，resume 先 verify 再继续下游", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const value = plan([
      action("homebrew", {
        type: "manual",
        params: {},
        critical: true,
      }),
      action("node", { dependsOn: ["action-homebrew"] }),
    ]);
    const applied = await executePlan({
      plan: value,
      ssh: new QueueSshExecutor([]),
      runsDirectory,
      runId: "run-manual",
      now: clock(),
    });
    assert.equal(applied.exitCode, 10);
    assert.equal(
      applied.events.at(-1)?.event.type,
      "needs-user",
    );

    const ssh = new QueueSshExecutor([
      response(0, "Homebrew 4.4.0\n"),
      response(1),
      response(0),
      response(0, "node 24.0.0\n"),
    ]);
    const resumed = await resumeRun({
      runId: "run-manual",
      ssh,
      runsDirectory,
      now: clock("2026-07-23T13:00:00.000Z"),
    });

    assert.equal(resumed.exitCode, 0);
    assert.deepEqual(
      resumed.events.map(({ event }) => event.type),
      [
        "run-started",
        "action-succeeded",
        "action-started",
        "action-succeeded",
        "run-completed",
      ],
    );
    assert.deepEqual(ssh.commands, [
      "brew --version",
      "brew list --versions node",
      "brew install node",
      "brew list --versions node",
    ]);
    assert.deepEqual(
      readRun("run-manual", { runsDirectory }).snapshot.actions.map(
        ({ state }) => state,
      ),
      ["succeeded", "succeeded"],
    );
  });
});

test("resume 只重试 ready 的 failed/blocked，succeeded 仅 re-verify", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const value = plan([
      action("node"),
      action("typescript", { dependsOn: ["action-node"] }),
      action("gh"),
    ]);
    await executePlan({
      plan: value,
      ssh: new QueueSshExecutor([
        response(1),
        response(1),
        response(0, "gh 2.75.0\n"),
      ]),
      runsDirectory,
      runId: "run-selective",
      now: clock(),
    });
    const ssh = new QueueSshExecutor([
      response(0, "gh 2.75.0\n"),
      response(0, "node 24.0.0\n"),
      response(1),
      response(0),
      response(0, "typescript 5.9.0\n"),
    ]);

    const result = await resumeRun({
      runId: "run-selective",
      ssh,
      runsDirectory,
      now: clock("2026-07-23T13:00:00.000Z"),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(
      ssh.commands.filter((command) => command === "brew list --versions gh")
        .length,
      1,
    );
    assert.ok(!ssh.commands.includes("brew install gh"));
    assert.deepEqual(
      readRun("run-selective", { runsDirectory }).snapshot.actions.map(
        ({ state }) => state,
      ),
      ["succeeded", "succeeded", "succeeded"],
    );
  });
});

test("resume re-verify 降级 succeeded，并重新评估其下游", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const value = plan([
      action("node"),
      action("typescript", { dependsOn: ["action-node"] }),
    ]);
    await executePlan({
      plan: value,
      ssh: new QueueSshExecutor([
        response(0, "node 24.0.0\n"),
        response(0, "typescript 5.9.0\n"),
      ]),
      runsDirectory,
      runId: "run-drift-retry",
      now: clock(),
    });
    const ssh = new QueueSshExecutor([
      response(1),
      response(0, "node 24.0.0\n"),
      response(0, "typescript 5.9.0\n"),
    ]);

    const result = await resumeRun({
      runId: "run-drift-retry",
      ssh,
      runsDirectory,
      now: clock("2026-07-23T13:00:00.000Z"),
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      result.events.map(({ event }) => event.type),
      [
        "run-started",
        "action-failed",
        "action-blocked",
        "action-started",
        "action-succeeded",
        "action-started",
        "action-succeeded",
        "run-completed",
      ],
    );
  });
});

test("resume 对遗留 running 先 fail closed，确认后再次调用才重试", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const value = plan([action("node")]);
    await assert.rejects(
      executePlan({
        plan: value,
        ssh: new QueueSshExecutor([]),
        runsDirectory,
        runId: "run-crashed",
        now: clock(),
        emit(event) {
          if (event.event.type === "action-started") {
            throw new Error("simulated crash");
          }
        },
      }),
      /simulated crash/,
    );

    const firstResume = await resumeRun({
      runId: "run-crashed",
      ssh: new QueueSshExecutor([]),
      runsDirectory,
      now: clock("2026-07-23T13:00:00.000Z"),
    });

    assert.equal(firstResume.exitCode, 40);
    assert.deepEqual(
      firstResume.events.map(({ event }) => event.type),
      [
        "run-started",
        "action-failed",
        "run-stopped",
      ],
    );
    const stoppedEvent = firstResume.events.at(-1);
    assert.equal(stoppedEvent?.event.type, "run-stopped");
    if (stoppedEvent?.event.type === "run-stopped") {
      assert.match(stoppedEvent.event.reason, /确认无遗留安装进程/);
    }

    const secondResume = await resumeRun({
      runId: "run-crashed",
      ssh: new QueueSshExecutor([response(0, "node 24.0.0\n")]),
      runsDirectory,
      now: clock("2026-07-23T14:00:00.000Z"),
    });
    assert.equal(secondResume.exitCode, 0);
    assert.deepEqual(
      secondResume.events.map(({ event }) => event.type),
      [
        "run-started",
        "action-started",
        "action-succeeded",
        "run-completed",
      ],
    );
  });
});

test("verify 只读检测 drift，并以 0/50 区分结果", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const value = plan([action("node"), action("gh")]);
    await executePlan({
      plan: value,
      ssh: new QueueSshExecutor([
        response(0, "node 24.0.0\n"),
        response(0, "gh 2.75.0\n"),
      ]),
      runsDirectory,
      runId: "run-verify",
      now: clock(),
    });
    const runDirectory = join(runsDirectory, "run-verify");
    const beforeJournal = await readFile(
      join(runDirectory, "journal.jsonl"),
      "utf8",
    );
    const beforeSnapshot = await readFile(
      join(runDirectory, "snapshot.json"),
      "utf8",
    );

    const drift = await verifyRun({
      runId: "run-verify",
      ssh: new QueueSshExecutor([
        response(0, "node 24.0.0\n"),
        response(1),
      ]),
      runsDirectory,
    });
    assert.equal(drift.exitCode, 50);
    assert.deepEqual(drift.drift.map(({ actionId }) => actionId), [
      "action-gh",
    ]);
    assert.equal(
      await readFile(join(runDirectory, "journal.jsonl"), "utf8"),
      beforeJournal,
    );
    assert.equal(
      await readFile(join(runDirectory, "snapshot.json"), "utf8"),
      beforeSnapshot,
    );

    const clean = await verifyRun({
      runId: "run-verify",
      ssh: new QueueSshExecutor([
        response(0, "node 24.0.0\n"),
        response(0, "gh 2.75.0\n"),
      ]),
      runsDirectory,
    });
    assert.equal(clean.exitCode, 0);
    assert.deepEqual(clean.drift, []);
  });
});

test("resume 输出失败不会把 re-verify 成功改写为 failed", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const value = plan([action("node")]);
    await executePlan({
      plan: value,
      ssh: new QueueSshExecutor([response(0, "node 24.0.0\n")]),
      runsDirectory,
      runId: "run-resume-output-failure",
      now: clock(),
    });

    await assert.rejects(
      resumeRun({
        runId: "run-resume-output-failure",
        ssh: new QueueSshExecutor([response(0, "node 24.0.0\n")]),
        runsDirectory,
        now: clock("2026-07-23T13:00:00.000Z"),
        emit(event) {
          if (event.event.type === "action-succeeded") {
            throw new Error("stdout closed");
          }
        },
      }),
      /stdout closed/,
    );

    const run = readRun("run-resume-output-failure", { runsDirectory });
    assert.equal(run.snapshot.actions[0].state, "succeeded");
    assert.equal(run.events.at(-1)?.event.type, "action-succeeded");
  });
});

test("resume 单次重试仍失败时不会无限重放同一 Action", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const value = plan([action("node")]);
    await executePlan({
      plan: value,
      ssh: new QueueSshExecutor([response(1), response(1)]),
      runsDirectory,
      runId: "run-retry-once",
      now: clock(),
    });
    const ssh = new QueueSshExecutor([response(1), response(1)]);

    const result = await resumeRun({
      runId: "run-retry-once",
      ssh,
      runsDirectory,
      now: clock("2026-07-23T13:00:00.000Z"),
    });

    assert.equal(result.exitCode, 40);
    assert.deepEqual(ssh.commands, [
      "brew list --versions node",
      "brew install node",
    ]);
    assert.equal(
      readRun("run-retry-once", { runsDirectory }).snapshot.actions[0].state,
      "failed",
    );
  });
});
