# 状态、恢复与验证

## 运行状态

状态必须在对应修改前创建，不得等到失败后补写。阶段 1 由 `prepare-ssh-bootstrap.mjs finalize` 原子保存目标 identity receipt；阶段 2 由 artifact cache metadata 和网络引导 mini-run receipt 记录；阶段 4 只通过 `scripts/installation-run.mjs prepare --plan <canonical-plan-bundle>` 创建 manifest 与 journal，并遵循 `references/execution.md`。`scripts/installation-run-state.mjs` 是 internal module，不得直接执行。不得声称阶段 4 journal 覆盖更早发生的修改。

在控制机保存：

```text
~/.dawn-forge/targets/<normalized-target-alias>/runs/<run-id>/manifest.json
~/.dawn-forge/targets/<normalized-target-alias>/runs/<run-id>/state/<state-run-key>.json
```

阶段 4 安装 journal 只包含：

- schema version；
- run ID、profile SHA-256、schedule SHA-256、`targetIdentitySha256`、revision 与时间；
- 批次及软件动作的独立 `fetch`、`install`、`verify` 结果；
- active `batchId`、`attemptId`、无秘密 owned process token 和 cancellation intent；
- 无秘密 event journal 和汇总。

alias、`ssh -G` 解析、host-key fingerprint、OS、architecture、系统版本、machine ID 与展示名称保存在阶段 1 identity receipt；artifact 名称、publisher、version、architecture、公开 digest 与校验时间保存在 canonical cache metadata；人工任务的确认与验收通过独立无秘密 receipt 关联到相同 digest。三类状态不得互相伪造。

不得包含 password、subscription、token、private key、带凭据 URL、proxy URL 或敏感命令输出。使用同目录临时文件、fsync 和原子 rename 更新；installer 退出只写 `install=completed`，逐项验证成功后才写软件 `completed`。

`status`/`observe` 只读上述本地 journal 并标注 freshness，不进行 SSH、DNS、HTTP 或 package manager 查询。尤其不得在活动安装期间用 `brew list`、`brew info`、`brew doctor`、`winget list`、`pgrep` 或固定 sleep 判断进度。

## 运行生命周期与取消

同一 machine ID 只允许一个修改 run，alias 级锁只作为第一层保护。状态更新必须持有同目录 exclusive lock 并检查 `expectedRevision`；冲突立即失败并重新读取，不以固定 sleep 轮询。开始批次前记录 schedule digest 和所有权；没有 owned process acknowledgment 时不启动 package manager。

显式 `cancel`、`停止` 或范围切换优先于诊断：

1. 先原子记录 `cancel-pending`；
2. 只向 active `batchId` / `attemptId` 的 owned handle 发送中断，不按进程名杀除；
3. runner 停止启动下一项并等待该 handle 退出；
4. 能证明退出时写 `cancelled`；断连或所有权不明时保持 `cancel-pending`；
5. 已验证项保持成功，中断项进入 `not-verified`，不删除 package manager lock 或 cache。

## 恢复规则

恢复时依次：

1. 重新校验 profile 并比较 SHA-256；变化后生成新计划，不沿用旧批准。
2. 重新解析同一 target alias，核对 `HostName`、`User`、`IdentityFile` 和 host key。
3. 重新探测目标 OS、architecture、系统版本、machine ID 和平台原生网络名称。
4. 已记录的 host key 或 machine ID 变化，或账号、平台、architecture 与目标不符时停止。
5. 先 reconcile run-state、owned attempt 和逐项 receipt；不因 state 写着 `completed` 或 SSH 命令已经返回就跳过验证，也不重复启动 active batch。
6. 只重试已证明幂等的步骤；GUI installer、管理员授权和未知状态 installer 必须先检查。

普通 hostname、`ComputerName`、`LocalHostName` 等可变名称发生变化时更新展示信息，不把名称变化单独视为错连，也不向用户增加确认步骤。`.local` 瞬时失败时先做最多三次短时有界重连；仍失败才请求 IPv4，不在每次 SSH 调用前重复发现。

同一规范化 target alias 和同一已知 machine ID 都只允许一个修改流程。锁已占用时拒绝启动；禁止通过换 alias 绕过。

## 文件恢复

- 修改前创建 `<name>.dawn-forge-backup.<timestamp>`。
- 只替换完整的 `# >>> dawn-forge ...` / `# <<< dawn-forge ...` 标记块。
- 标记不完整、重复或嵌套时停止。
- 只恢复本次创建且仍未被用户修改的备份；不能证明时提供人工步骤。

## 常见失败

**控制机命令被 wrapper 替换**：检查命令解析路径；deny shim 或未知 wrapper 的输出不得视为真实执行结果。

**Windows 到 macOS 的 shell 出现 `\r: command not found`**：控制机文本 pipeline 改写了换行。重新以 UTF-8 无 BOM、LF 传输并校验内容；不要修改目标 shell 或关闭错误检查。

**host key 变化**：停止并展示已知 fingerprint 与当前 alias 解析，不自动清除 `known_hosts`。

**管理身份失败**：验证 `ssh -G`、指定 `IdentityFile`、key pair 与 `IdentitiesOnly yes`；不要尝试其他默认 key。

**平台不匹配**：profile `platform` 与 SSH 探测不一致时停止，选择正确 profile 后重新计划。

**代理失败**：保留已验证 artifact，检查签名、GUI 授权和目标机实际 proxy/TUN；不索要订阅。

**包管理器中断**：先读取 run-state 并核对 owned attempt。owned process 已退出后才检查 package receipt、平台包管理器健康状态和待重启状态；不要用 package manager 查询监视活动进程，也不要直接删除 package manager 目录或 lock 后重装。

**软件部分成功**：保留每项 `fetch/install/verify` 事实；已验证项标记 `completed` 或恢复计划中的 `skip`，失败项及其依赖重新进入计划，不重复安装已验证项，也不把整批说成“一个都没装”。

## 完成条件

只有下列事实均验证后才报告成功：

- 指定管理身份能够以 public-key-only 模式连接；
- 目标身份稳定且平台与 profile 一致；
- 每个 required 软件已验证或经用户接受转为 `manual`；
- profile 中显式设置已验证；
- 没有未解释失败或未披露高风险变更。

最终按 `completed`、`manual`、`skipped`、`failed`、`not-verified` 分类，并标注实际验证过的控制机/目标机平台组合。
