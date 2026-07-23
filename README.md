# Dawn Forge

`dawn-forge` 是一个通过局域网 SSH 配置个人电脑的 Agent Skill。控制机和目标机均支持 macOS 或 Windows。

它负责：

- 默认从没有 SSH 开始，生成控制机 key、建立公钥连接并保存 alias；
- 根据用户选择的 JSON profile 生成计划并批量安装；
- 目标机离线时传输 Clash Verge 安装包和配置，由用户手动安装；
- 配置目标机 GitHub key、通用 SSH key，并验证结果。

目标机必须已经完成系统安装和首次设置。本 Skill 不分区、不处理企业 MDM，也不开放公网 SSH。

## 安装

```powershell
npx.cmd skills@latest add wangxiao0141/skill-dawn-forge --skill dawn-forge
```

macOS 或 Linux：

```bash
npx skills@latest add wangxiao0141/skill-dawn-forge --skill dawn-forge
```

## 使用

```text
使用 $dawn-forge 配置目标电脑。
```

流程只有四个阶段：

1. 目标与配置
2. 环境确认
3. Clash 安装与联网（不需要时跳过）
4. 执行与交付

Agent 首先询问目标机系统和称呼，再引导通过 GUI 开启 SSH、读取系统显示的局域网登录地址。控制机默认使用 `~/.ssh/id_ed25519`；已有 key 会验证复用，不存在时才生成。设置公钥只需在控制机运行一条命令并输入目标机密码，新目标机不需要复制或粘贴命令。

## Profile

使用 [`dawn-forge.profile.example.json`](./skills/dawn-forge/assets/dawn-forge.profile.example.json) 创建空 profile；[`dawn-forge.profile.macos.example.json`](./skills/dawn-forge/assets/dawn-forge.profile.macos.example.json) 仅作示例，不是默认软件集。

真实 profile 放在工作区的 `profiles/`，不会随 Skill 安装。订阅 URL、token 等配置不写入 profile，由 Agent 在运行时作为文件传到目标机。
