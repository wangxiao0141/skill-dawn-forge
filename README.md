# Dawn Forge

`dawn-forge` 是一个可安装的 Agent Skill，用于由 macOS 或 Windows 控制机上的 Agent 与用户协作，通过局域网 SSH 配置已可正常使用的 macOS 或 Windows 个人电脑。

第一版覆盖：

- SSH Remote Login 与长期管理公钥建联；
- 稳定 SSH alias、既有管理身份复用与首次建联；
- platform-specific profile、软件计划和一次确认后的批量安装；
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

安装后向 Agent 提供目标 SSH alias 和装机 profile，并调用：

```text
使用 $dawn-forge，以 target `personal-target` 和 profile `/path/to/profile.json` 配置目标电脑。
```

从 [`dawn-forge.profile.example.json`](./skills/dawn-forge/assets/dawn-forge.profile.example.json) 复制空 profile 模板；需要完整参考时查看 [`dawn-forge.profile.macos.example.json`](./skills/dawn-forge/assets/dawn-forge.profile.macos.example.json)。profile 不得保存订阅、password、token 或 private key；示例软件集合不得被当作默认需求。

仓库根目录的 `profiles/` 用于维护仓库所有者自己的真实 profile。它由 Git 管理，但位于可安装 Skill 目录之外，因此不会被 `npx skills` 带到使用者的安装目录。

## 当前验证边界

仓库会验证 Skill 结构、profile 校验器和 `npx skills` 发现。macOS/Windows 控制机到 macOS/Windows 目标机的每种组合必须分别完成真实端到端验证；未验证组合必须报告为 `not-verified`。
