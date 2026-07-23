# 秘密剪贴板交接

## 适用范围

仅用于用户明确授权交接订阅 URL、token 或其他必须粘贴到目标机 GUI 的短期秘密。优先让用户把秘密复制到控制机剪贴板，再由 Agent 通过已验证的 SSH stdin 写入目标机剪贴板。

秘密不得进入：

- profile、仓库、文件或运行状态；
- shell/PowerShell 参数、环境变量或临时脚本；
- Agent 输出、命令输出、错误日志或校验摘要。

用户直接在聊天中提供秘密时不要复述。要求用户在控制机复制该消息，再使用剪贴板桥接；聊天本身已经保存该秘密时，完成配置后提醒用户按需轮换。

## 前提

1. 重新确认控制机和目标机平台。
2. 使用已经通过 `ssh -G`、key pair 和 public-key-only 验证的同一 SSH executable、target alias 与管理身份。
3. 目标机必须有已登录的桌面用户；SSH 用户必须与桌面用户一致。
4. 在读取控制机剪贴板前让用户确认“已复制”。不得主动输出剪贴板内容进行检查。

## 传输

Windows 控制机到 macOS 目标机：

```powershell
Get-Clipboard -Raw |
  & '<verified-system-ssh.exe>' <public-key-only-options> <target> pbcopy
```

macOS 控制机到 macOS 目标机：

```bash
pbpaste | <verified-system-ssh> <public-key-only-options> <target> pbcopy
```

传输命令只能输出 SSH 成功或失败状态，不能使用 `tee`、`Write-Output`、`echo`、verbose shell tracing 或内容摘要。不要把 clipboard 内容赋给会被命令记录的参数。

Windows 目标机只有在 SSH 会话已验证能够访问当前交互桌面剪贴板时，才使用 stdin 到 `Set-Clipboard`；服务 session 与桌面 session 隔离时转为用户本地粘贴，不创建明文临时文件。

## 完成与清理

1. 只报告“剪贴板已传输”，不报告内容、长度、hash 或 URL host。
2. 用户在目标机 GUI 中粘贴、导入并完成配置。
3. 用户确认导入成功后，提醒其在两端复制无敏感文本覆盖剪贴板。
4. 不读取目标机剪贴板来验证；通过应用状态、proxy/TUN 和官方端点连通性验证结果。
