---
name: dawn-forge
description: 通过局域网 SSH 引导用户把已可正常使用的 Apple Silicon Mac mini 配置为个人工作站。用于根据声明式 JSON 装机清单完成 SSH 首次建联、Clash Verge Rev 准备与人工配置、软件计划和批量安装、目标机 GitHub 专用与通用 SSH 密钥初始化、验证、失败恢复和后续维护。
---

# Dawn Forge

协作完成 Mac mini 装机。让控制机上的 Agent 负责检查、规划和可远程执行的操作，让用户只处理目标机上的管理员密码、GUI、秘密输入和高风险确认。

## 固定边界

- 仅支持已完成 macOS 首次设置、可由管理员登录的 Apple Silicon（`arm64`）个人 Mac mini。
- 仅支持局域网域名连接；不配置公网 SSH、路由器端口转发、企业 MDM、磁盘分区或 macOS 安装。
- 使用控制机已有的 `ssh`、`scp` 和 `ssh-keygen`；不要求目标机安装 Dawn Forge、clone 仓库或预装 Node.js、Python、Git。
- 把装机清单视为目标状态，不把它当作远程命令列表。
- 不读取、索要、回显或保存 Clash 订阅、密码、token、私钥等秘密。
- 不复用三类 SSH 身份：控制机管理密钥、目标机 GitHub 专用密钥、目标机通用密钥。

## 按需读取资源

- 接收、创建或修改装机清单前，完整读取 [references/manifest.md](references/manifest.md)，并从 [assets/dawn-forge.example.json](assets/dawn-forge.example.json) 复制模板。
- 建立 SSH、修改 `authorized_keys` 或初始化目标机密钥前，完整读取 [references/ssh.md](references/ssh.md)。
- 准备 Clash Verge Rev、Homebrew 或批量软件安装前，完整读取 [references/macos.md](references/macos.md)。
- 发生失败、中断、目标身份变化或恢复执行时，完整读取 [references/recovery.md](references/recovery.md)。

## 工作流

### 1. 接收并校验装机清单

1. 要求用户提供装机清单路径；没有清单时复制示例并只询问无法从环境发现的字段。
2. 相对 `SKILL.md` 定位校验器并执行：

   ```text
   node <skill-directory>/scripts/validate-manifest.mjs <manifest.json>
   ```

3. 把校验器输出的 manifest SHA-256、`target.id`、`target.host` 和软件数量写入运行记录。
4. 发现秘密字段、未知字段、重复软件或不安全的 host/user 值时停止，不尝试猜测或自动修正。

### 2. 建立执行协议

1. 先做只读检查并展示分阶段计划。
2. 对 SSH 建联、代理准备、软件批量安装、目标机密钥初始化分别说明 Agent 与用户的动作。
3. 普通软件只展示一次安装计划；用户确认软件集合和来源后批量执行，不逐个请求批准。
4. 仅在秘密输入、GUI、管理员密码、重启、删除、降级或覆盖已有配置时单独暂停。

### 3. 建立 SSH 管理连接

1. 在控制机为 `target.id` 创建长期专用管理密钥；已存在时验证配对，绝不覆盖。
2. 生成一段可审计的目标机本地操作，引导用户开启 Remote Login，并幂等追加管理公钥。
3. 使用 `StrictHostKeyChecking=accept-new` 首次记录 host key；禁止 `StrictHostKeyChecking=no`。
4. 只使用指定管理密钥回连，并验证远端用户、`Darwin`、`arm64`、hostname 和 macOS 版本。
5. 建联完成后保留管理连接；不启用 root SSH，不写入免密 `sudo`，不上传控制机私钥。

### 4. 检查目标机并生成计划

1. 只读检查磁盘空间、macOS 支持状态、Command Line Tools、Homebrew、现有应用、CLI、shell 配置和代理状态。
2. 将每个软件分类为 `install`、`skip`、`update`、`conflict` 或 `manual`。
3. 默认选择最新稳定版；已满足则跳过，不自动降级或执行无关的全局升级。
4. 展示软件名、解析后的官方来源、安装方式和动作，等待一次批量安装确认。

### 5. 准备 Clash Verge Rev

1. 从官方 stable GitHub Release 动态选择唯一的 Apple Silicon 安装包，不把版本或文件名写死。
2. 在控制机下载并验证发布来源、release metadata、传输前后 SHA-256，以及目标机上的 macOS code signature。
3. 通过 `scp` 把安装包放入目标机 `~/Downloads/`。
4. 暂停并引导用户在目标机完成安装、macOS 授权、订阅导入和代理启用；不得要求用户把订阅发到聊天。
5. 从目标机实际代理状态推导连接方式，验证 GitHub 和 Homebrew 官方端点可访问后再继续。

### 6. 批量安装软件

1. 优先使用 Homebrew formula/cask；其次使用可验证的官方发布渠道；Mac App Store 和无法安全自动化的软件转为人工步骤。
2. 需要 Command Line Tools、Homebrew 首次管理员授权或 GUI 时，把相关动作合并为尽量少的人工阶段。
3. 按依赖顺序批量执行已批准的软件，不把清单中的字符串直接拼接为 shell。
4. 安装后逐项探测真实状态；单个失败时停止后续依赖项，保留无依赖项是否继续的选择。

### 7. 初始化目标机 SSH 密钥

1. 在目标机初始化 `~/.ssh/github_ed25519`，专用于 `github.com`。
2. 在目标机初始化 `~/.ssh/id_ed25519`，作为访问其他主机的通用密钥。
3. 任一同名私钥已存在时验证并复用，绝不覆盖；缺少配对公钥时从私钥重新导出。
4. 让用户在目标机本地设置 passphrase，并按需加入 macOS Keychain；秘密不得经过 SSH 命令参数、聊天或日志。
5. 为 GitHub 写入受标记管理的 `~/.ssh/config` 块，固定 `IdentityFile` 和 `IdentitiesOnly yes`。
6. 展示两把公钥。只引导用户或经用户明确授权后绑定 GitHub；不自动修改第三方账户。

### 8. 验证、记录和交付

1. 验证管理 SSH、Clash Verge Rev、代理、Homebrew、每个请求的软件、PATH、Git 设置和两把目标机公钥。
2. 将无秘密运行状态保存到控制机 `~/.dawn-forge/targets/<target.id>/state.json`，并以临时文件加原子替换方式更新。
3. 每次恢复都重新探测目标机；运行记录只用于进度，不覆盖目标机事实。
4. 输出 `completed`、`manual`、`skipped`、`failed` 和 `not-verified` 汇总，明确列出用户下一步。
5. 在真实 Mac mini 端到端验证完成前，明确标注相关能力为 `not-verified`，不得把 dry run 描述成真机成功。

## 安全规则

- 只信任官方 primary source；下载 URL 必须使用无嵌入凭据的 HTTPS。
- publisher 未提供 digest 时，只能用本地 SHA-256证明传输一致性，不能声称验证了发布者完整性；同时要求 macOS code signature 通过。
- 修改现有文件前创建带时间戳备份，只修改 Dawn Forge 标记块。
- 不自动卸载、降级、删除用户数据、替换现有密钥、清除 host key 或关闭系统安全机制。
- 不同时对同一 `target.id` 执行两个修改流程。
- 命令失败后先诊断；不得用忽略错误、关闭验证或扩大权限的方式继续。
