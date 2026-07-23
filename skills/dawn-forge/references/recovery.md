# 状态、恢复与验证

## 运行状态

在控制机保存：

```text
~/.dawn-forge/targets/<normalized-target-alias>/runs/<run-id>.json
```

状态只能包含：

- schema version；
- profile 路径、SHA-256、`id` 与 `platform`；
- target alias 及 `ssh -G` 解析后的非秘密连接字段；
- SSH host-key fingerprint；
- 目标 OS、architecture、hostname、系统版本与 machine ID；
- 各阶段状态和时间；
- 软件动作结果；
- artifact 名称、官方来源、版本和公开 digest；
- 待完成的人工任务。

不得包含 password、subscription、token、private key、proxy URL 或敏感命令输出。使用同目录临时文件和原子 rename 更新；修改前写 `in_progress`，验证成功后才写 `completed`。

## 恢复规则

恢复时依次：

1. 重新校验 profile 并比较 SHA-256；变化后生成新计划，不沿用旧批准。
2. 重新解析同一 target alias，核对 `HostName`、`User`、`IdentityFile` 和 host key。
3. 重新探测目标 OS、architecture、hostname、系统版本和 machine ID。
4. 任一身份字段或 profile platform 不一致时停止。
5. 重新探测每个阶段的真实状态，不因 state 写着 `completed` 就跳过验证。
6. 只重试已证明幂等的步骤；GUI installer、管理员授权和未知状态 installer 必须先检查。

同一规范化 target alias 只允许一个修改流程。锁已占用时拒绝启动；不同 alias 指向同一机器时无法自动识别，禁止通过换 alias 绕过。

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

**包管理器中断**：检查正在运行的 installer、package receipt、平台包管理器健康状态和待重启状态；不要直接删除包管理器目录后重装。

**软件部分成功**：重新探测已满足项并标记 `skip`；失败项重新进入计划，不重复安装已验证项。

## 完成条件

只有下列事实均验证后才报告成功：

- 指定管理身份能够以 public-key-only 模式连接；
- 目标身份稳定且平台与 profile 一致；
- 每个 required 软件已验证或经用户接受转为 `manual`；
- profile 中显式设置已验证；
- 没有未解释失败或未披露高风险变更。

最终按 `completed`、`manual`、`skipped`、`failed`、`not-verified` 分类，并标注实际验证过的控制机/目标机平台组合。
