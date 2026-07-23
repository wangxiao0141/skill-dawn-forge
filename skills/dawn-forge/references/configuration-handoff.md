# 配置文件交接

安装需要额外配置时，Agent 负责把配置放到目标机，用户负责手动应用。

目标目录：

- macOS：`~/Downloads/dawn-forge/`
- Windows：`%USERPROFILE%\Downloads\dawn-forge\`

规则：

1. 用户已经提供的配置直接使用；缺少必要配置时主动询问。
2. 用户提供的是文件时，通过 `scp` 保持原文件名传输。
3. 用户提供的是文字时，通过 SSH stdin 写成含义明确的文本文件。例如 Clash 订阅 URL 写为 `clash-subscription-url.txt`。
4. 一次传完本轮需要的配置，不逐个要求确认。
5. 不把配置内容写入 profile、仓库、命令参数、输出或运行状态。
6. macOS 目标目录权限设为 `0700`，文件权限设为 `0600`；Windows 文件放在当前用户 profile 下。
7. 传输后只报告文件名和目标路径，不读取或回显内容。
8. 文件默认保留，用户可在完成配置后自行删除。

配置文件只用于交接，不由 Agent 自动执行、导入或解释。
