import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildScpInvocation,
  buildSshInvocation,
  controlledPrivateInputNames,
  inspectWindowsFileAcl,
  parseArguments,
  transferPrivateInput,
  validatePrivateInputSource,
} from "../skills/dawn-forge/scripts/transfer-private-input.mjs";
import { targetIdentityDigest } from "../skills/dawn-forge/scripts/target-identity.mjs";

const root = mkdtempSync(
  join(tmpdir(), "dawn-forge-transfer-private-input-"),
);
const home = join(root, "controller home");
const privateRoot = join(home, ".dawn-forge", "private-inputs");
const targetRoot = join(home, ".dawn-forge", "targets", "mini");
const config = join(home, ".ssh", "config with spaces");
const knownHosts = join(home, ".ssh", "known_hosts");
const identityFile = join(home, ".ssh", "id_ed25519");
const input = join(privateRoot, "clash subscription.txt");
const secret = "https://private.invalid/subscription?token=fixture-secret";
const identity = {
  user: "wangxiao",
  os: "Darwin",
  architecture: "arm64",
  machineId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
};
const hostKeyBlob = Buffer.from("fixture-host-key", "utf8");
const hostKeyBase64 = hostKeyBlob.toString("base64");
const hostKeyFingerprints = [
  `SHA256:${createHash("sha256")
    .update(hostKeyBlob)
    .digest("base64")
    .replace(/=+$/, "")}`,
];
const keyFingerprint =
  "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
const digest = targetIdentityDigest({
  platform: "macos",
  ...identity,
  hostKeyFingerprints,
});

function writeReceipt(targetDigest = digest) {
  const configSha256 = createHash("sha256")
    .update(readFileSync(config))
    .digest("hex");
  const knownHostsSha256 = createHash("sha256")
    .update(readFileSync(knownHosts))
    .digest("hex");
  writeFileSync(
    join(targetRoot, "identity.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      finalized: true,
      alias: "mini",
      host: "mini.local",
      user: "wangxiao",
      platform: "macos",
      targetIdentitySha256: targetDigest,
      sshConfigPath: config,
      sshConfigSha256: configSha256,
      knownHostsPath: knownHosts,
      knownHostsSha256,
      handoff: {
        schemaVersion: 1,
        relativePath: ".dawn-forge/handoff",
        protection: "owner-directory-0700",
      },
      identityFile,
      keyFingerprint,
      identity,
      hostKeyFingerprints,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function fakeLocal(command, args) {
  if (command === "ssh") {
    return {
      status: 0,
      stdout: [
        "hostname mini.local",
        "user wangxiao",
        "port 22",
        "identitiesonly yes",
        `identityfile ${identityFile}`,
      ].join("\n"),
      stderr: "",
    };
  }
  assert.equal(command, "ssh-keygen");
  if (args[0] === "-F") {
    assert.deepEqual(args, ["-F", "mini.local", "-f", knownHosts]);
    return {
      status: 0,
      stdout: `mini.local ssh-ed25519 ${hostKeyBase64}\n`,
      stderr: "",
    };
  }
  assert.deepEqual(args, ["-lf", identityFile]);
  return {
    status: 0,
    stdout: `256 ${keyFingerprint} fixture (ED25519)\n`,
    stderr: "",
  };
}

function fixtureInput(overrides = {}) {
  return {
    input,
    name: "clash-subscription-url.txt",
    target: "mini",
    config,
    platform: "macos",
    targetIdentitySha256: digest,
    ...overrides,
  };
}

function fakeTransferCalls() {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      calls.push({
        command,
        args,
        input: options.input,
        timeout: options.timeout,
      });
      if (command === "scp") return { status: 0, stdout: "", stderr: "" };
      const marker = options.input.match(
        /__DAWN_FORGE_HANDOFF_[a-f0-9]{32}__/,
      )?.[0];
      assert.ok(marker);
      const stagedPath = calls[0].args.at(-2);
      const value = readFileSync(stagedPath);
      const sha256 = createHash("sha256").update(value).digest("hex");
      return {
        status: 0,
        stdout: `${marker} ${sha256} ${value.length}\n`,
        stderr: "",
      };
    },
  };
}

try {
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
  writeFileSync(input, secret, { encoding: "utf8", mode: 0o600 });
  writeFileSync(
    config,
    "Host mini\n  HostName mini.local\n  User wangxiao\n",
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    knownHosts,
    `mini.local ssh-ed25519 ${hostKeyBase64}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(identityFile, "fixture-private-key\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") {
    chmodSync(privateRoot, 0o700);
    chmodSync(input, 0o600);
    chmodSync(config, 0o600);
  }
  writeReceipt();

  if (process.platform === "win32") {
    const actualSshConfig = join(homedir(), ".ssh", "config");
    if (existsSync(actualSshConfig)) {
      assert.equal(
        inspectWindowsFileAcl(actualSshConfig).integritySafe,
        true,
        "当前 Windows SSH config 不得向非信任主体授予写权限",
      );
    }
  }

  assert.deepEqual(controlledPrivateInputNames, [
    "clash-subscription-url.txt",
    "clash-config.yaml",
  ]);
  assert.deepEqual(parseArguments(["--help"]), { help: true });
  assert.equal(
    parseArguments([
      "--input",
      input,
      "--name",
      "clash-subscription-url.txt",
      "--target",
      "mini",
      "--config",
      config,
      "--platform",
      "macos",
      "--target-identity-sha256",
      digest,
    ]).target,
    "mini",
  );
  assert.throws(
    () =>
      parseArguments([
        "--input",
        input,
        "--name",
        secret,
      ]),
    /不得包含 URL/,
  );

  const fake = fakeTransferCalls();
  const preflightOrder = [];
  const result = transferPrivateInput(fixtureInput(), {
    home,
    inspectWindowsAcl: () => ({ safe: true, reparsePoint: false }),
    localPlatform: process.platform,
    randomToken: () => "b".repeat(32),
    spawnLocal(command, args, options) {
      preflightOrder.push(
        command === "ssh" ? "ssh-g" : `ssh-keygen-${args[0]}`,
      );
      return fakeLocal(command, args, options);
    },
    spawnTransfer(command, args, options) {
      preflightOrder.push(command);
      return fake.spawn(command, args, options);
    },
    tightenWindowsAcl: () => true,
  });
  assert.equal(result.status, "transferred");
  assert.equal(result.bytes, Buffer.byteLength(secret));
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.targetIdentitySha256, digest);
  assert.doesNotMatch(JSON.stringify(result), /private\.invalid|fixture-secret/);
  assert.equal(fake.calls.length, 2, "只允许一次 scp 和一次 ssh");
  assert.deepEqual(
    fake.calls.map(({ command }) => command),
    ["scp", "ssh"],
  );
  assert.deepEqual(preflightOrder, [
    "ssh-g",
    "ssh-keygen--lf",
    "ssh-keygen--F",
    "scp",
    "ssh",
  ]);
  assert.deepEqual(
    fake.calls.map(({ timeout }) => timeout),
    [120_000, 120_000],
  );

  const scp = fake.calls[0];
  assert.equal(
    scp.args.at(-1),
    "mini:.dawn-forge/handoff/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.tmp",
  );
  assert.equal(scp.args.includes("-p"), false);
  assert.ok(
    scp.args.at(-2).includes("controller home"),
    "含空格的本地路径必须作为单个 argv 传入",
  );
  const ssh = fake.calls[1];
  for (const required of [
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    "IdentitiesOnly=yes",
    "ClearAllForwardings=yes",
    "ControlPersist=no",
    "ForkAfterAuthentication=no",
    "StdinNull=no",
    "RequestTTY=no",
    "Tunnel=no",
    "RemoteCommand=none",
    "PreferredAuthentications=publickey",
    "PubkeyAuthentication=yes",
    "HostbasedAuthentication=no",
    "GSSAPIAuthentication=no",
  ]) {
    assert.ok(ssh.args.includes(required));
    assert.ok(scp.args.includes(required));
  }
  assert.ok(ssh.args.includes("User=wangxiao"));
  assert.ok(scp.args.includes("User=wangxiao"));
  assert.ok(
    ssh.args.includes(
      `UserKnownHostsFile="${join(dirname(config), "known_hosts").replaceAll("\\", "/")}"`,
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(fake.calls),
    /fixture-secret|private\.invalid/,
    "argv、远端脚本和 fake spawn 记录不得包含秘密",
  );
  assert.match(ssh.input, /ln "\$source_file" "\$destination"/);
  assert.match(ssh.input, /rm -f "\$source_file"/);
  assert.match(ssh.input, /handoff_directory="\$handoff_base\/handoff"/);
  assert.match(ssh.input, /stat -f '%Lp' "\$handoff_directory"\)\" = "700"/);
  assert.doesNotMatch(ssh.input, /\*\.tmp|handoff-\*/);
  assert.equal(
    existsSync(join(privateRoot, `.transfer-${"b".repeat(32)}.tmp`)),
    false,
  );

  assert.throws(
    () =>
      transferPrivateInput(fixtureInput({ target: "wangxiao@mini.local" }), {
        home,
        spawnTransfer: () => {
          throw new Error("must not spawn");
        },
      }),
    /finalized SSH alias/,
  );

  assert.throws(
    () =>
      transferPrivateInput(
        fixtureInput({ targetIdentitySha256: "c".repeat(64) }),
        {
          home,
          inspectWindowsAcl: () => ({ safe: true, reparsePoint: false }),
          localPlatform: process.platform,
          spawnTransfer: () => {
            throw new Error("must not spawn");
          },
        },
      ),
    /finalized receipt 不一致/,
  );

  const originalConfig = readFileSync(config, "utf8");
  writeFileSync(config, `${originalConfig}# drift\n`, "utf8");
  assert.throws(
    () =>
      transferPrivateInput(fixtureInput(), {
        home,
        inspectWindowsAcl: () => ({ safe: true, reparsePoint: false }),
        localPlatform: process.platform,
        spawnLocal: fakeLocal,
        spawnTransfer: () => {
          throw new Error("must not transfer");
        },
      }),
    /finalize 后发生变化/,
  );
  writeFileSync(config, originalConfig, "utf8");
  writeReceipt();

  let racedTransfer = false;
  assert.throws(
    () =>
      transferPrivateInput(fixtureInput(), {
        home,
        inspectWindowsAcl: () => ({ safe: true, reparsePoint: false }),
        localPlatform: process.platform,
        randomToken() {
          writeFileSync(config, `${originalConfig}# raced\n`, "utf8");
          return "3".repeat(32);
        },
        spawnLocal: fakeLocal,
        spawnTransfer: () => {
          racedTransfer = true;
        },
        tightenWindowsAcl: () => true,
      }),
    /传输前发生变化/,
  );
  assert.equal(racedTransfer, false);
  assert.equal(
    existsSync(join(privateRoot, `.transfer-${"3".repeat(32)}.tmp`)),
    false,
    "pre-SCP trust drift 必须清理本次本地 staging",
  );
  writeFileSync(config, originalConfig, "utf8");
  writeReceipt();

  assert.throws(
    () =>
      transferPrivateInput(fixtureInput(), {
        home,
        inspectWindowsAcl: () => ({ safe: true, reparsePoint: false }),
        localPlatform: process.platform,
        spawnLocal(command, args) {
          const result = fakeLocal(command, args);
          if (command === "ssh-keygen") {
            result.stdout = `256 SHA256:${"C".repeat(43)} fixture\n`;
          }
          return result;
        },
        spawnTransfer: () => {
          throw new Error("must not transfer");
        },
      }),
    /key fingerprint/,
  );

  const symlinkPath = join(privateRoot, "symlink-secret.txt");
  let symlinkCreated = false;
  try {
    symlinkSync(input, symlinkPath, "file");
    symlinkCreated = true;
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
  }
  if (symlinkCreated) {
    assert.throws(
      () =>
        validatePrivateInputSource(symlinkPath, {
          home,
          inspectWindowsAcl: () => ({ safe: true, reparsePoint: false }),
          localPlatform: process.platform,
        }),
      /symlink|普通文件/,
    );
  }

  assert.throws(
    () =>
      validatePrivateInputSource(input, {
        home,
        localPlatform: "win32",
        inspectWindowsAcl: () => ({ safe: false }),
      }),
    /Windows owner\/ACL/,
  );

  const macInvocation = buildSshInvocation({
    cleanupOnly: false,
    config,
    expectedIdentity: {
      user: "wangxiao",
      os: "Darwin",
      architecture: "arm64",
      machineId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    },
    expectedBytes: 7,
    expectedSha256: "a".repeat(64),
    marker: "__DAWN_FORGE_HANDOFF_TEST__",
    name: "clash-config.yaml",
    nonce: "d".repeat(32),
    platform: "macos",
    target: "mini",
  });
  assert.equal(macInvocation.command, "ssh");
  assert.match(macInvocation.driver, /chmod 600/);
  assert.match(macInvocation.driver, /stat -f '%u'/);
  assert.match(macInvocation.driver, /published_by_this_run/);
  assert.match(macInvocation.driver, /\[ "\$digest" = "a{64}" \]/);
  const targetArgumentIndex = macInvocation.args.indexOf("mini");
  const realSshResolution = spawnSync(
    "ssh",
    [
      "-G",
      ...macInvocation.args.slice(0, targetArgumentIndex),
      "mini",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (realSshResolution.error === undefined) {
    assert.equal(realSshResolution.status, 0, realSshResolution.stderr);
    const knownHostsLine = realSshResolution.stdout
      .replaceAll("\r", "")
      .split("\n")
      .find((line) => line.startsWith("userknownhostsfile "));
    assert.equal(
      knownHostsLine?.slice("userknownhostsfile ".length).toLowerCase(),
      knownHosts.replaceAll("\\", "/").toLowerCase(),
      "含空格的 known_hosts 必须被 OpenSSH 解析为一个路径",
    );
  }

  const hostileConfig = join(dirname(config), "hostile config");
  writeFileSync(
    hostileConfig,
    [
      "Host *",
      "  RemoteCommand echo hostile",
      "  RequestTTY force",
      "  ControlPersist yes",
      "  ForkAfterAuthentication yes",
      "  StdinNull yes",
      "  Tunnel yes",
      "  PreferredAuthentications gssapi-with-mic,hostbased,password",
      "  PubkeyAuthentication no",
      "  HostbasedAuthentication yes",
      "  GSSAPIAuthentication yes",
      "Host mini",
      "  HostName mini.local",
      "  User wangxiao",
      `  IdentityFile "${identityFile.replaceAll("\\", "/")}"`,
      "  IdentitiesOnly yes",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  const hostileInvocation = buildSshInvocation({
    cleanupOnly: false,
    config: hostileConfig,
    expectedIdentity: identity,
    expectedBytes: 7,
    expectedSha256: "a".repeat(64),
    marker: "__DAWN_FORGE_HANDOFF_HOSTILE_CONFIG_TEST__",
    name: "clash-config.yaml",
    nonce: "7".repeat(32),
    platform: "macos",
    target: "mini",
  });
  const hostileTargetIndex = hostileInvocation.args.indexOf("mini");
  const systemSsh =
    process.platform === "win32"
      ? join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "OpenSSH",
          "ssh.exe",
        )
      : "ssh";
  const hostileResolution = spawnSync(
    systemSsh,
    [
      "-G",
      ...hostileInvocation.args.slice(0, hostileTargetIndex),
      "mini",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (hostileResolution.error === undefined) {
    assert.equal(hostileResolution.status, 0, hostileResolution.stderr);
    const effective = new Map(
      hostileResolution.stdout
        .replaceAll("\r", "")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf(" ");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    assert.equal(effective.has("remotecommand"), false);
    assert.equal(effective.get("requesttty"), "false");
    assert.equal(effective.get("controlpersist"), "no");
    assert.equal(effective.get("forkafterauthentication"), "no");
    assert.equal(effective.get("stdinnull"), "no");
    assert.equal(effective.get("tunnel"), "false");
    assert.equal(effective.get("preferredauthentications"), "publickey");
    assert.equal(effective.get("pubkeyauthentication"), "true");
    assert.equal(effective.get("hostbasedauthentication"), "no");
    assert.equal(effective.get("gssapiauthentication"), "no");
  }

  const windowsInvocation = buildSshInvocation({
    cleanupOnly: false,
    config,
    expectedIdentity: {
      user: "wangxiao",
      os: "Windows",
      architecture: "ARM64",
      machineId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    },
    expectedBytes: 7,
    expectedSha256: "a".repeat(64),
    marker: "__DAWN_FORGE_HANDOFF_TEST__",
    name: "clash-config.yaml",
    nonce: "e".repeat(32),
    platform: "windows",
    target: "mini",
  });
  assert.match(windowsInvocation.driver, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(windowsInvocation.driver, /\[IO\.File\]::Move/);
  assert.match(windowsInvocation.driver, /acl-postcondition/);
  assert.match(windowsInvocation.driver, /AreAccessRulesProtected/);
  assert.match(windowsInvocation.driver, /\$publishedByThisRun/);
  assert.match(windowsInvocation.driver, /source-integrity-mismatch/);
  assert.match(windowsInvocation.driver, /Assert-DawnForgeHandoffDirectory/);
  assert.match(windowsInvocation.driver, /ContainerInherit/);
  assert.match(windowsInvocation.driver, /ObjectInherit/);
  assert.match(
    windowsInvocation.driver,
    /Set-DawnForgeOwnedDirectory \$baseDirectory/,
  );
  assert.match(
    windowsInvocation.driver,
    /Set-DawnForgeOwnedDirectory \$targetDirectory/,
  );
  assert.doesNotMatch(windowsInvocation.driver, /\*\.tmp|handoff-\*/);
  if (process.platform === "win32") {
    const parsedDriver = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$text=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors);if($errors.Count -ne 0){$errors|ForEach-Object{[Console]::Error.WriteLine($_.Message)};exit 1}",
      ],
      {
        encoding: "utf8",
        input: windowsInvocation.driver,
        windowsHide: true,
      },
    );
    assert.equal(parsedDriver.status, 0, parsedDriver.stderr);
  }

  const scpInvocation = buildScpInvocation({
    config,
    expectedIdentity: {
      user: "wangxiao",
    },
    localPath: input,
    nonce: "f".repeat(32),
    target: "mini",
  });
  assert.equal(scpInvocation.args.at(-2), input);
  assert.equal(
    scpInvocation.args.at(-1),
    `mini:.dawn-forge/handoff/${"f".repeat(32)}.tmp`,
  );
  assert.equal(scpInvocation.args.includes("-p"), false);

  const interruptedCalls = [];
  assert.throws(
    () =>
      transferPrivateInput(fixtureInput(), {
        home,
        inspectWindowsAcl: () => ({ safe: true, reparsePoint: false }),
        localPlatform: process.platform,
        randomToken: () => "9".repeat(32),
        spawnLocal: fakeLocal,
        spawnTransfer(command, args, options) {
          interruptedCalls.push({ command, args, input: options.input });
          return command === "scp"
            ? { status: 0, stdout: "", stderr: "" }
            : { error: new Error("interrupted"), status: null };
        },
        tightenWindowsAcl: () => true,
      }),
    /远端原子发布失败/,
  );
  assert.equal(interruptedCalls.length, 2);
  assert.equal(
    interruptedCalls[0].args.at(-1),
    `mini:.dawn-forge/handoff/${"9".repeat(32)}.tmp`,
    "第二次 SSH 未启动时，orphan 也必须只位于 finalize 验证过的 owner-only 目录",
  );
  assert.equal(interruptedCalls[0].args.includes("-p"), false);
  assert.match(
    interruptedCalls[1].input,
    /\[ "\$\(stat -f '%Lp' "\$handoff_directory"\)" = "700" \]/,
  );

  const failedScpCalls = [];
  assert.throws(
    () =>
      transferPrivateInput(fixtureInput(), {
        home,
        inspectWindowsAcl: () => ({ safe: true, reparsePoint: false }),
        localPlatform: process.platform,
        randomToken: () => "1".repeat(32),
        spawnLocal: fakeLocal,
        spawnTransfer(command, args, options) {
          failedScpCalls.push({ command, args, input: options.input });
          return command === "scp"
            ? { status: 1, stdout: "", stderr: secret }
            : { status: 0, stdout: "", stderr: "" };
        },
        tightenWindowsAcl: () => true,
      }),
    /SCP 传输失败/,
  );
  assert.equal(failedScpCalls.length, 2);
  assert.deepEqual(
    failedScpCalls.map(({ command }) => command),
    ["scp", "ssh"],
  );
  assert.match(failedScpCalls[1].input, /if \[ "1" = "1" \]/);
  assert.match(
    failedScpCalls[1].input,
    /source_file="\$handoff_directory\/11111111111111111111111111111111\.tmp"/,
  );
  assert.doesNotMatch(failedScpCalls[1].input, /\*\.tmp|handoff-\*/);

  if (process.platform !== "win32") {
    chmodSync(input, 0o644);
    assert.throws(
      () =>
        validatePrivateInputSource(input, {
          home,
          localPlatform: process.platform,
        }),
      /mode 不安全/,
    );
    chmodSync(input, 0o600);
  }

  const gitInit = spawnSync("git", ["init", "--quiet"], {
    cwd: home,
    windowsHide: true,
  });
  assert.equal(gitInit.status, 0);
  const gitAdd = spawnSync(
    "git",
    ["add", "-f", "--", ".dawn-forge/private-inputs/clash subscription.txt"],
    { cwd: home, windowsHide: true },
  );
  assert.equal(gitAdd.status, 0);
  assert.throws(
    () =>
      validatePrivateInputSource(input, {
        home,
        inspectWindowsAcl: () => ({ safe: true, reparsePoint: false }),
        localPlatform: process.platform,
      }),
    /Git tracked/,
  );

  console.log("Private input transfer tests passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
