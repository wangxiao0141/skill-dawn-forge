# 将 Dawn Forge 作为独立可安装的 Skill 发布

新仓库采用 `skills/dawn-forge/` 作为唯一可分发单元，使用户能够通过 `npx skills add <owner>/<repo> --skill dawn-forge` 安装，同时避免把仓库开发依赖一并打包。`C:\dev\dawn-forge` 中的旧实现只用于提取需求、风险和测试场景，不复制其 controller、CLI、目录结构或技术选型，也不要求兼容或迁移。
