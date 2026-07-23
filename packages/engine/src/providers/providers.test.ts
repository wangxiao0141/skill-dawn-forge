import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { gitProvider } from "./git.ts";
import { homebrewProvider } from "./homebrew.ts";
import { getProvider } from "./index.ts";
import { type SshExecutor } from "./interface.ts";

function mockSsh(
  responses: Record<
    string,
    { stdout: string; exitCode: number; stderr?: string }
  >,
  commands: string[] = [],
): SshExecutor {
  return {
    async run(command) {
      commands.push(command);
      const response = responses[command];
      if (!response) {
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      return {
        stdout: response.stdout,
        stderr: response.stderr ?? "",
        exitCode: response.exitCode,
      };
    },
  };
}

test("catalog/v1.json 符合 schema 形状且依赖全部可解析", () => {
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const catalog = JSON.parse(
    readFileSync(join(repositoryRoot, "catalog", "v1.json"), "utf8"),
  );
  const schema = JSON.parse(
    readFileSync(
      join(repositoryRoot, "catalog", "catalog.schema.json"),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  assert.equal(
    validate(catalog),
    true,
    ajv.errorsText(validate.errors),
  );
  assert.ok(Array.isArray(catalog));
  const required = schema.$defs.entry.required;
  const ids = new Set<string>();
  for (const entry of catalog) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      [...required].sort(),
    );
    assert.match(entry.id, /^[a-z0-9][a-z0-9._-]{0,63}$/);
    assert.ok(["homebrew", "git"].includes(entry.provider));
    assert.equal(typeof entry.params, "object");
    assert.equal(typeof entry.critical, "boolean");
    assert.ok(Array.isArray(entry.dependsOn));
    assert.equal(ids.has(entry.id), false, `重复 Catalog id：${entry.id}`);
    ids.add(entry.id);
  }
  for (const entry of catalog) {
    for (const dependency of entry.dependsOn) {
      assert.ok(ids.has(dependency), `未知依赖：${dependency}`);
      assert.notEqual(dependency, entry.id);
    }
  }
  assert.deepEqual(
    [...ids].sort(),
    ["gh", "git", "homebrew", "node", "vscode"],
  );
  const gitEntry = catalog.find(
    (entry: { id: string }) => entry.id === "git",
  );
  assert.equal(gitEntry.provider, "git");
  assert.deepEqual(gitEntry.params, {});
  assert.equal(getProvider(gitEntry.provider), gitProvider);
});

test("Homebrew check reports Homebrew as not installed", async () => {
  const ssh = mockSsh({ "brew --version": { stdout: "", exitCode: 1 } });

  assert.deepEqual(await homebrewProvider.check({}, ssh), {
    installed: false,
  });
});

test("Homebrew check returns the Homebrew version", async () => {
  const ssh = mockSsh({
    "brew --version": { stdout: "Homebrew 4.4.0\n", exitCode: 0 },
  });

  assert.deepEqual(await homebrewProvider.check({}, ssh), {
    installed: true,
    version: "Homebrew 4.4.0",
  });
});

test("Homebrew check reports a formula with empty output as not installed", async () => {
  const ssh = mockSsh({
    "brew list --versions git": { stdout: "", exitCode: 1 },
  });

  assert.deepEqual(
    await homebrewProvider.check({ formula: "git" }, ssh),
    { installed: false },
  );
});

test("Homebrew check returns an installed formula version", async () => {
  const ssh = mockSsh({
    "brew list --versions git": { stdout: "git 2.50.1\n", exitCode: 0 },
  });

  assert.deepEqual(
    await homebrewProvider.check({ formula: "git" }, ssh),
    { installed: true, version: "2.50.1" },
  );
});

test("Homebrew apply rejects the Homebrew entry", async () => {
  await assert.rejects(
    homebrewProvider.apply({}, mockSsh({})),
    /Homebrew must be installed manually via the official installer/,
  );
});

test("Homebrew verify rejects an uninstalled package", async () => {
  const ssh = mockSsh({
    "brew list --versions git": { stdout: "", exitCode: 1 },
  });

  await assert.rejects(
    homebrewProvider.verify({ formula: "git" }, ssh),
    /git is not installed/,
  );
});

test("Homebrew apply 和 verify 只执行由类型化 params 构造的命令", async () => {
  const commands: string[] = [];
  const ssh = mockSsh(
    {
      "brew install --cask visual-studio-code": {
        stdout: "installed\n",
        exitCode: 0,
      },
      "brew list --cask --versions visual-studio-code": {
        stdout: "visual-studio-code 1.102.0\n",
        exitCode: 0,
      },
    },
    commands,
  );

  await homebrewProvider.apply(
    { formula: "visual-studio-code", cask: true },
    ssh,
  );
  await homebrewProvider.verify(
    { formula: "visual-studio-code", cask: true },
    ssh,
  );
  assert.deepEqual(commands, [
    "brew install --cask visual-studio-code",
    "brew list --cask --versions visual-studio-code",
  ]);
});

test("Homebrew provider 在 SSH 前拒绝未知参数和命令注入", async () => {
  const commands: string[] = [];
  const ssh = mockSsh({}, commands);
  await assert.rejects(
    () =>
      homebrewProvider.apply(
        { formula: "git; touch /tmp/pwned" },
        ssh,
      ),
    /Invalid Homebrew formula/,
  );
  await assert.rejects(
    () => homebrewProvider.apply({ formula: "--force" }, ssh),
    /Invalid Homebrew formula/,
  );
  await assert.rejects(
    () =>
      homebrewProvider.apply(
        { formula: "git", prefix: "/tmp" },
        ssh,
      ),
    /unknown parameter/,
  );
  assert.deepEqual(commands, []);
});

test("Git check reports Git as not installed", async () => {
  const ssh = mockSsh({ "git --version": { stdout: "", exitCode: 1 } });

  assert.deepEqual(await gitProvider.check({}, ssh), { installed: false });
});

test("Git check returns a valid Git version", async () => {
  const ssh = mockSsh({
    "git --version": { stdout: "git version 2.50.1\n", exitCode: 0 },
  });

  assert.deepEqual(await gitProvider.check({}, ssh), {
    installed: true,
    version: "2.50.1",
  });
});

test("Git apply 委托 Homebrew，verify 复验 git --version", async () => {
  const commands: string[] = [];
  const ssh = mockSsh(
    {
      "brew install git": { stdout: "installed\n", exitCode: 0 },
      "git --version": {
        stdout: "git version 2.50.1\n",
        exitCode: 0,
      },
    },
    commands,
  );

  await gitProvider.apply({}, ssh);
  await gitProvider.verify({}, ssh);
  assert.deepEqual(commands, ["brew install git", "git --version"]);
});

test("getProvider returns the Homebrew provider", () => {
  assert.equal(getProvider("homebrew"), homebrewProvider);
  assert.equal(getProvider("git"), gitProvider);
});

test("getProvider rejects an unknown provider", () => {
  assert.throws(() => getProvider("unknown"), /Unknown provider: unknown/);
});
