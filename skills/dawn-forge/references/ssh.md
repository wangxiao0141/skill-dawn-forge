# SSH Target 建联

Dawn Engine V1 默认从控制机没有可用 alias、目标 macOS 尚未开启 Remote Login 开始。Agent 不在目标机终端执行命令。

## 建联

1. 引导用户在 macOS 打开 `System Settings > General > Sharing > Remote Login`，只允许本次登录账号。
2. 一次收集面板中的 `<user>@<host>` 和设备称呼。
3. 运行：

   ```text
   dawn target bootstrap --host <host> --user <user> --name <name>
   ```

4. CLI 会显示唯一一条受限授权命令。让用户在控制机自己的 Terminal 或 PowerShell 执行并在本地输入目标机密码；密码不得进入聊天、argv 或日志。
5. 用户确认后，CLI 使用 public-key-only SSH 复验 host key、machine ID、architecture 和 remote user，并保存 `targetId`。

不要自行拼接公钥、`authorized_keys`、SSH config、`known_hosts` 或远端命令。管理 key、Target registry、并发锁、失败回滚和安全 SSH option 全部由 Engine 负责。

## 检查与撤销

```text
dawn target inspect --target <targetId>
dawn target revoke --target <targetId>
```

host key、machine ID、architecture、remote user 或受控 SSH config 发生变化时，以退出码 `30` 停止。不得自动清除 `known_hosts`、尝试其他默认 key、修改 Target 记录或换 alias 绕过冲突。

V1 不生成目标机用于 GitHub 或其他外部服务的 SSH key。
