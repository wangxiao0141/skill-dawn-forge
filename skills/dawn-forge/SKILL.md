---
name: dawn-forge
description: 通过 Dawn Engine CLI 从 Windows 控制机配置已完成首次设置的 macOS 个人电脑。用于注册或检查局域网 SSH Target、从声明式 JSON Profile 生成并审批不可变 Plan、执行安装、处理人工步骤、恢复 Run、检测 drift 或撤销 Target。
---

# Dawn Forge

只编排 `<skill-directory>/bin/dawn.mjs`。不要自行拼接 SSH、Homebrew、Git 或安装命令；规划、身份复验、失败传播和恢复全部交给 Dawn Engine。

## 边界

- V1 仅支持 Windows 控制机和 macOS 目标机。目标机必须已完成系统安装、首次设置并可由用户在 GUI 中开启 Remote Login。
- 控制机需要 Node.js 20+；目标机只需要系统 SSH，不需要安装 Dawn Forge、Node.js、Python 或 Git。
- 不在聊天、命令参数、Plan、Journal 或 profile 中放入密码、token、订阅 URL 或私钥。
- Target 身份冲突、Plan hash 不匹配或锁冲突时停止，不绕过 Engine 的身份、审批或锁。

以下命令中的 `dawn` 表示：

```text
node <skill-directory>/bin/dawn.mjs
```

## 工作流

1. 从用户处一次收集 macOS 登录地址中的 `<user>@<host>` 和设备称呼。若 Remote Login 尚未开启，只说明 macOS GUI 路径；不要让用户在目标机粘贴命令。
2. 注册 Target：

   ```text
   dawn target bootstrap --host <host> --user <user> --name <name>
   ```

   CLI 会显示一条需要在控制机终端执行的受限授权命令。让用户完成该唯一人工步骤，再按 CLI 提示确认。保存 CLI 输出的 `targetId`。
3. 让用户选择或创建符合 V1 格式的 JSON Profile。可从 `assets/dawn-engine.profile.example.json` 开始；软件 ID 只能来自随 Skill 发布的 `catalog/v1.json`。`packages` 的每一项必须是带 `id` 和 `state` 的对象，不是字符串。若用户要求配置 Git identity，先收集非敏感的 `name` 和 `email`，并使用 `git-identity` 条目：

   ```json
   {
     "schemaVersion": 1,
     "platform": "macos",
     "catalogVersion": "v1",
     "packages": [
       { "id": "homebrew", "state": "present" },
       { "id": "git", "state": "present" },
       {
         "id": "git-identity",
         "state": "present",
         "params": {
           "name": "Your Name",
           "email": "you@example.com"
         }
       },
       { "id": "node", "state": "present" },
       { "id": "vscode", "state": "present" }
     ]
   }
   ```
4. 生成 Plan：

   ```text
   dawn plan --target <targetId> --profile <profile.json> --out <plan.json>
   ```

   完整展示 `<plan.json>` 和 CLI 输出的 `planHash`。在用户明确批准这个精确 hash 前，不得运行 `apply`。
5. 获得批准后执行，并原样流式转发每一行 JSONL：

   ```text
   dawn apply --plan <plan.json> --approve <planHash> --format jsonl
   ```

   记录启动事件中的 `runId`。不要根据事件自行生成额外命令。
6. 退出码 `10` 表示等待人工步骤。一次只展示事件中的一个 `instruction`；用户明确完成后运行：

   ```text
   dawn resume --run <runId> --format jsonl
   ```

7. 退出码 `40` 表示 Action 失败或恢复需要先确认状态。先运行 `dawn run show --run <runId>`。若事件要求确认目标机没有遗留安装进程，必须让用户确认后才能再次 `resume`。
8. 需要只读 drift 检查时运行 `dawn verify --run <runId>`。不再管理目标机时运行 `dawn target revoke --target <targetId>`。

## 退出码

- `0`：成功
- `2`：参数或 schema 无效
- `10`：等待用户操作
- `20`：Plan 无效或审批 hash 不匹配
- `30`：Target 身份冲突
- `40`：Action 失败或 Run 安全停止
- `50`：verify 发现 drift
- `60`：状态锁冲突

除 `0` 和已说明的 `10` 外，不要静默重试；先向用户展示对应错误或 JSONL 事件。
