import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { InspectorSshExecutor } from "../inspector/index.ts";
import { readRun } from "../journal/index.ts";
import type { Plan } from "../protocol/index.ts";
import type { SshExecutor } from "../providers/interface.ts";
import {
  TargetManager,
  type ControllerKey,
  type SshTargetAdapter,
  type TargetConnection,
  type TargetProbe,
} from "../target/index.ts";
import { runCli } from "./index.ts";

const controllerKey: ControllerKey = {
  privateKeyPath: "/controller/.ssh/id_ed25519",
  publicKeyPath: "/controller/.ssh/id_ed25519.pub",
  publicKeyLine: "ssh-ed25519 AAAASMOKE controller",
  publicKeyBlob: "AAAASMOKE",
};

const targetProbe: TargetProbe = {
  platform: "macos",
  identityEvidence: {
    sshHostKeyFingerprint: "SHA256:smoke-host",
    machineId: "11111111-2222-3333-4444-555555555555",
    architecture: "arm64",
    remoteUser: "tester",
  },
};

class MockTargetSsh implements SshTargetAdapter {
  authorizationCommand(
    connection: TargetConnection,
    authorizedKeyLine: string,
  ): string {
    return `authorize ${connection.host} ${authorizedKeyLine}`;
  }

  async probe(connection: TargetConnection): Promise<TargetProbe> {
    if (!existsSync(connection.knownHostsPath)) {
      writeFileSync(connection.knownHostsPath, "known-host\n", "utf8");
    }
    return targetProbe;
  }

  async verifyAuthorization(): Promise<void> {}
  async rollbackAuthorization(): Promise<void> {}
  async revoke(): Promise<void> {}
}

class MockInspectorSsh implements InspectorSshExecutor {
  async run(): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    return {
      stdout: [
        "__DAWN_FORGE_INSPECTOR_V1__",
        "tester",
        "97656250",
        "BREW:1",
        "Homebrew 4.4.0",
        "__CASKS__",
        "__GIT__",
        "GIT:0",
        "",
        "__GIT_NAME__",
        "__GIT_EMAIL__",
        "",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    };
  }
}

class MockProviderSsh implements SshExecutor {
  readonly #responses = [
    { stdout: "Homebrew 4.4.0\n", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 1 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "node 24.0.0\n", stderr: "", exitCode: 0 },
  ];

  async run(): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const response = this.#responses.shift();
    assert.ok(response, "mock Provider SSH 响应不足");
    return response;
  }
}

test("mock SSH 完成真实 bootstrap → plan → apply → run show 并拒绝篡改 Plan", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "dawn-smoke-"));
  try {
    const runsDirectory = join(homeDirectory, ".dawn-forge", "runs");
    const profilePath = join(homeDirectory, "profile.json");
    const planPath = join(homeDirectory, "plan.json");
    await writeFile(
      profilePath,
      JSON.stringify({
        schemaVersion: 1,
        platform: "macos",
        catalogVersion: "v1",
        packages: [{ id: "node", state: "present" }],
      }),
      "utf8",
    );
    const manager = new TargetManager({
      homeDirectory,
      now: () => new Date("2026-07-23T12:00:00.000Z"),
      keyProvider: {
        async load() {
          return controllerKey;
        },
        async ensure() {
          return controllerKey;
        },
      },
      ssh: new MockTargetSsh(),
      authorize: async () => true,
    });
    const output: string[] = [];
    const dependencies = {
      targetManager: manager,
      homeDirectory,
      catalogDirectory: resolve("..", "..", "catalog"),
      inspectorSsh: new MockInspectorSsh(),
      providerSsh: new MockProviderSsh(),
      runsDirectory,
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(`error:${message}`),
    };

    assert.equal(
      await runCli(
        [
          "target",
          "bootstrap",
          "--host",
          "smoke-mac.local",
          "--user",
          "tester",
          "--name",
          "Smoke Mac",
        ],
        dependencies,
      ),
      0,
    );
    assert.equal(
      await runCli(
        [
          "plan",
          "--target",
          "smoke-mac",
          "--profile",
          profilePath,
          "--out",
          planPath,
        ],
        dependencies,
      ),
      0,
    );
    const plan = JSON.parse(await readFile(planPath, "utf8")) as Plan;
    assert.equal(
      await runCli(
        [
          "apply",
          "--plan",
          planPath,
          "--approve",
          plan.planHash,
          "--format",
          "jsonl",
        ],
        dependencies,
      ),
      0,
    );
    const runId = readFileSyncRunId(output);
    assert.equal(
      await runCli(["run", "show", "--run", runId], dependencies),
      0,
    );
    assert.deepEqual(
      readRun(runId, { runsDirectory }).snapshot.actions.map(
        ({ state }) => state,
      ),
      ["succeeded", "succeeded"],
    );
    assert.equal(
      existsSync(
        join(
          homeDirectory,
          ".dawn-forge",
          "targets",
          "smoke-mac",
          "target.json",
        ),
      ),
      true,
    );

    const tampered = {
      ...plan,
      spec: {
        ...plan.spec,
        actions: plan.spec.actions.map((action, index) =>
          index === 0 ? { ...action, critical: !action.critical } : action,
        ),
      },
    };
    await writeFile(planPath, `${JSON.stringify(tampered)}\n`, "utf8");
    assert.equal(
      await runCli(
        [
          "apply",
          "--plan",
          planPath,
          "--approve",
          plan.planHash,
        ],
        dependencies,
      ),
      20,
    );
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

function readFileSyncRunId(output: readonly string[]): string {
  for (const line of output) {
    try {
      const value = JSON.parse(line) as {
        readonly runId?: unknown;
        readonly event?: { readonly type?: unknown };
      };
      if (
        value.event?.type === "run-started" &&
        typeof value.runId === "string"
      ) {
        return value.runId;
      }
    } catch {
      // 人类可读的 bootstrap/plan 输出不是 JSONL。
    }
  }
  throw new Error("smoke test 未收到 run-started JSONL");
}
