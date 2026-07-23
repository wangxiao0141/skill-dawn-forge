import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createInstallationSchedule } from "../skills/dawn-forge/scripts/installation-batches.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const canonicalSkill = join(repositoryRoot, "skills", "dawn-forge");
const localSkill = join(repositoryRoot, ".agents", "skills", "dawn-forge");
const contextPath = join(repositoryRoot, "CONTEXT.md");
const failures = [];

function fail(contract, detail) {
  failures.push(`${contract}: ${detail}`);
}

function readUtf8(path) {
  return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
}

function paragraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function markdownFiles(root) {
  return filesUnder(root).filter((path) => path.endsWith(".md"));
}

function filesUnder(root) {
  if (!existsSync(root)) return [];

  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function checkStageFourExecutionContract() {
  const skillPath = join(canonicalSkill, "SKILL.md");
  const skill = readUtf8(skillPath);
  const match = skill.match(
    /###\s*阶段\s*4[^\n]*\n([\s\S]*?)(?=\n##\s|\s*$)/,
  );

  if (!match) {
    fail("阶段 4 受控执行", "`SKILL.md` 缺少可识别的“阶段 4”章节。");
    return;
  }

  const stageFour = match[1];
  if (!/references\/execution\.md/i.test(stageFour)) {
    fail(
      "阶段 4 受控执行",
      "阶段 4 必须直接引用 `references/execution.md`，不能依赖临时拼接命令。",
    );
  }
  if (!/(?:受控|controlled)/i.test(stageFour)) {
    fail("阶段 4 受控执行", "阶段 4 必须明确要求受控执行入口。");
  }
  if (!/(?:run[- ]?state|运行状态)/i.test(stageFour)) {
    fail("阶段 4 受控执行", "阶段 4 必须明确以 run-state/运行状态为准。");
  }
}

function checkBatchLimitContract() {
  const actions = Array.from({ length: 7 }, (_, index) => ({
    softwareId: `contract-item-${index + 1}`,
    name: `Contract item ${index + 1}`,
    installer: "brew-cask",
    package: `contract-item-${index + 1}`,
    version: "latest-stable",
    route: "direct",
    networkLocation: "target",
    executionMode: "automated",
    routeEvidence: {
      method: "target-probe",
      origins: ["example.com"],
      observedAt: "2026-07-23T12:00:00.000Z",
    },
    dependsOn: [],
  }));

  let schedule;
  try {
    schedule = createInstallationSchedule(actions, {
      initialRoutes: { controller: "direct", target: "direct" },
      preflightSha256: "a".repeat(64),
      machineExecutionIdentitySha256: "b".repeat(64),
    });
  } catch (error) {
    fail("安装批次上限", `默认排程失败：${error.message}`);
    return;
  }

  const oversized = schedule.batches.find((batch) => batch.items.length > 3);
  if (schedule.maxItemsPerBatch !== 3 || oversized) {
    fail("安装批次上限", "默认排程必须把每个批次限制为最多 3 项。");
  }

  try {
    createInstallationSchedule(actions, {
      maxItemsPerBatch: 4,
      initialRoutes: { controller: "direct", target: "direct" },
      preflightSha256: "a".repeat(64),
      machineExecutionIdentitySha256: "b".repeat(64),
    });
    fail("安装批次上限", "排程器不得接受大于 3 的 `maxItemsPerBatch`。");
  } catch (error) {
    if (!/1\s*(?:and|到|-)\s*3|between 1 and 3/i.test(error.message)) {
      fail("安装批次上限", `拒绝 4 项批次时错误不清楚：${error.message}`);
    }
  }
}

function checkControlledPreflightContract() {
  const scriptPath = join(
    canonicalSkill,
    "scripts",
    "plan-installation.mjs",
  );
  const skill = readUtf8(join(canonicalSkill, "SKILL.md"));
  if (!existsSync(scriptPath)) {
    fail(
      "受控环境确认",
      "缺少 `scripts/plan-installation.mjs`，resolved actions 仍可能由 Agent 临时手写。",
    );
  }
  if (
    !/scripts\/plan-installation\.mjs/.test(skill) ||
    !/(?:不得|禁止).{0,28}(?:手写|临时拼接).{0,24}(?:routeEvidence|权限|依赖)/i.test(
      skill,
    )
  ) {
    fail(
      "受控环境确认",
      "`SKILL.md` 必须要求受控 preflight，并禁止 Agent 手写执行证据。",
    );
  }
}

function checkNetworkBootstrapApprovalContract() {
  const skill = readUtf8(join(canonicalSkill, "SKILL.md"));
  const network = readUtf8(
    join(canonicalSkill, "references", "network-bootstrap.md"),
  );
  const text = `${skill}\n${network}`;
  if (
    !/mini-plan/i.test(text) ||
    !/(?:确认前|批准前).{0,30}(?:不下载|不得下载)/i.test(text) ||
    !/(?:确认前|批准前).{0,45}(?:不传输|不得传输)/i.test(text)
  ) {
    fail(
      "Clash 提前引导授权",
      "完整计划前的 Clash fast-path 必须先确认最小 mini-plan，确认前不得下载或传输。",
    );
  }
}

function checkNetworkLocationContract() {
  const execution = readUtf8(
    join(canonicalSkill, "references", "execution.md"),
  );
  if (
    !/networkLocation/.test(execution) ||
    !/controller-probe/.test(execution) ||
    !/target-probe/.test(execution) ||
    !/--controller-route/.test(execution) ||
    !/--target-route/.test(execution)
  ) {
    fail(
      "联网位置边界",
      "执行规范必须分开控制机与目标机的 route、probe 和初始状态。",
    );
  }
}

function checkNoGiantHomebrewCommand() {
  const sources = [
    contextPath,
    ...markdownFiles(canonicalSkill),
  ];
  const offenders = [];

  for (const path of sources) {
    const lines = readUtf8(path).split("\n");
    lines.forEach((line, index) => {
      const mentionsPackageKind = /\bformula\b|\bcask\b/i.test(line);
      const saysMergeAll =
        /(?:合并|汇总|combine|merge).{0,24}(?:一次|单条|一个命令|single|one command)/i.test(
          line,
        ) ||
        /(?:一次|单条|一个命令|single|one command).{0,24}(?:brew install)/i.test(
          line,
        );
      const isProhibition =
        /(?:不得|不要|禁止|严禁|不可|must not|never|do not)/i.test(line);

      if (mentionsPackageKind && saysMergeAll && !isProhibition) {
        offenders.push(
          `${relative(repositoryRoot, path)}:${index + 1} ${line.trim()}`,
        );
      }
    });
  }

  if (offenders.length > 0) {
    fail(
      "禁止巨型 Homebrew 命令",
      `不得把全部 formula/cask 合成一个命令；发现 ${offenders.join("；")}`,
    );
  }
}

function checkExecutionReferenceContracts() {
  const executionPath = join(
    canonicalSkill,
    "references",
    "execution.md",
  );
  if (!existsSync(executionPath)) {
    fail(
      "执行生命周期",
      "缺少 `references/execution.md`，无法约束 observe、cancel 与批次生命周期。",
    );
    return;
  }

  const execution = readUtf8(executionPath);
  const blocks = paragraphs(execution);

  const passiveObservation = blocks.some(
    (block) =>
      /(?:status|observe|状态观察)/i.test(block) &&
      /(?:不得|不要|禁止|严禁|must not|never|do not)/i.test(block) &&
      /brew\s+(?:list|info|doctor)|brew\s+list\s*\/\s*info\s*\/\s*doctor/i.test(
        block,
      ),
  );
  if (!passiveObservation) {
    fail(
      "被动状态观察",
      "`status`/`observe` 必须明确禁止 `brew list`、`brew info`、`brew doctor` 等主动探测。",
    );
  }

  const ownedCancel = blocks.some(
    (block) =>
      /cancel/i.test(block) &&
      /(?:显式|explicit)/i.test(block) &&
      /(?:优先|先处理|首先|first)/i.test(block) &&
      /(?:仅|只|only)/i.test(block) &&
      /(?:owned|归属|所有权)/i.test(block) &&
      /(?:batch|批次|handle|进程)/i.test(block),
  );
  if (!ownedCancel) {
    fail(
      "显式取消",
      "显式 `cancel` 必须先处理，并且只能中断 run-state 记录的 owned batch/handle。",
    );
  }

  const noFixedSleepPolling = blocks.some(
    (block) =>
      /(?:sleep|Start-Sleep|固定等待)/i.test(block) &&
      /(?:轮询|poll)/i.test(block) &&
      /(?:不得|不要|禁止|严禁|must not|never|do not)/i.test(block),
  );
  if (!noFixedSleepPolling) {
    fail(
      "事件驱动等待",
      "必须明确禁止用 fixed `sleep`/`Start-Sleep` 轮询安装状态。",
    );
  }

  const separatePhases = blocks.some(
    (block) =>
      /\bfetch\b/i.test(block) &&
      /\binstall\b/i.test(block) &&
      /\bverify\b/i.test(block) &&
      /(?:分离|分开|独立|separat)/i.test(block),
  );
  if (!separatePhases) {
    fail(
      "执行阶段分离",
      "每个批次必须明确分离 `fetch`、`install`、`verify`，保留部分成功事实。",
    );
  }

  if (!/(?:最多|上限|不超过|max(?:imum)?).{0,16}(?:`?3`?|三)(?:\s*项)?/i.test(execution)) {
    fail("安装批次上限", "`execution.md` 必须声明每批最多 3 项。");
  }
}

function checkPlanIsNotExecutionBatch() {
  const context = readUtf8(contextPath);
  const match = context.match(
    /\*\*安装计划\*\*:\s*([\s\S]*?)(?=\n\*\*[^*]+\*\*:|\s*$)/,
  );
  if (!match) {
    fail("安装计划语义", "`CONTEXT.md` 缺少“安装计划”定义。");
    return;
  }

  const definition = match[1].replace(/\s+/g, " ");
  if (!/(?:一次确认|确认一次)/.test(definition)) {
    fail("安装计划语义", "安装计划仍应由用户一次确认。");
  }
  if (
    !/(?:多个|若干|拆分|划分|不等于).{0,18}(?:执行)?批次/.test(definition)
  ) {
    fail(
      "安装计划语义",
      "安装计划必须明确可拆成多个执行批次，不能把一次确认等同于一次执行。",
    );
  }
  if (/作为一个批次执行|single execution batch/i.test(definition)) {
    fail(
      "安装计划语义",
      "仍存在“完整计划作为一个批次执行”的旧定义。",
    );
  }
}

function checkOptionalClashDoesNotFastPath() {
  const sources = [
    join(canonicalSkill, "SKILL.md"),
    join(canonicalSkill, "references", "macos.md"),
    join(canonicalSkill, "references", "network-bootstrap.md"),
  ];
  const blocks = sources.flatMap((path) => paragraphs(readUtf8(path)));
  const guarded = blocks.some(
    (block) =>
      /Clash/i.test(block) &&
      /required.{0,20}(?:false|为假)/i.test(block) &&
      /(?:不触发|不得触发|跳过|排除|不会进入|不进入)/i.test(block),
  );

  if (!guarded) {
    fail(
      "可选 Clash fast-path",
      "必须明确规定 `required: false` 的 Clash 条目不触发联网 fast-path。",
    );
  }
}

function checkLocalSkillDrift() {
  if (!existsSync(localSkill) || !statSync(localSkill).isDirectory()) return;

  const canonicalFiles = new Map(
    filesUnder(canonicalSkill).map((path) => [
      relative(canonicalSkill, path).replaceAll("\\", "/"),
      path,
    ]),
  );
  const localFiles = new Map(
    filesUnder(localSkill).map((path) => [
      relative(localSkill, path).replaceAll("\\", "/"),
      path,
    ]),
  );
  const drift = [];

  for (const file of new Set([
    ...canonicalFiles.keys(),
    ...localFiles.keys(),
  ])) {
    const canonicalPath = canonicalFiles.get(file);
    const localPath = localFiles.get(file);
    if (!canonicalPath) {
      drift.push(`${file} 仅存在于本地副本`);
    } else if (!localPath) {
      drift.push(`${file} 未同步到本地副本`);
    } else if (sha256(canonicalPath) !== sha256(localPath)) {
      drift.push(`${file} 内容不同`);
    }
  }

  if (drift.length > 0) {
    const visible = drift.slice(0, 8).join("；");
    const remaining =
      drift.length > 8 ? `；另有 ${drift.length - 8} 项` : "";
    fail(
      "Skill 副本漂移",
      `\`skills/dawn-forge\` 与 \`.agents/skills/dawn-forge\` 未同步：${visible}${remaining}`,
    );
  }
}

checkStageFourExecutionContract();
checkBatchLimitContract();
checkNoGiantHomebrewCommand();
checkExecutionReferenceContracts();
checkPlanIsNotExecutionBatch();
checkOptionalClashDoesNotFastPath();
checkControlledPreflightContract();
checkNetworkBootstrapApprovalContract();
checkNetworkLocationContract();
checkLocalSkillDrift();

if (failures.length > 0) {
  console.error(`Dawn Forge 工作流契约失败（${failures.length} 项）：`);
  failures.forEach((failure, index) => {
    console.error(`${index + 1}. ${failure}`);
  });
  process.exitCode = 1;
} else {
  console.log("Dawn Forge 工作流契约通过。");
}
