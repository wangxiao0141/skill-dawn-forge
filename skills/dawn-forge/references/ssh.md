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

## 2. 一次生成建联计划

先确认真实系统 `ssh`、`scp` 和 `ssh-keygen`，不要使用 deny shim 或未知 wrapper。
受管沙箱阻止调用时，取得必要工具授权，并通过 `--ssh-keygen <verified-path>` 传入已验证的系统可执行文件。

根据用户对目标机的称呼自动生成简短 alias。`plan` 必须在用户输入密码前通过 `ssh -G -F <config>` 检查受控候选配置、alias 解析、direct destination 重定向和自定义 `--config`；只有无冲突才继续，不单独询问。脚本不自行解释 `Include` 或 `Match`；现有配置含这两类无法证明安全的指令时停止并要求人工评审。目标地址只接受以 `.local`、`.home.arpa` 结尾的局域网 hostname、RFC1918/link-local IPv4、ULA IPv6 或带 zone 的 link-local IPv6，拒绝 `.lan`、公网地址、无 zone 的 link-local IPv6 和无法证明只解析到私网的单标签 hostname。macOS 面板只给出单标签时先补 `.local`。然后运行：

```text
node <skill-directory>/scripts/prepare-ssh-bootstrap.mjs plan --platform <macos|windows> --host <hostname-or-ip> --user <user> --alias <alias>
```

`plan` 自动读取控制机主机名，验证并复用控制机 `~/.ssh/id_ed25519`；两端都不存在时直接创建脚本可证明无 passphrase 的 ED25519 管理 key，并以控制机主机名作为 public key comment，不需要单独确认，也绝不覆盖已有文件。已有 key 只能报告 `none` 或 `unknown-or-required`，不得无证声称无 passphrase。key pair 单边缺失、不匹配、类型错误或无法证明无 passphrase 时，在修改目标机前停止；当前流程显式禁用 `ssh-agent`，不得先写入远端 key 再让 `finalize` 后置失败。需要加密管理 key 时必须先扩展并验证 agent 模式，本流程不自动降级。

Windows 目标账号属于 Administrators 时增加 `--windows-admin`，让脚本选择 Windows OpenSSH 的 administrator key 路径并设置受控 ACL。不要提升控制机 PowerShell；控制机 elevation 不会提升远端 SSH token。远端访问被 Windows policy 阻止时停止并给出一个目标机本地管理员人工步骤。

脚本输出：

- `keyCreated`：本次是否创建了控制机管理 key；
- `controllerName`：将写入目标机 `authorized_keys` comment 的控制机主机名；
- `installKeyCommand`：只在控制机运行，提示输入目标机密码并远程幂等写入公钥；
- `finalizeCommand`：Agent 在一个进程中完成仅公钥验证、一次强身份探测、SSH config 候选验证、alias CAS 发布和 effective config 复验；
- `targetIdentitySha256`：由账号、平台、architecture、machine ID 和 host-key fingerprints 生成的稳定无秘密 digest，后续 run-state 必须复用；
- `machineExecutionIdentitySha256`：只由平台、machine ID 和 canonical host-key fingerprint set 生成，不含 alias、账号或显示名；机器级 package-manager lease 必须使用此 digest，不能使用登录身份 digest；
- identity receipt：原子保存 `identityFile`、`identityFileSha256`、`sshConfigPath`、最终文件的 `sshConfigSha256`、受控单一 `knownHostsPath`、`knownHostsSha256`、管理 `keyFingerprint`、`hostKeyFingerprints`、登录身份 `targetIdentitySha256`、机器执行身份 `machineExecutionIdentitySha256`，以及 finalize 已创建并验证的 owner-only `~/.dawn-forge/handoff/` policy；后续传输或执行在连接前必须重算并完全匹配，字段缺失时 fail closed。

不要自行拼接公钥或远端命令。

生成计划后，在同一轮直接显示 `installKeyCommand`，不要先报告 key 结果，也不要询问 alias 是否确认。

## 3. 从控制机安装公钥

1. 用户在控制机自己的 Terminal 或 PowerShell 运行 `installKeyCommand`。
2. 脚本首次连接使用 `StrictHostKeyChecking=accept-new` 记录该局域网目标的 host key。
3. 用户只输入一次目标机账号密码。
4. 脚本按 key material 幂等更新 `authorized_keys`，将同一公钥的旧 comment 替换为控制机主机名后退出；用户不进入目标机 shell。

密码只由用户在自己的终端输入，不进入聊天、命令参数或日志。

不得使用 `dawn-forge-management`、目标机名称、目标机 hostname、profile 名或 Agent 临时名称作为该 comment。已有本地 public key 的 comment 不影响 fingerprint；写入目标机时统一使用本次探测到的控制机主机名。

## 4. 验证并保存 alias

1. Agent 直接运行 plan 输出的 `finalizeCommand`，不得手工重建其中的 SSH 命令。
2. `finalizeCommand` 必须使用固定参数数组调用 `ssh`。候选 alias 只用无覆盖参数的 `ssh -G -F <candidate> <alias>` 检查真实 effective config；有远端副作用的 direct install/probe 改用 `-F none`，固定 `HostName`、`User`、`Port=22`、`HostKeyAlias`、唯一 `IdentityFile` 和受控单一 `known_hosts`。所有远端调用都固定 `ClearAllForwardings=yes`、`ForwardAgent=no`、`ForwardX11=no`、`PermitLocalCommand=no`、`ControlMaster=no`、`ControlPath=none`、`CanonicalizeHostname=no`、`ConnectTimeout=8` 和 `ConnectionAttempts=1`；public-key probe 还必须禁用 password、keyboard-interactive、hostbased、GSSAPI 和 `ssh-agent`。不得依赖当前 shell 拼接、复用已有 master、回退到其他 key 或使用 `StrictHostKeyChecking=no`。`install-key` 只显式开放一次 password/keyboard-interactive 认证，仍保留全部无副作用约束。
3. 命令先从受控 `known_hosts` 计算 host-key fingerprint，再在整体 timeout 内只探测一次远端用户、OS、architecture、系统版本、machine ID 和平台原生网络名称；没有可证 fingerprint 时拒绝 finalize。普通 hostname 和设备显示名称只作信息记录。
4. 身份符合后，命令在 O_EXCL operation lock 内生成并通过 `ssh -G -F` 验证完整候选配置，以原配置 hash 做 CAS，通过同目录 no-clobber link/rename protocol 发布置顶的 Dawn Forge 标记块；最终 alias 只复验 effective config 和同一 host-key fingerprint，不重复远端 identity probe。任何复验失败都回滚本次新 alias；并发修改导致无法安全发布或回滚时保留并发内容、停止并明确报告。拒绝 symlink/non-regular trust file。`IdentityFile` 和 `UserKnownHostsFile` 必须使用支持空格的 SSH config 引号。
5. 已有 identity receipt 时，覆盖前必须比较历史 `targetIdentitySha256`、`machineExecutionIdentitySha256`、machine ID 和 host-key set，并对 receipt 原字节 hash 做 CAS；已知 host-key 冲突必须在会创建 handoff 目录的远端 identity probe 前停止。任何历史身份冲突都不得修改 config 或 receipt。
6. Agent 只根据该命令的结构化输出决定继续或停止。命令成功后不要再用额外 SSH 调用重复身份检查，也不要在本节混入磁盘、应用清单、CLI、PATH、proxy 或安装端点检查。

用户报告 `installKeyCommand` 完成后直接执行本节，不再请求确认。受管环境只为整个 `finalizeCommand` 请求一次范围明确的工具授权，不按内部步骤拆分。用户转为评审或修改 Skill 时停止本节及后续目标机操作。

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
