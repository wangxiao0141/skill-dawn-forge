import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import properLockfile from "proper-lockfile";

import {
  computeTargetFingerprint,
  ExitCode,
  type IdentityEvidence,
  type Target,
} from "../protocol/index.ts";

export type TargetPlatform = "macos" | "windows";

export interface ControllerKey {
  readonly privateKeyPath: string;
  readonly publicKeyPath: string;
  readonly publicKeyLine: string;
  readonly publicKeyBlob: string;
}

export interface ControllerKeyProvider {
  load(): Promise<ControllerKey>;
  ensure(): Promise<ControllerKey>;
}

export interface TargetConnection {
  readonly targetId: string;
  readonly alias: string;
  readonly host: string;
  readonly user: string;
  readonly platform: TargetPlatform;
  readonly configPath: string;
  readonly knownHostsPath: string;
  readonly identityFile: string;
}

export interface TargetProbe {
  readonly platform: TargetPlatform;
  readonly identityEvidence: IdentityEvidence;
}

export interface SshTargetAdapter {
  authorizationCommand(
    connection: TargetConnection,
    authorizedKeyLine: string,
  ): string;
  verifyAuthorization(
    connection: TargetConnection,
    authorizedKeyLine: string,
  ): Promise<void>;
  rollbackAuthorization(
    connection: TargetConnection,
    authorizedKeyLine: string,
  ): Promise<void>;
  probe(connection: TargetConnection): Promise<TargetProbe>;
  revoke(
    connection: TargetConnection,
    publicKeyBlob: string,
  ): Promise<void>;
}

interface StoredTarget extends Target {
  readonly platform: "macos";
  readonly connection: {
    readonly host: string;
    readonly user: string;
    readonly identityFile: string;
  };
  readonly controllerPublicKeyBlob: string;
}

interface TargetManagerOptions {
  readonly homeDirectory: string;
  readonly now: () => Date;
  readonly keyProvider: ControllerKeyProvider;
  readonly ssh: SshTargetAdapter;
  readonly authorize: (command: string) => Promise<boolean>;
}

export interface BootstrapTargetInput {
  readonly host: string;
  readonly user: string;
  readonly name: string;
}

export class IdentityConflictError extends Error {
  readonly exitCode = ExitCode.IdentityConflict;

  constructor(fields: readonly string[]) {
    super(`目标身份冲突：${fields.join(", ")} 已变化。`);
    this.name = "IdentityConflictError";
  }
}

export class TargetInputError extends Error {
  readonly exitCode = ExitCode.ParamError;

  constructor(message: string) {
    super(message);
    this.name = "TargetInputError";
  }
}

export class TargetNeedsUserError extends Error {
  readonly exitCode = ExitCode.NeedsUser;

  constructor() {
    super("尚未确认 authorized_keys 已安装。");
    this.name = "TargetNeedsUserError";
  }
}

export class TargetRollbackError extends Error {
  readonly exitCode = ExitCode.ActionFailed;

  constructor(
    originalError: unknown,
    rollbackError: unknown,
    recoveryDirectory: string,
  ) {
    const original =
      originalError instanceof Error
        ? originalError.message
        : String(originalError);
    const rollback =
      rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
    super(
      `Target bootstrap 失败且远端公钥回滚失败：${original}；回滚错误：${rollback}。恢复证据保留在 ${recoveryDirectory}`,
    );
    this.name = "TargetRollbackError";
  }
}

export class TargetLockError extends Error {
  readonly exitCode = ExitCode.LockConflict;

  constructor(targetId: string) {
    super(`Target lifecycle 已被其他进程锁定：${targetId}`);
    this.name = "TargetLockError";
  }
}

function assertSafeValue(value: string, label: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    /\s/.test(normalized)
  ) {
    throw new TargetInputError(`${label} 无效。`);
  }
  return normalized;
}

function isTrustedLanHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized.endsWith(".local") || normalized.endsWith(".home.arpa")) {
    return true;
  }
  if (isIP(normalized) === 4) {
    const [first, second] = normalized
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  const unbracketed = normalized.replace(/^\[|\]$/g, "");
  const [address, zone] = unbracketed.split("%", 2);
  if (isIP(address) !== 6) {
    return false;
  }
  return (
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    (/^fe[89ab]/.test(address) && Boolean(zone))
  );
}

function targetIdFromName(name: string): string {
  const targetId = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetId)) {
    throw new TargetInputError("--name 无法转换为有效 targetId。");
  }
  return targetId;
}

function validateTargetId(targetId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetId)) {
    throw new TargetInputError(`targetId 无效：${targetId}`);
  }
}

function quoteSshConfig(value: string): string {
  return `"${value.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
}

export function renderSshConfig(connection: TargetConnection): string {
  return [
    `Host ${connection.alias}`,
    `  HostName ${connection.host}`,
    `  User ${connection.user}`,
    `  IdentityFile ${quoteSshConfig(connection.identityFile)}`,
    "  IdentitiesOnly yes",
    "  ClearAllForwardings yes",
    "  ForwardAgent no",
    "  ForwardX11 no",
    "  PermitLocalCommand no",
    "  ControlMaster no",
    "  ControlPath none",
    "  ControlPersist no",
    "  CanonicalizeHostname no",
    "  ForkAfterAuthentication no",
    "  StdinNull no",
    "  RequestTTY no",
    "  Tunnel no",
    "  RemoteCommand none",
    "  ProxyCommand none",
    "  ProxyJump none",
    "  KnownHostsCommand none",
    "  IdentityAgent none",
    "  AddKeysToAgent no",
    "  UpdateHostKeys no",
    "  BatchMode yes",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    "  PreferredAuthentications publickey",
    "  PubkeyAuthentication yes",
    "  HostbasedAuthentication no",
    "  GSSAPIAuthentication no",
    "  StrictHostKeyChecking yes",
    "  ConnectTimeout 8",
    "  ConnectionAttempts 1",
    `  UserKnownHostsFile ${quoteSshConfig(connection.knownHostsPath)}`,
    "  GlobalKnownHostsFile none",
    "",
  ].join("\n");
}

export function buildAuthorizedKeyLine(
  publicKeyLine: string,
  controllerName = hostname(),
): string {
  const normalized = publicKeyLine.trim();
  const publicKeyBlob = normalized.match(
    /^ssh-ed25519 ([A-Za-z0-9+/=]+)(?: .*)?$/,
  )?.[1];
  if (!publicKeyBlob) {
    throw new TargetInputError("控制机公钥不是合法的 ED25519 public key。");
  }
  const comment = assertSafeValue(controllerName, "控制机 hostname");
  return `no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ssh-ed25519 ${publicKeyBlob} ${comment}`;
}

function writeFileAtomic(path: string, content: string, mode = 0o600): void {
  assertRegularDirectory(dirname(path), "原子写入目录");
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    mode,
  );
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
}

function assertRegularFile(path: string, label: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new TargetInputError(`${label} 不存在。`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new TargetInputError(`${label} 必须是 regular file，不能是 symlink。`);
  }
}

function assertRegularDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TargetInputError(`${label} 必须是 directory，不能是 symlink。`);
  }
}

function identityDifferences(
  expected: IdentityEvidence,
  actual: IdentityEvidence,
): string[] {
  return (
    [
      "sshHostKeyFingerprint",
      "machineId",
      "architecture",
      "remoteUser",
    ] as const
  ).filter((field) => expected[field] !== actual[field]);
}

function validateProbe(
  probe: TargetProbe,
  expectedPlatform: TargetPlatform,
  expectedUser: string,
): void {
  if (probe.platform !== expectedPlatform) {
    throw new IdentityConflictError(["platform"]);
  }
  for (const [field, value] of Object.entries(probe.identityEvidence)) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new TargetInputError(`identityEvidence.${field} 无效。`);
    }
  }
  if (
    probe.identityEvidence.remoteUser.toLowerCase() !==
    expectedUser.toLowerCase()
  ) {
    throw new IdentityConflictError(["remoteUser"]);
  }
}

function storedTargetConnection(
  target: StoredTarget,
  targetDirectory: string,
): TargetConnection {
  return {
    targetId: target.targetId,
    alias: target.locators.sshAlias,
    host: assertSafeValue(target.connection.host, "存储的 host"),
    user: assertSafeValue(target.connection.user, "存储的 user"),
    platform: target.platform,
    configPath: join(targetDirectory, "ssh_config"),
    knownHostsPath: join(targetDirectory, "known_hosts"),
    identityFile: target.connection.identityFile,
  };
}

function parseStoredTarget(
  content: string,
  expectedTargetId: string,
): StoredTarget {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new TargetInputError("target.json 不是合法 JSON。");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TargetInputError("target.json 结构无效。");
  }
  const target = value as Partial<StoredTarget>;
  if (
    target.targetId !== expectedTargetId ||
    typeof target.displayName !== "string" ||
    target.platform !== "macos" ||
    target.locators?.sshAlias !== `dawn-${expectedTargetId}` ||
    typeof target.identityEvidence?.sshHostKeyFingerprint !== "string" ||
    typeof target.identityEvidence.machineId !== "string" ||
    typeof target.identityEvidence.architecture !== "string" ||
    typeof target.identityEvidence.remoteUser !== "string" ||
    typeof target.targetFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(target.targetFingerprint) ||
    typeof target.registeredAt !== "string" ||
    typeof target.connection?.host !== "string" ||
    typeof target.connection.user !== "string" ||
    typeof target.connection.identityFile !== "string" ||
    typeof target.controllerPublicKeyBlob !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(target.controllerPublicKeyBlob)
  ) {
    throw new TargetInputError("target.json 结构无效。");
  }
  if (
    computeTargetFingerprint(target.identityEvidence) !==
    target.targetFingerprint
  ) {
    throw new TargetInputError("target.json 的 targetFingerprint 不一致。");
  }
  return target as StoredTarget;
}

export class TargetManager {
  readonly #options: TargetManagerOptions;
  readonly #stateDirectory: string;
  readonly #targetsDirectory: string;

  constructor(options: TargetManagerOptions) {
    this.#options = options;
    this.#stateDirectory = join(options.homeDirectory, ".dawn-forge");
    this.#targetsDirectory = join(this.#stateDirectory, "targets");
  }

  async bootstrap(input: BootstrapTargetInput): Promise<StoredTarget> {
    const host = assertSafeValue(input.host, "--host");
    const user = assertSafeValue(input.user, "--user");
    if (
      host.length > 253 ||
      !/^[A-Za-z0-9._:%[\]-]+$/.test(host) ||
      !isTrustedLanHost(host)
    ) {
      throw new TargetInputError("--host 必须是受信任的局域网地址。");
    }
    if (user.length > 128 || !/^[A-Za-z0-9._@\\-]+$/.test(user)) {
      throw new TargetInputError("--user 无效。");
    }
    const displayName = input.name.trim();
    if (!displayName || /[\u0000-\u001f\u007f]/.test(displayName)) {
      throw new TargetInputError("--name 无效。");
    }
    const platform = "macos";
    const targetId = targetIdFromName(displayName);
    const alias = `dawn-${targetId}`;
    this.#ensureStateDirectories();
    const releaseLock = this.#acquireTargetLock(targetId);
    try {
    const finalDirectory = join(this.#targetsDirectory, targetId);
    const stagingDirectory = join(
      this.#targetsDirectory,
      `.${targetId}.bootstrap-${randomUUID()}`,
    );
    if (existsSync(join(finalDirectory, "target.json"))) {
      const existing = this.#readTarget(targetId);
      const inputDifferences = [
        ...(existing.connection.host !== host ? ["host"] : []),
        ...(existing.connection.user.toLowerCase() !== user.toLowerCase()
          ? ["remoteUser"]
          : []),
      ];
      if (inputDifferences.length > 0) {
        throw new IdentityConflictError(inputDifferences);
      }
      await this.#verifyCurrentIdentity(existing, finalDirectory);
      const completedBootstrapPath = join(
        finalDirectory,
        "bootstrap.json",
      );
      if (existsSync(completedBootstrapPath)) {
        assertRegularFile(
          completedBootstrapPath,
          "已完成的 bootstrap pending state",
        );
        rmSync(completedBootstrapPath, { force: false });
      }
      return existing;
    }

    this.#assertNoPendingBootstrap();
    this.#assertUniqueLocator(host, targetId);
    const key = await this.#options.keyProvider.ensure();
    mkdirSync(stagingDirectory, { mode: 0o700 });
    let authorized = false;
    let published = false;
    let preserveStaging = false;
    let stagingConnection: TargetConnection | undefined;
    let authorizedKeyLine: string | undefined;

    try {
      stagingConnection = {
        targetId,
        alias,
        host,
        user,
        platform,
        configPath: join(stagingDirectory, "ssh_config"),
        knownHostsPath: join(stagingDirectory, "known_hosts"),
        identityFile: key.privateKeyPath,
      };
      writeFileAtomic(
        stagingConnection.configPath,
        renderSshConfig(stagingConnection),
      );
      authorizedKeyLine = buildAuthorizedKeyLine(
        key.publicKeyLine,
        `${hostname()}-dawn-${randomUUID()}`,
      );
      writeFileAtomic(
        join(stagingDirectory, "bootstrap.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            targetId,
            host,
            user,
            controllerPublicKeyBlob: key.publicKeyBlob,
            authorizedKeyLine,
            startedAt: this.#options.now().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
      const command = this.#options.ssh.authorizationCommand(
        stagingConnection,
        authorizedKeyLine,
      );
      if (!(await this.#options.authorize(command))) {
        throw new TargetNeedsUserError();
      }
      authorized = true;
      await this.#options.ssh.verifyAuthorization(
        stagingConnection,
        authorizedKeyLine,
      );

      const probe = await this.#options.ssh.probe(stagingConnection);
      validateProbe(probe, platform, user);
      this.#assertUniqueIdentity(probe.identityEvidence, targetId);
      assertRegularFile(
        stagingConnection.knownHostsPath,
        "受控 known_hosts",
      );
      const targetFingerprint = computeTargetFingerprint(
        probe.identityEvidence,
      );
      const finalConnection: TargetConnection = {
        ...stagingConnection,
        platform,
        configPath: join(finalDirectory, "ssh_config"),
        knownHostsPath: join(finalDirectory, "known_hosts"),
      };
      const target: StoredTarget = {
        targetId,
        displayName,
        platform,
        locators: { sshAlias: alias },
        identityEvidence: probe.identityEvidence,
        targetFingerprint,
        registeredAt: this.#options.now().toISOString(),
        connection: {
          host,
          user,
          identityFile: key.privateKeyPath,
        },
        controllerPublicKeyBlob: key.publicKeyBlob,
      };
      writeFileAtomic(
        stagingConnection.configPath,
        renderSshConfig(finalConnection),
      );
      writeFileAtomic(
        join(stagingDirectory, "target.json"),
        `${JSON.stringify(target, null, 2)}\n`,
      );
      renameSync(stagingDirectory, finalDirectory);
      published = true;
      rmSync(join(finalDirectory, "bootstrap.json"), { force: false });
      return target;
    } catch (error) {
      if (
        authorized &&
        !published &&
        stagingConnection &&
        authorizedKeyLine
      ) {
        try {
          writeFileAtomic(
            stagingConnection.configPath,
            renderSshConfig(stagingConnection),
          );
          await this.#options.ssh.rollbackAuthorization(
            stagingConnection,
            authorizedKeyLine,
          );
        } catch (rollbackError) {
          preserveStaging = true;
          throw new TargetRollbackError(
            error,
            rollbackError,
            stagingDirectory,
          );
        }
      }
      throw error;
    } finally {
      if (!preserveStaging && existsSync(stagingDirectory)) {
        rmSync(stagingDirectory, { recursive: true, force: true });
      }
    }
    } finally {
      releaseLock();
    }
  }

  async inspect(targetId: string): Promise<StoredTarget> {
    return this.withVerifiedTarget(targetId, async (target) => target);
  }

  async withVerifiedTarget<T>(
    targetId: string,
    operation: (target: StoredTarget) => Promise<T>,
  ): Promise<T> {
    validateTargetId(targetId);
    this.#assertTargetStateAvailable(targetId);
    const releaseLock = this.#acquireTargetLock(targetId);
    try {
      const target = this.#readTarget(targetId);
      const targetDirectory = join(this.#targetsDirectory, targetId);
      await this.#verifyCurrentIdentity(target, targetDirectory);
      return await operation(target);
    } finally {
      releaseLock();
    }
  }

  async revoke(targetId: string): Promise<void> {
    validateTargetId(targetId);
    this.#assertTargetStateAvailable(targetId);
    const releaseLock = this.#acquireTargetLock(targetId);
    try {
      const targetDirectory = join(this.#targetsDirectory, targetId);
      const target = this.#readTarget(targetId);
      const revokePath = join(targetDirectory, "revoke.json");
      if (existsSync(revokePath)) {
        assertRegularFile(revokePath, "revoke pending state");
        throw new TargetInputError(
          `Target ${targetId} 存在未完成的 revoke；已保留恢复证据，不能自动重试或删除。`,
        );
      }
      await this.#verifyCurrentIdentity(target, targetDirectory);
      writeFileAtomic(
        revokePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            targetId,
            startedAt: this.#options.now().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
      await this.#options.ssh.revoke(
        storedTargetConnection(target, targetDirectory),
        target.controllerPublicKeyBlob,
      );
      rmSync(targetDirectory, { recursive: true, force: false });
    } finally {
      releaseLock();
    }
  }

  #readTarget(targetId: string): StoredTarget {
    const targetDirectory = join(this.#targetsDirectory, targetId);
    const targetPath = join(targetDirectory, "target.json");
    try {
      this.#assertExistingStateDirectories();
      assertRegularDirectory(targetDirectory, "Target 目录");
      assertRegularFile(targetPath, "target.json");
      return parseStoredTarget(readFileSync(targetPath, "utf8"), targetId);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new TargetInputError(`找不到 Target：${targetId}`);
      }
      throw error;
    }
  }

  async #verifyCurrentIdentity(
    target: StoredTarget,
    targetDirectory: string,
  ): Promise<void> {
    const key = await this.#options.keyProvider.load();
    if (key.publicKeyBlob !== target.controllerPublicKeyBlob) {
      throw new IdentityConflictError(["controllerPublicKey"]);
    }
    if (key.privateKeyPath !== target.connection.identityFile) {
      throw new IdentityConflictError(["controllerIdentityFile"]);
    }
    const connection = storedTargetConnection(target, targetDirectory);
    assertRegularFile(connection.configPath, "Target SSH config");
    assertRegularFile(connection.knownHostsPath, "受控 known_hosts");
    if (
      readFileSync(connection.configPath, "utf8") !==
      renderSshConfig(connection)
    ) {
      throw new TargetInputError("Target SSH config 已漂移。");
    }
    const probe = await this.#options.ssh.probe(connection);
    validateProbe(probe, target.platform, target.connection.user);
    const differences = identityDifferences(
      target.identityEvidence,
      probe.identityEvidence,
    );
    if (
      differences.length > 0 ||
      computeTargetFingerprint(probe.identityEvidence) !==
        target.targetFingerprint
    ) {
      throw new IdentityConflictError(
        differences.length > 0 ? differences : ["targetFingerprint"],
      );
    }
  }

  #ensureStateDirectories(): void {
    assertRegularDirectory(this.#options.homeDirectory, "控制机 home 目录");
    if (!existsSync(this.#stateDirectory)) {
      mkdirSync(this.#stateDirectory, { mode: 0o700 });
    }
    assertRegularDirectory(this.#stateDirectory, "Dawn Forge 状态目录");
    if (!existsSync(this.#targetsDirectory)) {
      mkdirSync(this.#targetsDirectory, { mode: 0o700 });
    }
    assertRegularDirectory(this.#targetsDirectory, "Target 根目录");
  }

  #assertExistingStateDirectories(): void {
    assertRegularDirectory(this.#options.homeDirectory, "控制机 home 目录");
    assertRegularDirectory(this.#stateDirectory, "Dawn Forge 状态目录");
    assertRegularDirectory(this.#targetsDirectory, "Target 根目录");
  }

  #assertTargetStateAvailable(targetId: string): void {
    try {
      this.#assertExistingStateDirectories();
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new TargetInputError(`找不到 Target：${targetId}`);
      }
      throw error;
    }
  }

  #acquireTargetLock(targetId: string): () => void {
    try {
      return properLockfile.lockSync(this.#targetsDirectory, {
        lockfilePath: join(this.#targetsDirectory, ".registry.lock"),
        realpath: false,
        retries: 0,
        // 同步 SSH 最坏连续阻塞约 55 秒；stale 必须留出显著余量。
        stale: 120_000,
        update: 10_000,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ELOCKED"
      ) {
        throw new TargetLockError(targetId);
      }
      throw error;
    }
  }

  #storedTargets(excludingTargetId: string): StoredTarget[] {
    const targets: StoredTarget[] = [];
    for (const entry of readdirSync(this.#targetsDirectory, {
      withFileTypes: true,
    })) {
      if (entry.name.startsWith(".") || entry.name === excludingTargetId) {
        continue;
      }
      validateTargetId(entry.name);
      if (!entry.isDirectory()) {
        throw new TargetInputError(
          `Target 根目录包含非 directory 条目：${entry.name}`,
        );
      }
      targets.push(this.#readTarget(entry.name));
    }
    return targets;
  }

  #assertNoPendingBootstrap(): void {
    for (const entry of readdirSync(this.#targetsDirectory, {
      withFileTypes: true,
    })) {
      if (
        !entry.name.startsWith(".") ||
        !entry.name.includes(".bootstrap-") ||
        !entry.isDirectory()
      ) {
        continue;
      }
      const pendingPath = join(
        this.#targetsDirectory,
        entry.name,
        "bootstrap.json",
      );
      if (existsSync(pendingPath)) {
        assertRegularFile(pendingPath, "bootstrap pending state");
        throw new TargetInputError(
          `发现未完成的 Target bootstrap：${pendingPath}。已保留恢复证据，不能通过新 name 绕过。`,
        );
      }
    }
  }

  #assertUniqueLocator(host: string, targetId: string): void {
    const duplicate = this.#storedTargets(targetId).find(
      (target) =>
        target.connection.host.toLowerCase() === host.toLowerCase(),
    );
    if (duplicate) {
      throw new IdentityConflictError([
        `host 已由 ${duplicate.targetId} 注册`,
      ]);
    }
  }

  #assertUniqueIdentity(
    identity: IdentityEvidence,
    targetId: string,
  ): void {
    const duplicate = this.#storedTargets(targetId).find(
      (target) =>
        target.identityEvidence.machineId === identity.machineId ||
        target.identityEvidence.sshHostKeyFingerprint ===
          identity.sshHostKeyFingerprint,
    );
    if (duplicate) {
      throw new IdentityConflictError([
        `机器身份已由 ${duplicate.targetId} 注册`,
      ]);
    }
  }
}

interface ProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

type ProcessRunner = (
  command: string,
  args: readonly string[],
  timeout: number,
) => ProcessResult;

function defaultProcessRunner(
  command: string,
  args: readonly string[],
  timeout: number,
): ProcessResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

export class NodeControllerKeyProvider implements ControllerKeyProvider {
  readonly #homeDirectory: string;
  readonly #sshKeygen: string;
  readonly #run: ProcessRunner;

  constructor(
    homeDirectory: string,
    sshKeygen = "ssh-keygen",
    run: ProcessRunner = defaultProcessRunner,
  ) {
    this.#homeDirectory = homeDirectory;
    this.#sshKeygen = sshKeygen;
    this.#run = run;
  }

  async load(): Promise<ControllerKey> {
    return this.#read(false);
  }

  async ensure(): Promise<ControllerKey> {
    return this.#read(true);
  }

  #read(createIfMissing: boolean): ControllerKey {
    assertRegularDirectory(this.#homeDirectory, "控制机 home 目录");
    const privateKeyPath = resolve(
      this.#homeDirectory,
      ".ssh",
      "id_ed25519",
    );
    const publicKeyPath = `${privateKeyPath}.pub`;
    const sshDirectory = dirname(privateKeyPath);
    if (!existsSync(sshDirectory)) {
      if (!createIfMissing) {
        throw new TargetInputError(
          "SSH key pair 不存在；已有 Target 不允许自动换 key。",
        );
      }
      mkdirSync(sshDirectory, { mode: 0o700 });
    }
    assertRegularDirectory(sshDirectory, "控制机 .ssh 目录");
    const privateExists = existsSync(privateKeyPath);
    const publicExists = existsSync(publicKeyPath);
    if (privateExists !== publicExists) {
      throw new TargetInputError(
        "SSH key pair 不完整；为避免覆盖，已停止 bootstrap。",
      );
    }
    if (!privateExists && !createIfMissing) {
      throw new TargetInputError(
        "SSH key pair 不存在；已有 Target 不允许自动换 key。",
      );
    }
    if (!privateExists) {
      const result = this.#run(
        this.#sshKeygen,
        [
          "-t",
          "ed25519",
          "-f",
          privateKeyPath,
          "-N",
          "",
          "-C",
          `dawn-forge@${hostname()}`,
        ],
        10_000,
      );
      if (result.error || result.status !== 0) {
        throw new TargetInputError(
          result.stderr.trim() ||
            result.error?.message ||
            "无法创建 SSH key。",
        );
      }
    }
    assertRegularFile(privateKeyPath, "SSH private key");
    assertRegularFile(publicKeyPath, "SSH public key");
    if (process.platform !== "win32") {
      chmodSync(privateKeyPath, 0o600);
      chmodSync(publicKeyPath, 0o644);
    }
    const publicKeyLine = readFileSync(publicKeyPath, "utf8").trim();
    const match = publicKeyLine.match(
      /^ssh-ed25519 ([A-Za-z0-9+/=]+)(?: .*)?$/,
    );
    if (!match) {
      throw new TargetInputError("默认 SSH public key 不是 ED25519。");
    }
    const derived = this.#run(
      this.#sshKeygen,
      ["-y", "-P", "", "-f", privateKeyPath],
      10_000,
    );
    const derivedBlob = derived.stdout
      .trim()
      .match(/^ssh-ed25519 ([A-Za-z0-9+/=]+)(?: .*)?$/)?.[1];
    if (
      derived.error ||
      derived.status !== 0 ||
      !derivedBlob ||
      derivedBlob !== match[1]
    ) {
      throw new TargetInputError(
        "SSH private key 无效、需要 passphrase，或与 public key 不匹配。",
      );
    }
    return {
      privateKeyPath,
      publicKeyPath,
      publicKeyLine,
      publicKeyBlob: match[1],
    };
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsControllerCommand(
  executable: string,
  args: readonly string[],
): string {
  const script = [
    `$dawnArguments=@(${args.map(powershellQuote).join(",")})`,
    `& ${powershellQuote(executable)} @dawnArguments`,
    "exit $LASTEXITCODE",
  ].join("; ");
  return `powershell.exe -NoProfile -EncodedCommand ${Buffer.from(
    script,
    "utf16le",
  ).toString("base64")}`;
}

function macosAuthorizeScript(
  authorizedKeyLine: string,
  publicKeyBlob: string,
): string {
  const encodedLine = Buffer.from(authorizedKeyLine).toString("base64");
  return [
    "set -e",
    `KEY="$(printf %s '${encodedLine}' | base64 -D)"`,
    `BLOB='${publicKeyBlob}'`,
    "umask 077",
    'mkdir -p "$HOME/.ssh"',
    'AUTH="$HOME/.ssh/authorized_keys"',
    'TMP="$AUTH.dawn-forge.$$"',
    'trap \'rm -f "$TMP"\' EXIT',
    'touch "$AUTH"',
    'chmod 700 "$HOME/.ssh"',
    'chmod 600 "$AUTH"',
    "if awk -v blob=\"$BLOB\" '{ for (i=1; i<=NF; i++) if ($i == blob) found=1 } END { exit found ? 0 : 1 }' \"$AUTH\"; then printf '%s\\n' 'authorized_keys already contains controller key' >&2; exit 65; fi",
    'cp "$AUTH" "$TMP"',
    'printf \'%s\\n\' "$KEY" >> "$TMP"',
    'mv "$TMP" "$AUTH"',
    'chmod 600 "$AUTH"',
  ].join("; ");
}

function windowsRemoteCommand(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(
    script,
    "utf16le",
  ).toString("base64")}`;
}

function windowsAuthorizeScript(
  authorizedKeyLine: string,
  publicKeyBlob: string,
): string {
  const encodedLine = Buffer.from(authorizedKeyLine).toString("base64");
  return [
    "$ErrorActionPreference='Stop'",
    "$d=Join-Path $HOME '.ssh'",
    "New-Item -ItemType Directory -Force -Path $d | Out-Null",
    "$f=Join-Path $d 'authorized_keys'",
    `$k=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedLine}'))`,
    `$b='${publicKeyBlob}'`,
    "$lines=if(Test-Path -LiteralPath $f){[IO.File]::ReadAllLines($f)}else{@()}",
    "if(@($lines|Where-Object{($_ -split '\\s+') -contains $b}).Count -gt 0){throw 'authorized_keys already contains controller key'}",
    "[IO.File]::WriteAllText($f,((@($lines+$k)-join \"`n\")+\"`n\"),[Text.UTF8Encoding]::new($false))",
    '& icacls.exe $f /inheritance:r /grant:r "${env:USERNAME}:F" "SYSTEM:F" | Out-Null',
    "if($LASTEXITCODE -ne 0){throw 'authorized_keys ACL update failed'}",
  ].join("; ");
}

export function macosProbeCommand(): string {
  return [
    "set -e",
    "printf '%s\\n' __DAWN_FORGE_MACOS_V1__",
    "id -un",
    "uname -s",
    "uname -m",
    "sw_vers -productVersion",
    "scutil --get LocalHostName 2>/dev/null || printf '\\n'",
    "scutil --get ComputerName 2>/dev/null || printf '\\n'",
    "scutil --get HostName 2>/dev/null || printf '\\n'",
    "ioreg -rd1 -c IOPlatformExpertDevice",
  ].join("; ");
}

export function windowsProbeCommand(): string {
  return windowsRemoteCommand(
    [
      "$ErrorActionPreference='Stop'",
      "$machineId=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid",
      "$value=[ordered]@{marker='__DAWN_FORGE_WINDOWS_V1__';user=[Environment]::UserName;os='Windows';architecture=$env:PROCESSOR_ARCHITECTURE;version=[Environment]::OSVersion.Version.ToString();machineId=$machineId;computerName=$env:COMPUTERNAME}",
      "$value | ConvertTo-Json -Compress",
    ].join("; "),
  );
}

function parseMacosProbe(output: string): Omit<TargetProbe, "platform"> {
  const lines = output.replaceAll("\r", "").split("\n");
  const machineId = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
  if (
    lines[0] !== "__DAWN_FORGE_MACOS_V1__" ||
    !lines[1] ||
    lines[2] !== "Darwin" ||
    !lines[3] ||
    !machineId
  ) {
    throw new TargetInputError("无法解析 macOS identity probe。");
  }
  return {
    identityEvidence: {
      sshHostKeyFingerprint: "",
      machineId,
      architecture: lines[3],
      remoteUser: lines[1],
    },
  };
}

function parseWindowsProbe(output: string): Omit<TargetProbe, "platform"> {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    throw new TargetInputError("无法解析 Windows identity probe。");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TargetInputError("无法解析 Windows identity probe。");
  }
  const record = value as Record<string, unknown>;
  if (
    record.marker !== "__DAWN_FORGE_WINDOWS_V1__" ||
    typeof record.user !== "string" ||
    typeof record.architecture !== "string" ||
    typeof record.machineId !== "string"
  ) {
    throw new TargetInputError("无法解析 Windows identity probe。");
  }
  return {
    identityEvidence: {
      sshHostKeyFingerprint: "",
      machineId: record.machineId,
      architecture: record.architecture,
      remoteUser: record.user,
    },
  };
}

export class NodeSshTargetAdapter implements SshTargetAdapter {
  readonly #ssh: string;
  readonly #sshKeygen: string;
  readonly #run: ProcessRunner;

  constructor(
    ssh = "ssh",
    sshKeygen = "ssh-keygen",
    run: ProcessRunner = defaultProcessRunner,
  ) {
    this.#ssh = ssh;
    this.#sshKeygen = sshKeygen;
    this.#run = run;
  }

  authorizationCommand(
    connection: TargetConnection,
    authorizedKeyLine: string,
  ): string {
    const publicKeyBlob = authorizedKeyLine.match(
      /\bssh-ed25519 ([A-Za-z0-9+/=]+)(?:\s|$)/,
    )?.[1];
    if (!publicKeyBlob) {
      throw new TargetInputError("无法解析 authorized_keys public key。");
    }
    const remoteCommand =
      connection.platform === "windows"
        ? windowsRemoteCommand(
            windowsAuthorizeScript(authorizedKeyLine, publicKeyBlob),
          )
        : macosAuthorizeScript(authorizedKeyLine, publicKeyBlob);
    const args = [
      "-F",
      "none",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ForwardX11=no",
      "-o",
      "IdentityAgent=none",
      "-o",
      `UserKnownHostsFile=${connection.knownHostsPath}`,
      "-o",
      "GlobalKnownHostsFile=none",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-l",
      connection.user,
      connection.host,
      remoteCommand,
    ];
    return process.platform === "win32"
      ? windowsControllerCommand(this.#ssh, args)
      : [this.#ssh, ...args].map(shellQuote).join(" ");
  }

  async probe(connection: TargetConnection): Promise<TargetProbe> {
    const result = this.#run(
      this.#ssh,
      [
        "-F",
        connection.configPath,
        connection.alias,
        connection.platform === "windows"
          ? windowsProbeCommand()
          : macosProbeCommand(),
      ],
      15_000,
    );
    this.#assertSshSucceeded(result);
    const parsed =
      connection.platform === "windows"
        ? parseWindowsProbe(result.stdout)
        : parseMacosProbe(result.stdout);
    return {
      platform: connection.platform,
      identityEvidence: {
        ...parsed.identityEvidence,
        sshHostKeyFingerprint: this.#hostKeyFingerprint(
          connection.knownHostsPath,
        ),
      },
    };
  }

  async verifyAuthorization(
    connection: TargetConnection,
    authorizedKeyLine: string,
  ): Promise<void> {
    const encodedLine = Buffer.from(authorizedKeyLine).toString("base64");
    const remoteCommand =
      connection.platform === "windows"
        ? windowsRemoteCommand(
            [
              "$ErrorActionPreference='Stop'",
              "$f=Join-Path (Join-Path $HOME '.ssh') 'authorized_keys'",
              `$k=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedLine}'))`,
              "if(-not(Test-Path -LiteralPath $f)){throw 'authorized_keys missing'}",
              "if(-not([IO.File]::ReadAllLines($f) -ccontains $k)){throw 'controlled authorized_keys entry missing'}",
            ].join("; "),
          )
        : [
            "set -e",
            `KEY="$(printf %s '${encodedLine}' | base64 -D)"`,
            'AUTH="$HOME/.ssh/authorized_keys"',
            'grep -Fqx -- "$KEY" "$AUTH"',
          ].join("; ");
    const result = this.#run(
      this.#ssh,
      ["-F", connection.configPath, connection.alias, remoteCommand],
      15_000,
    );
    this.#assertSshSucceeded(result);
  }

  async rollbackAuthorization(
    connection: TargetConnection,
    authorizedKeyLine: string,
  ): Promise<void> {
    const encodedLine = Buffer.from(authorizedKeyLine).toString("base64");
    const remoteCommand =
      connection.platform === "windows"
        ? windowsRemoteCommand(
            [
              "$ErrorActionPreference='Stop'",
              "$f=Join-Path (Join-Path $HOME '.ssh') 'authorized_keys'",
              `$k=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedLine}'))`,
              "if(Test-Path -LiteralPath $f){$lines=@([IO.File]::ReadAllLines($f)|Where-Object{$_ -cne $k});$text=if($lines.Count -gt 0){($lines -join \"`n\")+\"`n\"}else{''};[IO.File]::WriteAllText($f,$text,[Text.UTF8Encoding]::new($false))}",
            ].join("; "),
          )
        : [
            "set -e",
            `KEY="$(printf %s '${encodedLine}' | base64 -D)"`,
            'AUTH="$HOME/.ssh/authorized_keys"',
            '[ ! -f "$AUTH" ] || { TMP="$AUTH.dawn-forge.$$"; trap \'rm -f "$TMP"\' EXIT; awk -v key="$KEY" \'$0 != key { print }\' "$AUTH" > "$TMP"; mv "$TMP" "$AUTH"; chmod 600 "$AUTH"; }',
          ].join("; ");
    const result = this.#run(
      this.#ssh,
      ["-F", connection.configPath, connection.alias, remoteCommand],
      15_000,
    );
    this.#assertSshSucceeded(result);
  }

  async revoke(
    connection: TargetConnection,
    publicKeyBlob: string,
  ): Promise<void> {
    const remoteCommand =
      connection.platform === "windows"
        ? windowsRemoteCommand(
            [
              "$ErrorActionPreference='Stop'",
              "$f=Join-Path (Join-Path $HOME '.ssh') 'authorized_keys'",
              `if(Test-Path -LiteralPath $f){$b='${publicKeyBlob}';$lines=@([IO.File]::ReadAllLines($f)|Where-Object{-not(($_ -split '\\s+') -contains $b)});$text=if($lines.Count -gt 0){($lines -join \"\`n\")+\"\`n\"}else{''};[IO.File]::WriteAllText($f,$text,[Text.UTF8Encoding]::new($false))}`,
            ].join("; "),
          )
        : [
            "set -e",
            `BLOB='${publicKeyBlob}'`,
            'AUTH="$HOME/.ssh/authorized_keys"',
            '[ ! -f "$AUTH" ] || { TMP="$AUTH.dawn-forge.$$"; trap \'rm -f "$TMP"\' EXIT; awk -v blob="$BLOB" \'{ keep=1; for (i=1; i<=NF; i++) if ($i == blob) keep=0; if (keep) print }\' "$AUTH" > "$TMP"; mv "$TMP" "$AUTH"; chmod 600 "$AUTH"; }',
          ].join("; ");
    const result = this.#run(
      this.#ssh,
      ["-F", connection.configPath, connection.alias, remoteCommand],
      15_000,
    );
    this.#assertSshSucceeded(result);
  }

  #hostKeyFingerprint(knownHostsPath: string): string {
    const result = this.#run(
      this.#sshKeygen,
      ["-lf", knownHostsPath],
      10_000,
    );
    if (result.error || result.status !== 0) {
      throw new TargetInputError(
        result.stderr.trim() ||
          result.error?.message ||
          "无法读取 SSH host key fingerprint。",
      );
    }
    const fingerprints = [
      ...new Set(result.stdout.match(/\bSHA256:[A-Za-z0-9+/=]+\b/g) ?? []),
    ].sort();
    if (fingerprints.length === 0) {
      throw new TargetInputError("known_hosts 中没有 SSH host key fingerprint。");
    }
    return fingerprints.join(",");
  }

  #assertSshSucceeded(result: ProcessResult): void {
    if (
      /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(
        `${result.stderr}\n${result.stdout}`,
      )
    ) {
      throw new IdentityConflictError(["sshHostKeyFingerprint"]);
    }
    if (result.error || result.status !== 0) {
      throw new TargetInputError(
        result.stderr.trim() ||
          result.stdout.trim() ||
          result.error?.message ||
          `SSH 失败，退出码 ${result.status ?? "unknown"}。`,
      );
    }
  }
}

export function createTargetManager(options?: {
  readonly homeDirectory?: string;
  readonly authorize?: (command: string) => Promise<boolean>;
}): TargetManager {
  if (process.platform !== "win32") {
    throw new TargetInputError(
      "Dawn Engine V1 仅支持 Windows 控制机。",
    );
  }
  const homeDirectory = options?.homeDirectory ?? homedir();
  return new TargetManager({
    homeDirectory,
    now: () => new Date(),
    keyProvider: new NodeControllerKeyProvider(
      homeDirectory,
      process.env.DAWN_SSH_KEYGEN ?? "ssh-keygen",
    ),
    ssh: new NodeSshTargetAdapter(
      process.env.DAWN_SSH ?? "ssh",
      process.env.DAWN_SSH_KEYGEN ?? "ssh-keygen",
    ),
    authorize:
      options?.authorize ??
      (async () => {
        throw new TargetNeedsUserError();
      }),
  });
}
