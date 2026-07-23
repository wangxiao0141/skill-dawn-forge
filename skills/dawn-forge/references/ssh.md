# SSH 建联

除非用户明确提供已验证可用的 alias，否则默认控制机与目标机之间没有 SSH。按下面顺序建联，不要求用户预先准备 alias、IP 或公钥命令。

## 身份边界

始终区分：

1. 目标机 SSH host key；
2. 控制机的 `~/.ssh/id_ed25519`，用于管理目标机；
3. 目标机后续生成的 GitHub key 和通用 key。

private key 不得在电脑之间复制。控制机默认 key 已存在时验证复用，不存在时才生成，不覆盖单边缺失或不匹配的 key pair。

## 1. 在目标机开启 SSH

先询问目标机系统和用户对它的称呼。

macOS：

1. 打开 `System Settings > General > Sharing > Remote Login`。
2. 只允许本次登录账号。
3. 在目标机 Terminal 运行：

```bash
printf 'user=%s\n' "$USER"
printf 'hostname=%s.local\n' "$(scutil --get LocalHostName)"
interface="$(route get default 2>/dev/null | awk '/interface:/{print $2}')"
printf 'ip=%s\n' "$(ipconfig getifaddr "$interface")"
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Windows：

1. 安装并启动 OpenSSH Server，确认 `sshd` service 和局域网 firewall rule。
2. 在目标机 PowerShell 运行：

```powershell
"user=$env:USERNAME"
"hostname=$env:COMPUTERNAME"
Get-NetIPConfiguration |
  Where-Object { $_.NetAdapter.Status -eq "Up" -and $_.IPv4Address } |
  Select-Object InterfaceAlias, @{Name="IP";Expression={$_.IPv4Address.IPAddress}}
ssh-keygen -lf "$env:ProgramData\ssh\ssh_host_ed25519_key.pub"
```

让用户一次返回账号、hostname、IP 和 fingerprint。优先使用 `.local` hostname；控制机无法解析时再使用局域网 IP。

## 2. 准备控制机 key

先确认真实系统 `ssh`、`scp` 和 `ssh-keygen`，不要使用 deny shim 或未知 wrapper。
受管沙箱阻止调用时，取得必要工具授权，并通过 `--ssh-keygen <verified-path>` 传入已验证的系统可执行文件。

运行：

```text
node <skill-directory>/scripts/prepare-ssh-bootstrap.mjs key
```

- `exists: true`：验证并复用该 key。
- `exists: false`：向用户说明将创建 `~/.ssh/id_ed25519`，一次确认后运行：

```text
node <skill-directory>/scripts/prepare-ssh-bootstrap.mjs key --create
```

脚本创建无 passphrase 的 ED25519 管理 key，便于 Agent 使用 `BatchMode`。不要覆盖已有文件；用户要求加密 key 时，改由用户在本地生成并配置 `ssh-agent`。

## 3. 推荐 alias 并生成命令

根据用户对目标机的称呼和 hostname 推荐简短 alias，等待确认后运行：

```text
node <skill-directory>/scripts/prepare-ssh-bootstrap.mjs plan --platform <macos|windows> --host <hostname-or-ip> --user <user> --alias <alias>
```

Windows 目标账号属于 Administrators 时增加 `--windows-admin`，并让用户在 elevated PowerShell 执行生成的授权命令。

脚本输出：

- `connectCommand`：用户首次密码登录；
- `authorizeCommand`：用户登录目标机后粘贴执行，幂等写入公钥；
- `verifyCommand`：Agent 验证仅公钥登录；
- `sshConfigBlock`：验证成功后写入控制机 SSH config。

不要自行拼接或改写 `authorizeCommand`。

## 4. 用户首次连接

1. 用户在控制机自己的 Terminal 或 PowerShell 运行 `connectCommand`。
2. 首次 host-key 提示必须与目标机返回的 fingerprint 一致；不一致时停止。
3. 用户输入目标机账号密码。
4. 登录成功后粘贴 `authorizeCommand`，执行完成后运行 `exit`。

密码只由用户在自己的终端输入，不进入聊天、命令参数或日志。

## 5. 验证并保存 alias

1. Agent 运行 `verifyCommand`，不得回退到 password、默认其他 key 或 `StrictHostKeyChecking=no`。
2. 探测远端用户、OS、architecture、hostname、系统版本和 machine ID。
3. 备份控制机 SSH config，写入 `sshConfigBlock` 的 Dawn Forge 标记块。
4. 用最终 alias 再次执行 public-key-only 验证。

host key 或目标身份变化时停止，不自动清除 `known_hosts`。

## 已有 alias

只有用户明确要求使用已有 alias 时才尝试复用。通过 `ssh -G <alias>` 核对 `HostName`、`User`、`IdentityFile` 和 `IdentitiesOnly yes`，再进行 public-key-only 验证；失败后回到默认建联流程。

## 目标机外部服务 key

仅在 profile `settings.ssh` 启用时，在目标机本地生成或复用：

```text
~/.ssh/github_ed25519
~/.ssh/id_ed25519
```

passphrase 由用户在目标机本地输入。GitHub key、通用 key 和控制机管理 key 不复制、不互换。
