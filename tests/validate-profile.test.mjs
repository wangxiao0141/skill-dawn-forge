import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProfile } from "../skills/dawn-forge/scripts/profile-validation.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = join(
  repositoryRoot,
  "skills",
  "dawn-forge",
  "assets",
  "dawn-forge.profile.example.json",
);
const validProfile = JSON.parse(readFileSync(examplePath, "utf8"));
const macosExamplePath = join(
  repositoryRoot,
  "skills",
  "dawn-forge",
  "assets",
  "dawn-forge.profile.macos.example.json",
);
const validateScriptPath = join(
  repositoryRoot,
  "skills",
  "dawn-forge",
  "scripts",
  "validate-profile.mjs",
);

assert.deepEqual(validateProfile(validProfile), []);
assert.equal(validProfile.software.length, 0);

const softwareProfile = structuredClone(validProfile);
softwareProfile.software.push({
  id: "visual-studio-code",
  name: "Visual Studio Code",
  source: "brew-cask",
  package: "visual-studio-code",
  required: true,
});
assert.deepEqual(validateProfile(softwareProfile), []);

const nodeToolProfile = structuredClone(validProfile);
nodeToolProfile.software.push(
  {
    id: "codex",
    name: "Codex CLI",
    source: "npm-global",
    package: "@openai/codex",
  },
  {
    id: "pnpm",
    name: "pnpm",
    source: "volta-tool",
    package: "pnpm",
  },
);
assert.deepEqual(validateProfile(nodeToolProfile), []);

const secretProfile = structuredClone(validProfile);
const secretFieldMarker = "apiKey_PROFILE_FIELD_MARKER_4d8c3";
const secretValueMarker = "PROFILE_VALUE_MARKER_9a2e7";
secretProfile[secretFieldMarker] = secretValueMarker;
const secretErrors = validateProfile(secretProfile).join("\n");
assert.match(secretErrors, /^\$: contains an unknown field/m);
assert.match(secretErrors, /^\$: secret-like fields are forbidden/m);
assert.doesNotMatch(
  secretErrors,
  /PROFILE_FIELD_MARKER_4d8c3|PROFILE_VALUE_MARKER_9a2e7/,
);

const hostileUnknownField = "https://user:ULTRA_PRIVATE_TOKEN@example.invalid";
const hostileUnknownProfile = structuredClone(validProfile);
hostileUnknownProfile[hostileUnknownField] = "unused";
const hostileUnknownErrors = validateProfile(hostileUnknownProfile).join("\n");
assert.match(hostileUnknownErrors, /^\$: contains an unknown field/m);
assert.doesNotMatch(hostileUnknownErrors, /ULTRA_PRIVATE_TOKEN|example\.invalid/);

const duplicateProfile = structuredClone(softwareProfile);
duplicateProfile.software.push(structuredClone(softwareProfile.software[0]));
assert.match(
  validateProfile(duplicateProfile).join("\n"),
  /duplicate software id/,
);
assert.match(
  validateProfile(duplicateProfile).join("\n"),
  /duplicate software name/,
);

const wrongPlatformSource = structuredClone(softwareProfile);
wrongPlatformSource.software[0].source = "winget";
wrongPlatformSource.software[0].package = "Microsoft.VisualStudioCode";
assert.match(
  validateProfile(wrongPlatformSource).join("\n"),
  /incompatible with macos/,
);

const windowsProfile = structuredClone(validProfile);
windowsProfile.platform = "windows";
windowsProfile.software.push({
  id: "visual-studio-code",
  name: "Visual Studio Code",
  source: "winget",
  package: "Microsoft.VisualStudioCode",
});
assert.deepEqual(validateProfile(windowsProfile), []);

const invalidSshSetting = structuredClone(validProfile);
invalidSshSetting.settings = { ssh: { githubKey: "yes" } };
assert.match(
  validateProfile(invalidSshSetting).join("\n"),
  /githubKey: must be a boolean/,
);

const dangerousCases = [
  {
    field: "package",
    value: "../formula",
    expected: /package: empty or traversal path segments are forbidden/,
  },
  {
    field: "package",
    value: "-formula",
    expected: /package: leading options are forbidden/,
  },
  {
    field: "package",
    value: String.raw`owner\formula`,
    expected: /package: backslashes are forbidden/,
  },
  {
    field: "package",
    value: "https://example.invalid/formula",
    expected: /package: URLs are forbidden/,
  },
  {
    field: "package",
    value: "$(whoami)",
    expected: /package: command interpolation is forbidden/,
  },
  {
    field: "version",
    value: "../../latest",
    expected: /version: paths and traversal are forbidden/,
  },
  {
    field: "version",
    value: "--latest",
    expected: /version: leading options are forbidden/,
  },
  {
    field: "version",
    value: String.raw`1.0\latest`,
    expected: /version: paths and traversal are forbidden/,
  },
  {
    field: "version",
    value: "https://example.invalid/1.0",
    expected: /version: URLs are forbidden/,
  },
  {
    field: "version",
    value: "${VERSION}",
    expected: /version: command interpolation is forbidden/,
  },
];

for (const { field, value, expected } of dangerousCases) {
  const profile = structuredClone(softwareProfile);
  profile.software[0][field] = value;
  assert.match(
    validateProfile(profile).join("\n"),
    expected,
    `${field} should reject ${JSON.stringify(value)}`,
  );
}

const manualTaskCases = [
  ["https://example.invalid/install", /manualTasks\[0\]: URLs are forbidden/],
  ["第一步\n第二步", /manualTasks\[0\]: control characters are forbidden/],
  ["brew install ripgrep", /manualTasks\[0\]: command-like content is forbidden/],
  ["完成授权 && 删除临时文件", /manualTasks\[0\]: shell operators are forbidden/],
  ["完成授权 & 删除临时文件", /manualTasks\[0\]: shell operators are forbidden/],
  ["导入 ${CONFIG}", /manualTasks\[0\]: command interpolation is forbidden/],
];

for (const [task, expected] of manualTaskCases) {
  const profile = structuredClone(validProfile);
  profile.manualTasks = [task];
  assert.match(
    validateProfile(profile).join("\n"),
    expected,
    `manual task should reject ${JSON.stringify(task)}`,
  );
}

const optionalProfile = JSON.parse(readFileSync(macosExamplePath, "utf8"));
assert.deepEqual(validateProfile(optionalProfile), []);
const validateResult = spawnSync(
  process.execPath,
  [validateScriptPath, macosExamplePath],
  { encoding: "utf8" },
);
assert.equal(validateResult.status, 0, validateResult.stderr);
const validatedModel = JSON.parse(validateResult.stdout);
assert.equal(
  validatedModel.software.find((item) => item.id === "clash-verge-rev")
    .required,
  false,
);
assert.equal(
  validatedModel.software.find((item) => item.id === "codex").required,
  false,
);

const liveProfilePath = join(
  repositoryRoot,
  "profiles",
  "mac-mini-personal-dev.json",
);
assert.deepEqual(
  validateProfile(JSON.parse(readFileSync(liveProfilePath, "utf8"))),
  [],
);

const temporaryDirectory = mkdtempSync(join(tmpdir(), "dawn-forge-profile-"));
try {
  const invalidJsonSecret = "PARSER_SECRET_8f7e2";
  const invalidJsonUrl = "https://user:URL_SECRET@example.invalid/profile";
  const invalidJsonPath = join(temporaryDirectory, "invalid.json");
  writeFileSync(
    invalidJsonPath,
    `{"name":"${invalidJsonSecret}","source":${invalidJsonUrl}}`,
    "utf8",
  );
  const invalidJsonResult = spawnSync(
    process.execPath,
    [validateScriptPath, invalidJsonPath],
    { encoding: "utf8" },
  );
  assert.equal(invalidJsonResult.status, 2);
  assert.match(invalidJsonResult.stderr, /^Profile validation failed:/m);
  assert.match(invalidJsonResult.stderr, /^- \$: invalid JSON$/m);
  assert.doesNotMatch(
    invalidJsonResult.stderr,
    /PARSER_SECRET_8f7e2|URL_SECRET|example\.invalid|Unexpected token/i,
  );

  const invalidSourceSecret = "SOURCE_SECRET_7c6d1";
  const invalidSourceUrl =
    `https://user:${invalidSourceSecret}@example.invalid/source`;
  const invalidSourceProfile = structuredClone(softwareProfile);
  invalidSourceProfile.software[0].source = invalidSourceUrl;
  const invalidSourcePath = join(temporaryDirectory, "invalid-source.json");
  writeFileSync(
    invalidSourcePath,
    JSON.stringify(invalidSourceProfile),
    "utf8",
  );
  const invalidSourceResult = spawnSync(
    process.execPath,
    [validateScriptPath, invalidSourcePath],
    { encoding: "utf8" },
  );
  assert.equal(invalidSourceResult.status, 1);
  assert.match(
    invalidSourceResult.stderr,
    /^- \$\.software\[0\]\.source: unsupported source$/m,
  );
  assert.doesNotMatch(
    invalidSourceResult.stderr,
    /SOURCE_SECRET_7c6d1|example\.invalid/,
  );

  const missingPathSecret = "MISSING_PATH_SECRET_2b4a9";
  const missingProfilePath = join(
    temporaryDirectory,
    `${missingPathSecret}.json`,
  );
  const missingProfileResult = spawnSync(
    process.execPath,
    [validateScriptPath, missingProfilePath],
    { encoding: "utf8" },
  );
  assert.equal(missingProfileResult.status, 2);
  assert.match(
    missingProfileResult.stderr,
    /^- \$: profile file cannot be read$/m,
  );
  assert.doesNotMatch(missingProfileResult.stderr, /MISSING_PATH_SECRET_2b4a9/);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("Profile validator tests passed.");
