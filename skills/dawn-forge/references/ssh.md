# SSH 建联

除非用户明确提供已验证可用的 alias，否则默认控制机与目标机之间没有 SSH。目标机不复制或粘贴命令；所有可复制命令只在控制机执行。

## 身份边界

始终区分：

1. 目标机 SSH host key；
2. 控制机的 `~/.ssh/id_ed25519`，用于管理目标机；
3. 目标机后续生成的 GitHub key 和通用 key。

private key 不得在电脑之间复制。控制机默认 key 已存在时验证复用，不存在时才生成，不覆盖单边缺失或不匹配的 key pair。

## 1. 在目标机通过 GUI 开启 SSH

首轮同时询问目标机系统和用户对它的称呼，并直接给出对应系统的 GUI 操作。用户只回答一部分时，下一轮合并询问所有剩余信息，不把称呼、账号和 hostname 拆成多轮。

例如用户只回答 `mac` 时，下一条消息应同时要求：

1. 目标机称呼；
2. 打开 `System Settings > General > Sharing > Remote Login`；
3. 回复面板中的 `<user>@<hostname>.local`。

不要先只问称呼，再用下一轮索要登录地址。

macOS：

1. 打开 `System Settings > General > Sharing > Remote Login`。
2. 只允许本次登录账号。
3. 让用户读取面板显示的 `ssh <user>@<hostname>.local`，只需把其中短地址告诉 Agent。
4. 控制机无法解析 `.local` hostname 时，让用户从 `System Settings > Network > 当前连接 > Details > TCP/IP` 读取 IPv4。

不要让用户打开目标 Mac 的 Terminal，也不要发送 macOS 命令供其粘贴。

Windows：

1. 安装并启动 OpenSSH Server，确认 `sshd` service 和局域网 firewall rule。
2. 从 `Settings > System > About` 读取 Device name，从当前用户信息读取账号。
3. hostname 无法解析时，从 `Settings > Network & internet > 当前连接 > Properties` 读取 IPv4。

目标机只处理 GUI；如果系统界面无法确定 Windows 本地账号，最多让用户手工输入一次短命令 `whoami`，不得要求输入或粘贴命令块。

## 2. 一次生成建联计划

先确认真实系统 `ssh`、`scp` 和 `ssh-keygen`，不要使用 deny shim 或未知 wrapper。
受管沙箱阻止调用时，取得必要工具授权，并通过 `--ssh-keygen <verified-path>` 传入已验证的系统可执行文件。

根据用户对目标机的称呼自动生成简短 alias。先检查 alias 是否与现有 SSH 配置冲突；没有冲突就直接采用，不单独询问。然后运行：

```text
node <skill-directory>/scripts/prepare-ssh-bootstrap.mjs plan --platform <macos|windows> --host <hostname-or-ip> --user <user> --alias <alias>
```

`plan` 自动验证并复用控制机 `~/.ssh/id_ed25519`；两端都不存在时直接创建无 passphrase 的 ED25519 管理 key，不需要单独确认，也绝不覆盖已有文件。key pair 单边缺失、不匹配或类型错误时停止并诊断。用户要求加密 key 时，改由用户在本地生成并配置 `ssh-agent`。

Windows 目标账号属于 Administrators 时增加 `--windows-admin`，并让用户在 elevated PowerShell 执行生成的授权命令。

脚本输出：

- `keyCreated`：本次是否创建了控制机管理 key；
- `installKeyCommand`：只在控制机运行，提示输入目标机密码并远程幂等写入公钥；
- `verifyCommand`：Agent 验证仅公钥登录；
- `sshConfigBlock`：验证成功后写入控制机 SSH config。

不要自行拼接公钥或远端命令。

生成计划后，在同一轮直接显示 `installKeyCommand`，不要先报告 key 结果，也不要询问 alias 是否确认。

## 3. 从控制机安装公钥

1. 用户在控制机自己的 Terminal 或 PowerShell 运行 `installKeyCommand`。
2. 脚本首次连接使用 `StrictHostKeyChecking=accept-new` 记录该局域网目标的 host key。
3. 用户只输入一次目标机账号密码。
4. 脚本直接写入 `authorized_keys` 并退出；用户不进入目标机 shell。

密码只由用户在自己的终端输入，不进入聊天、命令参数或日志。

## 4. 验证并保存 alias

1. Agent 运行 `verifyCommand`，不得回退到 password、默认其他 key 或 `StrictHostKeyChecking=no`。
2. 探测远端用户、OS、architecture、系统版本、machine ID 和平台原生网络名称；普通 hostname 和设备显示名称只作信息记录。
3. 备份控制机 SSH config，写入 `sshConfigBlock` 的 Dawn Forge 标记块。
4. 用最终 alias 再次执行 public-key-only 验证。

用户报告 `installKeyCommand` 完成后直接执行本节，不再请求确认。

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

passphrase 由用户在目标机本地输入。GitHub key、通用 key 和控制机管理 key 不复制、不互换。
