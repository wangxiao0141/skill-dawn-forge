import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillDirectory = join(repositoryRoot, "skills", "dawn-forge");
const skillText = readFileSync(join(skillDirectory, "SKILL.md"), "utf8");

test("薄 Skill 只编排完整 Dawn CLI 工作流", () => {
  for (const command of [
    "dawn target bootstrap",
    "dawn plan",
    "dawn apply",
    "dawn run show",
    "dawn resume",
    "dawn verify",
    "dawn target revoke",
  ]) {
    assert.match(skillText, new RegExp(command.replaceAll(" ", "\\s+")));
  }
  assert.doesNotMatch(skillText, /scripts\//);
  assert.doesNotMatch(skillText, /\bssh\s+(?:-[A-Za-z]|[^`\n]*@)/i);
  assert.doesNotMatch(skillText, /\bbrew\s+(?:install|uninstall|list)\b/i);
  assert.doesNotMatch(
    skillText,
    /installation-run|plan-installation|run-installation-batch/,
  );
});

test("Engine 已替换的四个脚本及测试不存在", () => {
  for (const file of [
    "skills/dawn-forge/scripts/installation-run-state.mjs",
    "skills/dawn-forge/scripts/plan-installation.mjs",
    "skills/dawn-forge/scripts/installation-run.mjs",
    "skills/dawn-forge/scripts/run-installation-batch.mjs",
    "tests/installation-run-state.test.mjs",
    "tests/plan-installation.test.mjs",
    "tests/installation-run.test.mjs",
    "tests/run-installation-batch.test.mjs",
  ]) {
    assert.equal(existsSync(join(repositoryRoot, file)), false, file);
  }
});

test("V1 范围外的五个脚本继续随 Skill 发布", () => {
  for (const file of [
    "artifact-cache.mjs",
    "transfer-artifact.mjs",
    "transfer-private-input.mjs",
    "collect-private-input.mjs",
    "profile-validation.mjs",
  ]) {
    assert.equal(
      existsSync(join(skillDirectory, "scripts", file)),
      true,
      file,
    );
  }
});

test("Skill 发布 Engine、Catalog 和合法 V1 Profile 示例", () => {
  assert.deepEqual(
    readFileSync(join(skillDirectory, "bin", "dawn.mjs")),
    readFileSync(join(repositoryRoot, "packages", "engine", "bin", "dawn.mjs")),
  );
  for (const file of ["catalog.schema.json", "v1.json"]) {
    assert.deepEqual(
      readFileSync(join(skillDirectory, "catalog", file)),
      readFileSync(join(repositoryRoot, "catalog", file)),
    );
  }
  const profile = JSON.parse(
    readFileSync(
      join(skillDirectory, "assets", "dawn-forge.profile.example.json"),
      "utf8",
    ),
  );
  assert.equal(Array.isArray(profile.software), true);
  const engineProfile = JSON.parse(
    readFileSync(
      join(skillDirectory, "assets", "dawn-engine.profile.example.json"),
      "utf8",
    ),
  );
  assert.deepEqual(engineProfile, {
    schemaVersion: 1,
    platform: "macos",
    catalogVersion: "v1",
    packages: [],
  });
});

test("随 Skill 发布的 dawn --help 成功，未知命令以 2 退出", () => {
  const executable = join(skillDirectory, "bin", "dawn.mjs");
  const help = spawnSync(process.execPath, [executable, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  for (const command of ["target bootstrap", "plan", "apply", "resume", "verify"]) {
    assert.match(help.stdout, new RegExp(command));
  }

  const unknown = spawnSync(process.execPath, [executable, "unknown"], {
    encoding: "utf8",
  });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知命令/);
});
