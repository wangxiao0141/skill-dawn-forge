import { createHash } from "node:crypto";

export function targetIdentityDigest(identity) {
  const normalize = (value) =>
    String(value ?? "").trim().normalize("NFC").toLowerCase();
  const hostKeyFingerprints = canonicalHostKeyFingerprints(identity);
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 2,
        platform: normalize(identity.platform),
        user: normalize(identity.user),
        os: normalize(identity.os),
        architecture: normalize(identity.architecture),
        machineId: normalize(identity.machineId),
        hostKeyFingerprints,
      }),
      "utf8",
    )
    .digest("hex");
}

export function machineExecutionIdentityDigest(identity) {
  const normalize = (value) =>
    String(value ?? "").trim().normalize("NFC").toLowerCase();
  const hostKeyFingerprints = canonicalHostKeyFingerprints(identity);
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        platform: normalize(identity.platform),
        machineId: normalize(identity.machineId),
        hostKeyFingerprints,
      }),
      "utf8",
    )
    .digest("hex");
}

function canonicalHostKeyFingerprints(identity) {
  if (!Array.isArray(identity?.hostKeyFingerprints)) {
    throw new TypeError("hostKeyFingerprints must be an array.");
  }
  return [
    ...new Set(
      identity.hostKeyFingerprints.map((value) =>
        String(value).trim().normalize("NFC")
      ),
    ),
  ].sort();
}
