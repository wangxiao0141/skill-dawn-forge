---
name: dawn-forge
description: 通过局域网 SSH 引导用户从 macOS 或 Windows 控制机配置已可正常使用的 macOS 或 Windows 个人电脑。用于按声明式 JSON profile 完成 SSH 建联、目标平台探测、软件计划与一次确认后的批量安装、可选代理客户端和目标机 SSH key 配置、验证、恢复及持续改进。
---

# Dawn Forge

协作完成个人电脑装机。控制机与目标机均支持 macOS 或 Windows；Agent 负责检查、规划和可远程执行的操作，用户只处理本地管理员授权、GUI、秘密输入和高风险确认。

## 固定边界

- 目标机必须已完成操作系统安装和首次设置，用户能够以管理员身份登录。
- 只支持 macOS/Windows 控制机到 macOS/Windows 目标机的四种组合。
- 最终通过稳定 SSH alias 或局域网域名管理目标机；装机开始时允许 SSH 尚未开启、alias 尚未创建。
- 安装内容由用户选择的 profile 唯一决定。Agent 发现并展示工作区已有真实 profile，但不得因为候选唯一就代替用户选择；示例 profile 不构成默认软件集。
- 不要求目标机安装 Dawn Forge、clone 仓库或预装 Node.js、Python、Git。
- 用户提供的配置内容不得进入 profile、仓库、输出或运行状态；按 [references/configuration-handoff.md](references/configuration-handoff.md) 作为文件传到目标机。
- 优先验证并复用控制机现有 SSH 管理身份；控制机管理身份与目标机外部服务身份不得互相复用。

## 按需读取资源

- 接收、创建或修改 profile 前，完整读取 [references/profile.md](references/profile.md)。新建时从 [assets/dawn-forge.profile.example.json](assets/dawn-forge.profile.example.json) 复制空模板；用户需要参考时可读取 [assets/dawn-forge.profile.macos.example.json](assets/dawn-forge.profile.macos.example.json)，但不得把示例软件集当作默认需求。
- 建立 SSH、修改 `authorized_keys` 或初始化目标机 key 前，完整读取 [references/ssh.md](references/ssh.md)。
- 需要向目标机传递配置值或配置文件时，完整读取 [references/configuration-handoff.md](references/configuration-handoff.md)。
- 用户说明目标机离线，或 preflight 证明目标机无法访问安装所需官方端点时，完整读取 [references/network-bootstrap.md](references/network-bootstrap.md)。
- 目标机确认为 macOS 后，完整读取 [references/macos.md](references/macos.md)。
- 目标机确认为 Windows 后，完整读取 [references/windows.md](references/windows.md)。
- 发生失败、中断、身份变化或恢复执行时，完整读取 [references/recovery.md](references/recovery.md)。

## 交互协议

- 对用户只展示四个阶段：`目标与配置 → 环境确认 → Clash 安装与联网 → 执行与交付`。SSH 建联和 profile 选择都属于“目标与配置”，内部检查不单独包装成阶段。
- 每轮只处理一个阶段，但把该阶段内彼此相关的 2–4 个问题或操作合并成编号清单，让用户一次回复。
- 不跨阶段混问，不把 SSH、profile、安装计划和错误修复塞进同一轮。
- 当前阶段只展示当前需要的信息，不在第一条回复同时展示 profile 错误、安装计划或修复授权。
- 读取文件、检查 SSH config、运行 validator 和诊断错误属于只读操作，直接执行；只有修改文件或目标机状态时才请求必要确认。
- 每次等待用户时说明当前阶段、已完成事项和下一步；跳过已知答案，并允许用户用一条紧凑回复按编号作答。

有已有 target 时，第一轮使用这种结构：

```text
阶段 1/4：目标与配置
已发现：
1. <alias> — <HostName>，用户 <User>

请一次回复：
1. 这次配置哪个 alias，还是“新电脑”？
2. 如果是新电脑：系统是 macOS 还是 Windows？
3. 如果是新电脑：你平时怎么称呼它？我会据此推荐 alias。
```

没有已有 target 时，第一轮只问：

```text
阶段 1/4：目标与配置
当前没有已配置的目标电脑。请一次回复：
1. 新电脑是 macOS 还是 Windows？
2. 你平时怎么称呼它？

SSH 不需要提前配置，我会继续引导。
```

## 工作流

### 阶段 1：目标与配置

1. 不要要求用户提供 SSH alias 或 profile 路径。先检查用户请求、当前会话和控制机 SSH config。
2. 用户未明确目标时，展示已有 alias 的非敏感 HostName/User 摘要，并一次询问：
   - 使用哪个已有 alias，还是新电脑；
   - 新电脑的系统；
   - 用户平时如何称呼它。
3. 已有 alias：使用真实 OpenSSH 解析配置并尝试 public-key-only 连接；失败时先只读诊断。
4. 新电脑：分两批引导，不逐项来回确认：
   - 在目标机开启 SSH，并一次取得登录账号与局域网 hostname；
   - Agent 选择控制机现有管理公钥后，提供一段幂等命令，让用户加入公钥并一次回报结果。
5. 使用 hostname 完成首次回连，提供 alias 推荐名称；用户确认后写入控制机 SSH config 并使用 alias 复验。
6. 探测并固定目标 OS、architecture、hostname、系统版本、machine ID 和 SSH host-key fingerprint。
7. 查找当前工作区 `profiles/` 下的 JSON 文件，不把 Skill `assets/` 当作候选。
8. 对每个候选执行以下命令；只能依据它的输出判断 JSON、schema、软件数量和内容：

   ```text
   node <skill-directory>/scripts/validate-profile.mjs <profile.json>
   ```

9. 过滤平台一致的有效 profile，展示软件、`settings` 和 `manualTasks`；一次询问选择哪个 profile、是否增删软件。唯一候选也只推荐。
10. 没有有效候选时，报告 validator 准确错误；完成只读诊断后，询问修复现有文件还是创建空模板。
11. 用户确认后记录 profile SHA-256、`id`、`platform` 和软件数量。

### 阶段 2：环境确认

1. 确认真实 `ssh`、`scp`、`ssh-keygen`，加载平台 reference，并完成磁盘、权限、包管理器、现有软件、PATH 和网络 preflight。
2. 只处理 profile 中的软件，分类为 `install`、`skip`、`update`、`conflict` 或 `manual`；默认最新稳定版，不自动降级或全局升级。
3. 根据网络检查结果明确标记是否需要进入 Clash 阶段；不要在确认环境之前安装或传输 Clash。
4. 展示环境检查结果、最终安装计划、必要依赖、配置交接和人工任务，等待用户一次确认整个批次。
5. profile 内容、目标身份或环境事实发生实质变化后，必须重新确认。

### 阶段 3：Clash 安装与联网

1. 环境确认表明目标机已经能访问后续安装所需的官方端点时，报告结果并跳过本阶段，不要求安装 Clash。
2. 目标机离线且 profile 包含 Clash 时，Agent 在控制机下载、校验官方安装包，再通过 SSH 传到目标机；Agent 不运行 installer。
3. 配置 URL 或其他配置内容由用户提供，Agent 按 [references/configuration-handoff.md](references/configuration-handoff.md) 写入文件并传到目标机，不写入 profile 或运行状态。
4. 用户在目标机手动安装 Clash Verge、读取配置文件、导入 URL 并完成必要授权。
5. Agent 重新验证目标机到所需官方端点的连通性；未通过时停留在本阶段诊断，不开始普通软件安装。

### 阶段 4：执行与交付

1. 按平台和依赖顺序批量执行批准的软件；不把 profile 字符串直接拼接为 shell。
2. 普通软件优先使用平台 package manager 并合并批量安装；无法安全自动化时标记 `manual`。
3. 只应用 profile 显式声明的 `settings`。创建 GitHub key 或 general key 时在目标机生成并复用已有 key，passphrase 由用户本地输入。
4. 修改现有文件前备份，只管理 Dawn Forge 标记块；失败时停止依赖项并先诊断。
5. 验证管理 SSH、目标身份、required 软件、PATH、设置和人工任务，输出 `completed`、`manual`、`skipped`、`failed` 和 `not-verified` 汇总。
6. 保存无秘密运行状态；恢复时重新探测目标事实。只有实际验证过的平台组合可标记为已验证。

## 安全规则

- 只信任官方 primary source；下载 URL 必须为无嵌入凭据的 HTTPS。
- publisher 未提供 digest 时，只能声明本地 SHA-256 证明传输一致，不能声称验证发布者完整性。
- 不自动卸载、降级、删除用户数据、替换 key、清除 host key 或关闭安全机制。
- 同一 target alias 同时只允许一个修改流程。
- 命令失败后先诊断；不得通过忽略错误、关闭验证或扩大权限继续。
