# SSH 建联与身份

## 身份模型

始终区分：

1. 目标机 SSH host key：证明连接到同一 SSH server。
2. 控制机管理身份：private key 只在控制机，用于访问目标机。
3. 目标机外部服务身份：private key 只在目标机，用于 GitHub 或其他主机。

控制机已有且匹配 target 的管理身份应验证后复用。不得把任一 private key 复制到另一台机器，也不得把管理身份改作目标机外部服务身份。

## 控制机工具链

控制机只支持 macOS 或 Windows。

- macOS：通过 `command -v` 和 `type -a` 确认系统 OpenSSH。
- Windows：通过 `Get-Command ssh -All`、`where.exe ssh` 确认真实 executable。
- 如果裸命令解析到 sandbox deny shim、`.bat`、`.cmd` 或未知 wrapper，不要把其输出当成 SSH 结果；获得工具授权后调用已验证的系统 executable 绝对路径。
- 同一次运行对 `ssh -G`、连接和 `scp` 使用同一套已验证工具。
- Windows 控制机向 macOS 目标机传输 shell 脚本时，必须使用 UTF-8 无 BOM 与 LF；不要假设 PowerShell 文本 pipeline 会保持原始换行。可在上传前后比较 SHA-256，或以不会重编码 stdin 的方式传输。出现 `\r: command not found` 时按控制机传输编码故障处理，不得误判为目标命令失败或忽略错误继续。

## SSH 尚未开启或没有 alias

SSH alias 是建联结果，不是启动前提。没有 alias 时：

1. 引导用户访问本次要配置的目标电脑；使用已经确认的目标平台，不重复询问。
2. 引导用户在目标机开启 SSH：
   - macOS：打开 `System Settings > General > Sharing > Remote Login`，只允许目标账号；
   - Windows：安装并启动 OpenSSH Server，确认 `sshd` service 和局域网 firewall rule。
3. 让用户在目标机本地确认登录账号和局域网名称：
   - macOS：`whoami` 与 `scutil --get LocalHostName`，默认目标为 `<LocalHostName>.local`；
   - Windows：`whoami` 与 `hostname`。
4. 在控制机检查现有 SSH config 和 key。优先复用已知管理身份；没有可用 key 时才请求创建。
5. 给出目标平台对应的本地步骤，把选定管理公钥幂等加入 `authorized_keys`。
6. 先用局域网 hostname 完成 public-key-only 回连。
7. 回连成功后询问用户希望如何命名这台电脑的稳定 alias；提供一个推荐名称，但必须等待确认。
8. 把确认后的 alias 与已验证的 HostName、User、IdentityFile 写入控制机 SSH config，再使用 alias 复验。

不要要求用户自己设计 alias、提前提供 IdentityFile，或在尚未开启 SSH 时反复尝试连接。

## 稳定 alias 与管理身份

推荐配置：

```sshconfig
Host personal-target
  HostName personal-target.local
  User alice
  IdentityFile ~/.ssh/personal-target_ed25519
  IdentitiesOnly yes
```

已有匹配 alias 时先展示并询问是否用于本次目标。需要创建时，根据用户对目标电脑的称呼和已验证 hostname 提供推荐名称，等待用户确认后再写入控制机 SSH config 的 Dawn Forge 标记块。

执行 `<ssh-executable> -G <target>`，至少核对：

- `HostName` 解析为预期局域网目标；
- `User` 是目标机现有管理员账号；
- `IdentityFile` 只有选定的管理身份；
- `IdentitiesOnly yes`；
- 没有意外的 `ProxyCommand`、`ProxyJump` 或 `RemoteCommand`。

`IdentityFile` 存在时：

1. 确认 private/public 文件同时存在；
2. 用 `ssh-keygen -y -f <private>` 导出 type/blob；
3. 与 `.pub` 的 type/blob 比较；
4. 匹配后直接复用，不创建第二把 key。

只有没有可用身份时，才让用户选择已有 key；仍无可用 key 时，经明确确认创建：

```text
~/.ssh/dawn-forge/<target-id>/management_ed25519
```

不得覆盖、不自动替换 alias 中的既有身份。

## Public-key-only 验证

使用：

```text
<ssh-executable> -o BatchMode=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o IdentitiesOnly=yes -o StrictHostKeyChecking=<accept-new-or-yes> -i <management-key> <target>
```

- 首次没有 host key 时使用 `accept-new`；已有记录时使用 `yes`。
- 禁止 `StrictHostKeyChecking=no`。
- 禁止回退到默认 key、SSH agent 中的其他身份或 password。
- host key 变化时停止，不自动执行 `ssh-keygen -R`。
- 连接成功后探测远端用户、OS、architecture、hostname、系统版本和 machine ID。

## 目标尚未信任公钥

只有 public-key-only 验证失败且原因确定为未授权 key 时，才进入 bootstrap。先由用户在目标机本地启用 SSH：

- macOS：`System Settings > General > Sharing > Remote Login`，只允许目标账号。
- Windows：安装并启动 OpenSSH Server，确认 `sshd` service 与局域网 firewall rule；Administrator 场景需理解共享授权文件边界。

macOS 普通账号幂等追加：

```bash
umask 077
mkdir -p "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh"
chmod 600 "$HOME/.ssh/authorized_keys"
grep -qxF '<managed-authorized-key-line>' "$HOME/.ssh/authorized_keys" ||
  printf '%s\n' '<managed-authorized-key-line>' >> "$HOME/.ssh/authorized_keys"
```

Windows 普通账号使用 `%USERPROFILE%\.ssh\authorized_keys`。Administrator 默认使用 `%PROGRAMDATA%\ssh\administrators_authorized_keys`，该文件对 Administrators 组共享，必须按 Windows OpenSSH 要求收敛 ACL；先检查实际 `sshd_config`，不要假设自定义配置仍使用默认路径。

写入行增加 `no-agent-forwarding,no-port-forwarding,no-X11-forwarding`，使用选定 key 的 type/blob 和受控 comment。不得覆盖整个文件。回连失败时，只能精确移除本次新增且仍完全匹配的行。

## 目标机外部服务 key

仅在 profile `settings.ssh` 明确启用时处理：

```text
~/.ssh/github_ed25519
~/.ssh/id_ed25519
```

- 使用 `ED25519`。
- private key 已存在时验证并复用；缺少 `.pub` 时可从 private key 导出。
- passphrase 由用户在目标机本地输入，不经过 SSH 参数、聊天或日志。
- `githubKey` 只用于 GitHub；`generalKey` 不写全局 `Host *` 规则。
- macOS 可按用户选择使用 `ssh-add --apple-use-keychain`；Windows 使用系统 OpenSSH agent 时需用户明确授权。
- 写 `~/.ssh/config` 前创建时间戳备份，只管理 Dawn Forge 标记块；已有竞争配置时报告冲突。
- 展示 public key。第三方账户绑定由用户完成，或在额外明确授权且官方 CLI 已登录时执行。
