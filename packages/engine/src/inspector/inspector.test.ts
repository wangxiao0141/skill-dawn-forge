import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectMacos,
  type InspectorSshExecutor,
} from "./index.ts";

test("macOS Inspector 用单次 SSH 收集只读结构化快照", async () => {
  const calls: unknown[] = [];
  const ssh: InspectorSshExecutor = {
    async run(configPath, alias, command) {
      calls.push({ configPath, alias, command });
      return {
        exitCode: 0,
        stderr: "",
        stdout: [
          "__DAWN_FORGE_INSPECTOR_V1__",
          "wangxiao",
          "97656250",
          "BREW:1",
          "Homebrew 4.4.0",
          "git",
          "node",
          "__CASKS__",
          "visual-studio-code",
          "__GIT__",
          "GIT:1",
          "git version 2.50.1",
          "__GIT_NAME__",
          Buffer.from("__GIT_EMAIL__", "utf8").toString("base64"),
          "__GIT_EMAIL__",
          Buffer.from("wang@example.com", "utf8").toString("base64"),
          "",
        ].join("\n"),
      };
    },
  };

  const snapshot = await inspectMacos(
    {
      configPath: "C:/controlled/ssh_config",
      alias: "dawn-office-mac",
    },
    ssh,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(snapshot, {
    platform: "macos",
    remoteUser: "wangxiao",
    freeDiskBytes: 100_000_000_000,
    homebrew: {
      installed: true,
      version: "Homebrew 4.4.0",
      formulae: ["git", "node"],
      casks: ["visual-studio-code"],
    },
    git: {
      installed: true,
      version: "2.50.1",
      userName: "__GIT_EMAIL__",
      userEmail: "wang@example.com",
    },
  });
  assert.match(String((calls[0] as { command: string }).command), /df -Pk/);
  assert.match(
    String((calls[0] as { command: string }).command),
    /list --formula/,
  );
  assert.match(
    String((calls[0] as { command: string }).command),
    /list --cask/,
  );
  assert.match(
    String((calls[0] as { command: string }).command),
    /GIT_NAME="\$\(git config.*user\.name.*printf '%s'.*base64/,
  );
});
