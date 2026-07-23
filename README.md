# Dawn Forge

`dawn-forge` 是一个通过局域网 SSH 配置个人电脑的 Agent Skill。控制机和目标机均支持 macOS 或 Windows。

它负责：

- 默认从没有 SSH 开始，生成控制机 key、建立公钥连接并保存 alias；
- 通过单次 inventory、批量 metadata 和分位置 route probe 生成一次确认的完整计划，再按依赖和实际联网端点拆成每批最多三个软件；
- 目标机离线时先确认只包含 Clash 的网络引导 mini-plan，再通过 canonical cache 和受控传输交给用户手动安装；
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
2. Clash 安装与联网（不需要时跳过）
3. 环境确认
4. 执行与交付

Agent 在首轮要求按 `<platform> <user>@<host>` 一次提供目标平台和 GUI 显示的完整登录地址。信息齐全后自动准备无冲突的 alias 和控制机 `~/.ssh/id_ed25519`。建联时只需输入一次目标机登录密码；后续仅在计划已披露的 sudo 人工步骤中按需输入。`finalize` 原子保存目标 identity receipt。只有必需的 Clash 且目标机直连确实不可用时才走已确认的网络引导 mini-plan。

环境确认不再由 Agent 临时拼 SSH 或逐项 `brew info`：受控 planner 生成 preflight receipt 与 schedule。执行统一走 `prepare → advance → observe → cancel`，控制机和目标机 route 分开记录，每批最多三个并逐项 `fetch → install → verify`。`observe` 只读本地状态，取消只触及 owned process；不启动 detached 后台下载，也不用固定 sleep、`pgrep` 或 package manager 查询轮询。

## Profile

使用 [`dawn-forge.profile.example.json`](./skills/dawn-forge/assets/dawn-forge.profile.example.json) 创建空 profile；[`dawn-forge.profile.macos.example.json`](./skills/dawn-forge/assets/dawn-forge.profile.macos.example.json) 仅作示例，不是默认软件集。

真实 profile 放在工作区的 `profiles/`，不会随 Skill 安装。订阅 URL、token 等配置不写入聊天或 profile；用户通过控制机本地隐藏输入生成用户目录下的受保护文件，再由 Agent 传到目标机。
