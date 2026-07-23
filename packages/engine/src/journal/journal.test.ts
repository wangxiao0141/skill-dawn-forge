import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type RunEvent } from "../protocol/index.ts";
import {
  JournalLockError,
  openJournal,
  readRun,
  type RunSnapshot,
} from "./index.ts";

const runId = "test-run";
const event: RunEvent = {
  timestamp: "2026-07-23T10:00:00.000Z",
  runId,
  event: { type: "run-started" },
};
const snapshot: RunSnapshot = {
  schemaVersion: 1,
  runId,
  planHash: "plan-hash",
  createdAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:01:00.000Z",
  actions: [{ actionId: "install-git", state: "pending" }],
  outcome: "in-progress",
};

async function withRunsDirectory(
  callback: (runsDirectory: string) => Promise<void>,
): Promise<void> {
  const runsDirectory = await mkdtemp(join(tmpdir(), "dawn-journal-"));
  try {
    await callback(runsDirectory);
  } finally {
    await rm(runsDirectory, { recursive: true, force: true });
  }
}

test("openJournal 创建 Run 目录和锁文件", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const writer = openJournal(runId, { runsDirectory });
    try {
      assert.equal(existsSync(join(runsDirectory, runId)), true);
      assert.equal(existsSync(join(runsDirectory, runId, "lock")), true);
    } finally {
      writer.close();
    }
  });
});

test("commit 写入可由 readRun 读取的合法 JSON 行", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const writer = openJournal(runId, { runsDirectory });
    try {
      await writer.commit(event, snapshot);
      const line = readFileSync(
        join(runsDirectory, runId, "journal.jsonl"),
        "utf8",
      );
      assert.deepEqual(JSON.parse(line), event);
      assert.deepEqual(readRun(runId, { runsDirectory }).events, [event]);
    } finally {
      writer.close();
    }
  });
});

test("多事件 commit 保持每行一条 RunEvent", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const writer = openJournal(runId, { runsDirectory });
    const startedEvent: RunEvent = {
      timestamp: "2026-07-23T10:00:01.000Z",
      runId,
      event: {
        type: "action-started",
        actionId: "install-git",
        message: "开始安装",
      },
    };
    const runningSnapshot: RunSnapshot = {
      ...snapshot,
      actions: [{ actionId: "install-git", state: "running" }],
    };
    try {
      await writer.commit([event, startedEvent], runningSnapshot);
    } finally {
      writer.close();
    }

    const records = readFileSync(
      join(runsDirectory, runId, "journal.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n");
    assert.deepEqual(records.map((record) => JSON.parse(record)), [
      event,
      startedEvent,
    ]);
    assert.deepEqual(readRun(runId, { runsDirectory }).events, [
      event,
      startedEvent,
    ]);
  });
});

test("commit 拒绝改变 Run 的不可变 Plan 元数据", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const writer = openJournal(runId, { runsDirectory });
    await writer.commit(event, snapshot);
    const nextEvent: RunEvent = {
      timestamp: "2026-07-23T10:00:01.000Z",
      runId,
      event: { type: "run-started" },
    };
    try {
      await assert.rejects(
        () =>
          writer.commit(nextEvent, {
            ...snapshot,
            planHash: "different-plan",
          }),
        /planHash/,
      );
      await assert.rejects(
        () =>
          writer.commit(nextEvent, {
            ...snapshot,
            createdAt: "2026-07-23T10:00:01.000Z",
          }),
        /createdAt/,
      );
      await assert.rejects(
        () =>
          writer.commit(nextEvent, {
            ...snapshot,
            actions: [
              ...snapshot.actions,
              { actionId: "install-node", state: "pending" },
            ],
          }),
        /actionId/,
      );
    } finally {
      writer.close();
    }
  });
});

test("commit 原子写入内容一致的 snapshot.json", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const writer = openJournal(runId, { runsDirectory });
    try {
      await writer.commit(event, snapshot);
      const stored = JSON.parse(
        readFileSync(join(runsDirectory, runId, "snapshot.json"), "utf8"),
      );
      assert.deepEqual(stored, snapshot);
    } finally {
      writer.close();
    }
  });
});

test("第二个 openJournal 写入方以退出码 60 被拒绝", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const writer = openJournal(runId, { runsDirectory });
    try {
      assert.throws(
        () => openJournal(runId, { runsDirectory }),
        (error) =>
          error instanceof JournalLockError && error.exitCode === 60,
      );
    } finally {
      writer.close();
    }
  });
});

test("close 释放 Run 锁", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    openJournal(runId, { runsDirectory }).close();
    const reopened = openJournal(runId, { runsDirectory });
    reopened.close();
  });
});

test("readRun 返回 snapshot 和全部已提交事件", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const secondEvent: RunEvent = {
      timestamp: "2026-07-23T10:01:00.000Z",
      runId,
      event: {
        type: "action-started",
        actionId: "install-git",
        message: "开始安装",
      },
    };
    const runningSnapshot: RunSnapshot = {
      ...snapshot,
      actions: [{ actionId: "install-git", state: "running" }],
    };
    const writer = openJournal(runId, { runsDirectory });
    try {
      await writer.commit(event, snapshot);
      await writer.commit(secondEvent, runningSnapshot);
      assert.deepEqual(readRun(runId, { runsDirectory }), {
        snapshot: runningSnapshot,
        events: [event, secondEvent],
      });
    } finally {
      writer.close();
    }
  });
});

test("重开 Journal 时丢弃崩溃留下的末尾半行", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const journalPath = join(runsDirectory, runId, "journal.jsonl");
    const firstWriter = openJournal(runId, { runsDirectory });
    await firstWriter.commit(event, snapshot);
    firstWriter.close();

    appendFileSync(journalPath, '{"timestamp":"未完成');
    assert.deepEqual(readRun(runId, { runsDirectory }).events, [event]);

    const secondEvent: RunEvent = {
      timestamp: "2026-07-23T10:01:00.000Z",
      runId,
      event: { type: "run-started" },
    };
    const secondWriter = openJournal(runId, { runsDirectory });
    await secondWriter.commit(secondEvent, snapshot);
    secondWriter.close();

    assert.deepEqual(readRun(runId, { runsDirectory }).events, [
      event,
      secondEvent,
    ]);
  });
});

test("commit 拒绝 snapshot 凭空出现的终态", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const unsupportedSnapshot: RunSnapshot = {
      ...snapshot,
      actions: [{ actionId: "install-git", state: "succeeded" }],
      outcome: "completed",
    };
    const writer = openJournal(runId, { runsDirectory });
    try {
      await assert.rejects(
        () => writer.commit(event, unsupportedSnapshot),
        /Journal 与 snapshot 不一致/,
      );
    } finally {
      writer.close();
    }
  });
});

test("readRun 拒绝与 Journal 重放结果不一致的 snapshot", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const startedEvent: RunEvent = {
      timestamp: "2026-07-23T10:00:30.000Z",
      runId,
      event: {
        type: "action-started",
        actionId: "install-git",
        message: "开始安装",
      },
    };
    const succeededEvent: RunEvent = {
      timestamp: "2026-07-23T10:01:00.000Z",
      runId,
      event: {
        type: "action-succeeded",
        actionId: "install-git",
        message: "安装完成",
      },
    };
    const inconsistentSnapshot: RunSnapshot = {
      ...snapshot,
      actions: [
        {
          actionId: "install-git",
          state: "failed",
          error: "不应存在",
        },
      ],
    };
    const writer = openJournal(runId, { runsDirectory });
    try {
      await writer.commit(startedEvent, {
        ...snapshot,
        actions: [{ actionId: "install-git", state: "running" }],
      });
      await assert.rejects(
        () => writer.commit(succeededEvent, inconsistentSnapshot),
        /Journal 与 snapshot 不一致/,
      );
    } finally {
      writer.close();
    }
  });
});

test("Journal 重放覆盖每种 Action 状态转换", async (context) => {
  const transitions: ReadonlyArray<{
    readonly name: string;
    readonly events: readonly RunEvent["event"][];
    readonly state: RunSnapshot["actions"][number]["state"];
  }> = [
    {
      name: "running",
      events: [
        {
          type: "action-started",
          actionId: "install-git",
          message: "开始安装",
        },
      ],
      state: "running",
    },
    {
      name: "succeeded",
      events: [
        {
          type: "action-started",
          actionId: "install-git",
          message: "开始安装",
        },
        {
          type: "action-succeeded",
          actionId: "install-git",
          message: "安装成功",
        },
      ],
      state: "succeeded",
    },
    {
      name: "failed",
      events: [
        {
          type: "action-started",
          actionId: "install-git",
          message: "开始安装",
        },
        {
          type: "action-failed",
          actionId: "install-git",
          message: "安装失败",
          critical: false,
        },
      ],
      state: "failed",
    },
    {
      name: "blocked",
      events: [
        {
          type: "action-blocked",
          actionId: "install-git",
          reason: "依赖失败",
        },
      ],
      state: "blocked",
    },
    {
      name: "skipped",
      events: [
        {
          type: "action-started",
          actionId: "install-git",
          message: "开始检查",
        },
        {
          type: "action-skipped",
          actionId: "install-git",
          message: "已满足",
        },
      ],
      state: "skipped",
    },
  ];

  for (const transition of transitions) {
    await context.test(transition.name, async () => {
      await withRunsDirectory(async (runsDirectory) => {
        const transitionSnapshot: RunSnapshot = {
          ...snapshot,
          actions: [
            {
              actionId: "install-git",
              state: transition.state,
              ...(transition.state === "failed"
                ? { error: "安装失败" }
                : {}),
            },
          ],
        };
        const writer = openJournal(runId, { runsDirectory });
        try {
          for (const [index, transitionEvent] of transition.events.entries()) {
            const state =
              index === transition.events.length - 1
                ? transition.state
                : "running";
            await writer.commit(
              {
                timestamp: `2026-07-23T10:01:0${index}.000Z`,
                runId,
                event: transitionEvent,
              },
              {
                ...snapshot,
                actions: [
                  {
                    actionId: "install-git",
                    state,
                    ...(state === "failed" ? { error: "安装失败" } : {}),
                  },
                ],
              },
            );
          }
          assert.deepEqual(
            readRun(runId, { runsDirectory }).snapshot,
            transitionSnapshot,
          );
        } finally {
          writer.close();
        }
      });
    });
  }
});

test("Journal 重放支持 Resume 的选择性重试和 verify 降级", async (context) => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly events: readonly RunEvent["event"][];
    readonly states: readonly RunSnapshot["actions"][number]["state"][];
    readonly state: RunSnapshot["actions"][number]["state"];
  }> = [
    {
      name: "failed 重试后 succeeded",
      events: [
        {
          type: "action-started",
          actionId: "install-git",
          message: "首次开始",
        },
        {
          type: "action-failed",
          actionId: "install-git",
          message: "首次失败",
          critical: false,
        },
        {
          type: "action-started",
          actionId: "install-git",
          message: "重试开始",
        },
        {
          type: "action-succeeded",
          actionId: "install-git",
          message: "重试成功",
        },
      ],
      states: ["running", "failed", "running", "succeeded"],
      state: "succeeded",
    },
    {
      name: "needs_user verify 后 succeeded",
      events: [
        {
          type: "action-started",
          actionId: "install-git",
          message: "等待用户",
        },
        {
          type: "needs-user",
          actionId: "install-git",
          instruction: "完成手动操作",
        },
        {
          type: "action-succeeded",
          actionId: "install-git",
          message: "验证成功",
        },
      ],
      states: ["running", "needs_user", "succeeded"],
      state: "succeeded",
    },
    {
      name: "succeeded verify 后降级为 failed",
      events: [
        {
          type: "action-started",
          actionId: "install-git",
          message: "开始安装",
        },
        {
          type: "action-succeeded",
          actionId: "install-git",
          message: "安装成功",
        },
        {
          type: "action-failed",
          actionId: "install-git",
          message: "verify 发现漂移",
          critical: false,
        },
      ],
      states: ["running", "succeeded", "failed"],
      state: "failed",
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      await withRunsDirectory(async (runsDirectory) => {
        const writer = openJournal(runId, { runsDirectory });
        for (const [index, replayEvent] of item.events.entries()) {
          const state = item.states[index];
          await writer.commit(
            {
              timestamp: `2026-07-23T10:02:0${index}.000Z`,
              runId,
              event: replayEvent,
            },
            {
              ...snapshot,
              actions: [
                {
                  actionId: "install-git",
                  state,
                  ...(state === "failed" ? { error: "verify 失败" } : {}),
                },
              ],
            },
          );
        }
        writer.close();

        assert.equal(
          readRun(runId, { runsDirectory }).snapshot.actions[0].state,
          item.state,
        );
      });
    });
  }
});

test("Journal 拒绝 critical 失败后继续执行 Action", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const writer = openJournal(runId, { runsDirectory });
    await writer.commit(
      {
        timestamp: "2026-07-23T10:01:00.000Z",
        runId,
        event: {
          type: "action-started",
          actionId: "install-git",
          message: "开始安装",
        },
      },
      {
        ...snapshot,
        actions: [
          { actionId: "install-git", state: "running" },
          { actionId: "install-node", state: "pending" },
        ],
      },
    );

    await assert.rejects(
      () =>
        writer.commit(
          [
            {
              timestamp: "2026-07-23T10:01:01.000Z",
              runId,
              event: {
                type: "action-failed",
                actionId: "install-git",
                message: "关键失败",
                critical: true,
              },
            },
            {
              timestamp: "2026-07-23T10:01:02.000Z",
              runId,
              event: {
                type: "action-started",
                actionId: "install-node",
                message: "不应执行",
              },
            },
          ],
          {
            ...snapshot,
            actions: [
              {
                actionId: "install-git",
                state: "failed",
                error: "关键失败",
              },
              { actionId: "install-node", state: "running" },
            ],
          },
        ),
      /critical 失败后必须立即停止 Run/,
    );
    writer.close();
  });
});

test("Run stopped 后可以在新 Resume 周期继续", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const writer = openJournal(runId, { runsDirectory });
    await writer.commit(
      {
        timestamp: "2026-07-23T10:01:00.000Z",
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
      },
    );
    await writer.commit(
      [
        {
          timestamp: "2026-07-23T10:01:01.000Z",
          runId,
          event: {
            type: "action-failed",
            actionId: "install-git",
            message: "关键失败",
            critical: true,
          },
        },
        {
          timestamp: "2026-07-23T10:01:02.000Z",
          runId,
          event: { type: "run-stopped", reason: "关键失败" },
        },
      ],
      {
        ...snapshot,
        actions: [
          { actionId: "install-git", state: "failed", error: "关键失败" },
        ],
        outcome: "stopped",
      },
    );
    await writer.commit(
      {
        timestamp: "2026-07-23T10:02:00.000Z",
        runId,
        event: { type: "run-started" },
      },
      {
        ...snapshot,
        actions: [
          { actionId: "install-git", state: "failed", error: "关键失败" },
        ],
      },
    );
    await writer.commit(
      {
        timestamp: "2026-07-23T10:02:01.000Z",
        runId,
        event: {
          type: "action-started",
          actionId: "install-git",
          message: "恢复重试",
        },
      },
      {
        ...snapshot,
        actions: [{ actionId: "install-git", state: "running" }],
      },
    );
    writer.close();

    assert.equal(
      readRun(runId, { runsDirectory }).snapshot.actions[0].state,
      "running",
    );
  });
});

test("崩溃发生在 Journal fsync 后时采用 pending snapshot", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const runDirectory = join(runsDirectory, runId);
    const writer = openJournal(runId, { runsDirectory });
    await writer.commit(event, snapshot);
    writer.close();

    const startedEvent: RunEvent = {
      timestamp: "2026-07-23T10:01:00.000Z",
      runId,
      event: {
        type: "action-started",
        actionId: "install-git",
        message: "开始安装",
      },
    };
    const runningSnapshot: RunSnapshot = {
      ...snapshot,
      actions: [{ actionId: "install-git", state: "running" }],
    };
    await writeFile(
      join(runDirectory, "snapshot.pending"),
      JSON.stringify(runningSnapshot),
      "utf8",
    );
    const journalPath = join(runDirectory, "journal.jsonl");
    const committedBytes = Buffer.from(`${JSON.stringify(startedEvent)}\n`);
    await writeFile(
      join(runDirectory, "commit.pending"),
      JSON.stringify({
        schemaVersion: 1,
        startOffset: readFileSync(journalPath).length,
        byteLength: committedBytes.length,
        sha256: createHash("sha256").update(committedBytes).digest("hex"),
      }),
      "utf8",
    );
    appendFileSync(journalPath, committedBytes);

    assert.deepEqual(
      readRun(runId, { runsDirectory }).snapshot,
      runningSnapshot,
    );

    const recoveryWriter = openJournal(runId, { runsDirectory });
    recoveryWriter.close();
    assert.equal(existsSync(join(runDirectory, "snapshot.pending")), false);
    assert.equal(existsSync(join(runDirectory, "commit.pending")), false);
    assert.deepEqual(
      JSON.parse(readFileSync(join(runDirectory, "snapshot.json"), "utf8")),
      runningSnapshot,
    );
  });
});

test("崩溃发生在 Journal append 前时保留旧 snapshot", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const runDirectory = join(runsDirectory, runId);
    const writer = openJournal(runId, { runsDirectory });
    await writer.commit(event, snapshot);
    writer.close();

    const nextSnapshot = {
      ...snapshot,
      actions: [{ actionId: "install-git", state: "running" as const }],
    };
    await writeFile(
      join(runDirectory, "snapshot.pending"),
      JSON.stringify(nextSnapshot),
      "utf8",
    );
    const journalPath = join(runDirectory, "journal.jsonl");
    const committedBytes = Buffer.from(
      `${JSON.stringify({
        timestamp: "2026-07-23T10:01:00.000Z",
        runId,
        event: {
          type: "action-started",
          actionId: "install-git",
          message: "开始安装",
        },
      })}\n`,
    );
    await writeFile(
      join(runDirectory, "commit.pending"),
      JSON.stringify({
        schemaVersion: 1,
        startOffset: readFileSync(journalPath).length,
        byteLength: committedBytes.length,
        sha256: createHash("sha256").update(committedBytes).digest("hex"),
      }),
      "utf8",
    );

    assert.deepEqual(readRun(runId, { runsDirectory }).snapshot, snapshot);

    const recoveryWriter = openJournal(runId, { runsDirectory });
    recoveryWriter.close();
    assert.equal(existsSync(join(runDirectory, "snapshot.pending")), false);
    assert.equal(existsSync(join(runDirectory, "commit.pending")), false);
  });
});

test("多事件 commit 写入中途崩溃时回滚全部事件", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const runDirectory = join(runsDirectory, runId);
    const writer = openJournal(runId, { runsDirectory });
    await writer.commit(event, snapshot);
    writer.close();

    const startedEvent: RunEvent = {
      timestamp: "2026-07-23T10:01:00.000Z",
      runId,
      event: {
        type: "action-started",
        actionId: "install-git",
        message: "开始安装",
      },
    };
    const succeededEvent: RunEvent = {
      timestamp: "2026-07-23T10:01:01.000Z",
      runId,
      event: {
        type: "action-succeeded",
        actionId: "install-git",
        message: "安装成功",
      },
    };
    const pendingSnapshotPath = join(runDirectory, "snapshot.pending");
    await writeFile(
      pendingSnapshotPath,
      JSON.stringify({
        ...snapshot,
        actions: [{ actionId: "install-git", state: "succeeded" }],
      }),
      "utf8",
    );
    const journalPath = join(runDirectory, "journal.jsonl");
    const startOffset = readFileSync(journalPath).length;
    const committedBytes = Buffer.from(
      `${JSON.stringify(startedEvent)}\n${JSON.stringify(succeededEvent)}\n`,
    );
    await writeFile(
      join(runDirectory, "commit.pending"),
      JSON.stringify({
        schemaVersion: 1,
        startOffset,
        byteLength: committedBytes.length,
        sha256: createHash("sha256").update(committedBytes).digest("hex"),
      }),
      "utf8",
    );
    appendFileSync(
      journalPath,
      committedBytes.subarray(0, Buffer.byteLength(JSON.stringify(startedEvent)) + 20),
    );

    assert.deepEqual(readRun(runId, { runsDirectory }), {
      snapshot,
      events: [event],
    });

    const recoveryWriter = openJournal(runId, { runsDirectory });
    recoveryWriter.close();

    assert.deepEqual(readRun(runId, { runsDirectory }), {
      snapshot,
      events: [event],
    });
  });
});

test("readRun 在 snapshot rename 窗口重读稳定视图", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const runDirectory = join(runsDirectory, runId);
    const writer = openJournal(runId, { runsDirectory });
    await writer.commit(event, snapshot);
    const startedEvent: RunEvent = {
      timestamp: "2026-07-23T10:01:00.000Z",
      runId,
      event: {
        type: "action-started",
        actionId: "install-git",
        message: "开始安装",
      },
    };
    await writer.commit(startedEvent, {
      ...snapshot,
      actions: [{ actionId: "install-git", state: "running" }],
    });
    writer.close();

    const preloadPath = join(runDirectory, "inject-stale-snapshot.cjs");
    await writeFile(
      preloadPath,
      `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const realReadFileSync = fs.readFileSync;
let injected = false;
fs.readFileSync = function readFileSync(path, options) {
  if (!injected && String(path) === ${JSON.stringify(join(runDirectory, "snapshot.json"))}) {
    injected = true;
    const content = ${JSON.stringify(JSON.stringify(snapshot))};
    return typeof options === "string" || options?.encoding
      ? content
      : Buffer.from(content);
  }
  return realReadFileSync.apply(this, arguments);
};
syncBuiltinESMExports();
`,
      "utf8",
    );
    const childScript = `
      import { readRun } from "./src/journal/index.ts";
      const result = readRun(${JSON.stringify(runId)}, {
        runsDirectory: ${JSON.stringify(runsDirectory)}
      });
      process.exit(result.snapshot.actions[0]?.state === "running" ? 0 : 1);
    `;
    const status = await new Promise<number | null>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--require",
          preloadPath,
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          childScript,
        ],
        { cwd: process.cwd(), stdio: "ignore" },
      );
      child.once("exit", resolve);
    });

    assert.equal(status, 0);
  });
});

test("openJournal 回收已退出进程留下的锁", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const runDirectory = join(runsDirectory, runId);
    await mkdir(runDirectory, { recursive: true });
    const lockPath = join(runDirectory, "lock");
    await mkdir(lockPath);
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const writer = openJournal(runId, { runsDirectory });
    writer.close();
  });
});

test("两个进程竞争回收 stale lock 时只有一个取得写锁", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const runDirectory = join(runsDirectory, runId);
    await mkdir(runDirectory, { recursive: true });
    const lockPath = join(runDirectory, "lock");
    await mkdir(lockPath);
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const childScript = `
      import { openJournal } from "./src/journal/index.ts";
      try {
        const writer = openJournal(${JSON.stringify(runId)}, {
          runsDirectory: ${JSON.stringify(runsDirectory)}
        });
        setTimeout(() => {
          writer.close();
          process.exit(0);
        }, 200);
      } catch (error) {
        process.exit(error?.exitCode ?? 1);
      }
    `;
    const runChild = () =>
      new Promise<number | null>((resolve) => {
        const child = spawn(
          process.execPath,
          [
            "--experimental-strip-types",
            "--input-type=module",
            "--eval",
            childScript,
          ],
          { cwd: process.cwd(), stdio: "ignore" },
        );
        child.once("exit", resolve);
      });

    const statuses = await Promise.all([runChild(), runChild()]);
    assert.deepEqual(statuses.sort((left, right) => (left ?? 1) - (right ?? 1)), [
      0,
      60,
    ]);
  });
});

test("runId 不能越出 runs 目录", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    assert.throws(
      () => openJournal("../outside", { runsDirectory }),
      /runId 无效/,
    );
    assert.throws(
      () => readRun("../outside", { runsDirectory }),
      /runId 无效/,
    );
  });
});

test("readRun 将畸形 snapshot 报告为受控一致性错误", async () => {
  await withRunsDirectory(async (runsDirectory) => {
    const writer = openJournal(runId, { runsDirectory });
    await writer.commit(event, snapshot);
    writer.close();
    await writeFile(
      join(runsDirectory, runId, "snapshot.json"),
      JSON.stringify({ schemaVersion: 1, runId, actions: "invalid" }),
      "utf8",
    );

    assert.throws(
      () => readRun(runId, { runsDirectory }),
      /Journal 与 snapshot 不一致：snapshot 结构无效/,
    );
  });
});
