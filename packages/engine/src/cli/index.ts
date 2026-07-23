import { readRun } from "../journal/index.ts";
import { ExitCode, type ActionState } from "../protocol/index.ts";

const usage = `用法：dawn <command>

命令：
  target bootstrap
  target inspect
  target revoke
  plan
  apply
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

function fail(message: string): never {
  console.error(message);
  process.exit(ExitCode.ParamError);
}

function showRun(args: readonly string[]): void {
  const runOption = args.indexOf("--run");
  const runId = runOption === -1 ? undefined : args[runOption + 1];
  if (!runId || args.length !== 2 || runOption !== 0) {
    fail("用法：dawn run show --run <runId>");
  }

  try {
    const { snapshot } = readRun(runId);
    console.log(`Run ${runId}`);
    console.log(`Outcome: ${snapshot.outcome ?? "in-progress"}`);
    console.log("\nActions:");
    for (const action of snapshot.actions) {
      const error =
        action.state === "failed" && action.error ? `：${action.error}` : "";
      console.log(
        `  [${stateMarkers[action.state]}] ${action.actionId}  ${action.state}${error}`,
      );
    }
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT")
    ) {
      fail(`找不到或无法读取 Run：${runId}`);
    }
    throw error;
  }
}

function main(args: readonly string[]): void {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(usage);
    return;
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

  if (!command || !knownCommands.has(command)) {
    fail(`未知命令：${command ?? ""}`);
  }
  if (command === "run show") {
    showRun(args.slice(2));
    return;
  }

  console.error(`尚未实现：${command}`);
  process.exit(ExitCode.ParamError);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (
    error instanceof Error &&
    "exitCode" in error &&
    typeof error.exitCode === "number"
  ) {
    console.error(error.message);
    process.exit(error.exitCode);
  }
  throw error;
}
