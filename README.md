# Dawn Forge

`dawn-forge` 是一个可安装的 Agent Skill，用于由控制机上的 Agent 与用户协作，通过局域网 SSH 配置已可正常使用的 Apple Silicon Mac mini。

第一版覆盖：

- SSH Remote Login 与长期管理公钥建联；
- `Clash Verge Rev` 官方安装包准备、校验、传输和人工配置；
- 声明式装机清单、软件计划和一次确认后的批量安装；
- 目标机 GitHub 专用密钥与通用 SSH 密钥初始化；
- 状态验证、失败恢复和后续重复执行。

它不安装 macOS、不分区、不处理企业 MDM，也不开放公网 SSH。

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

安装后向 Agent 提供装机清单，并调用：

```text
使用 $dawn-forge 根据装机清单配置我的 Mac mini。
```

从 [`dawn-forge.example.json`](./skills/dawn-forge/assets/dawn-forge.example.json) 复制清单模板。清单不得保存 Clash 订阅、password、token 或 private key。

## 当前验证边界

仓库会验证 Skill 结构、装机清单校验器和 `npx skills` 发现。真实 Mac mini 的 SSH、GUI、`sudo`、Clash 和软件组合仍需首次端到端装机验证；完成前必须报告为 `not-verified`。
