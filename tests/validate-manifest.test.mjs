import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../skills/dawn-forge/scripts/manifest-validation.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = join(
  repositoryRoot,
  "skills",
  "dawn-forge",
  "assets",
  "dawn-forge.example.json",
);
const validManifest = JSON.parse(readFileSync(examplePath, "utf8"));

assert.deepEqual(validateManifest(validManifest), []);

const secretManifest = structuredClone(validManifest);
secretManifest.token = "forbidden";
assert.match(
  validateManifest(secretManifest).join("\n"),
  /secret-like fields are forbidden/,
);

const duplicateManifest = structuredClone(validManifest);
duplicateManifest.software.push(structuredClone(validManifest.software[0]));
assert.match(
  validateManifest(duplicateManifest).join("\n"),
  /duplicate software name/,
);

const unsafeHostManifest = structuredClone(validManifest);
unsafeHostManifest.target.host = "alice@mac-mini.local;whoami";
assert.match(
  validateManifest(unsafeHostManifest).join("\n"),
  /must be a DNS name/,
);

const malformedHostManifest = structuredClone(validManifest);
malformedHostManifest.target.host = "mac-mini..local";
assert.match(
  validateManifest(malformedHostManifest).join("\n"),
  /must be a DNS name/,
);

console.log("Manifest validator tests passed.");
