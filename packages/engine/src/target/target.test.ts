import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeTargetFingerprint } from "../protocol/index.ts";
import {
  IdentityConflictError,
  NodeControllerKeyProvider,
  NodeSshTargetAdapter,
  TargetLockError,
  TargetManager,
  TargetRollbackError,
  buildAuthorizedKeyLine,
  macosProbeCommand,
  windowsProbeCommand,
  type ControllerKey,
  type SshTargetAdapter,
  type TargetConnection,
  type TargetProbe,
} from "./index.ts";

const controllerKey: ControllerKey = {
  privateKeyPath: "/controller/.ssh/id_ed25519",
  publicKeyPath: "/controller/.ssh/id_ed25519.pub",
  publicKeyLine: "ssh-ed25519 AAAATEST controller",
  publicKeyBlob: "AAAATEST",
};

const initialProbe: TargetProbe = {
  platform: "macos",
  identityEvidence: {
    sshHostKeyFingerprint: "SHA256:host-a",
    machineId: "11111111-2222-3333-4444-555555555555",
    architecture: "arm64",
    remoteUser: "wangxiao",
  },
};

class FakeSshAdapter implements SshTargetAdapter {
  readonly authorizationCommands: string[] = [];
  readonly revoked: Array<{
    connection: TargetConnection;
    publicKeyBlob: string;
  }> = [];
  readonly rolledBack: Array<{
    authorizedKeyLine: string;
    config: string;
  }> = [];
  readonly verifiedAuthorizationLines: string[] = [];
  probes: TargetProbe[] = [initialProbe];
  revokeError?: Error;
  afterProbe?: (connection: TargetConnection) => void;
  verifiedBootstrapPending = false;
  verifiedRevokePending = false;

  authorizationCommand(
    connection: TargetConnection,
    authorizedKeyLine: string,
  ): string {
    const command = `authorize ${connection.host} ${authorizedKeyLine}`;
    this.authorizationCommands.push(command);
    return command;
  }

  async probe(connection: TargetConnection): Promise<TargetProbe> {
    const probe = this.probes.shift();
    if (!probe) {
      throw new Error("测试没有提供 probe");
    }
    if (!existsSync(connection.knownHostsPath)) {
      writeFileSync(connection.knownHostsPath, "known-host\n", "utf8");
    }
    this.afterProbe?.(connection);
    return probe;
  }

  async verifyAuthorization(
    connection: TargetConnection,
    authorizedKeyLine: string,
  ): Promise<void> {
    this.verifiedAuthorizationLines.push(authorizedKeyLine);
    this.verifiedBootstrapPending = existsSync(
      join(connection.configPath, "..", "bootstrap.json"),
    );
  }

  async rollbackAuthorization(
    connection: TargetConnection,
    authorizedKeyLine: string,
  ): Promise<void> {
    this.rolledBack.push({
      authorizedKeyLine,
      config: readFileSync(connection.configPath, "utf8"),
    });
    if (this.revokeError) {
      throw this.revokeError;
    }
  }

  async revoke(
    connection: TargetConnection,
    publicKeyBlob: string,
  ): Promise<void> {
    this.verifiedRevokePending = existsSync(
      join(connection.configPath, "..", "revoke.json"),
    );
    this.revoked.push({ connection, publicKeyBlob });
  }
}

async function withFixture(
  callback: (fixture: {
    homeDirectory: string;
    manager: TargetManager;
    ssh: FakeSshAdapter;
    authorizationCommands: string[];
  }) => Promise<void>,
): Promise<void> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "dawn-target-"));
  const ssh = new FakeSshAdapter();
  const authorizationCommands: string[] = [];
  const manager = new TargetManager({
    homeDirectory,
    now: () => new Date("2026-07-23T12:00:00.000Z"),
    keyProvider: {
      load: async () => controllerKey,
      ensure: async () => controllerKey,
    },
    ssh,
    authorize: async (command) => {
      authorizationCommands.push(command);
      return true;
    },
  });
  try {
    await callback({
      homeDirectory,
      manager,
      ssh,
      authorizationCommands,
    });
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

test("bootstrap 创建带正确 fingerprint 的 target.json 和安全 SSH config", async () => {
  await withFixture(async ({
    homeDirectory,
    manager,
    ssh,
    authorizationCommands,
  }) => {
    const target = await manager.bootstrap({
      host: "mac-mini.local",
      user: "wangxiao",
      name: "Office Mac",
    });

    assert.equal(target.targetId, "office-mac");
    assert.equal(
      target.targetFingerprint,
      computeTargetFingerprint(initialProbe.identityEvidence),
    );
    assert.equal(target.identityEvidence.machineId, initialProbe.identityEvidence.machineId);
    const targetDirectory = join(
      homeDirectory,
      ".dawn-forge",
      "targets",
      target.targetId,
    );
    const stored = JSON.parse(
      readFileSync(join(targetDirectory, "target.json"), "utf8"),
    );
    assert.equal(stored.targetFingerprint, target.targetFingerprint);
    assert.equal(stored.connection.host, "mac-mini.local");
    assert.equal(
      existsSync(join(targetDirectory, "bootstrap.json")),
      false,
    );

    const config = readFileSync(join(targetDirectory, "ssh_config"), "utf8");
    for (const option of [
      "IdentitiesOnly yes",
      "ClearAllForwardings yes",
      "ForwardAgent no",
      "ForwardX11 no",
      "PermitLocalCommand no",
      "IdentityAgent none",
      "BatchMode yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "StrictHostKeyChecking yes",
      "UserKnownHostsFile",
      "GlobalKnownHostsFile none",
    ]) {
      assert.match(config, new RegExp(option));
    }
    assert.equal(authorizationCommands.length, 1);
    assert.equal(ssh.verifiedBootstrapPending, true);
    assert.match(authorizationCommands[0], /no-agent-forwarding/);
    assert.match(authorizationCommands[0], /no-port-forwarding/);
    assert.match(authorizationCommands[0], /no-X11-forwarding/);
  });
});

test("authorized_keys 条目包含全部转发限制", () => {
  assert.equal(
    buildAuthorizedKeyLine(controllerKey.publicKeyLine, "controller-host"),
    "no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAATEST controller-host",
  );
});

test("bootstrap 拒绝公网和无法证明属于局域网的 host", async () => {
  await withFixture(async ({ manager, authorizationCommands }) => {
    for (const host of ["example.com", "8.8.8.8", "office"]) {
      await assert.rejects(
        () =>
          manager.bootstrap({
            host,
            user: "wangxiao",
            name: "Office Mac",
          }),
        /受信任的局域网地址/,
      );
    }
    assert.equal(authorizationCommands.length, 0);
  });
});

test("inspect 不存在的 Target 时不创建状态目录", async () => {
  await withFixture(async ({ homeDirectory, manager }) => {
    await assert.rejects(
      () => manager.inspect("missing-target"),
      /找不到 Target：missing-target/,
    );
    assert.equal(existsSync(join(homeDirectory, ".dawn-forge")), false);
  });
});

test("Target lifecycle 使用全局排他锁阻止并发修改", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "dawn-lock-"));
  let releaseAuthorization: ((accepted: boolean) => void) | undefined;
  let markAuthorizationStarted: (() => void) | undefined;
  const authorizationStarted = new Promise<void>((resolve) => {
    markAuthorizationStarted = resolve;
  });
  const first = new TargetManager({
    homeDirectory,
    now: () => new Date("2026-07-23T12:00:00.000Z"),
    keyProvider: {
      load: async () => controllerKey,
      ensure: async () => controllerKey,
    },
    ssh: new FakeSshAdapter(),
    authorize: async () => {
      markAuthorizationStarted?.();
      return new Promise<boolean>((resolve) => {
        releaseAuthorization = resolve;
      });
    },
  });
  const second = new TargetManager({
    homeDirectory,
    now: () => new Date("2026-07-23T12:00:00.000Z"),
    keyProvider: {
      load: async () => controllerKey,
      ensure: async () => controllerKey,
    },
    ssh: new FakeSshAdapter(),
    authorize: async () => true,
  });

  try {
    const firstBootstrap = first.bootstrap({
      host: "mac-mini.local",
      user: "wangxiao",
      name: "Office Mac",
    });
    await authorizationStarted;
    await assert.rejects(
      () =>
        second.bootstrap({
          host: "other.local",
          user: "wangxiao",
          name: "Other Mac",
        }),
      (error) =>
        error instanceof TargetLockError && error.exitCode === 60,
    );
    releaseAuthorization?.(false);
    await assert.rejects(firstBootstrap, /authorized_keys/);
  } finally {
    releaseAuthorization?.(false);
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("bootstrap 发现硬中断 pending state 时保留证据并禁止换 name 绕过", async () => {
  await withFixture(async ({
    homeDirectory,
    manager,
    authorizationCommands,
  }) => {
    const pendingDirectory = join(
      homeDirectory,
      ".dawn-forge",
      "targets",
      ".old.bootstrap-interrupted",
    );
    mkdirSync(pendingDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(pendingDirectory, "bootstrap.json"),
      '{"schemaVersion":1}\n',
      "utf8",
    );

    await assert.rejects(
      () =>
        manager.bootstrap({
          host: "mac-mini.local",
          user: "wangxiao",
          name: "New Name",
        }),
      /发现未完成的 Target bootstrap/,
    );
    assert.equal(authorizationCommands.length, 0);
    assert.equal(existsSync(pendingDirectory), true);
  });
});

test("bootstrap 授权后的身份验证失败会撤销远端 key 并清理 staging", async () => {
  await withFixture(async ({ homeDirectory, manager, ssh }) => {
    ssh.probes = [
      {
        ...initialProbe,
        identityEvidence: {
          ...initialProbe.identityEvidence,
          remoteUser: "other-user",
        },
      },
    ];

    await assert.rejects(
      () =>
        manager.bootstrap({
          host: "mac-mini.local",
          user: "wangxiao",
          name: "Office Mac",
        }),
      (error) =>
        error instanceof IdentityConflictError &&
        /remoteUser/.test(error.message),
    );

    assert.equal(ssh.rolledBack.length, 1);
    assert.match(
      ssh.rolledBack[0].authorizedKeyLine,
      / AAAATEST .+-dawn-[0-9a-f-]+$/,
    );
    assert.doesNotMatch(
      ssh.rolledBack[0].authorizedKeyLine,
      / controller$/,
    );
    assert.deepEqual(
      readdirSync(join(homeDirectory, ".dawn-forge", "targets")),
      [],
    );
  });
});

test("bootstrap 失败且远端 key 回滚失败时退出 40 并保留 staging", async () => {
  await withFixture(async ({ homeDirectory, manager, ssh }) => {
    ssh.probes = [
      {
        ...initialProbe,
        identityEvidence: {
          ...initialProbe.identityEvidence,
          remoteUser: "other-user",
        },
      },
    ];
    ssh.revokeError = new Error("rollback failed");

    await assert.rejects(
      () =>
        manager.bootstrap({
          host: "mac-mini.local",
          user: "wangxiao",
          name: "Office Mac",
        }),
      (error) =>
        error instanceof TargetRollbackError &&
        error.exitCode === 40 &&
        /rollback failed/.test(error.message),
    );

    assert.equal(ssh.rolledBack.length, 1);
    assert.match(
      readdirSync(join(homeDirectory, ".dawn-forge", "targets"))[0] ?? "",
      /^\.office-mac\.bootstrap-/,
    );
  });
});

test("bootstrap 发布失败时使用 staging trust 精确回滚本次授权", async () => {
  await withFixture(async ({ homeDirectory, manager, ssh }) => {
    const finalDirectory = join(
      homeDirectory,
      ".dawn-forge",
      "targets",
      "office-mac",
    );
    ssh.afterProbe = () => {
      mkdirSync(finalDirectory, { mode: 0o700 });
    };

    await assert.rejects(() =>
      manager.bootstrap({
        host: "mac-mini.local",
        user: "wangxiao",
        name: "Office Mac",
      }),
    );

    assert.equal(ssh.rolledBack.length, 1);
    assert.match(
      ssh.rolledBack[0].config,
      /\.office-mac\.bootstrap-[^/"]+\/known_hosts/,
    );
    assert.doesNotMatch(
      ssh.rolledBack[0].config,
      /targets\/office-mac\/known_hosts/,
    );
  });
});

test("重复 bootstrap 身份变化时以 30 拒绝覆盖", async () => {
  await withFixture(async ({
    homeDirectory,
    manager,
    ssh,
    authorizationCommands,
  }) => {
    await manager.bootstrap({
      host: "mac-mini.local",
      user: "wangxiao",
      name: "Office Mac",
    });
    const targetPath = join(
      homeDirectory,
      ".dawn-forge",
      "targets",
      "office-mac",
      "target.json",
    );
    const original = readFileSync(targetPath, "utf8");
    ssh.probes.push({
      ...initialProbe,
      identityEvidence: {
        ...initialProbe.identityEvidence,
        machineId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      },
    });

    await assert.rejects(
      () =>
        manager.bootstrap({
          host: "mac-mini.local",
          user: "wangxiao",
          name: "Office Mac",
        }),
      (error) =>
        error instanceof IdentityConflictError &&
        error.exitCode === 30 &&
        /machineId/.test(error.message),
    );
    assert.equal(readFileSync(targetPath, "utf8"), original);
    assert.equal(
      authorizationCommands.length,
      1,
      "重复 bootstrap 必须先检查已有身份，不能再次写入 authorized_keys",
    );
  });
});

test("bootstrap 拒绝用不同 name 重复注册同一 locator 或机器身份", async () => {
  await withFixture(async ({ manager, ssh, authorizationCommands }) => {
    await manager.bootstrap({
      host: "mac-mini.local",
      user: "wangxiao",
      name: "Office Mac",
    });

    await assert.rejects(
      () =>
        manager.bootstrap({
          host: "mac-mini.local",
          user: "wangxiao",
          name: "Other Name",
        }),
      /host 已由 office-mac 注册/,
    );
    assert.equal(authorizationCommands.length, 1);

    ssh.probes.push(initialProbe);
    await assert.rejects(
      () =>
        manager.bootstrap({
          host: "192.168.1.20",
          user: "wangxiao",
          name: "Other Machine",
        }),
      /机器身份已由 office-mac 注册/,
    );
    assert.equal(ssh.rolledBack.length, 1);
  });
});

test("inspect 在身份未变化时成功，host key 或 machine ID 变化时退出 30", async () => {
  await withFixture(async ({ manager, ssh }) => {
    const target = await manager.bootstrap({
      host: "mac-mini.local",
      user: "wangxiao",
      name: "Office Mac",
    });
    ssh.probes.push(initialProbe);
    assert.deepEqual(await manager.inspect(target.targetId), target);

    ssh.probes.push({
      ...initialProbe,
      identityEvidence: {
        ...initialProbe.identityEvidence,
        sshHostKeyFingerprint: "SHA256:host-b",
        machineId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      },
    });
    await assert.rejects(
      () => manager.inspect(target.targetId),
      (error) =>
        error instanceof IdentityConflictError &&
        /sshHostKeyFingerprint, machineId/.test(error.message),
    );
  });
});

test("inspect 在 SSH config 漂移时停止且不连接目标机", async () => {
  await withFixture(async ({ homeDirectory, manager, ssh }) => {
    const target = await manager.bootstrap({
      host: "mac-mini.local",
      user: "wangxiao",
      name: "Office Mac",
    });
    const configPath = join(
      homeDirectory,
      ".dawn-forge",
      "targets",
      target.targetId,
      "ssh_config",
    );
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        "ForwardAgent no",
        "ForwardAgent yes",
      ),
      "utf8",
    );

    await assert.rejects(
      () => manager.inspect(target.targetId),
      /SSH config 已漂移/,
    );
    assert.equal(ssh.probes.length, 0);
  });
});

test("inspect 拒绝 target.json 中被篡改为 SSH option 的 alias", async () => {
  await withFixture(async ({ homeDirectory, manager, ssh }) => {
    const target = await manager.bootstrap({
      host: "mac-mini.local",
      user: "wangxiao",
      name: "Office Mac",
    });
    const targetPath = join(
      homeDirectory,
      ".dawn-forge",
      "targets",
      target.targetId,
      "target.json",
    );
    const stored = JSON.parse(readFileSync(targetPath, "utf8"));
    stored.locators.sshAlias = "-oProxyCommand=malicious";
    writeFileSync(targetPath, JSON.stringify(stored), "utf8");

    await assert.rejects(
      () => manager.inspect(target.targetId),
      /target\.json 结构无效/,
    );
    assert.equal(ssh.probes.length, 0);
  });
});

test("inspect 拒绝 target.json 与 SSH config 同步篡改 identityFile", async () => {
  await withFixture(async ({ homeDirectory, manager, ssh }) => {
    const target = await manager.bootstrap({
      host: "mac-mini.local",
      user: "wangxiao",
      name: "Office Mac",
    });
    const targetDirectory = join(
      homeDirectory,
      ".dawn-forge",
      "targets",
      target.targetId,
    );
    const targetPath = join(targetDirectory, "target.json");
    const configPath = join(targetDirectory, "ssh_config");
    const stored = JSON.parse(readFileSync(targetPath, "utf8"));
    stored.connection.identityFile = "/attacker/id_ed25519";
    writeFileSync(targetPath, JSON.stringify(stored), "utf8");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        controllerKey.privateKeyPath,
        "/attacker/id_ed25519",
      ),
      "utf8",
    );

    await assert.rejects(
      () => manager.inspect(target.targetId),
      (error) =>
        error instanceof IdentityConflictError &&
        /controllerIdentityFile/.test(error.message),
    );
    assert.equal(ssh.probes.length, 0);
  });
});

test("revoke 删除远端 authorized_keys 条目和本地 Target", async () => {
  await withFixture(async ({ homeDirectory, manager, ssh }) => {
    const target = await manager.bootstrap({
      host: "mac-mini.local",
      user: "wangxiao",
      name: "Office Mac",
    });
    const targetDirectory = join(
      homeDirectory,
      ".dawn-forge",
      "targets",
      target.targetId,
    );

    ssh.probes.push(initialProbe);
    await manager.revoke(target.targetId);

    assert.equal(ssh.revoked.length, 1);
    assert.equal(ssh.verifiedRevokePending, true);
    assert.equal(ssh.revoked[0].publicKeyBlob, controllerKey.publicKeyBlob);
    assert.equal(existsSync(targetDirectory), false);
  });
});

test("revoke 身份漂移或 target.json key blob 被篡改时不修改远端", async () => {
  await withFixture(async ({ homeDirectory, manager, ssh }) => {
    const target = await manager.bootstrap({
      host: "mac-mini.local",
      user: "wangxiao",
      name: "Office Mac",
    });
    const targetDirectory = join(
      homeDirectory,
      ".dawn-forge",
      "targets",
      target.targetId,
    );
    ssh.probes.push({
      ...initialProbe,
      identityEvidence: {
        ...initialProbe.identityEvidence,
        machineId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      },
    });
    await assert.rejects(
      () => manager.revoke(target.targetId),
      IdentityConflictError,
    );
    assert.equal(ssh.revoked.length, 0);
    assert.equal(existsSync(targetDirectory), true);

    const targetPath = join(targetDirectory, "target.json");
    const stored = JSON.parse(readFileSync(targetPath, "utf8"));
    stored.controllerPublicKeyBlob = "BBBB";
    writeFileSync(targetPath, JSON.stringify(stored), "utf8");
    await assert.rejects(
      () => manager.revoke(target.targetId),
      (error) =>
        error instanceof IdentityConflictError &&
        /controllerPublicKey/.test(error.message),
    );
    assert.equal(ssh.revoked.length, 0);

    stored.controllerPublicKeyBlob = "'; Remove-Item -Recurse C:\\; '";
    writeFileSync(targetPath, JSON.stringify(stored), "utf8");
    await assert.rejects(
      () => manager.revoke(target.targetId),
      /target\.json 结构无效/,
    );
    assert.equal(ssh.revoked.length, 0);
  });
});

test("Controller key 缺少任一文件时拒绝覆盖，完全缺失时才创建", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "dawn-key-"));
  try {
    const sshDirectory = join(homeDirectory, ".ssh");
    const privateKeyPath = join(sshDirectory, "id_ed25519");
    mkdirSync(sshDirectory, { recursive: true });
    writeFileSync(privateKeyPath, "existing-private", "utf8");
    let incompleteCalls = 0;
    const incomplete = new NodeControllerKeyProvider(
      homeDirectory,
      "fake-keygen",
      () => {
        incompleteCalls += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    );
    await assert.rejects(() => incomplete.ensure(), /SSH key pair 不完整/);
    assert.equal(readFileSync(privateKeyPath, "utf8"), "existing-private");
    assert.equal(incompleteCalls, 0);

    writeFileSync(
      `${privateKeyPath}.pub`,
      "ssh-ed25519 BBBB mismatched",
      "utf8",
    );
    let mismatchCalls = 0;
    const mismatched = new NodeControllerKeyProvider(
      homeDirectory,
      "fake-keygen",
      () => {
        mismatchCalls += 1;
        return {
          status: 0,
          stdout: "ssh-ed25519 AAAATEST derived\n",
          stderr: "",
        };
      },
    );
    await assert.rejects(
      () => mismatched.ensure(),
      /与 public key 不匹配/,
    );
    assert.equal(mismatchCalls, 1);

    await rm(sshDirectory, { recursive: true, force: true });
    let loadCalls = 0;
    const missingExisting = new NodeControllerKeyProvider(
      homeDirectory,
      "fake-keygen",
      () => {
        loadCalls += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    );
    await assert.rejects(
      () => missingExisting.load(),
      /已有 Target 不允许自动换 key/,
    );
    assert.equal(loadCalls, 0);

    let createCalls = 0;
    const created = new NodeControllerKeyProvider(
      homeDirectory,
      "fake-keygen",
      (_command, args) => {
        createCalls += 1;
        if (args.includes("-y")) {
          return {
            status: 0,
            stdout: "ssh-ed25519 AAAATEST derived\n",
            stderr: "",
          };
        }
        const keyPath = args[args.indexOf("-f") + 1];
        writeFileSync(keyPath, "new-private", "utf8");
        writeFileSync(
          `${keyPath}.pub`,
          "ssh-ed25519 AAAATEST dawn-forge",
          "utf8",
        );
        return { status: 0, stdout: "", stderr: "" };
      },
    );
    assert.equal((await created.ensure()).publicKeyBlob, "AAAATEST");
    assert.equal(createCalls, 2);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("Node SSH adapter 迁移 macOS/Windows identity probe 和受控 SSH 选项", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const run = (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    if (command === "fake-keygen") {
      return {
        status: 0,
        stdout: "256 SHA256:host-a target (ED25519)\n",
        stderr: "",
      };
    }
    const remoteCommand = args.at(-1) ?? "";
    if (remoteCommand.includes("__DAWN_FORGE_MACOS_V1__")) {
      return {
        status: 0,
        stdout: [
          "__DAWN_FORGE_MACOS_V1__",
          "wangxiao",
          "Darwin",
          "arm64",
          "15.5",
          "mini",
          "Mac mini",
          "",
          '    "IOPlatformUUID" = "11111111-2222-3333-4444-555555555555"',
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    return {
      status: 0,
      stdout: JSON.stringify({
        marker: "__DAWN_FORGE_WINDOWS_V1__",
        user: "wangxiao",
        architecture: "AMD64",
        machineId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      }),
      stderr: "",
    };
  };
  const adapter = new NodeSshTargetAdapter("fake-ssh", "fake-keygen", run);
  const baseConnection: TargetConnection = {
    targetId: "office",
    alias: "dawn-office",
    host: "office.local",
    user: "wangxiao",
    platform: "macos",
    configPath: "/controlled/ssh_config",
    knownHostsPath: "/controlled/known_hosts",
    identityFile: "/controller/id_ed25519",
  };

  const command = adapter.authorizationCommand(
    baseConnection,
    buildAuthorizedKeyLine(controllerKey.publicKeyLine, "controller-host"),
  );
  const authorizationText =
    process.platform === "win32"
      ? Buffer.from(command.split(" ").at(-1) ?? "", "base64").toString(
          "utf16le",
        )
      : command;
  assert.match(authorizationText, /ForwardAgent=no/);
  assert.match(authorizationText, /ForwardX11=no/);
  assert.match(authorizationText, /StrictHostKeyChecking=accept-new/);
  if (process.platform === "win32") {
    assert.match(command, /^powershell\.exe -NoProfile -EncodedCommand /);
    assert.match(authorizationText, /& 'fake-ssh' @dawnArguments/);
  }
  assert.match(
    authorizationText,
    /authorized_keys already contains controller key/,
  );
  const controlledLine = buildAuthorizedKeyLine(
    controllerKey.publicKeyLine,
    "controller-host-dawn-test",
  );
  await adapter.verifyAuthorization(baseConnection, controlledLine);
  await adapter.rollbackAuthorization(baseConnection, controlledLine);
  const verificationRemote = calls.at(-2)?.args.at(-1) ?? "";
  const rollbackRemote = calls.at(-1)?.args.at(-1) ?? "";
  const decodeRemote = (value: string) => {
    const encoded = value.match(/EncodedCommand ([A-Za-z0-9+/=]+)$/)?.[1];
    return encoded
      ? Buffer.from(encoded, "base64").toString("utf16le")
      : value;
  };
  assert.match(decodeRemote(verificationRemote), /authorized_keys|grep -Fqx/);
  assert.match(decodeRemote(rollbackRemote), /-cne \$k|\$0 != key/);
  assert.equal(
    (await adapter.probe(baseConnection)).identityEvidence.machineId,
    "11111111-2222-3333-4444-555555555555",
  );
  assert.equal(
    (
      await adapter.probe({ ...baseConnection, platform: "windows" })
    ).identityEvidence.architecture,
    "AMD64",
  );
  assert.match(macosProbeCommand(), /ioreg/);
  assert.match(macosProbeCommand(), /scutil/);
  const encodedWindowsProbe = windowsProbeCommand().split(" ").at(-1) ?? "";
  assert.match(
    Buffer.from(encodedWindowsProbe, "base64").toString("utf16le"),
    /MachineGuid/,
  );
  assert.ok(
    calls.some(
      ({ command: calledCommand, args }) =>
        calledCommand === "fake-ssh" &&
        args.includes("-F") &&
        args.includes("/controlled/ssh_config"),
    ),
  );
});
