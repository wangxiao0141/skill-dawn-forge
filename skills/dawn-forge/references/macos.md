# macOS V1 约束

Dawn Engine V1 只支持已完成首次设置、可在 GUI 中开启 Remote Login 的 macOS 目标机。控制机运行 Node.js 20+；目标机不需要安装 Dawn Forge、Node.js、Python 或 Git。

- Target 注册、身份复验和撤销只通过 `dawn target` 子命令。
- 软件 ID、Provider、参数、依赖和关键性只来自版本化 Catalog。
- Homebrew 本体缺失时形成单一人工步骤；Agent 不自行运行官方安装脚本。
- formula、cask、Git 和 Git identity 均由 Engine Provider 检查、应用并复验。
- Profile 请求 `git-identity` 时必须显式提供非敏感的 `name` 与 `email`；已有相同配置会跳过，不同配置按批准的 Plan 更新。
- GUI 登录、许可证、Apple ID、系统扩展和隐私授权不在 V1 自动化范围内。

完整流程见 `references/execution.md`。
