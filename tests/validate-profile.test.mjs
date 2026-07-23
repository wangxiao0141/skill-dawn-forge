import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const secretProfile = structuredClone(validProfile);
secretProfile.token = "forbidden";
assert.match(
  validateProfile(secretProfile).join("\n"),
  /secret-like fields are forbidden/,
);

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

console.log("Profile validator tests passed.");
