# Dawn Forge

`dawn-forge` 是一个通过 Dawn Engine 配置个人电脑的 Agent Skill。V1 支持 Windows 控制机通过局域网 SSH 管理已完成首次设置的 macOS 目标机。

Skill 只编排确定性的 `dawn` CLI；Target 身份、Catalog、Plan hash 审批、安装执行、Journal、失败传播和恢复都由 Engine 负责。

## 安装

```powershell
npx.cmd skills@latest add wangxiao0141/skill-dawn-forge --skill dawn-forge
```

## 使用

```text
使用 $dawn-forge 配置目标电脑。
```

主流程：

1. `dawn target bootstrap` 注册并验证目标机。
2. `dawn plan` 从声明式 JSON Profile 生成不可变 Plan。
3. Agent 展示完整 Plan 和 `planHash`，等待用户明确批准。
4. `dawn apply --approve <planHash> --format jsonl` 执行。
5. 需要人工操作或恢复时使用 `dawn resume`。
6. 使用 `dawn verify` 检测 drift，使用 `dawn target revoke` 撤销目标机。

目标机不需要安装 Dawn Forge、Node.js、Python 或 Git。Dawn Forge 不处理系统安装、分区、企业 MDM 或公网 SSH。
