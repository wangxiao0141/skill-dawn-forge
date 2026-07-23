# Dawn Forge

`dawn-forge` 是一个可安装的 Agent Skill，用于由 macOS 或 Windows 控制机上的 Agent 与用户协作，通过局域网 SSH 配置已可正常使用的 macOS 或 Windows 个人电脑。

第一版覆盖：

- SSH Remote Login 与长期管理公钥建联；
- 稳定 SSH alias、既有管理身份复用与首次建联；
- platform-specific profile、软件计划和一次确认后的批量安装；
- 离线目标机的代理安装包下载与传输、用户手动安装、配置文件交接与联网门禁；
- 文字配置和现有配置文件的目标机交接；
- 可选代理客户端、GitHub 专用 key 与通用 SSH key 配置；
- 状态验证、失败恢复和后续重复执行。

它不安装操作系统、不分区、不处理企业 MDM，也不开放公网 SSH。

## 安装

从 GitHub 仓库安装指定 skill：

```powershell
npx.cmd skills@latest add wangxiao0141/skill-dawn-forge --skill dawn-forge
```

在 macOS 或 Linux 上使用：

```bash
npx skills@latest add wangxiao0141/skill-dawn-forge --skill dawn-forge
```

开发期间可从本地仓库验证发现：

```powershell
npx.cmd skills@latest add . --list
```

`skills` CLI 会发现 [`skills/dawn-forge/SKILL.md`](./skills/dawn-forge/SKILL.md)，仓库根目录的设计记录和测试不会进入安装后的 Skill。

## 使用

安装后直接调用：

```text
使用 $dawn-forge 配置目标电脑。
```

Agent 按固定阶段交互：先选择已有电脑或新电脑，再完成 SSH 建联和 alias 命名，随后使用 validator 展示兼容 profile 的软件、设置与人工任务，最后生成安装计划。每次只要求用户完成一个决定或目标机操作；即使只有一个 profile 也不会自动替用户选择。

从 [`dawn-forge.profile.example.json`](./skills/dawn-forge/assets/dawn-forge.profile.example.json) 复制空 profile 模板；需要完整参考时查看 [`dawn-forge.profile.macos.example.json`](./skills/dawn-forge/assets/dawn-forge.profile.macos.example.json)。profile 不保存实际配置内容；Agent 在运行时索要缺失配置，并把文字配置或现有配置文件统一传到目标机供用户手动应用。示例软件集合不得被当作默认需求。

仓库根目录的 `profiles/` 用于维护仓库所有者自己的真实 profile。它由 Git 管理，但位于可安装 Skill 目录之外，因此不会被 `npx skills` 带到使用者的安装目录。

## 当前验证边界

仓库会验证 Skill 结构、profile 校验器和 `npx skills` 发现。macOS/Windows 控制机到 macOS/Windows 目标机的每种组合必须分别完成真实端到端验证；未验证组合必须报告为 `not-verified`。
