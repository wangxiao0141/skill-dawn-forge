#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const allowedRoutes = new Set(["direct", "clash", "local"]);
const allowedNetworkLocations = new Set(["controller", "target", "none"]);
const allowedExecutionModes = new Set(["automated", "manual-receipt"]);
const allowedInstallers = new Set([
  "homebrew-metadata",
  "brew-formula",
  "brew-cask",
  "winget",
  "npm-global",
  "volta-tool",
  "official-download",
  "manual",
]);
const allowedActionKeys = new Set([
  "softwareId",
  "name",
  "installer",
  "package",
  "version",
  "route",
  "networkLocation",
  "executionMode",
  "routeEvidence",
  "dependsOn",
  "requiresAdmin",
  "requiresGui",
  "requiresRestart",
]);
const allowedRouteEvidenceKeys = new Set(["method", "origins", "observedAt"]);
const allowedRouteEvidenceMethods = new Set([
  "target-probe",
  "controller-probe",
  "no-network",
]);
const defaultRouteOrder = ["direct", "clash", "local"];

export function validateResolvedActions(actions) {
  const errors = [];
  if (!Array.isArray(actions)) return ["$: resolved actions must be an array"];

  const ids = new Set();
  actions.forEach((action, index) => {
    const path = `$[${index}]`;
    if (!isPlainObject(action)) {
      errors.push(`${path}: action must be an object`);
      return;
    }

    for (const key of Object.keys(action)) {
      if (!allowedActionKeys.has(key)) errors.push(`${path}.${key}: unknown field`);
    }

    if (
      typeof action.softwareId !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(action.softwareId)
    ) {
      errors.push(`${path}.softwareId: invalid software id`);
    } else if (ids.has(action.softwareId)) {
      errors.push(`${path}.softwareId: duplicate software id`);
    } else {
      ids.add(action.softwareId);
    }

    if (
      typeof action.name !== "string" ||
      action.name.trim().length === 0 ||
      action.name.length > 160 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(action.name)
    ) {
      errors.push(`${path}.name: must be a safe non-empty string up to 160 characters`);
    }
    if (!allowedInstallers.has(action.installer)) {
      errors.push(`${path}.installer: unsupported installer`);
    }
    if (
      typeof action.package !== "string" ||
      action.package !== action.package.trim() ||
      action.package.startsWith("-") ||
      !/^[A-Za-z0-9@+._/-]+$/.test(action.package) ||
      action.package
        .split("/")
        .some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      errors.push(`${path}.package: invalid controlled package identifier`);
    }
    if (
      typeof action.version !== "string" ||
      action.version.length > 80 ||
      !/^[A-Za-z0-9][A-Za-z0-9.+_~^-]*$/.test(action.version)
    ) {
      errors.push(`${path}.version: required safe resolved version policy`);
    }
    if (
      action.installer === "homebrew-metadata" &&
      action.package !== "homebrew-metadata"
    ) {
      errors.push(`${path}.package: homebrew metadata must use homebrew-metadata`);
    }
    if (!allowedRoutes.has(action.route)) {
      errors.push(`${path}.route: unsupported route`);
    }
    if (!allowedNetworkLocations.has(action.networkLocation)) {
      errors.push(`${path}.networkLocation: unsupported network location`);
    }
    if (!allowedExecutionModes.has(action.executionMode)) {
      errors.push(`${path}.executionMode: unsupported execution mode`);
    }
    validateRouteEvidence(
      action.routeEvidence,
      action.route,
      action.networkLocation,
      `${path}.routeEvidence`,
      errors,
    );
    if (!Array.isArray(action.dependsOn)) {
      errors.push(`${path}.dependsOn: must be an array`);
    } else {
      const dependencies = new Set();
      action.dependsOn.forEach((dependencyId, dependencyIndex) => {
        if (
          typeof dependencyId !== "string" ||
          !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(dependencyId)
        ) {
          errors.push(
            `${path}.dependsOn[${dependencyIndex}]: invalid software id`,
          );
        } else if (dependencies.has(dependencyId)) {
          errors.push(`${path}.dependsOn: duplicate dependency ${dependencyId}`);
        } else {
          dependencies.add(dependencyId);
        }
      });
    }
    for (const key of ["requiresAdmin", "requiresGui", "requiresRestart"]) {
      if (action[key] !== undefined && typeof action[key] !== "boolean") {
        errors.push(`${path}.${key}: must be a boolean`);
      }
    }
    const hasManualBarrier = [
      action.requiresAdmin,
      action.requiresGui,
      action.requiresRestart,
    ].includes(true);
    if (action.executionMode === "automated" && hasManualBarrier) {
      errors.push(
        `${path}.executionMode: automated actions cannot require admin, GUI, or restart`,
      );
    }
    if (
      ["official-download", "manual"].includes(action.installer) &&
      action.executionMode !== "manual-receipt"
    ) {
      errors.push(
        `${path}.executionMode: ${action.installer} requires manual-receipt`,
      );
    }
    if (action.installer === "official-download") {
      errors.push(
        `${path}.installer: official-download requires the canonical network-bootstrap artifact pipeline`,
      );
    }
  });

  if (errors.length === 0) {
    const actionsById = new Map(
      actions.map((action) => [action.softwareId, action]),
    );
    actions.forEach((action, index) => {
      for (const dependencyId of action.dependsOn) {
        if (dependencyId === action.softwareId) {
          errors.push(`$[${index}].dependsOn: self dependency is forbidden`);
        } else if (!actionsById.has(dependencyId)) {
          errors.push(
            `$[${index}].dependsOn: unknown dependency ${dependencyId}`,
          );
        }
      }
    });
    if (errors.length === 0) {
      try {
        computeDependencyLevels(actions);
      } catch (error) {
        errors.push(`$: ${error.message}`);
      }
    }
  }

  return errors;
}

export function createInstallationSchedule(
  actions,
  {
    maxItemsPerBatch = 3,
    routeOrder = defaultRouteOrder,
    initialRoutes,
    preflightSha256,
    machineExecutionIdentitySha256,
  } = {},
) {
  const errors = validateResolvedActions(actions);
  if (errors.length > 0) {
    throw new Error(`Invalid resolved actions:\n${errors.join("\n")}`);
  }
  if (
    !Number.isInteger(maxItemsPerBatch) ||
    maxItemsPerBatch < 1 ||
    maxItemsPerBatch > 3
  ) {
    throw new Error("maxItemsPerBatch must be between 1 and 3.");
  }
  validateRouteOrder(routeOrder);
  validateInitialRoutes(initialRoutes);
  if (
    typeof preflightSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(preflightSha256)
  ) {
    throw new Error("preflightSha256 must be a lowercase SHA-256 digest.");
  }
  if (
    typeof machineExecutionIdentitySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(machineExecutionIdentitySha256)
  ) {
    throw new Error(
      "machineExecutionIdentitySha256 must be a lowercase SHA-256 digest.",
    );
  }

  const routeRank = new Map(routeOrder.map((route, index) => [route, index]));
  const dependencyLevels = computeDependencyLevels(actions);
  const ordered = actions
    .map((action, originalIndex) => ({
      ...action,
      requiresAdmin: action.requiresAdmin ?? false,
      requiresGui: action.requiresGui ?? false,
      requiresRestart: action.requiresRestart ?? false,
      dependencyLevel: dependencyLevels.get(action.softwareId),
      originalIndex,
    }))
    .sort(
      (left, right) =>
        left.dependencyLevel - right.dependencyLevel ||
        routeRank.get(left.route) - routeRank.get(right.route) ||
        left.installer.localeCompare(right.installer) ||
        left.originalIndex - right.originalIndex,
    );

  const batches = [];
  let active = null;
  for (const action of ordered) {
    const groupingKey = [
      action.dependencyLevel,
      action.executionMode,
      action.networkLocation,
      action.route,
      action.installer,
      action.requiresAdmin,
      action.requiresGui,
      action.requiresRestart,
    ].join("|");

    if (
      active === null ||
      active.groupingKey !== groupingKey ||
      active.items.length >= maxItemsPerBatch
    ) {
      active = {
        groupingKey,
        dependencyLevel: action.dependencyLevel,
        executionMode: action.executionMode,
        networkLocation: action.networkLocation,
        route: action.route,
        installer: action.installer,
        requiresAdmin: action.requiresAdmin,
        requiresGui: action.requiresGui,
        requiresRestart: action.requiresRestart,
        items: [],
      };
      batches.push(active);
    }

    const { originalIndex: _originalIndex, ...item } = action;
    active.items.push(item);
  }

  const previousRoutes = { ...initialRoutes };
  const publicBatches = batches.map((batch, index) => {
    const requiresRouteSwitch =
      batch.networkLocation !== "none" &&
      batch.route !== previousRoutes[batch.networkLocation];
    if (batch.networkLocation !== "none") {
      previousRoutes[batch.networkLocation] = batch.route;
    }
    const { groupingKey: _groupingKey, ...publicBatch } = batch;
    return {
      batchId: `batch-${String(index + 1).padStart(3, "0")}`,
      sequence: index + 1,
      requiresRouteSwitch,
      ...publicBatch,
    };
  });

  const schedule = {
    schemaVersion: 2,
    preflightSha256,
    machineExecutionIdentitySha256,
    maxItemsPerBatch,
    initialRoutes: { ...initialRoutes },
    routeOrder: [...routeOrder],
    batches: publicBatches,
  };

  return {
    ...schedule,
    scheduleSha256: sha256(JSON.stringify(schedule)),
  };
}

function validateInitialRoutes(initialRoutes) {
  if (
    !isPlainObject(initialRoutes) ||
    Object.keys(initialRoutes).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(initialRoutes, "controller") ||
    !Object.prototype.hasOwnProperty.call(initialRoutes, "target")
  ) {
    throw new Error(
      "initialRoutes must explicitly contain controller and target routes.",
    );
  }
  for (const location of ["controller", "target"]) {
    if (!["direct", "clash"].includes(initialRoutes[location])) {
      throw new Error(
        `initialRoutes.${location} must be direct or clash.`,
      );
    }
  }
}

function validateRouteOrder(routeOrder) {
  if (
    !Array.isArray(routeOrder) ||
    routeOrder.length !== allowedRoutes.size ||
    new Set(routeOrder).size !== allowedRoutes.size ||
    routeOrder.some((route) => !allowedRoutes.has(route))
  ) {
    throw new Error("routeOrder must contain direct, clash, and local exactly once.");
  }
}

function computeDependencyLevels(actions) {
  const actionsById = new Map(
    actions.map((action) => [action.softwareId, action]),
  );
  const levels = new Map();
  const visiting = new Set();

  function visit(softwareId) {
    if (levels.has(softwareId)) return levels.get(softwareId);
    if (visiting.has(softwareId)) {
      throw new Error(`dependency cycle includes ${softwareId}`);
    }
    visiting.add(softwareId);
    const action = actionsById.get(softwareId);
    const dependencies = action?.dependsOn ?? [];
    const level =
      dependencies.length === 0
        ? 0
        : Math.max(...dependencies.map((dependencyId) => visit(dependencyId))) + 1;
    visiting.delete(softwareId);
    levels.set(softwareId, level);
    return level;
  }

  for (const action of actions) visit(action.softwareId);
  return levels;
}

function validateRouteEvidence(value, route, networkLocation, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowedRouteEvidenceKeys.has(key)) {
      errors.push(`${path}.${key}: unknown field`);
    }
  }

  const { method, origins, observedAt } = value;
  if (!allowedRouteEvidenceMethods.has(method)) {
    errors.push(`${path}.method: unsupported route evidence method`);
  }
  if (!Array.isArray(origins)) {
    errors.push(`${path}.origins: must be an array`);
  } else {
    if (new Set(origins).size !== origins.length) {
      errors.push(`${path}.origins: duplicate origins are forbidden`);
    }
    origins.forEach((origin, index) => {
      if (
        typeof origin !== "string" ||
        origin !== origin.toLowerCase() ||
        origin.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
          origin,
        )
      ) {
        errors.push(
          `${path}.origins[${index}]: must be a lowercase public hostname without scheme, path, or credentials`,
        );
      }
    });
  }

  if (method === "no-network") {
    if (route !== "local") {
      errors.push(`${path}.method: no-network requires the local route`);
    }
    if (networkLocation !== "none") {
      errors.push(`${path}.method: no-network requires networkLocation none`);
    }
    if (Array.isArray(origins) && origins.length !== 0) {
      errors.push(`${path}.origins: no-network must not declare origins`);
    }
    if (observedAt !== undefined) {
      errors.push(`${path}.observedAt: no-network must not declare observedAt`);
    }
    return;
  }

  if (!["direct", "clash"].includes(route)) {
    errors.push(`${path}.method: probe evidence requires direct or clash route`);
  }
  if (method === "target-probe" && networkLocation !== "target") {
    errors.push(
      `${path}.method: target-probe requires networkLocation target`,
    );
  }
  if (method === "controller-probe" && networkLocation !== "controller") {
    errors.push(
      `${path}.method: controller-probe requires networkLocation controller`,
    );
  }

  if (Array.isArray(origins) && origins.length === 0) {
    errors.push(`${path}.origins: network evidence requires at least one origin`);
  }
  if (
    typeof observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(observedAt) ||
    Number.isNaN(Date.parse(observedAt))
  ) {
    errors.push(`${path}.observedAt: must be an ISO-8601 UTC timestamp`);
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  console.error(
    JSON.stringify({
      kind: "internal-only",
      code: "USE_INSTALLATION_RUN",
      message:
        "installation-batches.mjs is an internal module; use plan-installation.mjs and installation-run.mjs.",
    }),
  );
  process.exitCode = 2;
}
