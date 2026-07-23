import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPrivateInputWriter,
  parseArguments,
  privateInputPath,
} from "../skills/dawn-forge/scripts/collect-private-input.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scriptPath = join(
  repositoryRoot,
  "skills",
  "dawn-forge",
  "scripts",
  "collect-private-input.mjs",
);
const temporaryRoot = mkdtempSync(
  join(tmpdir(), "dawn-forge-private-input-"),
);
const fakeHome = join(temporaryRoot, "controller-home");
const firstSecret = "fixture-secret-alpha";
const secondSecret = "fixture-secret-beta";

function environmentForHome(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
}

function run(args, input, { home = fakeHome } = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: temporaryRoot,
    encoding: "utf8",
    env: environmentForHome(home),
    input,
    windowsHide: true,
  });
}

function runAsync(args, input) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: temporaryRoot,
      env: environmentForHome(fakeHome),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolvePromise({ status, stderr, stdout });
    });
    child.stdin.end(input);
  });
}

try {
  mkdirSync(fakeHome);

  const name = `subscription-${process.pid}`;
  const outputPath = privateInputPath(name, { home: fakeHome });
  assert.equal(
    outputPath,
    join(
      fakeHome,
      ".dawn-forge",
      "private-inputs",
      `${name}.txt`,
    ),
  );

  assert.throws(
    () => parseArguments(["--name", "subscription", "--output", "x"]),
    /未知命令参数/,
  );
  assert.throws(
    () => parseArguments(["--name", "../escape"]),
    /不能包含|必须是/,
  );

  const missingStdin = run(["--name", name], firstSecret);
  assert.equal(missingStdin.status, 2);
  assert.match(missingStdin.stderr, /--stdin/);
  assert.equal(existsSync(outputPath), false);

  const stored = run(
    ["--name", name, "--stdin"],
    `${firstSecret}\r\n`,
  );
  assert.equal(stored.status, 0, stored.stderr);
  assert.equal(readFileSync(outputPath, "utf8"), firstSecret);
  assert.doesNotMatch(stored.stdout, new RegExp(firstSecret));
  assert.deepEqual(JSON.parse(stored.stdout), {
    bytes: Buffer.byteLength(firstSecret),
    path: outputPath,
    permissions: process.platform === "win32" ? "acl-restricted" : "0600",
    replaced: false,
    status: "stored",
  });
  if (process.platform !== "win32") {
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(outputPath)).mode & 0o777, 0o700);
  }

  const existsResult = run(["--name", name, "--exists"]);
  assert.equal(existsResult.status, 0, existsResult.stderr);
  assert.deepEqual(JSON.parse(existsResult.stdout), {
    path: outputPath,
    status: "exists",
  });

  const refusedOverwrite = run(
    ["--name", name, "--stdin"],
    secondSecret,
  );
  assert.equal(refusedOverwrite.status, 4);
  assert.equal(readFileSync(outputPath, "utf8"), firstSecret);
  assert.match(refusedOverwrite.stderr, /未读取新输入/);
  assert.doesNotMatch(
    `${refusedOverwrite.stdout}${refusedOverwrite.stderr}`,
    new RegExp(secondSecret),
  );

  const replaced = run(
    ["--name", name, "--stdin", "--replace"],
    `${secondSecret}\n`,
  );
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(readFileSync(outputPath, "utf8"), secondSecret);
  assert.equal(JSON.parse(replaced.stdout).status, "replaced");
  assert.doesNotMatch(replaced.stdout, new RegExp(secondSecret));

  const urlArgument = "https://example.invalid/private-fixture";
  const rejectedUrl = run(["--name", urlArgument, "--exists"]);
  assert.equal(rejectedUrl.status, 2);
  assert.doesNotMatch(
    `${rejectedUrl.stdout}${rejectedUrl.stderr}`,
    new RegExp(urlArgument.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(rejectedUrl.stderr, /拒绝从命令参数接收 URL/);

  const linkedHome = join(temporaryRoot, "linked-home");
  let homeLinkCreated = false;
  try {
    symlinkSync(
      fakeHome,
      linkedHome,
      process.platform === "win32" ? "junction" : "dir",
    );
    homeLinkCreated = true;
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
  }
  if (homeLinkCreated) {
    const rejectedLinkedHome = run(
      ["--name", "linked", "--stdin"],
      firstSecret,
      { home: linkedHome },
    );
    assert.equal(rejectedLinkedHome.status, 2);
    assert.match(rejectedLinkedHome.stderr, /home 路径/);
  }

  const reparseHome = join(temporaryRoot, "reparse-home");
  mkdirSync(reparseHome);
  const outsideDirectory = join(temporaryRoot, "outside-private-inputs");
  mkdirSync(outsideDirectory);
  let privateLinkCreated = false;
  try {
    symlinkSync(
      outsideDirectory,
      join(reparseHome, ".dawn-forge"),
      process.platform === "win32" ? "junction" : "dir",
    );
    privateLinkCreated = true;
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
  }
  if (privateLinkCreated) {
    const rejectedReparse = run(
      ["--name", "escape", "--stdin"],
      firstSecret,
      { home: reparseHome },
    );
    assert.equal(rejectedReparse.status, 2);
    assert.match(rejectedReparse.stderr, /symlink|junction|reparse point/);
    assert.equal(existsSync(join(outsideDirectory, "escape.txt")), false);
  }

  const concurrentName = `concurrent-${process.pid}`;
  const concurrentSecrets = ["concurrent-secret-one", "concurrent-secret-two"];
  const concurrentResults = await Promise.all(
    concurrentSecrets.map((secret) =>
      runAsync(["--name", concurrentName, "--stdin"], secret),
    ),
  );
  assert.deepEqual(
    concurrentResults.map((result) => result.status).sort((a, b) => a - b),
    [0, 4],
  );
  assert.ok(
    concurrentSecrets.includes(
      readFileSync(privateInputPath(concurrentName, { home: fakeHome }), "utf8"),
    ),
  );
  for (const [index, result] of concurrentResults.entries()) {
    assert.doesNotMatch(result.stdout, new RegExp(concurrentSecrets[index]));
    assert.doesNotMatch(result.stderr, new RegExp(concurrentSecrets[index]));
  }

  const aclHome = join(temporaryRoot, "acl-home");
  mkdirSync(aclHome);
  const simulatedWindowsWriter = createPrivateInputWriter({
    platform: "win32",
    tightenWindowsAcl: () => false,
  });
  await assert.rejects(
    simulatedWindowsWriter(
      "acl-failure",
      Buffer.from("simulated-windows-secret", "utf8"),
      { home: aclHome },
    ),
    /无法确认或收紧 Windows ACL/,
  );
  assert.equal(
    existsSync(privateInputPath("acl-failure", { home: aclHome })),
    false,
  );

  const temporaryFiles = readdirSync(dirname(outputPath)).filter((entry) =>
    entry.endsWith(".tmp"),
  );
  assert.deepEqual(temporaryFiles, []);

  console.log("Private input collector tests passed.");
} finally {
  if (existsSync(temporaryRoot)) {
    if (process.platform !== "win32") chmodSync(temporaryRoot, 0o700);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
