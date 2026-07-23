import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  machineExecutionIdentityDigest,
  targetIdentityDigest,
} from "../skills/dawn-forge/scripts/target-identity.mjs";

const scriptPath = resolve("skills/dawn-forge/scripts/prepare-ssh-bootstrap.mjs");
const publicBlob =
  "AAAAC3NzaC1lZDI1NTE5AAAAIGZha2VkYXduZm9yZ2VwdWJsaWNrZXk";

test("plan rejects a public target address before creating a key", () => {
  withFixture(({ keyPath }) => {
    const result = runScript([
      "plan",
      "--platform",
      "macos",
      "--host",
      "8.8.8.8",
      "--user",
      "wangxiao",
      "--alias",
      "mini",
      "--key",
      keyPath,
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /LAN hostname or private IP address/i);
  }, { createKey: false });
});

test("plan rejects a single-label hostname instead of relying on public DNS", () => {
  withFixture(({ keyPath }) => {
    const result = runScript([
      "plan",
      "--platform",
      "macos",
      "--host",
      "mac-mini",
      "--user",
      "wangxiao",
      "--alias",
      "mini",
      "--key",
      keyPath,
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /LAN hostname or private IP address/i);
    assert.equal(existsSync(keyPath), false);
  }, { createKey: false });
});

test("each subcommand rejects unknown, duplicate, and out-of-scope options", () => {
  const unknown = runScript(["key", "--unknown"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unsupported option/i);

  const duplicate = runScript(["key", "--key", "one", "--key", "two"]);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /Duplicate option/i);

  const wrongCommand = runScript(["key", "--host", "mac-mini.local"]);
  assert.equal(wrongCommand.status, 2);
  assert.match(wrongCommand.stderr, /not supported by key/i);
});

test("plan finds an alias declared by an included SSH config before key creation", () => {
  withFixture(({ configPath, directory, keyPath }) => {
    const includedPath = join(directory, "included.conf");
    writeFileSync(configPath, "Include included.conf\n", "utf8");
    writeFileSync(
      includedPath,
      ["Host mini", "  HostName another-mini.local", "  User somebody", ""].join("\n"),
      "utf8",
    );

    const result = runScript([
      "plan",
      "--platform",
      "macos",
      "--host",
      "mac-mini.local",
      "--user",
      "wangxiao",
      "--alias",
      "mini",
      "--key",
      keyPath,
      "--config",
      configPath,
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Include and Match directives require manual review/i);
  }, { createKey: false });
});

test("install-key repeats alias preflight before starting password SSH", () => {
  withFixture(({ configPath, keyPath, knownHostsPath, logPath, preloadPath }) => {
    writeFileSync(
      configPath,
      ["Host mini", "  HostName another-mini.local", ""].join("\n"),
      "utf8",
    );

    const result = runScript(
      [
        "install-key",
        "--platform",
        "macos",
        "--host",
        "mac-mini.local",
        "--user",
        "wangxiao",
        "--alias",
        "mini",
        "--key",
        keyPath,
        "--config",
        configPath,
        "--ssh",
        "fake-ssh",
        "--ssh-keygen",
        "fake-keygen",
      ],
      fakeEnvironment({ configPath, keyPath, knownHostsPath, logPath, preloadPath }),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /alias mini already exists/i);
    assert.equal(existsSync(logPath), false, "password SSH must not start after preflight failure");
  });
});

test("finalize passes the selected config and bounded safety options to every probe", () => {
  withFixture(({ configPath, keyPath, knownHostsPath, logPath, preloadPath }) => {
    const result = runScript(
      [
        "finalize",
        "--platform",
        "macos",
        "--host",
        "mac-mini.local",
        "--user",
        "wangxiao",
        "--alias",
        "mini",
        "--key",
        keyPath,
        "--config",
        configPath,
        "--ssh",
        "fake-ssh",
        "--ssh-keygen",
        "fake-keygen",
      ],
      fakeEnvironment({ configPath, keyPath, knownHostsPath, logPath, preloadPath }),
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.finalized, true);
    assert.match(output.targetIdentitySha256, /^[a-f0-9]{64}$/);
    assert.match(output.machineExecutionIdentitySha256, /^[a-f0-9]{64}$/);
    const expectedDigest = createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: 2,
          platform: "macos",
          user: "wangxiao",
          os: "darwin",
          architecture: "arm64",
          machineId: "11111111-2222-3333-4444-555555555555",
          hostKeyFingerprints: [
            "SHA256:ZF4i/P0s7JMXTiebWcxawuCgI0UZ+TV+rtxjWZFEwUQ",
          ],
        }),
        "utf8",
      )
      .digest("hex");
    assert.equal(output.targetIdentitySha256, expectedDigest);
    const expectedMachineDigest = createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: 1,
          platform: "macos",
          machineId: "11111111-2222-3333-4444-555555555555",
          hostKeyFingerprints: [
            "SHA256:ZF4i/P0s7JMXTiebWcxawuCgI0UZ+TV+rtxjWZFEwUQ",
          ],
        }),
        "utf8",
      )
      .digest("hex");
    assert.equal(output.machineExecutionIdentitySha256, expectedMachineDigest);
    assert.equal(
      output.identityReceiptPath,
      join(dirname(configPath), ".dawn-forge", "targets", "mini", "identity.json"),
    );
    const receipt = JSON.parse(readFileSync(output.identityReceiptPath, "utf8"));
    assert.equal(receipt.alias, "mini");
    assert.equal(receipt.targetIdentitySha256, output.targetIdentitySha256);
    assert.equal(
      receipt.machineExecutionIdentitySha256,
      output.machineExecutionIdentitySha256,
    );
    assert.equal(receipt.identity.machineId, output.identity.machineId);
    assert.deepEqual(output.hostKeyFingerprints, [
      "SHA256:ZF4i/P0s7JMXTiebWcxawuCgI0UZ+TV+rtxjWZFEwUQ",
    ]);
    assert.equal(output.identityFile, keyPath);
    assert.equal(
      output.identityFileSha256,
      createHash("sha256").update(readFileSync(keyPath)).digest("hex"),
    );
    assert.equal(output.sshConfigPath, configPath);
    assert.equal(output.knownHostsPath, knownHostsPath);
    assert.equal(
      output.sshConfigSha256,
      createHash("sha256").update(readFileSync(configPath)).digest("hex"),
    );
    assert.equal(
      output.knownHostsSha256,
      createHash("sha256").update(readFileSync(knownHostsPath)).digest("hex"),
    );
    assert.equal(receipt.sshConfigSha256, output.sshConfigSha256);
    assert.equal(receipt.knownHostsSha256, output.knownHostsSha256);
    assert.deepEqual(receipt.handoff, {
      schemaVersion: 1,
      relativePath: ".dawn-forge/handoff",
      protection: "owner-directory-0700",
    });
    assert.ok(output.sshConfig.backup);
    assert.equal(readFileSync(output.sshConfig.backup, "utf8"), "");

    const calls = readCalls(logPath).filter((call) => call.command === "fake-ssh");
    const probes = calls.filter(
      ({ args }) => !args.includes("-G") && args.at(-1)?.includes("__DAWN_FORGE_MACOS_V1__"),
    );
    assert.equal(probes.length, 1);
    for (const { args } of probes) {
      assert.match(args.at(-1), /handoff_directory="\$handoff_base\/handoff"/);
      assert.match(args.at(-1), /stat -f '%Lp'/);
      assertOption(args, "-F", "none");
      assertOption(args, "-o", "BatchMode=yes");
      assertOption(args, "-o", "ConnectTimeout=8");
      assertOption(args, "-o", "ConnectionAttempts=1");
      assertOption(args, "-o", "ClearAllForwardings=yes");
      assertOption(args, "-o", "ForwardAgent=no");
      assertOption(args, "-o", "ForwardX11=no");
      assertOption(args, "-o", "PermitLocalCommand=no");
      assertOption(args, "-o", "ControlMaster=no");
      assertOption(args, "-o", "ControlPath=none");
      assertOption(args, "-o", "CanonicalizeHostname=no");
      assertOption(args, "-o", "ForkAfterAuthentication=no");
      assertOption(args, "-o", "RequestTTY=no");
      assertOption(args, "-o", "Tunnel=no");
      assertOption(
        args,
        "-o",
        `UserKnownHostsFile="${knownHostsPath.replaceAll("\\", "/")}"`,
      );
      assertOption(args, "-o", "PreferredAuthentications=publickey");
      assertOption(args, "-o", "PubkeyAuthentication=yes");
      assertOption(args, "-o", "HostbasedAuthentication=no");
      assertOption(args, "-o", "GSSAPIAuthentication=no");
      assertOption(args, "-o", "HostName=mac-mini.local");
      assertOption(args, "-o", "User=wangxiao");
      assertOption(args, "-o", "Port=22");
      assertOption(args, "-o", "HostKeyAlias=mac-mini.local");
      assertOption(args, "-F", "none");
    }
    const outputConfig = readFileSync(configPath, "utf8");
    assert.ok(
      outputConfig.includes(
        `IdentityFile "${keyPath.replaceAll("\\", "/")}"`,
      ),
    );
    assert.ok(
      outputConfig.includes(
        `UserKnownHostsFile "${knownHostsPath.replaceAll("\\", "/")}"`,
      ),
    );
    assert.equal("verifyCommand" in output, false);
    assert.equal("sshConfigBlock" in output, false);

    const hostKeyCall = readCalls(logPath).findIndex(
      ({ command, args }) => command === "fake-keygen" && args.includes("-F"),
    );
    const identityProbe = readCalls(logPath).findIndex(
      ({ command, args }) =>
        command === "fake-ssh" &&
        !args.includes("-G") &&
        args.at(-1)?.includes("__DAWN_FORGE_MACOS_V1__"),
    );
    assert.ok(hostKeyCall !== -1 && hostKeyCall < identityProbe);
    if (process.platform === "win32") {
      const aclCalls = readCalls(logPath).filter(
        ({ command }) => command === "powershell.exe",
      );
      assert.ok(aclCalls.length >= 4);
      const aclScript = Buffer.from(aclCalls[0].args.at(-1), "base64").toString(
        "utf16le",
      );
      assert.match(aclScript, /\$expected=@\(\$me\.Value,'S-1-5-18'\)/);
      assert.match(aclScript, /\/inheritance:r/);
      assert.match(aclScript, /local trust ACL postcondition failed/);
    }
  });
});

test("plan refuses unsafe effective SSH config before creating a key", () => {
  withFixture(
    ({ configPath, keyPath, knownHostsPath, logPath, preloadPath }) => {
      const result = runScript(
        [
          "plan",
          "--platform",
          "macos",
          "--host",
          "mac-mini.local",
          "--user",
          "wangxiao",
          "--alias",
          "mini",
          "--key",
          keyPath,
          "--config",
          configPath,
          "--ssh",
          "fake-ssh",
        ],
        fakeEnvironment({
          configPath,
          dangerousEffectiveConfig: true,
          keyPath,
          knownHostsPath,
          logPath,
          preloadPath,
        }),
      );

      assert.equal(result.status, 1);
      assert.match(result.stderr, /unsafe forwardagent/i);
      assert.equal(existsSync(keyPath), false);
    },
    { createKey: false },
  );
});

test("finalize uses hash CAS and preserves a concurrent config edit", () => {
  withFixture(({ configPath, keyPath, knownHostsPath, logPath, preloadPath }) => {
    const original = "# user config\n";
    writeFileSync(configPath, original, "utf8");
    const result = runScript(
      [
        "finalize",
        "--platform",
        "macos",
        "--host",
        "mac-mini.local",
        "--user",
        "wangxiao",
        "--alias",
        "mini",
        "--key",
        keyPath,
        "--config",
        configPath,
        "--ssh",
        "fake-ssh",
        "--ssh-keygen",
        "fake-keygen",
      ],
      fakeEnvironment({
        concurrentConfigMutation: true,
        configPath,
        keyPath,
        knownHostsPath,
        logPath,
        preloadPath,
      }),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /changed concurrently/i);
    assert.equal(
      readFileSync(configPath, "utf8"),
      `${original}# concurrent user edit\n`,
    );
    assert.equal(
      readdirSync(dirname(configPath)).some((entry) => entry.endsWith(".tmp")),
      false,
    );
  });
});

test("finalize captures and preserves an edit injected after the initial CAS check", () => {
  withFixture(({ configPath, keyPath, knownHostsPath, logPath, preloadPath }) => {
    const original = "# user config\n";
    writeFileSync(configPath, original, "utf8");
    const result = runScript(
      [
        "finalize",
        "--platform",
        "macos",
        "--host",
        "mac-mini.local",
        "--user",
        "wangxiao",
        "--alias",
        "mini",
        "--key",
        keyPath,
        "--config",
        configPath,
        "--ssh",
        "fake-ssh",
        "--ssh-keygen",
        "fake-keygen",
      ],
      fakeEnvironment({
        configPath,
        keyPath,
        knownHostsPath,
        logPath,
        preloadPath,
        renameRace: true,
      }),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /changed concurrently/i);
    assert.equal(
      readFileSync(configPath, "utf8"),
      `${original}# edit in CAS window\n`,
    );
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /Dawn Forge: mini/);
  });
});

test("install-key fixes SSH side effects and writes Windows UTF-8 ACL-safe content", () => {
  withFixture(({ configPath, keyPath, knownHostsPath, logPath, preloadPath }) => {
    const result = runScript(
      [
        "install-key",
        "--platform",
        "windows",
        "--host",
        "mac-mini.local",
        "--user",
        "wangxiao",
        "--alias",
        "mini",
        "--windows-admin",
        "--key",
        keyPath,
        "--config",
        configPath,
        "--ssh",
        "fake-ssh",
        "--ssh-keygen",
        "fake-keygen",
      ],
      fakeEnvironment({
        configPath,
        keyPath,
        knownHostsPath,
        logPath,
        mutateAfterDirectG: true,
        preloadPath,
      }),
    );

    assert.equal(result.status, 0, result.stderr);
    const sshCall = readCalls(logPath).find(
      ({ command, args }) => command === "fake-ssh" && !args.includes("-G"),
    );
    assert.ok(sshCall);
    assertOption(sshCall.args, "-o", "BatchMode=no");
    assertOption(sshCall.args, "-o", "PasswordAuthentication=yes");
    assertOption(sshCall.args, "-o", "PubkeyAuthentication=no");
    assertOption(sshCall.args, "-o", "ClearAllForwardings=yes");
    assertOption(sshCall.args, "-o", "PermitLocalCommand=no");
    assertOption(sshCall.args, "-o", "ForkAfterAuthentication=no");
    assertOption(
      sshCall.args,
      "-o",
      `UserKnownHostsFile="${knownHostsPath.replaceAll("\\", "/")}"`,
    );
    assertOption(sshCall.args, "-F", "none");
    assertOption(sshCall.args, "-o", "HostName=mac-mini.local");
    assertOption(sshCall.args, "-o", "User=wangxiao");
    assertOption(sshCall.args, "-o", "Port=22");
    assertOption(sshCall.args, "-o", "HostKeyAlias=mac-mini.local");
    assert.match(
      readFileSync(configPath, "utf8"),
      /HostName wrong-target\.local/,
      "the fixture must mutate config after preflight so the action proves it ignores that race",
    );

    const encoded = sshCall.args.at(-1).split(/\s+/).at(-1);
    const remoteScript = Buffer.from(encoded, "base64").toString("utf16le");
    assert.match(remoteScript, /UTF8Encoding\]::new\(\$false,\$true\)/);
    assert.doesNotMatch(remoteScript, /Set-Content.+-Encoding ascii/i);
    assert.match(remoteScript, /if\(\$LASTEXITCODE -ne 0\)/);
    assert.match(remoteScript, /RemoveAccessRuleSpecific/);
    assert.match(remoteScript, /ACL postcondition failed/);
    assert.match(remoteScript, /\$ErrorActionPreference='Stop'/);
    assert.match(remoteScript, /\[IO\.File\]::Replace\(\$tmp,\$f,\$backup,\$true\)/);
    assert.ok(
      remoteScript.indexOf("Set-DawnForgeAcl $tmp") <
        remoteScript.indexOf("[IO.File]::Replace($tmp,$f,$backup,$true)"),
    );
    assert.match(remoteScript, /authorized_keys rollback failed/);
  });
});

test("finalize restores the config when the final alias probe fails", () => {
  withFixture(({ configPath, keyPath, knownHostsPath, logPath, preloadPath }) => {
    const original = ["Host existing", "  HostName existing.local", ""].join("\n");
    writeFileSync(configPath, original, "utf8");

    const result = runScript(
      [
        "finalize",
        "--platform",
        "macos",
        "--host",
        "mac-mini.local",
        "--user",
        "wangxiao",
        "--alias",
        "mini",
        "--key",
        keyPath,
        "--config",
        configPath,
        "--ssh",
        "fake-ssh",
        "--ssh-keygen",
        "fake-keygen",
      ],
      fakeEnvironment({
        aliasProbeFails: true,
        configPath,
        keyPath,
        knownHostsPath,
        logPath,
        preloadPath,
      }),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unexpected HostName/i);
    assert.equal(readFileSync(configPath, "utf8"), original);
  });
});

test("finalize is idempotent and atomically replaces an existing identity receipt", () => {
  withFixture(({ configPath, keyPath, knownHostsPath, logPath, preloadPath }) => {
    const args = [
      "finalize",
      "--platform",
      "macos",
      "--host",
      "mac-mini.local",
      "--user",
      "wangxiao",
      "--alias",
      "mini",
      "--key",
      keyPath,
      "--config",
      configPath,
      "--ssh",
      "fake-ssh",
      "--ssh-keygen",
      "fake-keygen",
    ];
    const environment = fakeEnvironment({
      configPath,
      keyPath,
      knownHostsPath,
      logPath,
      preloadPath,
    });
    const first = runScript(args, environment);
    assert.equal(first.status, 0, first.stderr);
    const second = runScript(args, environment);
    assert.equal(second.status, 0, second.stderr);
    const output = JSON.parse(second.stdout);
    assert.equal(output.sshConfig.changed, false);
    assert.equal(
      JSON.parse(readFileSync(output.identityReceiptPath, "utf8"))
        .targetIdentitySha256,
      output.targetIdentitySha256,
    );
  });
});

test("finalize preserves config and receipt when historical target identity conflicts", () => {
  withFixture(({ configPath, keyPath, knownHostsPath, logPath, preloadPath }) => {
    const originalConfig = "# existing user config\n";
    writeFileSync(configPath, originalConfig, "utf8");
    const receiptPath = join(
      dirname(configPath),
      ".dawn-forge",
      "targets",
      "mini",
      "identity.json",
    );
    mkdirSync(dirname(receiptPath), { recursive: true });
    const oldIdentity = {
      user: "wangxiao",
      os: "Darwin",
      architecture: "arm64",
      version: "15.5",
      machineId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    };
    const oldHostKeyFingerprints = ["SHA256:b2xkdGFyZ2V0"];
    const oldReceipt = `${JSON.stringify(
      {
        schemaVersion: 1,
        finalized: true,
        platform: "macos",
        host: "mac-mini.local",
        user: "wangxiao",
        alias: "mini",
        identityFile: keyPath,
        identityFileSha256: createHash("sha256")
          .update(readFileSync(keyPath))
          .digest("hex"),
        keyFingerprint: "SHA256:YWJjZGVmZ2hpamtsbW5vcA==",
        sshConfigPath: configPath,
        sshConfigSha256: createHash("sha256")
          .update(Buffer.from(originalConfig))
          .digest("hex"),
        knownHostsPath,
        knownHostsSha256: createHash("sha256")
          .update(readFileSync(knownHostsPath))
          .digest("hex"),
        targetIdentitySha256: targetIdentityDigest({
          platform: "macos",
          ...oldIdentity,
          hostKeyFingerprints: oldHostKeyFingerprints,
        }),
        machineExecutionIdentitySha256: machineExecutionIdentityDigest({
          platform: "macos",
          machineId: oldIdentity.machineId,
          hostKeyFingerprints: oldHostKeyFingerprints,
        }),
        identity: oldIdentity,
        hostKeyFingerprints: oldHostKeyFingerprints,
        handoff: {
          schemaVersion: 1,
          relativePath: ".dawn-forge/handoff",
          protection: "owner-directory-0700",
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(receiptPath, oldReceipt, "utf8");

    const result = runScript(
      [
        "finalize",
        "--platform",
        "macos",
        "--host",
        "mac-mini.local",
        "--user",
        "wangxiao",
        "--alias",
        "mini",
        "--key",
        keyPath,
        "--config",
        configPath,
        "--ssh",
        "fake-ssh",
        "--ssh-keygen",
        "fake-keygen",
      ],
      fakeEnvironment({ configPath, keyPath, knownHostsPath, logPath, preloadPath }),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /conflicts with the existing finalized receipt/i);
    assert.equal(readFileSync(configPath, "utf8"), originalConfig);
    assert.equal(readFileSync(receiptPath, "utf8"), oldReceipt);
    const remoteProbes = readCalls(logPath).filter(
      ({ command, args }) => command === "fake-ssh" && !args.includes("-G"),
    );
    assert.equal(
      remoteProbes.length,
      0,
      "a known host-key conflict must stop before the identity probe mutates handoff state",
    );
  });
});

test("finalize preserves a receipt edit injected inside the receipt CAS window", () => {
  withFixture(({ configPath, keyPath, knownHostsPath, logPath, preloadPath }) => {
    const args = [
      "finalize",
      "--platform",
      "macos",
      "--host",
      "mac-mini.local",
      "--user",
      "wangxiao",
      "--alias",
      "mini",
      "--key",
      keyPath,
      "--config",
      configPath,
      "--ssh",
      "fake-ssh",
      "--ssh-keygen",
      "fake-keygen",
    ];
    const baseEnvironment = fakeEnvironment({
      configPath,
      keyPath,
      knownHostsPath,
      logPath,
      preloadPath,
    });
    const first = runScript(args, baseEnvironment);
    assert.equal(first.status, 0, first.stderr);
    const receiptPath = JSON.parse(first.stdout).identityReceiptPath;
    const previousBytes = readFileSync(receiptPath, "utf8");

    const raced = runScript(
      args,
      fakeEnvironment({
        configPath,
        keyPath,
        knownHostsPath,
        logPath,
        preloadPath,
        receiptRace: true,
      }),
    );

    assert.equal(raced.status, 1);
    assert.match(raced.stderr, /identity receipt changed concurrently/i);
    assert.equal(readFileSync(receiptPath, "utf8"), `${previousBytes}\n`);
  });
});

test("finalize refuses an identity without a recorded host-key fingerprint", () => {
  withFixture(({ configPath, keyPath, knownHostsPath, logPath, preloadPath }) => {
    const result = runScript(
      [
        "finalize",
        "--platform",
        "macos",
        "--host",
        "mac-mini.local",
        "--user",
        "wangxiao",
        "--alias",
        "mini",
        "--key",
        keyPath,
        "--config",
        configPath,
        "--ssh",
        "fake-ssh",
        "--ssh-keygen",
        "fake-keygen",
      ],
      fakeEnvironment({
        configPath,
        hostKeyMissing: true,
        keyPath,
        knownHostsPath,
        logPath,
        preloadPath,
      }),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot confirm the SSH host key fingerprint/i);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /Dawn Forge: mini/);
  });
});

test("plan refuses an existing encrypted key before any target mutation", () => {
  withFixture(({ configPath, keyPath, knownHostsPath, logPath, preloadPath }) => {
    const result = runScript(
      [
        "plan",
        "--platform",
        "macos",
        "--host",
        "mac-mini.local",
        "--user",
        "wangxiao",
        "--alias",
        "mini",
        "--key",
        keyPath,
        "--config",
        configPath,
        "--ssh",
        "fake-ssh",
        "--ssh-keygen",
        "fake-keygen",
      ],
      fakeEnvironment({
        configPath,
        emptyPassphraseFails: true,
        keyPath,
        knownHostsPath,
        logPath,
        preloadPath,
      }),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /encrypted|empty passphrase cannot be proven/i);
    const remoteCalls = readCalls(logPath).filter(
      ({ command, args }) => command === "fake-ssh" && !args.includes("-G"),
    );
    assert.equal(remoteCalls.length, 0);
  });
});

test("plan rejects a symlink SSH config before creating a key", (t) => {
  withFixture(({ configPath, directory, keyPath }) => {
    const realConfigPath = join(directory, "real-config");
    writeFileSync(realConfigPath, "", "utf8");
    unlinkSync(configPath);
    try {
      symlinkSync(realConfigPath, configPath, "file");
    } catch (error) {
      t.skip(`symlink creation is unavailable: ${error.code ?? error.message}`);
      return;
    }

    const result = runScript([
      "plan",
      "--platform",
      "macos",
      "--host",
      "mac-mini.local",
      "--user",
      "wangxiao",
      "--alias",
      "mini",
      "--key",
      keyPath,
      "--config",
      configPath,
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /SSH config must be a regular file/i);
    assert.equal(existsSync(keyPath), false);
  }, { createKey: false });
});

test("finalize refuses an already-owned operation lock before remote SSH", () => {
  withFixture(({ configPath, keyPath, knownHostsPath, logPath, preloadPath }) => {
    const lockPath = join(
      dirname(configPath),
      `.${basename(configPath)}.dawn-forge.lock`,
    );
    writeFileSync(lockPath, '{"owner":"another-process"}\n', "utf8");

    const result = runScript(
      [
        "finalize",
        "--platform",
        "macos",
        "--host",
        "mac-mini.local",
        "--user",
        "wangxiao",
        "--alias",
        "mini",
        "--key",
        keyPath,
        "--config",
        configPath,
        "--ssh",
        "fake-ssh",
        "--ssh-keygen",
        "fake-keygen",
      ],
      fakeEnvironment({ configPath, keyPath, knownHostsPath, logPath, preloadPath }),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /owns the operation lock/i);
    const remoteCalls = existsSync(logPath)
      ? readCalls(logPath).filter(
          ({ command, args }) => command === "fake-ssh" && !args.includes("-G"),
        )
      : [];
    assert.equal(remoteCalls.length, 0);
  });
});

test("system ssh -G honors the leading managed block and quoted paths", (t) => {
  const systemSsh = systemSshPath();
  if (!systemSsh) {
    t.skip("a system OpenSSH client is unavailable");
    return;
  }

  withFixture(({ configPath, knownHostsPath }) => {
    writeFileSync(
      configPath,
      [
        "Host mini",
        "  HostName mac-mini.local",
        "  User wangxiao",
        "  ForwardAgent no",
        "  ProxyCommand none",
        "  ControlPath none",
        `  UserKnownHostsFile "${knownHostsPath.replaceAll("\\", "/")}"`,
        "Host *",
        "  HostName wrong-target.local",
        "  ForwardAgent yes",
        "  ProxyCommand unexpected-command",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(systemSsh, ["-G", "-F", configPath, "mini"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const resolved = parseSshG(result.stdout);
    assert.equal(resolved.hostname, "mac-mini.local");
    assert.equal(resolved.user, "wangxiao");
    assert.equal(resolved.forwardagent, "no");
    assert.equal(resolved.proxycommand, undefined);
    assert.equal(
      resolve(resolved.userknownhostsfile),
      resolve(knownHostsPath),
      "quoted UserKnownHostsFile must remain one path even when it contains spaces",
    );

    const direct = spawnSync(
      systemSsh,
      [
        "-G",
        "-F",
        "none",
        "-o",
        `UserKnownHostsFile="${knownHostsPath.replaceAll("\\", "/")}"`,
        "mac-mini.local",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    );
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(
      resolve(parseSshG(direct.stdout).userknownhostsfile),
      resolve(knownHostsPath),
      "quoted command-line UserKnownHostsFile must remain one path",
    );
  });
});

function withFixture(callback, { createKey = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dawn forge ssh-"));
  const configPath = join(directory, "config");
  const keyPath = join(directory, "id_ed25519");
  const knownHostsPath = join(directory, "known_hosts");
  const logPath = join(directory, "calls.jsonl");
  const preloadPath = join(directory, "fake-tools.cjs");

  try {
    if (createKey) {
      writeFileSync(keyPath, "fake-private-key\n", "utf8");
      writeFileSync(`${keyPath}.pub`, `ssh-ed25519 ${publicBlob} controller\n`, "utf8");
    }
    writeFileSync(configPath, "", "utf8");
    writeFileSync(
      knownHostsPath,
      `mac-mini.local ssh-ed25519 ${publicBlob}\n`,
      "utf8",
    );
    writeFileSync(preloadPath, fakeToolsPreload(), "utf8");
    callback({
      configPath,
      directory,
      keyPath,
      knownHostsPath,
      logPath,
      preloadPath,
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function runScript(args, environment = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
    windowsHide: true,
  });
}

function fakeEnvironment({
  aliasProbeFails = false,
  concurrentConfigMutation = false,
  configPath,
  dangerousEffectiveConfig = false,
  emptyPassphraseFails = false,
  hostKeyMissing = false,
  keyPath,
  knownHostsPath,
  logPath,
  mutateAfterDirectG = false,
  preloadPath,
  receiptRace = false,
  renameRace = false,
}) {
  const fixtureHome = dirname(configPath);
  return {
    DAWN_FORGE_TEST_ALIAS_FAIL: aliasProbeFails ? "1" : "0",
    DAWN_FORGE_TEST_CONCURRENT_MUTATION: concurrentConfigMutation ? "1" : "0",
    DAWN_FORGE_TEST_CONFIG: configPath,
    DAWN_FORGE_TEST_EMPTY_PASSPHRASE_FAIL: emptyPassphraseFails ? "1" : "0",
    DAWN_FORGE_TEST_HOST_KEY_MISSING: hostKeyMissing ? "1" : "0",
    DAWN_FORGE_TEST_MUTATE_AFTER_DIRECT_G: mutateAfterDirectG ? "1" : "0",
    DAWN_FORGE_TEST_RECEIPT_RACE: receiptRace ? "1" : "0",
    DAWN_FORGE_TEST_DANGEROUS_EFFECTIVE: dangerousEffectiveConfig ? "1" : "0",
    DAWN_FORGE_TEST_RENAME_RACE: renameRace ? "1" : "0",
    DAWN_FORGE_TEST_KEY: keyPath,
    DAWN_FORGE_TEST_KNOWN_HOSTS: knownHostsPath,
    DAWN_FORGE_TEST_LOG: logPath,
    DAWN_FORGE_TEST_PUBLIC_BLOB: publicBlob,
    HOME: fixtureHome,
    NODE_OPTIONS: `--require="${preloadPath.replaceAll("\\", "/")}"`,
    USERPROFILE: fixtureHome,
  };
}

function readCalls(logPath) {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertOption(args, option, value) {
  assert.ok(
    args.some((entry, index) => entry === option && args[index + 1] === value),
    `missing ${option} ${value} in ${JSON.stringify(args)}`,
  );
}

function fakeToolsPreload() {
  return String.raw`
const childProcess = require("node:child_process");
const fs = require("node:fs");
const { appendFileSync, readFileSync } = fs;
const { syncBuiltinESMExports } = require("node:module");

const realSpawnSync = childProcess.spawnSync;
const realRenameSync = fs.renameSync;
let candidateEvaluations = 0;
let renameRaceInjected = false;
let directMutationInjected = false;
let receiptRaceInjected = false;

fs.renameSync = function fakeRenameSync(source, destination) {
  if (
    process.env.DAWN_FORGE_TEST_RECEIPT_RACE === "1" &&
    !receiptRaceInjected &&
    /[\\/]identity\.json$/.test(String(source)) &&
    String(destination).includes(".identity.previous.")
  ) {
    receiptRaceInjected = true;
    appendFileSync(source, "\n", "utf8");
  }
  if (
    process.env.DAWN_FORGE_TEST_RENAME_RACE === "1" &&
    !renameRaceInjected &&
    source === process.env.DAWN_FORGE_TEST_CONFIG &&
    String(destination).includes(".dawn-forge-") &&
    String(destination).endsWith(".bak")
  ) {
    renameRaceInjected = true;
    appendFileSync(source, "# edit in CAS window\n", "utf8");
  }
  return realRenameSync(source, destination);
};

childProcess.spawnSync = function fakeSpawnSync(command, args = [], options = {}) {
  if (
    command !== "fake-ssh" &&
    command !== "fake-keygen" &&
    command !== "powershell.exe"
  ) {
    return realSpawnSync(command, args, options);
  }

  appendFileSync(
    process.env.DAWN_FORGE_TEST_LOG,
    JSON.stringify({ command, args }) + "\n",
    "utf8",
  );

  if (command === "powershell.exe") {
    return completed("");
  }

  if (command === "fake-keygen") {
    if (args.includes("-lf")) {
      return completed(
        "256 SHA256:YWJjZGVmZ2hpamtsbW5vcA== controller (ED25519)\n",
      );
    }
    if (args.includes("-y")) {
      if (process.env.DAWN_FORGE_TEST_EMPTY_PASSPHRASE_FAIL === "1") {
        return failed("incorrect passphrase supplied to decrypt private key\n");
      }
      return completed(
        "ssh-ed25519 " + process.env.DAWN_FORGE_TEST_PUBLIC_BLOB + "\n",
      );
    }
    if (args.includes("-F")) {
      if (process.env.DAWN_FORGE_TEST_HOST_KEY_MISSING === "1") {
        return { error: undefined, signal: null, status: 1, stderr: "", stdout: "" };
      }
      return completed(
        "mac-mini.local ssh-ed25519 " +
          process.env.DAWN_FORGE_TEST_PUBLIC_BLOB +
          "\n",
      );
    }
    return failed("unexpected fake-keygen invocation\n");
  }

  if (args.includes("-G")) {
    const destination = args.at(-1);
    const configPath = args[args.indexOf("-F") + 1];
    const config = readFileSync(configPath, "utf8");
    const hasManagedAlias = config.includes("# >>> Dawn Forge: mini >>>");
    if (
      process.env.DAWN_FORGE_TEST_MUTATE_AFTER_DIRECT_G === "1" &&
      !directMutationInjected &&
      destination.includes("@") &&
      configPath === process.env.DAWN_FORGE_TEST_CONFIG
    ) {
      directMutationInjected = true;
      appendFileSync(
        process.env.DAWN_FORGE_TEST_CONFIG,
        "Host *\n  HostName wrong-target.local\n  Port 2222\n",
        "utf8",
      );
    }
    if (
      configPath !== process.env.DAWN_FORGE_TEST_CONFIG &&
      hasManagedAlias
    ) {
      candidateEvaluations += 1;
      if (
        process.env.DAWN_FORGE_TEST_CONCURRENT_MUTATION === "1" &&
        candidateEvaluations === 2
      ) {
        appendFileSync(
          process.env.DAWN_FORGE_TEST_CONFIG,
          "# concurrent user edit\n",
          "utf8",
        );
      }
    }
    let host = destination.includes("@")
      ? destination.slice(destination.indexOf("@") + 1)
      : destination === "mini" && hasManagedAlias
        ? "mac-mini.local"
        : destination;
    if (
      process.env.DAWN_FORGE_TEST_ALIAS_FAIL === "1" &&
      destination === "mini" &&
      configPath === process.env.DAWN_FORGE_TEST_CONFIG &&
      hasManagedAlias
    ) {
      host = "different-mini.local";
    }
    const forwardAgent =
      process.env.DAWN_FORGE_TEST_DANGEROUS_EFFECTIVE === "1" ? "yes" : "no";
    return completed(
      [
        "hostname " + host,
        "user wangxiao",
        "identityfile " + process.env.DAWN_FORGE_TEST_KEY,
        "identitiesonly yes",
        "port 22",
        "clearallforwardings yes",
        "forwardagent " + forwardAgent,
        "forwardx11 no",
        "permitlocalcommand no",
        "controlmaster false",
        "controlpersist no",
        "canonicalizehostname false",
        "forkafterauthentication no",
        "stdinnull no",
        "requesttty false",
        "tunnel false",
        "batchmode yes",
        "passwordauthentication no",
        "kbdinteractiveauthentication no",
        "preferredauthentications publickey",
        "pubkeyauthentication true",
        "hostbasedauthentication no",
        "gssapiauthentication no",
        "stricthostkeychecking true",
        "connecttimeout 8",
        "connectionattempts 1",
        "identityagent none",
        "globalknownhostsfile none",
        "userknownhostsfile " + process.env.DAWN_FORGE_TEST_KNOWN_HOSTS,
        "",
      ].join("\n"),
    );
  }

  return completed(
    [
      "__DAWN_FORGE_MACOS_V1__",
      "wangxiao",
      "Darwin",
      "arm64",
      "15.5",
      "mac-mini",
      "Mac mini",
      "",
      '    "IOPlatformUUID" = "11111111-2222-3333-4444-555555555555"',
      "",
    ].join("\n"),
  );
};

syncBuiltinESMExports();

function completed(stdout) {
  return { error: undefined, signal: null, status: 0, stderr: "", stdout };
}

function failed(stderr) {
  return { error: undefined, signal: null, status: 255, stderr, stdout: "" };
}
`;
}

function systemSshPath() {
  const candidates =
    process.platform === "win32"
      ? [
          join(
            process.env.WINDIR ?? "C:\\Windows",
            "System32",
            "OpenSSH",
            "ssh.exe",
          ),
        ]
      : ["/usr/bin/ssh", "/bin/ssh"];
  return candidates.find((candidate) => existsSync(candidate));
}

function parseSshG(output) {
  const values = {};
  for (const line of output.replaceAll("\r", "").split("\n")) {
    const separator = line.indexOf(" ");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    if (!(key in values)) values[key] = line.slice(separator + 1);
  }
  return values;
}
