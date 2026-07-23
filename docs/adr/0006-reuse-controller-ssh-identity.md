# 验证并复用控制机已有的 SSH 管理身份

Dawn Forge 通过稳定 SSH alias 解析控制机现有的 `User` 与 `IdentityFile`，验证 key pair 后优先复用；只有没有可用身份且用户明确确认时才创建新 key。管理身份可以服务于既有目标连接，但不得与目标机持有的 GitHub 或其他外部服务身份互相复制或复用。这样既避免重复创建 key，也保留身份用途边界。
