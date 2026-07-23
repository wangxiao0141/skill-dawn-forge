#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateManifest } from "./manifest-validation.mjs";

const manifestPath = process.argv[2];

if (!manifestPath) {
  console.error("Usage: node validate-manifest.mjs <manifest.json>");
  process.exit(2);
}

let raw;
let manifest;

try {
  raw = await readFile(manifestPath, "utf8");
} catch (error) {
  console.error(`Cannot read manifest: ${error.message}`);
  process.exit(2);
}

try {
  manifest = JSON.parse(raw);
} catch (error) {
  console.error(`Invalid JSON: ${error.message}`);
  process.exit(1);
}

const errors = validateManifest(manifest);

if (errors.length > 0) {
  console.error("Manifest validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
console.log(
  JSON.stringify(
    {
      valid: true,
      manifest: resolve(manifestPath),
      sha256,
      targetId: manifest.target.id,
      targetHost: manifest.target.host,
      softwareCount: manifest.software.length,
    },
    null,
    2,
  ),
);
