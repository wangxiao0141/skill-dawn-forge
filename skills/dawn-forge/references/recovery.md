# 状态、恢复与验证

## 运行状态

在控制机保存：

```text
~/.dawn-forge/targets/<target.id>/state.json
```

状态只能包含：

- schema version；
- manifest 路径与 SHA-256；
- target id、host、user；
- 已接受的 SSH host key fingerprint；
- `Darwin`、`arm64`、hostname 和 macOS version；
- 各阶段状态与时间；
- 软件动作结果；
- 下载 artifact 名称、来源、版本和公开 digest；
- 待完成的人工任务。

不得包含 password、subscription、token、private key、proxy URL 或命令输出中的敏感内容。

使用同目录临时文件写入，并通过原子 rename 替换。任何修改前写入 `in_progress`；成功验证后才写 `completed`。

## 恢复规则

恢复时依次：

1. 重新校验装机清单并比较 SHA-256。不同则生成新计划，不沿用旧批准。
2. 重新连接原 host，并比较 user、SSH host key、`Darwin`、`arm64` 和 hostname。
3. 任一身份字段变化时停止，不自动接受新 host key。
4. 重新探测每个阶段的真实状态，不因 state 写着 `completed` 就跳过验证。
5. 对幂等步骤安全重试；对 GUI installer、Homebrew 首次安装和未知状态的官方 installer 先检查再决定。

同一 `target.id` 只允许一个修改流程。检测到活动运行时拒绝并要求等待；过期状态必须先核实没有正在运行的 SSH/安装进程。

## 文件恢复

- 修改前创建 `<name>.dawn-forge-backup.<timestamp>`。
- 只替换 `# >>> dawn-forge ...` 与 `# <<< dawn-forge ...` 之间的完整标记块。
- 标记不完整、重复或嵌套时停止。
- 回滚只恢复本次创建且仍未被用户修改的备份；不能证明时提供人工步骤。

## 常见失败

**host key 变化**：停止并展示已知记录和当前域名，不自动删除 `known_hosts`。

**管理 key 回连失败**：验证使用了指定 `IdentityFile` 和 `IdentitiesOnly yes`；不要尝试控制机其他 key。只精确移除本次新增的 `authorized_keys` 行。

**Clash 安装或代理失败**：保留已验证安装包，检查应用签名、GUI 授权、系统代理/TUN 状态和目标机实际网络；不索要订阅。

**Homebrew 中断**：先检查进程、`/opt/homebrew`、Command Line Tools 和 `brew doctor`；不要直接删除 Homebrew 目录后重装。

**软件部分成功**：重新探测 receipt、bundle、CLI 和版本；已满足项保持 `skip`，失败项重新进入计划。

## 完成条件

只有下列事实均验证后才报告成功：

- 指定管理密钥能够以 `BatchMode=yes` 连接；
- 目标为预期用户、`Darwin` 和 `arm64`；
- Clash Verge Rev 已安装，代理检查通过；
- Homebrew 状态正常；
- 每个 required 软件已验证或经用户接受转为 manual；
- GitHub 专用与通用 key pair 均存在、权限正确且不相同；
- `~/.ssh/config` 的 GitHub 标记块正确；
- 没有未解释的失败或未披露的高风险变更。

最终按 `completed`、`manual`、`skipped`、`failed`、`not-verified` 分类。真实 Mac 未执行过的路径必须保留 `not-verified`。
