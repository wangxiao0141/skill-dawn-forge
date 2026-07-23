# Dawn Engine 执行约束

安装执行的唯一公开入口是 `<skill-directory>/bin/dawn.mjs`。Agent 只负责收集非敏感输入、展示 Plan、取得精确 `planHash` 批准并转发 Run 事件；不得拼接 SSH、Homebrew、Git 或其他安装命令。

## 标准流程

```text
node <skill-directory>/bin/dawn.mjs target bootstrap --host <host> --user <user> --name <name>
node <skill-directory>/bin/dawn.mjs plan --target <targetId> --profile <profile.json> --out <plan.json>
node <skill-directory>/bin/dawn.mjs apply --plan <plan.json> --approve <planHash> --format jsonl
node <skill-directory>/bin/dawn.mjs run show --run <runId>
node <skill-directory>/bin/dawn.mjs resume --run <runId> --format jsonl
node <skill-directory>/bin/dawn.mjs verify --run <runId>
```

`plan` 只解析随 Skill 发布的版本化 Catalog。`apply` 会重新验证 Plan 结构、Catalog 绑定和 `planHash`；任何变化都必须重新生成并批准。

## 事件与恢复

- `action-progress` 只表示远端命令仍有输出，不包含原始输出或秘密。
- `needs-user` 一次只展示一个 `instruction`。用户完成后才运行 `resume`。
- 崩溃遗留的 `running` Action 首次恢复时 fail closed。只有用户确认目标机没有遗留安装进程后，才允许再次 `resume`。
- `verify` 只检查已成功 Action 的 drift，不修改目标机。
- 不静默重试失败 Action，不绕过 Target identity、Run lock 或 Plan approval。

退出码以 `SKILL.md` 的 V1 表格为准。
