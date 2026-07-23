#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateProfile } from "./profile-validation.mjs";

const profilePath = process.argv[2];

if (!profilePath) {
  console.error("Usage: node validate-profile.mjs <profile.json>");
  process.exit(2);
}

let raw;
let profile;

try {
  raw = await readFile(profilePath, "utf8");
} catch (error) {
  console.error(`Cannot read profile: ${error.message}`);
  process.exit(2);
}

try {
  profile = JSON.parse(raw);
} catch (error) {
  console.error(`Invalid JSON: ${error.message}`);
  process.exit(2);
}

const errors = validateProfile(profile);

if (errors.length > 0) {
  console.error("Profile validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");

console.log(
  JSON.stringify(
    {
      valid: true,
      profile: resolve(profilePath),
      sha256,
      profileId: profile.id,
      platform: profile.platform,
      softwareCount: profile.software.length,
    },
    null,
    2,
  ),
);
