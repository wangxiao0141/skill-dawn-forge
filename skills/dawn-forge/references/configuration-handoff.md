# 配置文件交接范围

Dawn Engine V1 不负责代理订阅、token、许可证、SSH private key 或其他秘密配置的收集与传输。不得把这些值放入聊天、Profile、Plan、Journal、环境变量或命令参数。

随 Skill 保留的 `collect-private-input.mjs`、`transfer-private-input.mjs`、`artifact-cache.mjs` 和 `transfer-artifact.mjs` 属于尚未接入 Engine Target/Plan/Run 合同的底层能力，不是当前公开工作流入口。不得把 `dawn target bootstrap` 生成的 Target 伪装成 legacy identity receipt，也不得手写 `scp`、SSH 或下载命令绕过边界。

需要配置交接时，将其作为 V1 范围外人工任务报告。用户独立完成后，只重新运行与 Catalog Action 有关的 `dawn plan`、`apply` 或 `verify` 流程。
