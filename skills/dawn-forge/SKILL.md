---
name: dawn-forge
description: 通过局域网 SSH 引导用户从 Windows 控制机注册已可正常使用的 macOS 个人电脑。当前里程碑完成 Target 建联、检查和撤销。
---

# Dawn Forge

通过局域网 SSH 协作配置个人电脑。Agent 负责发现、规划、传输、安装和验证；用户负责目标机上的 GUI、管理员授权和秘密输入。

## 边界

- V1 仅支持 Windows 控制机和 macOS 目标机；目标机必须已完成系统安装和首次设置。
- 默认从没有 SSH、没有 alias 开始；用户明确提供可用 alias 时才复用。
- 目标机无需安装 Dawn Forge，也无需预装 Node.js、Python 或 Git。
- 只安装用户确认的 profile 内容。示例不是默认软件集；唯一匹配候选可用于只读预检。唯一候选明确包含 `required: true`、`official-download` 的 Clash 且尚未安装时，必须先展示并确认只包含 Clash artifact、传输、手动安装、授权和配置交接的网络引导 mini-plan；直连是否可用只决定联网门禁和实际 route，不再跳过 required Clash。`required: false` 不触发本阶段，也不得安装、运行或处理其他软件。
- 配置值和秘密不写入聊天、命令参数、profile、仓库、输出或状态文件；使用 `scripts/collect-private-input.mjs` 在控制机本地收集为受保护文件，再传到目标机。
- 控制机管理 key 默认使用 `~/.ssh/id_ed25519`：存在则验证复用，不存在则生成，绝不覆盖。写入目标机 `authorized_keys` 时使用控制机主机名作为 comment。目标机的 GitHub key 和通用 key 与它分开。
- 不要求新目标机复制或粘贴命令。可复制命令只在控制机执行；目标机只处理 GUI 和查看连接地址，目标机密码由用户在控制机终端输入。

## 按需读取

- 处理 profile 前完整读取 [references/profile.md](references/profile.md)。
- 建立 SSH 或创建 key 前完整读取 [references/ssh.md](references/ssh.md)。
- 传递配置前完整读取 [references/configuration-handoff.md](references/configuration-handoff.md)。
- required Clash 尚未安装或需要处理其联网门禁时完整读取 [references/network-bootstrap.md](references/network-bootstrap.md)。
- 确认平台后完整读取 [references/macos.md](references/macos.md) 或 [references/windows.md](references/windows.md)。
- 生成安装计划或开始任何修改前完整读取 [references/execution.md](references/execution.md) 和 [references/recovery.md](references/recovery.md)；失败、取消或恢复时不得等到事后才读取。

## 交互协议

- 只展示四个阶段：`目标与配置 → Clash 安装与联网（按需） → 环境确认 → 执行与交付`。
- 每轮只处理当前阶段，一次收集当前能够获得的全部必要信息；用户只回答一部分时，下一轮合并询问所有剩余项，不拆成单字段往返。
- 首轮要求用户按 `<platform> <user>@<host>` 一次回复目标平台和 GUI 显示的完整登录地址；设备称呼可选。给出对应系统开启 SSH、读取登录地址的 GUI 路径，不要求用户预先准备 alias、IP 或 profile 路径。
- 接受 `<platform> <user> <host>` 等紧凑输入并按登录账号、地址解析，不把中间字段误当设备称呼。macOS 裸 hostname 自动补 `.local`；解析失败后才索要 IPv4。
- 已知信息不再询问。Agent 自动采用无冲突的安全默认值，不单独确认控制机默认 key 或推荐 alias。
- 只读检查、诊断和非覆盖式 SSH 准备直接执行。目标与配置阶段只在用户输入目标机密码时暂停；key 异常、alias 冲突、已记录的 host key 或 machine ID 变化、平台或账号冲突时才停止询问。
- 装机请求仍然有效时，将同一阶段的安全只读检查合并执行；受管环境需要工具授权时只发起一次范围明确的授权，不按子步骤拆分。
- 用户的最新范围和停止指令优先于旧计划。用户说 `停止`、`取消`、`不要后台下载` 时先取消受管批次，不先诊断；用户转为评审、解释或修改 Dawn Forge Skill 时，完成必要的取消握手后只处理仓库，不得继续连接、验证、配置或收尾目标机，除非用户随后明确要求恢复装机。
- 用户问窄问题时先直接回答该问题；用户明确拒绝非必要诊断时跳过它。只有身份、安全边界或下一项安装的必要前置条件失败时才阻止执行。
- 任一时刻最多向用户暴露一个待办人工步骤，并给出稳定的 `stepId`。用户回复 `好了`、`完成了` 或 `继续` 时，默认表示刚才唯一待办步骤已完成：先按该 `stepId` 验证并继续，不重新生成计划、不重复下载或重启已经运行的批次；没有唯一待办步骤时才简短说明当前状态。
- 严格区分 downloaded、installed 和 verified。没有逐项验证证据时不得说“安装上了”，也不得因 package manager 仍在下载就说“一个都没安装”。
- 软件和设置在环境确认结束时一次确认完整计划，不逐项确认。required Clash 尚未安装时，网络引导 mini-plan 是唯一允许的提前确认；直连结果只决定 route 和联网门禁。秘密输入说明合并在这一次交互中，不得安装后再次索要。

## 工作流

### 阶段 1：目标与配置

1. 除非用户明确提供可用 alias，否则默认没有 SSH。首轮给出该系统开启 SSH、读取登录地址的 GUI 操作，并要求一次回复 `<platform> <user>@<host>`；设备称呼可选。
2. 优先解析用户的一行紧凑输入。macOS hostname 没有点号且不是 IP 时补 `.local`；只有信息确实缺失或地址无法解析时，才一次补问全部剩余信息。
3. 根据目标机称呼生成稳定的 `<target-name>`，直接运行 `dawn target bootstrap --host <host> --user <user> --name <target-name>`。V1 只接受 macOS 目标机。
4. CLI 会验证或非覆盖式创建控制机默认 `~/.ssh/id_ed25519`，并显示一条受控授权命令。用户只在控制机终端运行这一条命令并输入一次目标机密码，然后按 CLI 提示确认。
5. CLI 使用 public-key-only SSH 完成 host key、machine ID、architecture 和远程账号探测，写入独立安全 SSH config 与 `~/.dawn-forge/targets/<targetId>/target.json`。退出码 30 表示身份冲突，必须停止；不得手工重建 SSH 命令或绕过身份检查。
6. Target 注册成功后停止。profile 校验、目标环境探测、网络引导和完整计划确认等待后续 Engine 能力，不得提前执行。

### 阶段 2：等待 Engine 后续能力

当前里程碑只开放 `dawn target bootstrap`、`dawn target inspect` 和 `dawn target revoke`。`dawn plan`、`dawn apply`、artifact 传输与安装执行尚未完成切换；Target 注册成功后停止，不得把 `target.json` 伪装成旧 `identity.json`，也不得回退到已删除脚本或手写 SSH/安装命令。

## 底线

- 下载只使用官方 HTTPS 来源；expected digest 匹配只证明 bytes 一致，只有另外验证官方签名、notarization 或受信 publisher manifest 后才声称 publisher 完整性；否则只报告本地 SHA-256。
- 不自动卸载、降级、删除用户数据、替换 key、清除 host key 或关闭安全机制。
- 不执行 profile 中的字符串命令，也不把字段直接拼接为 shell。
- 不要求用户把秘密发送到聊天，不把秘密放进 argv、日志或 tool output。
- 身份或系统性边界变化时停止；单项命令失败按受控状态保留证据和部分成功，不通过忽略错误或扩大权限继续。
