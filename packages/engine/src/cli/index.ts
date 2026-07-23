import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  executePlan,
  NodeProviderSshExecutor,
  readApprovedPlan,
  type ExecutePlanResult,
} from "../executor/index.ts";
import { readRun } from "../journal/index.ts";
import {
  planFromFiles,
  writePlanAtomic,
} from "../planner/index.ts";
import {
  ExitCode,
  type ActionState,
  type Plan,
  type RunEvent,
  type Target,
} from "../protocol/index.ts";
import {
  createTargetManager,
  type BootstrapTargetInput,
  IdentityConflictError,
  type TargetManager,
} from "../target/index.ts";

const usage = `用法：dawn <command>

命令：
  target bootstrap --host <host> --user <user> --name <name>
  target inspect --target <id>
  target revoke --target <id>
  plan --target <id> --profile <path> --out <path>
  apply --plan <path> --approve <sha256> [--format jsonl]
  run show --run <runId>
  resume
  verify`;

const stateMarkers: Record<ActionState, string> = {
  succeeded: "✓",
  skipped: "-",
  failed: "✗",
  blocked: "~",
  pending: " ",
  running: ">",
  needs_user: "?",
};

interface TargetCommands {
  bootstrap(input: BootstrapTargetInput): Promise<Target>;
  inspect(targetId: string): Promise<Target>;
  withVerifiedTarget?<T>(
    targetId: string,
    operation: (target: Target) => Promise<T>,
  ): Promise<T>;
  revoke(targetId: string): Promise<void>;
}

interface CliDependencies {
  readonly targetManager?: TargetCommands;
  readonly planBuilder?: {
    create(input: {
      readonly targetId: string;
      readonly profilePath: string;
    }): Promise<Plan>;
  };
  readonly applyExecutor?: (input: {
    readonly plan: Plan;
    readonly emit: (event: RunEvent) => void;
  }) => Promise<ExecutePlanResult>;
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
}

function parseOptions(
  args: readonly string[],
  allowed: ReadonlySet<string>,
): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      !option?.startsWith("--") ||
      !allowed.has(option) ||
      !value ||
      value.startsWith("--") ||
      options.has(option)
    ) {
      throw new Error("参数无效。");
    }
    options.set(option, value);
  }
  return options;
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) {
    throw new Error(`缺少参数：${name}`);
  }
  return value;
}

function showRun(
  args: readonly string[],
  stdout: (message: string) => void,
): void {
  const options = parseOptions(args, new Set(["--run"]));
  const runId = requiredOption(options, "--run");
  const { snapshot } = readRun(runId);
  stdout(`Run ${runId}`);
  stdout(`Outcome: ${snapshot.outcome ?? "in-progress"}`);
  stdout("\nActions:");
  for (const action of snapshot.actions) {
    const error =
      action.state === "failed" && action.error ? `：${action.error}` : "";
    stdout(
      `  [${stateMarkers[action.state]}] ${action.actionId}  ${action.state}${error}`,
    );
  }
}

function targetSummary(target: Target): string {
  return [
    `Target ${target.targetId}`,
    `  name: ${target.displayName}`,
    `  platform: ${target.platform}`,
    `  machineId: ${target.identityEvidence.machineId}`,
    `  architecture: ${target.identityEvidence.architecture}`,
    `  remoteUser: ${target.identityEvidence.remoteUser}`,
    `  hostKey: ${target.identityEvidence.sshHostKeyFingerprint}`,
    `  targetFingerprint: ${target.targetFingerprint}`,
  ].join("\n");
}

function emitRunEvent(
  event: RunEvent,
  format: "human" | "jsonl",
  stdout: (message: string) => void,
): void {
  if (format === "jsonl") {
    stdout(JSON.stringify(event));
    return;
  }
  switch (event.event.type) {
    case "run-started":
      stdout(`Run ${event.runId}`);
      break;
    case "action-started":
    case "action-succeeded":
    case "action-skipped":
    case "action-failed":
      stdout(`${event.event.actionId}: ${event.event.message}`);
      break;
    case "action-blocked":
      stdout(`${event.event.actionId}: ${event.event.reason}`);
      break;
    case "needs-user":
      stdout(`${event.event.actionId}: ${event.event.instruction}`);
      break;
    case "run-completed":
      stdout(event.event.summary);
      break;
    case "run-stopped":
      stdout(event.event.reason);
      break;
  }
}

async function confirmAuthorizationCommand(
  command: string,
  stdout: (message: string) => void,
): Promise<boolean> {
  stdout("请在控制机终端执行以下命令，将受限公钥写入目标机：");
  stdout(command);
  if (process.env.DAWN_AUTO_CONFIRM === "1") {
    return true;
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await readline.question(
      "命令成功完成后输入 yes 继续：",
    );
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

function defaultTargetManager(
  stdout: (message: string) => void,
): TargetManager {
  return createTargetManager({
    authorize: (command) => confirmAuthorizationCommand(command, stdout),
  });
}

export function resolveCatalogDirectory(
  entryPath = process.argv[1],
): string {
  if (process.env.DAWN_CATALOG_DIRECTORY) {
    return resolve(process.env.DAWN_CATALOG_DIRECTORY);
  }
  const entryDirectory = dirname(
    resolve(entryPath ?? fileURLToPath(import.meta.url)),
  );
  const candidates = [
    join(entryDirectory, "..", "catalog"),
    join(entryDirectory, "..", "..", "..", "catalog"),
  ].map((path) => resolve(path));
  return (
    candidates.find((path) =>
      existsSync(join(path, "catalog.schema.json")),
    ) ?? candidates[0]
  );
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  try {
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
      stdout(usage);
      return ExitCode.Success;
    }

    const command =
      args[0] === "target" || args[0] === "run"
        ? `${args[0]} ${args[1] ?? ""}`.trim()
        : args[0];
    const knownCommands = new Set([
      "target bootstrap",
      "target inspect",
      "target revoke",
      "plan",
      "apply",
      "run show",
      "resume",
      "verify",
    ]);
    if (!knownCommands.has(command)) {
      stderr(`未知命令：${command}`);
      return ExitCode.ParamError;
    }
    if (command === "run show") {
      try {
        showRun(args.slice(2), stdout);
        return ExitCode.Success;
      } catch (error) {
        if (
          error instanceof SyntaxError ||
          (error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT")
        ) {
          stderr(
            `找不到或无法读取 Run：${
              args[args.indexOf("--run") + 1] ?? ""
            }`,
          );
          return ExitCode.ParamError;
        }
        throw error;
      }
    }

    if (command.startsWith("target ")) {
      const targetManager =
        dependencies.targetManager ?? defaultTargetManager(stdout);
      if (command === "target bootstrap") {
        const options = parseOptions(
          args.slice(2),
          new Set(["--host", "--user", "--name"]),
        );
        const target = await targetManager.bootstrap({
          host: requiredOption(options, "--host"),
          user: requiredOption(options, "--user"),
          name: requiredOption(options, "--name"),
        });
        stdout(targetSummary(target));
        return ExitCode.Success;
      }
      const options = parseOptions(args.slice(2), new Set(["--target"]));
      const targetId = requiredOption(options, "--target");
      if (command === "target inspect") {
        stdout(targetSummary(await targetManager.inspect(targetId)));
      } else {
        await targetManager.revoke(targetId);
        stdout(`已撤销 Target ${targetId}：远端公钥和本地记录均已删除。`);
      }
      return ExitCode.Success;
    }

    if (command === "plan") {
      const options = parseOptions(
        args.slice(1),
        new Set(["--target", "--profile", "--out"]),
      );
      const targetId = requiredOption(options, "--target");
      const profilePath = requiredOption(options, "--profile");
      const outputPath = requiredOption(options, "--out");
      const plan = dependencies.planBuilder
        ? await dependencies.planBuilder.create({
            targetId,
            profilePath,
          })
        : await (async () => {
            const homeDirectory = homedir();
            const manager =
              dependencies.targetManager ?? defaultTargetManager(stdout);
            const buildPlan = (target: Target) =>
              planFromFiles({
                target,
                homeDirectory,
                profilePath,
                catalogDirectory: resolveCatalogDirectory(),
              });
            return manager.withVerifiedTarget
              ? manager.withVerifiedTarget(targetId, buildPlan)
              : buildPlan(await manager.inspect(targetId));
          })();
      writePlanAtomic(outputPath, plan);
      stdout(plan.planHash);
      return ExitCode.Success;
    }

    if (command === "apply") {
      const options = parseOptions(
        args.slice(1),
        new Set(["--plan", "--approve", "--format"]),
      );
      const plan = readApprovedPlan(
        requiredOption(options, "--plan"),
        requiredOption(options, "--approve"),
      );
      const requestedFormat = options.get("--format");
      if (requestedFormat !== undefined && requestedFormat !== "jsonl") {
        throw new Error("--format 仅支持 jsonl。");
      }
      const format = requestedFormat === "jsonl" ? "jsonl" : "human";
      const emit = (event: RunEvent) => emitRunEvent(event, format, stdout);
      const result = dependencies.applyExecutor
        ? await dependencies.applyExecutor({ plan, emit })
        : await (async () => {
            const homeDirectory = homedir();
            const manager =
              dependencies.targetManager ?? defaultTargetManager(stdout);
            const applyToTarget = async (target: Target) => {
              if (target.targetFingerprint !== plan.spec.targetFingerprint) {
                throw new IdentityConflictError(["targetFingerprint"]);
              }
              return executePlan({
                plan,
                ssh: new NodeProviderSshExecutor(
                  join(
                    homeDirectory,
                    ".dawn-forge",
                    "targets",
                    target.targetId,
                    "ssh_config",
                  ),
                  target.locators.sshAlias,
                ),
                emit,
              });
            };
            return manager.withVerifiedTarget
              ? manager.withVerifiedTarget(plan.spec.targetId, applyToTarget)
              : applyToTarget(await manager.inspect(plan.spec.targetId));
          })();
      return result.exitCode;
    }

    stderr(`尚未实现：${command}`);
    return ExitCode.ParamError;
  } catch (error) {
    if (
      error instanceof Error &&
      "exitCode" in error &&
      typeof error.exitCode === "number"
    ) {
      stderr(error.message);
      return error.exitCode;
    }
    if (error instanceof Error) {
      stderr(error.message);
      return ExitCode.ParamError;
    }
    throw error;
  }
}

const entryPath = process.argv[1]
  ? pathToFileURL(resolveEntryPath(process.argv[1])).href
  : undefined;
if (entryPath === import.meta.url) {
  runCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}

function resolveEntryPath(path: string): string {
  return resolve(path);
}
