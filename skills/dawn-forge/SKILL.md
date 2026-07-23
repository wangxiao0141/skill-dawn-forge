---
name: dawn-forge
description: 通过局域网 SSH 引导用户从 macOS 或 Windows 控制机配置已可正常使用的 macOS 或 Windows 个人电脑。默认从目标机尚未开启 SSH、控制机没有 alias 的状态开始，按声明式 JSON profile 完成建联、批量安装、可选代理客户端、目标机 SSH key、验证和恢复。
---

# Dawn Forge

通过局域网 SSH 协作配置个人电脑。Agent 负责发现、规划、传输、安装和验证；用户负责目标机上的 GUI、管理员授权和秘密输入。

## 边界

- 控制机和目标机支持 macOS 或 Windows；目标机必须已完成系统安装和首次设置。
- 默认从没有 SSH、没有 alias 开始；用户明确提供可用 alias 时才复用。
- 目标机无需安装 Dawn Forge，也无需预装 Node.js、Python 或 Git。
- 只安装用户确认的 profile 内容。示例不是默认软件集，唯一候选也不能自动选择。
- 配置值和秘密不写入 profile、仓库、输出或状态文件，只作为文件传到目标机。
- 控制机管理 key 默认使用 `~/.ssh/id_ed25519`：存在则验证复用，不存在则生成，绝不覆盖。目标机的 GitHub key 和通用 key 与它分开。
- 不要求新目标机复制或粘贴命令。可复制命令只在控制机执行；目标机只处理 GUI 和查看连接地址，目标机密码由用户在控制机终端输入。

## 按需读取

- 处理 profile 前完整读取 [references/profile.md](references/profile.md)。
- 建立 SSH 或创建 key 前完整读取 [references/ssh.md](references/ssh.md)。
- 传递配置前完整读取 [references/configuration-handoff.md](references/configuration-handoff.md)。
- 目标机离线时完整读取 [references/network-bootstrap.md](references/network-bootstrap.md)。
- 确认平台后完整读取 [references/macos.md](references/macos.md) 或 [references/windows.md](references/windows.md)。
- 失败或恢复时完整读取 [references/recovery.md](references/recovery.md)。

## 交互协议

- 只展示四个阶段：`目标与配置 → 环境确认 → Clash 安装与联网 → 执行与交付`。
- 每轮只处理当前阶段，一次收集当前能够获得的全部必要信息；用户只回答一部分时，下一轮合并询问所有剩余项，不拆成单字段往返。
- 首轮同时询问目标机系统和称呼，并给出对应系统开启 SSH、读取登录地址的 GUI 路径；不要要求用户预先准备 alias、IP 或 profile 路径。
- 已知信息不再询问。Agent 自动采用无冲突的安全默认值，不单独确认控制机默认 key 或推荐 alias。
- 只读检查、诊断和非覆盖式 SSH 准备直接执行。目标与配置阶段只在用户输入目标机密码时暂停；key 异常、alias 冲突、已记录的 host key 或 machine ID 变化、平台或账号冲突时才停止询问。
- 软件和设置在环境确认结束时一次确认完整计划，不逐项确认。

## 工作流

### 阶段 1：目标与配置

1. 除非用户明确提供可用 alias，否则默认没有 SSH。首轮一次询问目标机系统和称呼，同时给出该系统开启 SSH、读取登录地址的 GUI 操作。
2. 收到部分答案时，一次补问剩余信息。收到登录账号和局域网 hostname 后，不再用单独消息确认 key 或 alias。
3. 根据目标机称呼自动选用无冲突的简短 alias，直接运行 `scripts/prepare-ssh-bootstrap.mjs plan`。该命令会验证或非覆盖式创建控制机默认 `~/.ssh/id_ed25519`，并生成 `installKeyCommand`。
4. 在同一轮把 `installKeyCommand` 交给用户。用户只在控制机终端运行这一条命令并输入一次目标机密码；脚本直接写入远端 `authorized_keys`。
5. 用户报告完成后，Agent 直接完成 public-key-only 验证、确认强身份信号、写入 alias 并继续发现 profile，不再请求确认。普通 hostname 或设备显示名称只记录，不用于单独拦截。
6. 查找工作区 `profiles/*.json`，逐个运行：

   ```text
   node <skill-directory>/scripts/validate-profile.mjs <profile.json>
   ```

7. 展示匹配 profile 的软件、`settings` 和 `manualTasks`，让用户选择并一次说明增删项。没有有效 profile 时再修复或从空模板创建。
8. 记录确认后的 profile `id`、platform 和 SHA-256。

### 阶段 2：环境确认

1. 按目标平台检查磁盘、权限、包管理器、现有软件、PATH 和安装端点网络。
2. 把 profile 项目分为 `install`、`skip`、`update`、`conflict` 或 `manual`；默认使用最新稳定版，不做无关升级或降级。
3. 展示检查结果、完整安装计划、人工任务，以及是否需要 Clash。
4. 用户一次确认整个计划；profile、目标身份或关键环境变化后重新确认。

### 阶段 3：Clash 安装与联网

1. 目标机已能访问安装端点时跳过本阶段。
2. 需要联网且 profile 包含 Clash Verge 时，Agent 下载、校验并传输安装包；用户手动安装并授权。
3. Agent 将用户提供的订阅 URL 或配置作为文件传到目标机；用户手动导入。
4. 验证安装端点连通性；失败时先诊断，不执行后续安装。

### 阶段 4：执行与交付

1. 按依赖顺序批量安装已确认的软件，优先使用平台 package manager。
2. 应用 profile 明确声明的设置；在目标机生成或复用 GitHub key 和通用 key，passphrase 由用户本地输入。
3. 修改现有文件前备份；失败时停止相关后续项并先诊断。
4. 验证 SSH、软件、PATH、设置和人工任务，汇总 `completed`、`manual`、`skipped`、`failed` 和 `not-verified`。

## 底线

- 下载只使用官方 HTTPS 来源；如无 publisher digest，只报告本地 SHA-256，不声称验证了发布者完整性。
- 不自动卸载、降级、删除用户数据、替换 key、清除 host key 或关闭安全机制。
- 不执行 profile 中的字符串命令，也不把字段直接拼接为 shell。
- 身份变化或命令失败时停止并诊断，不通过忽略错误或扩大权限继续。
