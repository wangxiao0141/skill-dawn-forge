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

- 按 `选择目标机 → SSH 建联并命名 → 选择 profile → 确认安装计划 → 执行与人工门禁` 推进。
- 每次回复最多要求用户作出一个决定或完成一个目标机操作；不要组合多个问题。
- 当前阶段只展示当前需要的信息，不在第一条回复同时展示 profile 错误、安装计划或修复授权。
- 读取文件、检查 SSH config、运行 validator 和诊断错误属于只读操作，直接执行；只有修改文件或目标机状态时才请求必要确认。
- 每次等待用户时说明当前阶段、已完成事项和下一步，不重复询问已经确认的信息。

有已有 target 时，第一轮使用这种结构：

```text
阶段 1/5：选择目标电脑
已发现：
1. <alias> — <HostName>，用户 <User>

这次配置哪台？如果是尚未建联的电脑，请回答“新电脑”。
```

没有已有 target 时，第一轮只问：

```text
阶段 1/5：选择目标电脑
当前没有已配置的目标电脑。新电脑是 macOS 还是 Windows？
SSH 不需要提前配置，我会逐步引导。
```

## 工作流

### 1. 选择目标电脑

1. 不要要求用户提供 SSH alias 或 profile 路径。先检查用户请求、当前会话和控制机 SSH config。
2. 如果用户已经明确指出目标电脑，直接进入 SSH 阶段。
3. 否则只展示已有 SSH alias 的非敏感 HostName/User 摘要，并询问本次是其中哪台电脑，还是一台尚未建联的新电脑。
4. 没有已有 alias 时，只询问目标电脑是 macOS 还是 Windows，并说明 SSH 不需要预先配置。

### 2. SSH 建联并命名

1. 已有 target alias 时，使用真实 OpenSSH 的 `ssh -G <target>` 解析配置并尝试 public-key-only 连接；失败时先只读诊断，不立即让用户重配。
2. 新目标机每次只给一个操作：
   - 引导用户访问目标机并开启 SSH；
   - 获取登录账号与局域网 hostname；
   - 检查并选择控制机现有管理公钥；
   - 让用户在目标机本地幂等加入公钥；
   - 使用 hostname 完成首次回连。
3. 首次回连成功后，提供一个 alias 推荐名称并询问用户如何命名；等待确认后才写入控制机 SSH config。
4. 使用最终 alias 完成 public-key-only 复验，并探测目标 OS、architecture、hostname、系统版本和 machine ID。

### 3. 选择 profile

1. 目标平台确认后，查找当前工作区 `profiles/` 下的 JSON 文件，不把 Skill `assets/` 当作候选。
2. 对每个候选都执行以下命令；只能依据它的输出判断 JSON、schema、软件数量和内容，不得自行解析或估算：

   ```text
   node <skill-directory>/scripts/validate-profile.mjs <profile.json>
   ```

3. 过滤出与目标平台一致的有效 profile，展示每个候选的名称，以及 validator 返回的软件、`settings` 和 `manualTasks`。
4. 明确询问用户是否给这台电脑使用某个 profile。即使只有一个候选也只推荐，不自动选择。
5. 用户确认后记录 profile SHA-256、`id`、`platform` 和软件数量。
6. 没有有效候选时，先给出 validator 的准确错误；只读诊断无需授权。然后只询问用户是修复某个现有 profile，还是从空模板新建。

### 4. 建立执行协议并探测现状

1. 探测控制机是 macOS 还是 Windows，并确认真实 `ssh`、`scp`、`ssh-keygen` 可执行文件；拒绝 deny shim 或未知 wrapper。
2. 确认探测到的平台与 profile 一致，并保存 SSH host-key fingerprint 与目标身份；后续变化时停止。
3. 加载对应平台 reference，执行磁盘、权限、包管理器、现有软件、shell/PATH 和网络的只读 preflight。
4. 展示 SSH、离线网络引导、配置文件交接、软件批次和目标机 key 阶段中 Agent/用户各自的动作。
5. 用户已声明离线或所需官方端点不可达时，把网络引导设为剩余安装的前置门禁。

### 5. 生成一次性安装计划

1. 只处理 profile 中的软件，将每项分类为 `install`、`skip`、`update`、`conflict` 或 `manual`。
2. 默认选择最新稳定版；已满足则跳过，不自动降级或做无关的全局升级。
3. 展示软件、当前状态、动作、官方来源、安装方式、必要依赖和版本策略。
4. 等待用户一次确认整个批次；profile 或解析来源变化后必须重新确认。
5. 目标机离线时，把 Agent 下载并传输代理安装包、用户手动安装、Agent 传入配置和联网验证列为批次的第一阶段。

### 6. 批量配置目标机

1. 按目标平台和依赖顺序批量执行已批准的软件，不把 profile 字符串直接拼接为 shell。
2. 代理客户端仅在 profile 明确列出时处理。Agent 在控制机下载并校验官方安装包，通过 `scp` 传到目标机，但不运行 installer；用户在目标机手动安装。网络门禁通过前不得执行其余联网安装。
3. 安装需要用户配置时，已有配置文件直接通过 `scp` 传输；文字配置通过 SSH stdin 写成文件。缺少必要配置时主动向用户索要，最后由用户在目标机手动应用。
4. 优先平台原生 package manager，其次使用可验证的官方发布渠道；无法安全自动化时标记 `manual`。
5. 修改现有文件前备份，只修改 Dawn Forge 标记块。
6. 每项安装后重新探测；失败时停止依赖它的后续项，并先诊断再决定恢复。

### 7. 应用非软件设置

1. 仅应用 profile 中显式声明的 `settings`。
2. `settings.git` 缺省时保持现状。
3. `settings.ssh.githubKey` 或 `generalKey` 为 `true` 时，按目标平台在目标机本地初始化对应 key；已存在时验证并复用，绝不覆盖。
4. passphrase 只能由用户在目标机本地输入。第三方账户绑定需要用户操作或额外明确授权。

### 8. 验证、记录和交付

1. 验证管理 SSH、平台身份、profile 中每个 required 软件、PATH、显式设置和人工任务。
2. 保存无秘密运行状态；恢复时重新探测目标事实，不以状态文件覆盖事实。
3. 输出 `completed`、`manual`、`skipped`、`failed` 和 `not-verified` 汇总。
4. 仅把实际验证过的控制机/目标机平台组合标记为已验证；其他组合保持 `not-verified`。

## 安全规则

- 只信任官方 primary source；下载 URL 必须为无嵌入凭据的 HTTPS。
- publisher 未提供 digest 时，只能声明本地 SHA-256 证明传输一致，不能声称验证发布者完整性。
- 不自动卸载、降级、删除用户数据、替换 key、清除 host key 或关闭安全机制。
- 同一 target alias 同时只允许一个修改流程。
- 命令失败后先诊断；不得通过忽略错误、关闭验证或扩大权限继续。
