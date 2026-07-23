import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import properLockfile from "proper-lockfile";

import {
  ExitCode,
  type ActionState,
  type RunEvent,
} from "../protocol/index.ts";

export interface RunSnapshot {
  schemaVersion: 1;
  runId: string;
  planHash: string;
  createdAt: string;
  updatedAt: string;
  actions: Array<{
    actionId: string;
    state: ActionState;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  }>;
  outcome?: "completed" | "stopped" | "in-progress";
}

export interface JournalWriter {
  commit(
    events: RunEvent | readonly RunEvent[],
    snapshot: RunSnapshot,
  ): Promise<void>;
  close(): void;
}

export interface JournalOptions {
  runsDirectory?: string;
}

interface PendingCommit {
  schemaVersion: 1;
  startOffset: number;
  byteLength: number;
  sha256: string;
}

export class JournalLockError extends Error {
  readonly exitCode = ExitCode.LockConflict;

  constructor(runId: string) {
    super(`Run ${runId} 已被其他写入方锁定。`);
    this.name = "JournalLockError";
  }
}

export class JournalConsistencyError extends Error {
  readonly exitCode = ExitCode.ParamError;

  constructor(message: string) {
    super(`Journal 与 snapshot 不一致：${message}`);
    this.name = "JournalConsistencyError";
  }
}

export class InvalidRunIdError extends Error {
  readonly exitCode = ExitCode.ParamError;

  constructor(runId: string) {
    super(`runId 无效：${runId}`);
    this.name = "InvalidRunIdError";
  }
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new InvalidRunIdError(runId);
  }
}

function getRunDirectory(runId: string, options?: JournalOptions): string {
  validateRunId(runId);
  const runsDirectory =
    options?.runsDirectory ?? join(homedir(), ".dawn-forge", "runs");
  return join(runsDirectory, runId);
}

function acquireJournalLock(
  runDirectory: string,
  lockPath: string,
  runId: string,
): () => void {
  try {
    return properLockfile.lockSync(runDirectory, {
      lockfilePath: lockPath,
      realpath: false,
      retries: 0,
      stale: 30_000,
      update: 10_000,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ELOCKED"
    ) {
      throw new JournalLockError(runId);
    }
    throw error;
  }
}

function recoverIncompleteJournalTail(journalPath: string): void {
  let content: Buffer;
  try {
    content = readFileSync(journalPath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }

  if (content.length === 0 || content[content.length - 1] === 0x0a) {
    return;
  }

  const lastNewline = content.lastIndexOf(0x0a);
  truncateSync(journalPath, lastNewline + 1);
  const descriptor = openSync(journalPath, constants.O_WRONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

function fsyncJournalAfterTruncate(journalPath: string, length: number): void {
  truncateSync(journalPath, length);
  const descriptor = openSync(journalPath, constants.O_WRONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parsePendingCommit(path: string): PendingCommit | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw new JournalConsistencyError("commit.pending 不是合法 JSON。");
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.startOffset) ||
    (value.startOffset as number) < 0 ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new JournalConsistencyError("commit.pending 结构无效。");
  }
  return value as unknown as PendingCommit;
}

function recoverInterruptedCommit(
  journalPath: string,
  pendingSnapshotPath: string,
  pendingCommitPath: string,
): boolean {
  const pendingCommit = parsePendingCommit(pendingCommitPath);
  if (!pendingCommit) {
    return false;
  }

  const journal = readJournalIfExists(journalPath);
  const expectedEnd = pendingCommit.startOffset + pendingCommit.byteLength;
  if (
    pendingCommit.startOffset > journal.length ||
    journal.length > expectedEnd
  ) {
    throw new JournalConsistencyError(
      "commit.pending 的 Journal offset 与实际文件不一致。",
    );
  }
  if (journal.length < expectedEnd) {
    fsyncJournalAfterTruncate(journalPath, pendingCommit.startOffset);
    unlinkIfExists(pendingSnapshotPath);
    unlinkSync(pendingCommitPath);
    return false;
  }

  const committedBytes = journal.subarray(pendingCommit.startOffset);
  const actualHash = createHash("sha256").update(committedBytes).digest("hex");
  if (actualHash !== pendingCommit.sha256) {
    throw new JournalConsistencyError(
      "commit.pending 记录的 Journal 内容 hash 不匹配。",
    );
  }
  return true;
}

function visibleJournalBytes(
  journal: Buffer,
  pendingCommitPath: string,
): Buffer {
  const pendingCommit = parsePendingCommit(pendingCommitPath);
  if (!pendingCommit) {
    return journal;
  }

  const expectedEnd = pendingCommit.startOffset + pendingCommit.byteLength;
  if (
    pendingCommit.startOffset > journal.length ||
    journal.length > expectedEnd
  ) {
    throw new JournalConsistencyError(
      "commit.pending 的 Journal offset 与实际文件不一致。",
    );
  }
  if (journal.length < expectedEnd) {
    return journal.subarray(0, pendingCommit.startOffset);
  }

  const committedBytes = journal.subarray(pendingCommit.startOffset);
  const actualHash = createHash("sha256").update(committedBytes).digest("hex");
  if (actualHash !== pendingCommit.sha256) {
    throw new JournalConsistencyError(
      "commit.pending 记录的 Journal 内容 hash 不匹配。",
    );
  }
  return journal;
}

function assertImmutableSnapshot(
  snapshotPath: string,
  nextSnapshot: RunSnapshot,
): void {
  const current = readSnapshotCandidate(snapshotPath);
  if (current.error) {
    throw current.error;
  }
  if (!current.snapshot) {
    return;
  }
  if (current.snapshot.planHash !== nextSnapshot.planHash) {
    throw new JournalConsistencyError("Run 的 planHash 不可变。");
  }
  if (current.snapshot.createdAt !== nextSnapshot.createdAt) {
    throw new JournalConsistencyError("Run 的 createdAt 不可变。");
  }
  const currentActionIds = current.snapshot.actions.map(
    (action) => action.actionId,
  );
  const nextActionIds = nextSnapshot.actions.map((action) => action.actionId);
  if (
    currentActionIds.length !== nextActionIds.length ||
    currentActionIds.some(
      (actionId, index) => actionId !== nextActionIds[index],
    )
  ) {
    throw new JournalConsistencyError(
      "Run 的 actionId 列表及顺序不可变。",
    );
  }
}

export function openJournal(
  runId: string,
  options?: JournalOptions,
): JournalWriter {
  const runDirectory = getRunDirectory(runId, options);
  const lockPath = join(runDirectory, "lock");
  const journalPath = join(runDirectory, "journal.jsonl");
  const snapshotPath = join(runDirectory, "snapshot.json");
  const pendingSnapshotPath = join(runDirectory, "snapshot.pending");
  const pendingCommitPath = join(runDirectory, "commit.pending");
  const pendingCommitTempPath = join(runDirectory, "commit.pending.tmp");

  mkdirSync(runDirectory, { recursive: true });

  const releaseJournalLock = acquireJournalLock(runDirectory, lockPath, runId);

  let journalDescriptor: number;
  try {
    unlinkIfExists(pendingCommitTempPath);
    recoverIncompleteJournalTail(journalPath);
    const interruptedCommitCompleted = recoverInterruptedCommit(
      journalPath,
      pendingSnapshotPath,
      pendingCommitPath,
    );
    recoverPendingSnapshot(
      runId,
      journalPath,
      snapshotPath,
      pendingSnapshotPath,
    );
    if (interruptedCommitCompleted) {
      unlinkSync(pendingCommitPath);
    }
    journalDescriptor = openSync(
      journalPath,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY,
      0o600,
    );
  } catch (error) {
    releaseJournalLock();
    throw error;
  }

  let closed = false;

  function assertOpen(): void {
    if (closed) {
      throw new Error(`Run ${runId} 的 Journal 已关闭。`);
    }
  }

  return {
    async commit(eventsToCommit, snapshot) {
      assertOpen();
      const committedEvents = Array.isArray(eventsToCommit)
        ? eventsToCommit
        : [eventsToCommit];
      if (committedEvents.length === 0) {
        throw new JournalConsistencyError("一次 commit 至少需要一个事件。");
      }
      for (const event of committedEvents) {
        if (event.runId !== runId) {
          throw new JournalConsistencyError(
            `事件 runId ${event.runId} 与 ${runId} 不同。`,
          );
        }
      }
      if (snapshot.runId !== runId) {
        throw new JournalConsistencyError(
          `snapshot runId ${snapshot.runId} 与 ${runId} 不同。`,
        );
      }

      const currentJournal = readFileSync(journalPath);
      const events = parseCommittedEvents(currentJournal);
      assertImmutableSnapshot(snapshotPath, snapshot);
      verifySnapshot(runId, snapshot, [...events, ...committedEvents]);

      const snapshotDescriptor = openSync(
        pendingSnapshotPath,
        constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY,
        0o600,
      );
      try {
        writeFileSync(snapshotDescriptor, JSON.stringify(snapshot, null, 2));
        fsyncSync(snapshotDescriptor);
      } finally {
        closeSync(snapshotDescriptor);
      }

      const journalBytes = Buffer.from(
        `${committedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
      const pendingCommit: PendingCommit = {
        schemaVersion: 1,
        startOffset: currentJournal.length,
        byteLength: journalBytes.length,
        sha256: createHash("sha256").update(journalBytes).digest("hex"),
      };
      const commitDescriptor = openSync(
        pendingCommitTempPath,
        constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY,
        0o600,
      );
      try {
        writeFileSync(commitDescriptor, JSON.stringify(pendingCommit));
        fsyncSync(commitDescriptor);
      } finally {
        closeSync(commitDescriptor);
      }
      renameSync(pendingCommitTempPath, pendingCommitPath);

      writeFileSync(journalDescriptor, journalBytes);
      fsyncSync(journalDescriptor);
      renameSync(pendingSnapshotPath, snapshotPath);
      unlinkSync(pendingCommitPath);
    },

    close() {
      if (closed) {
        return;
      }
      closed = true;
      closeSync(journalDescriptor);
      releaseJournalLock();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isActionState(value: unknown): value is ActionState {
  return (
    typeof value === "string" &&
    [
      "pending",
      "blocked",
      "running",
      "succeeded",
      "skipped",
      "failed",
      "needs_user",
    ].includes(value)
  );
}

function parseSnapshot(content: string): RunSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new JournalConsistencyError("snapshot 不是合法 JSON。");
  }

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.runId !== "string" ||
    typeof value.planHash !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(value.actions) ||
    !value.actions.every(
      (action) =>
        isRecord(action) &&
        typeof action.actionId === "string" &&
        isActionState(action.state) &&
        (action.startedAt === undefined ||
          typeof action.startedAt === "string") &&
        (action.finishedAt === undefined ||
          typeof action.finishedAt === "string") &&
        (action.error === undefined || typeof action.error === "string"),
    ) ||
    (value.outcome !== undefined &&
      !["completed", "stopped", "in-progress"].includes(
        value.outcome as string,
      ))
  ) {
    throw new JournalConsistencyError("snapshot 结构无效。");
  }

  const actionIds = value.actions.map(
    (action) => (action as { readonly actionId: string }).actionId,
  );
  if (new Set(actionIds).size !== actionIds.length) {
    throw new JournalConsistencyError("snapshot 包含重复的 actionId。");
  }

  return value as unknown as RunSnapshot;
}

function parseEvent(value: unknown, lineNumber: number): RunEvent {
  if (
    !isRecord(value) ||
    typeof value.timestamp !== "string" ||
    typeof value.runId !== "string" ||
    !isRecord(value.event) ||
    typeof value.event.type !== "string"
  ) {
    throw new JournalConsistencyError(
      `journal 第 ${lineNumber} 行结构无效。`,
    );
  }

  const event = value.event;
  const eventType = event.type as string;
  const hasActionMessage =
    typeof event.actionId === "string" && typeof event.message === "string";
  const valid =
    eventType === "run-started" ||
    (["action-started", "action-succeeded", "action-skipped"].includes(
      eventType,
    ) &&
      hasActionMessage) ||
    (eventType === "action-failed" &&
      hasActionMessage &&
      typeof event.critical === "boolean") ||
    (eventType === "action-blocked" &&
      typeof event.actionId === "string" &&
      typeof event.reason === "string") ||
    (eventType === "needs-user" &&
      typeof event.actionId === "string" &&
      typeof event.instruction === "string") ||
    (eventType === "run-completed" && typeof event.summary === "string") ||
    (eventType === "run-stopped" && typeof event.reason === "string");
  if (!valid) {
    throw new JournalConsistencyError(
      `journal 第 ${lineNumber} 行事件无效。`,
    );
  }

  return value as unknown as RunEvent;
}

function parseCommittedEvents(journal: Buffer): RunEvent[] {
  const committedLength =
    journal.length === 0 || journal[journal.length - 1] === 0x0a
      ? journal.length
      : journal.lastIndexOf(0x0a) + 1;
  if (committedLength === 0) {
    return [];
  }

  return journal
    .subarray(0, committedLength)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new JournalConsistencyError(
          `journal 第 ${index + 1} 行不是合法 JSON。`,
        );
      }
      return parseEvent(value, index + 1);
    });
}

function verifySnapshot(
  runId: string,
  snapshot: RunSnapshot,
  events: readonly RunEvent[],
): void {
  if (snapshot.runId !== runId) {
    throw new JournalConsistencyError(
      `snapshot runId ${snapshot.runId} 与目录 ${runId} 不同。`,
    );
  }

  const replayedStates = new Map<string, ActionState>();
  let replayedOutcome: RunSnapshot["outcome"];
  let waitingForCriticalStop = false;

  function transition(
    actionId: string,
    nextState: ActionState,
    allowedStates: readonly ActionState[],
  ): void {
    const currentState = replayedStates.get(actionId) ?? "pending";
    if (!allowedStates.includes(currentState)) {
      throw new JournalConsistencyError(
        `Action ${actionId} 不能从 ${currentState} 转为 ${nextState}。`,
      );
    }
    replayedStates.set(actionId, nextState);
  }

  for (const item of events) {
    if (item.runId !== runId) {
      throw new JournalConsistencyError(
        `事件 runId ${item.runId} 与目录 ${runId} 不同。`,
      );
    }

    if (replayedOutcome) {
      if (replayedOutcome === "stopped" && item.event.type === "run-started") {
        replayedOutcome = undefined;
        continue;
      }
      throw new JournalConsistencyError(
        `Run 已进入 ${replayedOutcome}，只能从 stopped 恢复。`,
      );
    }
    if (waitingForCriticalStop && item.event.type !== "run-stopped") {
      throw new JournalConsistencyError(
        "critical 失败后必须立即停止 Run。",
      );
    }

    switch (item.event.type) {
      case "action-started":
        transition(item.event.actionId, "running", [
          "pending",
          "failed",
          "blocked",
        ]);
        break;
      case "action-succeeded":
        transition(item.event.actionId, "succeeded", [
          "running",
          "needs_user",
          "succeeded",
        ]);
        break;
      case "action-skipped":
        transition(item.event.actionId, "skipped", ["running"]);
        break;
      case "action-failed":
        transition(item.event.actionId, "failed", ["running", "succeeded"]);
        waitingForCriticalStop = item.event.critical;
        break;
      case "action-blocked":
        transition(item.event.actionId, "blocked", ["pending"]);
        break;
      case "needs-user":
        transition(item.event.actionId, "needs_user", [
          "running",
          "needs_user",
        ]);
        break;
      case "run-completed":
        if (replayedOutcome) {
          throw new JournalConsistencyError("Run 存在多个终态事件。");
        }
        replayedOutcome = "completed";
        break;
      case "run-stopped":
        if (replayedOutcome) {
          throw new JournalConsistencyError("Run 存在多个终态事件。");
        }
        waitingForCriticalStop = false;
        replayedOutcome = "stopped";
        break;
      case "run-started":
        break;
    }
  }
  if (waitingForCriticalStop) {
    throw new JournalConsistencyError("critical 失败后必须立即停止 Run。");
  }

  const snapshotStates = new Map(
    snapshot.actions.map((action) => [action.actionId, action.state]),
  );
  for (const [actionId, state] of replayedStates) {
    if (snapshotStates.get(actionId) !== state) {
      throw new JournalConsistencyError(
        `Action ${actionId} 重放为 ${state}，snapshot 为 ${
          snapshotStates.get(actionId) ?? "missing"
        }。`,
      );
    }
  }
  for (const action of snapshot.actions) {
    if (
      !replayedStates.has(action.actionId) &&
      action.state !== "pending"
    ) {
      throw new JournalConsistencyError(
        `Action ${action.actionId} 在 Journal 中没有状态事件，snapshot 为 ${action.state}。`,
      );
    }
  }
  if (replayedOutcome && snapshot.outcome !== replayedOutcome) {
    throw new JournalConsistencyError(
      `Run 重放为 ${replayedOutcome}，snapshot 为 ${
        snapshot.outcome ?? "missing"
      }。`,
    );
  }
  if (
    !replayedOutcome &&
    snapshot.outcome !== undefined &&
    snapshot.outcome !== "in-progress"
  ) {
    throw new JournalConsistencyError(
      `Journal 中没有终态事件，snapshot 为 ${snapshot.outcome}。`,
    );
  }
}

interface SnapshotCandidate {
  readonly exists: boolean;
  readonly snapshot?: RunSnapshot;
  readonly error?: JournalConsistencyError;
}

function readSnapshotCandidate(path: string): SnapshotCandidate {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { exists: false };
    }
    throw error;
  }

  try {
    return { exists: true, snapshot: parseSnapshot(content) };
  } catch (error) {
    if (error instanceof JournalConsistencyError) {
      return { exists: true, error };
    }
    throw error;
  }
}

function snapshotMatchesJournal(
  runId: string,
  snapshot: RunSnapshot,
  events: readonly RunEvent[],
): boolean {
  try {
    verifySnapshot(runId, snapshot, events);
    return true;
  } catch (error) {
    if (error instanceof JournalConsistencyError) {
      return false;
    }
    throw error;
  }
}

function selectConsistentSnapshot(
  runId: string,
  snapshotPath: string,
  pendingSnapshotPath: string,
  events: readonly RunEvent[],
): {
  readonly source: "current" | "pending";
  readonly snapshot: RunSnapshot;
  readonly pendingExists: boolean;
} | undefined {
  const pending = readSnapshotCandidate(pendingSnapshotPath);
  const current = readSnapshotCandidate(snapshotPath);

  if (
    pending.snapshot &&
    snapshotMatchesJournal(runId, pending.snapshot, events)
  ) {
    return {
      source: "pending",
      snapshot: pending.snapshot,
      pendingExists: true,
    };
  }
  if (
    current.snapshot &&
    snapshotMatchesJournal(runId, current.snapshot, events)
  ) {
    return {
      source: "current",
      snapshot: current.snapshot,
      pendingExists: pending.exists,
    };
  }
  if (!current.exists && !pending.exists && events.length === 0) {
    return undefined;
  }

  throw (
    pending.error ??
    current.error ??
    new JournalConsistencyError(
      "current 和 pending snapshot 均无法匹配 Journal。",
    )
  );
}

function readJournalIfExists(journalPath: string): Buffer {
  try {
    return readFileSync(journalPath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return Buffer.alloc(0);
    }
    throw error;
  }
}

function recoverPendingSnapshot(
  runId: string,
  journalPath: string,
  snapshotPath: string,
  pendingSnapshotPath: string,
): void {
  const events = parseCommittedEvents(readJournalIfExists(journalPath));
  let selected:
    | ReturnType<typeof selectConsistentSnapshot>
    | undefined;
  try {
    selected = selectConsistentSnapshot(
      runId,
      snapshotPath,
      pendingSnapshotPath,
      events,
    );
  } catch (error) {
    const current = readSnapshotCandidate(snapshotPath);
    const pending = readSnapshotCandidate(pendingSnapshotPath);
    if (!current.exists && pending.exists && events.length === 0) {
      unlinkSync(pendingSnapshotPath);
      return;
    }
    throw error;
  }

  if (selected?.source === "pending") {
    renameSync(pendingSnapshotPath, snapshotPath);
  } else if (selected?.pendingExists) {
    unlinkSync(pendingSnapshotPath);
  }
}

export function readRun(
  runId: string,
  options?: JournalOptions,
): { snapshot: RunSnapshot; events: RunEvent[] } {
  const runDirectory = getRunDirectory(runId, options);
  const snapshotPath = join(runDirectory, "snapshot.json");
  const pendingSnapshotPath = join(runDirectory, "snapshot.pending");
  const journalPath = join(runDirectory, "journal.jsonl");
  const pendingCommitPath = join(runDirectory, "commit.pending");
  let lastConsistencyError: JournalConsistencyError | undefined;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const journalBefore = readFileSync(journalPath);
    const events = parseCommittedEvents(
      visibleJournalBytes(journalBefore, pendingCommitPath),
    );
    try {
      const selected = selectConsistentSnapshot(
        runId,
        snapshotPath,
        pendingSnapshotPath,
        events,
      );
      const journalAfter = readFileSync(journalPath);
      if (!journalBefore.equals(journalAfter)) {
        continue;
      }
      if (!selected) {
        throw new JournalConsistencyError("Run 尚无已提交的 snapshot。");
      }
      return { snapshot: selected.snapshot, events };
    } catch (error) {
      if (!(error instanceof JournalConsistencyError)) {
        throw error;
      }
      lastConsistencyError = error;
      const journalAfter = readFileSync(journalPath);
      if (!journalBefore.equals(journalAfter)) {
        continue;
      }
    }
  }

  throw (
    lastConsistencyError ??
    new JournalConsistencyError("无法读取稳定的 Journal 与 snapshot 视图。")
  );
}
