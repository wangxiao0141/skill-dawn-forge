import assert from "node:assert/strict";
import test from "node:test";

import {
  machineExecutionIdentityDigest,
  targetIdentityDigest,
} from "../skills/dawn-forge/scripts/target-identity.mjs";

const base = {
  platform: "macos",
  user: "wangxiao",
  os: "Darwin",
  architecture: "arm64",
  machineId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  hostKeyFingerprints: ["SHA256:second", " SHA256:first ", "SHA256:second"],
};

test("machine execution identity ignores SSH user and canonicalizes host-key order", () => {
  const first = machineExecutionIdentityDigest(base);
  const second = machineExecutionIdentityDigest({
    ...base,
    platform: " MACOS ",
    user: "administrator",
    os: "another-display-value",
    architecture: "x86_64",
    machineId: base.machineId.toLowerCase(),
    hostKeyFingerprints: ["SHA256:first", "SHA256:second"],
  });

  assert.equal(first, second);
  assert.notEqual(
    targetIdentityDigest(base),
    targetIdentityDigest({ ...base, user: "administrator" }),
  );
});

test("machine execution identity changes with the machine or host-key set", () => {
  const digest = machineExecutionIdentityDigest(base);
  assert.notEqual(
    digest,
    machineExecutionIdentityDigest({
      ...base,
      machineId: "11111111-2222-3333-4444-555555555555",
    }),
  );
  assert.notEqual(
    digest,
    machineExecutionIdentityDigest({
      ...base,
      hostKeyFingerprints: ["SHA256:different"],
    }),
  );
});
