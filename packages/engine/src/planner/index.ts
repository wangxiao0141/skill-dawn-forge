import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";

import {
  inspectMacos,
  NodeInspectorSshExecutor,
  type InspectorSnapshot,
  type InspectorSshExecutor,
} from "../inspector/index.ts";
import {
  computePlanHash,
  computeProfileHash,
  ExitCode,
  type Action,
  type JsonValue,
  type Plan,
  type Target,
} from "../protocol/index.ts";

export interface CatalogEntry {
  readonly id: string;
  readonly provider: string;
  readonly params: Readonly<Record<string, JsonValue>>;
  readonly critical: boolean;
  readonly dependsOn: readonly string[];
}

export interface ProfilePackage {
  readonly id: string;
  readonly state: "present" | "absent";
}

export interface Profile {
  readonly schemaVersion: 1;
  readonly platform: "macos";
  readonly catalogVersion: string;
  readonly packages: readonly ProfilePackage[];
}

export class PlannerInputError extends Error {
  readonly exitCode = ExitCode.ParamError;

  constructor(message: string) {
    super(message);
    this.name = "PlannerInputError";
  }
}

interface CreatePlanInput {
  readonly target: Target;
  readonly snapshot: InspectorSnapshot;
  readonly profile: Profile;
  readonly catalog: readonly CatalogEntry[];
  readonly now: Date;
}

function actionId(packageId: string): string {
  return `action-${packageId}`;
}

function installed(
  entry: CatalogEntry,
  snapshot: InspectorSnapshot,
): boolean | undefined {
  if (entry.provider === "git") {
    return snapshot.git.installed;
  }
  if (entry.provider === "homebrew") {
    const formula = entry.params.formula;
    if (formula === undefined && Object.keys(entry.params).length === 0) {
      return snapshot.homebrew.installed;
    }
    if (typeof formula === "string") {
      return entry.params.cask === true
        ? snapshot.homebrew.casks.includes(formula)
        : snapshot.homebrew.formulae.includes(formula);
    }
  }
  return undefined;
}

function classify(
  entry: CatalogEntry,
  desiredState: "present" | "absent",
  snapshot: InspectorSnapshot,
): Action["type"] {
  const current = installed(entry, snapshot);
  if (current === undefined) {
    return "conflict";
  }
  if (desiredState === "absent") {
    return current ? "conflict" : "skip";
  }
  if (current) {
    return "skip";
  }
  if (
    entry.provider === "homebrew" &&
    Object.keys(entry.params).length === 0
  ) {
    return "manual";
  }
  return "install";
}

function resolveRequestedEntries(
  profile: Profile,
  catalogById: ReadonlyMap<string, CatalogEntry>,
): Map<string, "present" | "absent"> {
  const requested = new Map<string, "present" | "absent">();
  for (const item of profile.packages) {
    if (requested.has(item.id)) {
      throw new PlannerInputError(`Profile 包含重复软件 ID：${item.id}`);
    }
    if (!catalogById.has(item.id)) {
      throw new PlannerInputError(`Profile 引用了未知 Catalog 条目：${item.id}`);
    }
    requested.set(item.id, item.state);
  }

  const visit = (id: string, stack: readonly string[]): void => {
    if (stack.includes(id)) {
      throw new PlannerInputError(
        `Catalog 存在循环依赖：${[...stack, id].join(" -> ")}`,
      );
    }
    const entry = catalogById.get(id);
    if (!entry) {
      throw new PlannerInputError(`引用了不存在的 Catalog 依赖：${id}`);
    }
    if (requested.get(id) === "absent") {
      return;
    }
    for (const dependency of entry.dependsOn) {
      if (!catalogById.has(dependency)) {
        throw new PlannerInputError(
          `Catalog ${id} 引用了不存在的 Catalog 依赖：${dependency}`,
        );
      }
      if (requested.get(dependency) === "absent") {
        throw new PlannerInputError(
          `Profile 要求移除依赖 ${dependency}，但 ${id} 需要它。`,
        );
      }
      if (!requested.has(dependency)) {
        requested.set(dependency, "present");
      }
      visit(dependency, [...stack, id]);
    }
  };
  for (const id of [...requested.keys()]) {
    visit(id, []);
  }
  return requested;
}

function topologicalOrder(
  requested: ReadonlyMap<string, "present" | "absent">,
  catalogById: ReadonlyMap<string, CatalogEntry>,
): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of requested.keys()) {
    const entry = catalogById.get(id);
    if (!entry) {
      throw new PlannerInputError(`Catalog 条目不存在：${id}`);
    }
    const dependencies = entry.dependsOn.filter((dependency) =>
      requested.get(id) === "present" && requested.has(dependency),
    );
    indegree.set(id, dependencies.length);
    for (const dependency of dependencies) {
      const values = dependents.get(dependency) ?? [];
      values.push(id);
      dependents.set(dependency, values);
    }
  }
  const ready = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();
  const result: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    result.push(id);
    for (const dependent of (dependents.get(id) ?? []).sort()) {
      const degree = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, degree);
      if (degree === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (result.length !== requested.size) {
    throw new PlannerInputError("Catalog 存在循环依赖，无法拓扑排序。");
  }
  return result;
}

function validateCatalogGraph(
  catalogById: ReadonlyMap<string, CatalogEntry>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new PlannerInputError(`Catalog 存在循环依赖：${id}`);
    }
    if (visited.has(id)) {
      return;
    }
    const entry = catalogById.get(id);
    if (!entry) {
      throw new PlannerInputError(`Catalog 条目不存在：${id}`);
    }
    visiting.add(id);
    for (const dependency of entry.dependsOn) {
      if (!catalogById.has(dependency)) {
        throw new PlannerInputError(
          `Catalog ${id} 引用了不存在的 Catalog 依赖：${dependency}`,
        );
      }
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...catalogById.keys()].sort()) {
    visit(id);
  }
}

export function createPlan(input: CreatePlanInput): Plan {
  if (
    input.target.platform !== "macos" ||
    input.profile.platform !== "macos" ||
    input.snapshot.platform !== "macos"
  ) {
    throw new PlannerInputError("V1 Planner 仅支持 macOS 目标机。");
  }
  if (
    input.snapshot.remoteUser.toLowerCase() !==
    input.target.identityEvidence.remoteUser.toLowerCase()
  ) {
    throw new PlannerInputError("Inspector remoteUser 与 Target 不一致。");
  }
  if (
    !input.snapshot.homebrew.installed &&
    (input.snapshot.homebrew.version !== undefined ||
      input.snapshot.homebrew.formulae.length > 0 ||
      input.snapshot.homebrew.casks.length > 0)
  ) {
    throw new PlannerInputError("Inspector Homebrew 快照不一致。");
  }
  const catalogById = new Map<string, CatalogEntry>();
  for (const entry of input.catalog) {
    if (catalogById.has(entry.id)) {
      throw new PlannerInputError(`Catalog 包含重复 ID：${entry.id}`);
    }
    catalogById.set(entry.id, entry);
  }
  validateCatalogGraph(catalogById);
  const requested = resolveRequestedEntries(input.profile, catalogById);
  const orderedIds = topologicalOrder(requested, catalogById);
  const actions: Action[] = orderedIds.map((id) => {
    const entry = catalogById.get(id)!;
    return {
      actionId: actionId(id),
      type: classify(entry, requested.get(id)!, input.snapshot),
      packageId: id,
      provider: entry.provider,
      params: entry.params,
      critical: entry.critical,
      dependsOn:
        requested.get(id) === "present"
          ? entry.dependsOn
              .filter((dependency) => requested.has(dependency))
              .map(actionId)
              .sort()
          : [],
    };
  });
  const profileJson = input.profile as unknown as JsonValue;
  const spec = {
    engineVersion: "1",
    catalogVersion: input.profile.catalogVersion,
    targetId: input.target.targetId,
    targetFingerprint: input.target.targetFingerprint,
    profileHash: computeProfileHash(profileJson),
    actions,
  };
  return {
    spec,
    planHash: computePlanHash(spec),
    createdAt: input.now.toISOString(),
  };
}

function readJsonFile(path: string, label: string): unknown {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new PlannerInputError(`${label} 必须是 regular file。`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new PlannerInputError(`${label} 不是合法 JSON。`);
  }
}

export function parseProfile(value: unknown): Profile {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new PlannerInputError("Profile 结构无效。");
  }
  const profile = value as Partial<Profile>;
  if (
    profile.schemaVersion !== 1 ||
    profile.platform !== "macos" ||
    typeof profile.catalogVersion !== "string" ||
    !/^v[0-9]+$/.test(profile.catalogVersion) ||
    !Array.isArray(profile.packages)
  ) {
    throw new PlannerInputError("Profile 结构无效。");
  }
  for (const item of profile.packages) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(item.id) ||
      (item.state !== "present" && item.state !== "absent") ||
      Object.keys(item).some((key) => key !== "id" && key !== "state")
    ) {
      throw new PlannerInputError("Profile packages 结构无效。");
    }
  }
  if (
    Object.keys(profile).some(
      (key) =>
        !["schemaVersion", "platform", "catalogVersion", "packages"].includes(
          key,
        ),
    )
  ) {
    throw new PlannerInputError("Profile 包含未知字段。");
  }
  return profile as Profile;
}

export function loadCatalog(
  catalogDirectory: string,
  catalogVersion: string,
): CatalogEntry[] {
  if (!/^v[0-9]+$/.test(catalogVersion)) {
    throw new PlannerInputError("catalogVersion 无效。");
  }
  const schema = readJsonFile(
    join(catalogDirectory, "catalog.schema.json"),
    "Catalog schema",
  );
  const catalog = readJsonFile(
    join(catalogDirectory, `${catalogVersion}.json`),
    "Catalog",
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema as object);
  if (!validate(catalog)) {
    throw new PlannerInputError(
      `Catalog schema 验证失败：${ajv.errorsText(validate.errors)}`,
    );
  }
  return catalog as CatalogEntry[];
}

export async function planFromFiles(options: {
  readonly target: Target;
  readonly homeDirectory: string;
  readonly profilePath: string;
  readonly catalogDirectory: string;
  readonly now?: () => Date;
  readonly ssh?: InspectorSshExecutor;
}): Promise<Plan> {
  const profile = parseProfile(
    readJsonFile(resolve(options.profilePath), "Profile"),
  );
  const catalog = loadCatalog(
    options.catalogDirectory,
    profile.catalogVersion,
  );
  const targetDirectory = join(
    options.homeDirectory,
    ".dawn-forge",
    "targets",
    options.target.targetId,
  );
  const snapshot = await inspectMacos(
    {
      configPath: join(targetDirectory, "ssh_config"),
      alias: options.target.locators.sshAlias,
    },
    options.ssh ?? new NodeInspectorSshExecutor(),
  );
  return createPlan({
    target: options.target,
    snapshot,
    profile,
    catalog,
    now: options.now?.() ?? new Date(),
  });
}

export function writePlanAtomic(path: string, plan: Plan): void {
  const resolvedPath = resolve(path);
  const parent = dirname(resolvedPath);
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new PlannerInputError("Plan 输出目录必须是 regular directory。");
  }
  const temporaryPath = `${resolvedPath}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(descriptor, `${JSON.stringify(plan, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, resolvedPath);
  } finally {
    if (existsSync(temporaryPath)) {
      rmSync(temporaryPath, { force: true });
    }
  }
}
