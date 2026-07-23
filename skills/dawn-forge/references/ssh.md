# SSH 建联

除非用户明确提供已验证可用的 alias，否则默认控制机与目标机之间没有 SSH。目标机不复制或粘贴命令；所有可复制命令只在控制机执行。

## 身份边界

始终区分：

1. 目标机 SSH host key；
2. 控制机的 `~/.ssh/id_ed25519`，用于管理目标机；
3. 目标机后续生成的 GitHub key 和通用 key。

private key 不得在电脑之间复制。控制机默认 key 已存在时验证复用，不存在时才生成，不覆盖单边缺失或不匹配的 key pair。

目标机 `authorized_keys` 中的管理公钥 comment 必须是控制机自身的主机名，用来说明允许哪台控制机连接。它不是目标机名称，也不是 key 身份验证依据。

## 1. 在目标机通过 GUI 开启 SSH

首轮直接给出对应系统的 GUI 操作，并要求用户按 `<platform> <user>@<host>` 一次回复目标平台和面板显示的完整登录地址；设备称呼可选。接受 `<platform> <user> <host>` 等紧凑输入并把后两项解析为登录账号和地址，不把账号误当设备称呼。用户只回答一部分时，下一轮合并询问所有剩余信息，不把称呼、账号和 hostname 拆成多轮。

例如用户只回答 `mac` 时，下一条消息应同时要求：

1. 打开 `System Settings > General > Sharing > Remote Login`；
2. 回复面板中的 `<user>@<hostname>.local`；
3. 可选提供目标机称呼。

不要先只问称呼，再用下一轮索要登录地址。

macOS：

1. 打开 `System Settings > General > Sharing > Remote Login`。
2. 只允许本次登录账号。
3. 让用户读取面板显示的 `ssh <user>@<hostname>.local`，只需把其中短地址告诉 Agent。
4. 用户提供的 hostname 没有点号且不是 IP 时自动补 `.local`；控制机仍无法解析时，再让用户从 `System Settings > Network > 当前连接 > Details > TCP/IP` 读取 IPv4。

不要让用户打开目标 Mac 的 Terminal，也不要发送 macOS 命令供其粘贴。

Windows：

1. 安装并启动 OpenSSH Server，确认 `sshd` service 和局域网 firewall rule。
2. 从 `Settings > System > About` 读取 Device name，从当前用户信息读取账号。
3. hostname 无法解析时，从 `Settings > Network & internet > 当前连接 > Properties` 读取 IPv4。

目标机只处理 GUI；如果系统界面无法确定 Windows 本地账号，最多让用户手工输入一次短命令 `whoami`，不得要求输入或粘贴命令块。

## 2. 注册 Target

先确认控制机使用真实系统 `ssh` 和 `ssh-keygen`，不要使用 deny shim 或未知 wrapper。V1 只支持 macOS 目标机。根据用户对目标机的称呼生成稳定的 `<target-name>`，然后运行：

```text
dawn target bootstrap --host <hostname-or-ip> --user <user> --name <target-name>
```

CLI 只在 `~/.ssh/id_ed25519` 公私钥都不存在时创建 ED25519 key；单边缺失、私钥需要 passphrase、公私钥不匹配或类型错误时，在修改目标机前停止。不要自行拼接公钥或远端命令。

CLI 会显示唯一一条授权命令。用户在控制机自己的 Terminal 或 PowerShell 运行该命令，并只在本地输入一次目标机密码；命令使用 `StrictHostKeyChecking=accept-new`，把带 `no-agent-forwarding`、`no-port-forwarding`、`no-X11-forwarding` 和 `no-pty` 限制的公钥写入目标机。密码不得进入聊天、命令参数或日志。

用户按提示确认后，CLI 使用 public-key-only SSH 探测 host key、machine ID、architecture 和远程账号，并原子写入：

```text
~/.dawn-forge/targets/<targetId>/target.json
~/.dawn-forge/targets/<targetId>/ssh_config
~/.dawn-forge/targets/<targetId>/known_hosts
```

`ssh_config` 固定禁用 forwarding、agent、X11、local command、multiplexing、proxy、password、keyboard-interactive、hostbased 和 GSSAPI，并启用 `IdentitiesOnly`、`StrictHostKeyChecking` 与受控 `known_hosts`。重复 bootstrap 必须先用已有记录检查身份，不得先向未知机器写入公钥。

## 3. 检查或撤销 Target

继续执行前需要重新确认目标身份时运行：

```text
dawn target inspect --target <targetId>
```

host key、machine ID、architecture 或远程账号任一变化时以退出码 30 停止。撤销长期访问时运行：

```text
dawn target revoke --target <targetId>
```

`revoke` 先执行相同的完整身份检查，再从远端 `authorized_keys` 删除控制机公钥，最后删除本地 Target 目录。任何身份冲突都不得修改远端或本地记录。

首次建联没有历史 machine ID 可比较；连接地址来自用户刚从目标机系统界面读取，且账号、OS 和 architecture 符合时，记录 host key 与 machine ID 后继续。macOS 的额外判定见 `references/macos.md`。

只有下列强冲突才停止并询问：

- 已记录的 SSH host key 变化；
- 已记录的 machine ID 变化；
- 远端账号、平台或 architecture 与本次目标不符；
- alias 解析到不同的 `HostName`、`User` 或 `IdentityFile`。

普通 `hostname`、设备显示名称或未设置的系统 HostName 与连接地址不同，不是设备错连证据，不得单独停下询问。发生强冲突时不自动清除 `known_hosts`。

## 已有 alias

只有用户明确要求使用已有 alias 时才尝试复用。通过 `ssh -G <alias>` 核对 `HostName`、`User`、`IdentityFile` 和 `IdentitiesOnly yes`，再进行 public-key-only 验证；失败后回到默认建联流程。

## 目标机外部服务 key

仅在 profile `settings.ssh` 启用时，在目标机本地生成或复用：

```text
~/.ssh/github_ed25519
~/.ssh/id_ed25519
```

Agent 从控制机开启一个受控 interactive SSH TTY，在目标机本地生成 key；用户只在控制机终端的 `ssh-keygen` 提示中选择 passphrase。两个 key 的提示合并在同一个人工步骤，秘密不进入聊天、argv、日志或 run-state。GitHub key、通用 key 和控制机管理 key 不复制、不互换。
