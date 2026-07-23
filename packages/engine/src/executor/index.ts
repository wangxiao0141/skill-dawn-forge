import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  openJournal,
  type RunSnapshot,
} from "../journal/index.ts";
import { getProvider } from "../providers/index.ts";
import type { SshExecutor } from "../providers/interface.ts";
import {
  computePlanHash,
  ExitCode,
  type Action,
  type ActionState,
  type Plan,
  type RunEvent,
} from "../protocol/index.ts";
import { writePlanAtomic } from "../planner/index.ts";

export class PlanApprovalError extends Error {
  readonly exitCode = ExitCode.PlanInvalid;

  constructor(message: string) {
    super(message);
    this.name = "PlanApprovalError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new PlanApprovalError(`${label} 包含未知或缺失字段。`);
  }
}

export function parsePlan(value: unknown): Plan {
  if (!isRecord(value)) {
    throw new PlanApprovalError("Plan 结构无效。");
  }
  assertExactKeys(value, ["spec", "planHash", "createdAt"], "Plan");
  if (
    !isRecord(value.spec) ||
    typeof value.planHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.planHash) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new PlanApprovalError("Plan 结构无效。");
  }
  const spec = value.spec;
  assertExactKeys(
    spec,
    [
      "engineVersion",
      "catalogVersion",
      "targetId",
      "targetFingerprint",
      "profileHash",
      "actions",
    ],
    "Plan spec",
  );
  if (
    spec.engineVersion !== "1" ||
    typeof spec.catalogVersion !== "string" ||
    !/^v[0-9]+$/.test(spec.catalogVersion) ||
    typeof spec.targetId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(spec.targetId) ||
    typeof spec.targetFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(spec.targetFingerprint) ||
    typeof spec.profileHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(spec.profileHash) ||
    !Array.isArray(spec.actions)
  ) {
    throw new PlanApprovalError("Plan spec 结构无效。");
  }
  const seen = new Set<string>();
  for (const candidate of spec.actions) {
    if (!isRecord(candidate)) {
      throw new PlanApprovalError("Plan Action 结构无效。");
    }
    assertExactKeys(
      candidate,
      [
        "actionId",
        "type",
        "packageId",
        "provider",
        "params",
        "critical",
        "dependsOn",
      ],
      "Plan Action",
    );
    if (
      typeof candidate.actionId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.actionId) ||
      seen.has(candidate.actionId) ||
      !["install", "skip", "conflict", "manual"].includes(
        String(candidate.type),
      ) ||
      typeof candidate.packageId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate.packageId) ||
      typeof candidate.provider !== "string" ||
      !isRecord(candidate.params) ||
      typeof candidate.critical !== "boolean" ||
      !Array.isArray(candidate.dependsOn) ||
      candidate.dependsOn.some(
        (dependency) =>
          typeof dependency !== "string" || !seen.has(dependency),
      ) ||
      new Set(candidate.dependsOn).size !== candidate.dependsOn.length
    ) {
      throw new PlanApprovalError(
        "Plan Action 无效、未拓扑排序或依赖不存在。",
      );
    }
    try {
      getProvider(candidate.provider);
    } catch {
      throw new PlanApprovalError(
        `Plan Action 使用未知 provider：${candidate.provider}`,
      );
    }
    seen.add(candidate.actionId);
  }
  return value as unknown as Plan;
}

export function readApprovedPlan(path: string, approval: string): Plan {
  if (!/^[0-9a-f]{64}$/.test(approval)) {
    throw new PlanApprovalError("--approve 必须是 64 位小写 SHA-256。");
  }
  const resolvedPath = resolve(path);
  const stat = lstatSync(resolvedPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new PlanApprovalError("Plan 必须是 regular file。");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch {
    throw new PlanApprovalError("Plan 不是合法 JSON。");
  }
  const plan = parsePlan(value);
  const computed = computePlanHash(plan.spec);
  if (computed !== plan.planHash || computed !== approval) {
    throw new PlanApprovalError(
      `Plan hash 不匹配；实际为 ${computed}。`,
    );
  }
  return plan;
}

export class NodeProviderSshExecutor implements SshExecutor {
  readonly #configPath: string;
  readonly #alias: string;
  readonly #ssh: string;

  constructor(
    configPath: string,
    alias: string,
    ssh = process.env.DAWN_SSH ?? "ssh",
  ) {
    this.#configPath = configPath;
    this.#alias = alias;
    this.#ssh = ssh;
  }

  async run(
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolvePromise) => {
      execFile(
        this.#ssh,
        ["-F", this.#configPath, this.#alias, command],
        {
          encoding: "utf8",
          timeout: 2 * 60 * 60 * 1000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const exitCode =
            error && "code" in error && typeof error.code === "number"
              ? error.code
              : error
                ? 1
                : 0;
          resolvePromise({ stdout, stderr, exitCode });
        },
      );
    });
  }
}

interface ExecutePlanOptions {
  readonly plan: Plan;
  readonly ssh: SshExecutor;
  readonly runsDirectory?: string;
  readonly runId?: string;
  readonly now?: () => Date;
  readonly emit?: (event: RunEvent) => void;
}

export interface ExecutePlanResult {
  readonly runId: string;
  readonly exitCode: number;
  readonly events: readonly RunEvent[];
}

function descendants(
  failedActionId: string,
  actions: readonly Action[],
): Set<string> {
  const result = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const action of actions) {
      if (
        !result.has(action.actionId) &&
        action.dependsOn.some(
          (dependency) =>
            dependency === failedActionId || result.has(dependency),
        )
      ) {
        result.add(action.actionId);
        changed = true;
      }
    }
  }
  return result;
}

export async function executePlan(
  options: ExecutePlanOptions,
): Promise<ExecutePlanResult> {
  const plan = parsePlan(options.plan);
  const computedHash = computePlanHash(plan.spec);
  if (computedHash !== plan.planHash) {
    throw new PlanApprovalError("执行前 Plan hash 已变化。");
  }
  const now = options.now ?? (() => new Date());
  const runId =
    options.runId ??
    `run-${now().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID()}`;
  const runsDirectory =
    options.runsDirectory ?? join(homedir(), ".dawn-forge", "runs");
  const journal = openJournal(runId, { runsDirectory });
  const events: RunEvent[] = [];
  const createdAt = now().toISOString();
  const states = new Map<string, ActionState>(
    plan.spec.actions.map((action) => [action.actionId, "pending"]),
  );
  const timestamps = new Map<
    string,
    { startedAt?: string; finishedAt?: string; error?: string }
  >();
  let outcome: RunSnapshot["outcome"] = "in-progress";

  const snapshot = (): RunSnapshot => ({
    schemaVersion: 1,
    runId,
    planHash: plan.planHash,
    createdAt,
    updatedAt: now().toISOString(),
    actions: plan.spec.actions.map((action) => ({
      actionId: action.actionId,
      state: states.get(action.actionId) ?? "pending",
      ...timestamps.get(action.actionId),
    })),
    outcome,
  });
  const commit = async (
    values: RunEvent | readonly RunEvent[],
  ): Promise<void> => {
    const list = Array.isArray(values) ? values : [values];
    await journal.commit(list, snapshot());
    for (const event of list) {
      events.push(event);
      options.emit?.(event);
    }
  };
  const makeEvent = (event: RunEvent["event"]): RunEvent => ({
    timestamp: now().toISOString(),
    runId,
    event,
  });

  let sawFailure = false;
  try {
    writePlanAtomic(join(runsDirectory, runId, "plan.json"), plan);
    await commit(makeEvent({ type: "run-started" }));

    while (true) {
      const action = plan.spec.actions.find(
        (candidate) =>
          states.get(candidate.actionId) === "pending" &&
          candidate.dependsOn.every(
            (dependency) => states.get(dependency) === "succeeded",
          ),
      );
      if (!action) {
        break;
      }
      const startedAt = now().toISOString();
      states.set(action.actionId, "running");
      timestamps.set(action.actionId, { startedAt });
      await commit(
        makeEvent({
          type: "action-started",
          actionId: action.actionId,
          message: `开始处理 ${action.packageId}`,
        }),
      );

      if (action.type === "manual") {
        states.set(action.actionId, "needs_user");
        await commit(
          makeEvent({
            type: "needs-user",
            actionId: action.actionId,
            instruction: `请手动完成 ${action.packageId} 后运行 dawn resume。`,
          }),
        );
        return {
          runId,
          exitCode: ExitCode.NeedsUser,
          events,
        };
      }

      let operationError: unknown;
      let wasAlreadyInstalled = false;
      try {
        if (action.type === "conflict") {
          throw new Error(`${action.packageId} 存在无法自动处理的冲突。`);
        }
        const provider = getProvider(action.provider);
        const check = await provider.check(action.params, options.ssh);
        wasAlreadyInstalled = check.installed;
        if (!check.installed) {
          if (action.type === "skip") {
            throw new Error(`${action.packageId} 不再满足 skip 条件。`);
          }
          await provider.apply(action.params, options.ssh);
          await provider.verify(action.params, options.ssh);
        }
      } catch (error) {
        operationError = error;
      }

      if (operationError === undefined) {
        const finishedAt = now().toISOString();
        states.set(action.actionId, "succeeded");
        timestamps.set(action.actionId, { startedAt, finishedAt });
        await commit(
          makeEvent({
            type: "action-succeeded",
            actionId: action.actionId,
            message: wasAlreadyInstalled
              ? `${action.packageId} 已满足，无需修改。`
              : `${action.packageId} 已安装并验证。`,
          }),
        );
        continue;
      }

      sawFailure = true;
      const message =
        operationError instanceof Error
          ? operationError.message
          : String(operationError);
      const finishedAt = now().toISOString();
      states.set(action.actionId, "failed");
      timestamps.set(action.actionId, {
        startedAt,
        finishedAt,
        error: message,
      });
      const failure = makeEvent({
        type: "action-failed",
        actionId: action.actionId,
        message,
        critical: action.critical,
      });
      if (action.critical) {
        outcome = "stopped";
        await commit([
          failure,
          makeEvent({
            type: "run-stopped",
            reason: `关键 Action ${action.actionId} 失败。`,
          }),
        ]);
        return {
          runId,
          exitCode: ExitCode.ActionFailed,
          events,
        };
      }
      const blockedEvents: RunEvent[] = [];
      for (const blockedId of descendants(
        action.actionId,
        plan.spec.actions,
      )) {
        if (states.get(blockedId) !== "pending") {
          continue;
        }
        states.set(blockedId, "blocked");
        timestamps.set(blockedId, {
          finishedAt,
          error: `依赖 ${action.actionId} 失败。`,
        });
        blockedEvents.push(
          makeEvent({
            type: "action-blocked",
            actionId: blockedId,
            reason: `依赖 ${action.actionId} 失败。`,
          }),
        );
      }
      await commit([failure, ...blockedEvents]);
    }

    const pending = [...states.values()].some(
      (state) => state === "pending",
    );
    if (pending) {
      throw new PlanApprovalError("Plan 没有可执行的就绪 Action。");
    }
    outcome = "completed";
    await commit(
      makeEvent({
        type: "run-completed",
        summary: sawFailure ? "Run 完成，但存在部分失败。" : "Run 成功完成。",
      }),
    );
    return {
      runId,
      exitCode: sawFailure ? ExitCode.ActionFailed : ExitCode.Success,
      events,
    };
  } finally {
    journal.close();
  }
}
