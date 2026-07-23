# 受控安装执行

阶段 4 的安装、状态观察、取消和恢复必须通过本节定义的受控入口完成。不得临时拼接 SSH 远端命令，也不得把聊天中的字符串当作 shell、PowerShell 或 package manager 参数。

## 唯一公开入口

`scripts/installation-batches.mjs`、`scripts/run-installation-batch.mjs` 和 `scripts/installation-run-state.mjs` 仅供模块内部 import，不得直接执行。阶段 4 只使用 planner 发布的 canonical bundle 和 `scripts/installation-run.mjs`：

```text
node <skill-directory>/scripts/plan-installation.mjs plan --profile <profile.json> --identity-receipt <canonical-identity.json> --controller-route <direct|clash> --target-route <direct|clash> --output-dir <new-plan-bundle>
node <skill-directory>/scripts/plan-installation.mjs probe --plan-bundle <existing-plan-bundle> --controller-route <direct|clash> --target-route <direct|clash> --output-dir <new-plan-bundle>
node <skill-directory>/scripts/installation-run.mjs prepare --plan <new-plan-bundle>
node <skill-directory>/scripts/installation-run.mjs advance --run-id <run-id>
node <skill-directory>/scripts/installation-run.mjs observe --run-id <run-id>
node <skill-directory>/scripts/installation-run.mjs verify-manual --run-id <run-id>
```

`plan`/`probe` 的 `--output-dir` 必须是尚不存在的新目录。bundle 固定包含 `profile.json`、`identity.json`、`preflight.json`、`plan.json`，只有状态可执行时才包含 `schedule.json`；不得从旧 bundle 覆盖写入或手工抽取中间 JSON。

`prepare` 输出的 `runId` 是后续命令唯一允许的运行标识。每次 `advance` 只启动下一个批次；route gate 只允许把返回的 `gateToken` 交给同一命令的 `--gate-token`。退出码：`0` 表示命令成功或已到安全终态，`1` 表示输入、绑定或执行错误，`2` 表示需要用户动作或重新规划，`3` 表示仍在运行、阻塞或等待验证。

启动安装的 `advance` 必须留在同一个前台 tool session，直到该批次终态。取消时只向这个 `advance` session 发送 `Ctrl-C`；owned runner 会先持久化 intent，再中断精确 owned process。不得另起 `cancel` 进程修改 state；独立进程不能取得另一个进程的 owned handle，未收到 runner acknowledgement 时只能报告 `cancel-pending`。

公开结果一次最多包含一个 `kind=user-action`，并带稳定 `stepId`。用户回复 `好了`、`完成了` 或 `继续` 时，只消费这个待办步骤：route 切换使用原 `gateToken` 继续同一 run，人工安装使用 `verify-manual` 验收同一 batch。不得把简短确认解释为重新 `prepare`、重新下载或再次启动当前批次。

## 输入与批准

1. 从已确认的 profile 和 `scripts/plan-installation.mjs` 受控 preflight 生成 resolved actions；每项只包含受控 identifier、resolved `version`、显式 `dependsOn`、`executionMode=automated|manual-receipt`、installer、权限/GUI/重启属性和本次联网路由，不包含 raw command 或秘密。不得由 Agent 手写这些字段。planner 必须拒绝缺失依赖、self dependency 和 cycle，并自行计算 dependency level。
2. 联网路由按本次动作实际访问的 metadata 与 artifact 官方端点探测为 `direct`、`clash` 或 `local`。每项同时记录 `networkLocation=controller|target|none`、无 scheme/path/credential 的 `routeEvidence.origins`、受控探测方法和 UTC 时间；缺少证据或探测位置不匹配时 planner 拒绝排程。`controller-probe` 与 `target-probe` 不得互换，不得根据软件名称、国别或历史下载速度猜测。
3. metadata 和 artifact 需要不同路由时拆成独立动作。Homebrew metadata refresh 每个 run 最多一次，之后安装设置 `HOMEBREW_NO_AUTO_UPDATE=1`，避免安装阶段隐式换路由。
4. 受控 preflight receipt 绑定 profile、登录身份 `targetIdentitySha256`、机器执行身份 `machineExecutionIdentitySha256`、SSH identity file digest、inventory、metadata 和 route probe，计算 `preflightSha256`；`scripts/plan-installation.mjs` 必须在内部调度并把 preflight 与机器身份 digest 写入 schema v2 schedule。每个安装批次最多 `3` 项，并且依赖层级、`executionMode`、installer、`networkLocation`、route、管理员模式、GUI 和重启模式一致。必须分别通过 planner 的 `--controller-route` 与 `--target-route` 传入两个位置当前已验证的 route；CLI 不提供猜测默认值。route 顺序只在满足依赖的前提下减少同一位置的 Clash 切换。
5. 安装计划由用户一次确认，同时记录 profile SHA-256、schedule SHA-256、`targetIdentitySha256` 与 `machineExecutionIdentitySha256`。后续拆批不重复确认；任一 digest 或目标强身份变化时必须重新计划。
6. `required: false` 的项目只有用户明确选入本次安装计划后才生成 action。

full plan 不得包含 `official-download` 或 `controller-cache` action，因为当前 schedule schema 没有逐项 canonical artifact request binding。required Clash 必须先走 `references/network-bootstrap.md`；否则 planner 返回 `conflict` 且不生成 schedule。

安装批次不是一条大命令。即使同批包含三个 Homebrew cask 或 Winget package，也必须逐项执行；前一项验证完成后立即写入结果，再处理下一项。

## 运行状态

控制机为每个 run 保存无秘密原子 journal。状态至少区分：

```text
planned → running → verifying → completed
                  ↘ partial | failed | cancel-pending | cancelled
```

每个软件分别记录 `fetch`、`install`、`verify`。三者必须分离：

- artifact 下载完成只代表 `fetch=completed`；
- installer 退出成功只代表 `install=completed`；
- 只有 receipt、bundle、CLI 或受控版本证据通过后，软件才能标记 `completed`；
- 已成功项和失败项同时存在时保留 `partial`，不得把整批重写为失败或未安装。

状态不得包含 subscription、password、token、private key、带凭据 URL、proxy URL 或敏感输出。更新使用同目录临时文件和原子 rename。

## 前台执行与等待

- 默认只启动一个前台受管 runner，并保留同一个 tool/session handle 直到本批终态。禁止 `nohup`、detached job、无所有权的后台下载和第二个 download owner。
- 受管环境需要授权时，在阶段 4 开始时为受控 runner 请求一个可复用、范围明确的授权；不得为同批的每个 SSH、软件或 phase 重复请求。
- runner 只使用固定 executable、argv 和受控 identifier；目标机不需要 Node.js、Python、Git 或仓库副本。
- 批次内逐项执行 `fetch → install → verify`。某项完成后立即写 journal，不等待整批全部下载完才报告。
- 等待同一 runner 的事件或退出结果。不得用固定 `sleep`、`Start-Sleep` 或重复 SSH `pgrep` 轮询安装状态。
- `status`/`observe` 只读取控制机 journal，不执行 SSH、DNS、HTTP 或 package manager 命令；尤其禁止用 `brew list`、`brew info`、`brew doctor` 或 `winget list` 充当活动进程监视器。
- runner 退出后才允许执行一次离线/只读验证。状态陈旧时明确显示 `local-snapshot`，不得为了“刷新”而静默联网。

如果调用工具暂时 yield 并返回 session ID，该 runner 仍属于同一个前台受管会话，不得另启相同批次。重新进入 turn 时先读取该 session 或 run-state，不重复启动。

## 联网切换

- route 只在没有活动 installer 的批次边界切换；提示必须写明 `networkLocation`，不能把控制机与目标机的 Clash 状态混为一谈。
- 当前 route 不匹配时返回一个合并的人工步骤，让用户在指定位置启用或退出 Clash；Agent 不自动操作 Clash GUI，也不边下载边切换。
- 同一路由的连续批次直接推进；不得每批重复询问。
- endpoint 重定向或 CDN 变化导致 route 证据失效时暂停并重新解析，不能在失败后秘密改走代理。

用户询问下载速度时，优先使用当前 owned runner 已产生的多个真实进度样本；不得另起测速下载抢占带宽。只有当前批次结束后，才可用同一官方 endpoint 做有边界的 direct/clash 比较。原 downloader 已退出或没有可比样本时直接说明无法确认，不根据单个瞬时速度或旧日志猜测。

## 显式取消与范围切换

显式 `cancel`、`停止`、`不要后台下载` 或“不要再装机”必须先处理，并且只能中断 run-state 记录的 owned batch/handle：

1. 立即把 cancel intent 原子写入 run-state，不先做速度诊断、软件扫描或固定等待。
2. 只中断 run-state 中 active `batchId`、`attemptId` 和 owned process handle 对应的进程树；禁止使用模糊 `pgrep`、`pkill`、`killall` 或按 package manager 名称清理。
3. 向同一个受管 session 发送中断并等待退出事件；不启动下一项或下一批。
4. 能证明 owned process 已退出时标记 `cancelled`。无法证明时保持 `cancel-pending`，不得声称“已经取消”。
5. 已验证完成项保持 `completed`；中断项为 `not-verified`，恢复前先 reconcile。
6. 用户把范围切换为 Skill 评审或其他本地任务后，除完成上述取消握手外不得继续访问目标机；若用户同时禁止任何目标访问，则只报告本地 `cancel-pending`。

## 失败隔离

- host key、machine ID、平台、账号、profile/schedule digest、package manager integrity 或权限模型发生系统性异常时停止整个 run。
- 单个软件失败时停止它的依赖项并保留原始脱敏错误；已经验证的独立项不回滚。是否继续其他独立批次按已批准计划和用户最新指令决定。
- runner 只能启动全部 `dependsOn` 已在同一 run-state 中验证为 `completed` 的 batch；不能用手工指定后续 `batchId` 绕过依赖或 GUI/restart barrier。
- SSH/tool 返回、下载速度变化或 artifact 出现在 cache 中都不代表安装完成。
- 需要 GUI、管理员授权或重启时形成一个合并人工步骤；不得循环尝试 sudo/UAC 或让多个 installer 竞争同一 package manager。
- `manual-receipt` 批次不会由 SSH runner 伪造成功。用户完成合并人工步骤后，只运行一次 `verify-manual`；内置 verifier 验证受控 receipt 类型和证据 SHA-256 后，在同一操作中原子记录完成并解除依赖。不得再暴露 `manual-complete` 或接受外部手写 receipt；未验收时保持等待状态并返回非成功 gate。

## 验收指标

- 每批 `1..3` 项，同批 `executionMode`、`networkLocation`、route 和 installer 一致；
- 每个 run 只有一个活动修改流程和一个 download owner；
- 活动安装的固定等待时间为 `0`，被动状态观察的 SSH/package-manager 调用为 `0`；
- 显式取消先于任何诊断处理，且只触及 owned batch；
- Homebrew metadata refresh 每个 run 最多一次；
- 最终逐项报告 `completed`、`manual`、`skipped`、`failed` 和 `not-verified`，并明确区分 downloaded、installed 与 verified。
