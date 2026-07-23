import { createHash } from "node:crypto";

import type { IdentityEvidence, PlanSpec } from "./index.ts";

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) {
        throw new TypeError("JCS 输入包含未配对的 Unicode surrogate。");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("JCS 输入包含未配对的 Unicode surrogate。");
    }
  }
}

function serializeString(value: string): string {
  assertValidUnicode(value);
  return JSON.stringify(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return serializeString(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JCS 输入包含非有限数值。");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JCS 输入只能包含普通 JSON 对象。");
    }

    const object = value as Record<string, unknown>;
    const properties = Object.keys(object)
      .sort()
      .map((key) => `${serializeString(key)}:${canonicalize(object[key])}`);
    return `{${properties.join(",")}}`;
  }

  throw new TypeError(`JCS 输入包含不支持的类型：${typeof value}。`);
}

function sha256Jcs(value: unknown): string {
  const canonicalJson = canonicalize(value);
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

export function computePlanHash(
  spec: PlanSpec & { readonly createdAt?: string },
): string {
  const { createdAt: _createdAt, ...hashableSpec } = spec;
  return sha256Jcs(hashableSpec);
}

export function computeTargetFingerprint(
  evidence: IdentityEvidence,
): string {
  return sha256Jcs(evidence);
}
