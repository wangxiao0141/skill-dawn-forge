---
name: dawn-forge
description: 通过局域网 SSH 引导用户从 macOS 或 Windows 控制机配置已可正常使用的 macOS 或 Windows 个人电脑。默认从目标机尚未开启 SSH、控制机没有 alias 的状态开始，按声明式 JSON profile 完成建联、批量安装、可选代理客户端、目标机 SSH key、验证和恢复。
---

# Dawn Forge

通过局域网 SSH 协作配置个人电脑。Agent 负责发现、规划、传输、安装和验证；用户负责目标机上的 GUI、管理员授权和秘密输入。

## 边界

- 控制机和目标机支持 macOS 或 Windows；目标机必须已完成系统安装和首次设置。
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
3. 根据目标机称呼自动选用无冲突的简短 alias，直接运行 `scripts/prepare-ssh-bootstrap.mjs plan`。该命令会验证或非覆盖式创建控制机默认 `~/.ssh/id_ed25519`，并生成 `installKeyCommand`。
4. 在同一轮把 `installKeyCommand` 交给用户。用户只在控制机终端运行这一条命令并输入一次目标机密码；脚本直接写入远端 `authorized_keys`。
5. 用户报告完成后，Agent 直接运行 plan 输出的 `finalizeCommand`。该命令在一次进程中完成 public-key-only 验证、强身份探测、SSH config 备份、alias 写入和 alias 复验。不得改用临时拼接的 SSH 远端命令，不得先跑磁盘、软件、PATH 或安装端点预检；`finalizeCommand` 失败时只诊断其原始错误。
6. 查找工作区 `profiles/*.json`，逐个运行：

   ```text
   node <skill-directory>/scripts/validate-profile.mjs <profile.json>
   ```

7. 多个匹配 profile 时展示软件、`settings` 和 `manualTasks` 并让用户选择。只有一个匹配 profile 时，将它标为“待确认候选”，不单独暂停确认。没有有效 profile 时再修复或从空模板创建。
8. 唯一候选以 `required: true`、`official-download` 明确包含 Clash 时，只做目标 OS、architecture、Clash 是否已安装、最小直连探测和控制机下载条件这组最小检查。未安装就进入阶段 2；已安装或 `required: false` 才跳过。不要在传输 Clash 前扫描完整应用清单、CLI、PATH、package manager 或所有安装端点。
9. 在阶段 3 的完整计划确认中同时确认 profile，并记录其 `id`、platform 和 SHA-256。

### 阶段 2：Clash 安装与联网

1. 候选 profile 不包含 required Clash，或受控最小检查已证明 Clash 安装完成时跳过本阶段。
2. 唯一匹配候选中 Clash Verge 为 `required: true` 且未安装时，用唯一受控入口生成网络引导 bundle：

   ```text
   node <skill-directory>/scripts/plan-installation.mjs network-bootstrap --profile <profile.json> --identity-receipt <identity.json> --controller-route <direct|clash> --target-route direct --output-dir <new-network-bundle-directory>
   ```

   `mini-plan.json` 必须列出 artifact 的 publisher/version/architecture、控制机联网位置与实际 route、传输目标、签名校验、手动安装/授权和配置交接；用户明确确认前不下载、不传输、不修改目标机。
3. 在确认 mini-plan 的同一条消息中复用已有本地配置；缺少秘密输入时只让用户在控制机终端运行 `scripts/collect-private-input.mjs`，不得要求把订阅 URL 发到聊天，也不得安装完成后再索要。
4. 确认后只运行 `node <skill-directory>/scripts/artifact-cache.mjs fetch --request <network-bundle-directory>/artifact-request.json` 复用控制机 canonical artifact cache；不得手工重填 URL、host、version 或 architecture。未命中时由唯一 download owner 写 `.partial`，校验成功后原子发布，再通过已验证 alias 和 `scripts/transfer-artifact.mjs` 传到目标机 Downloads。不得创建第二套缓存、手写 `scp` 或 detached 下载。
5. 用户在一个合并人工步骤中手动安装、完成 GUI/网络扩展/系统权限授权、导入配置并启用系统代理或 TUN。
6. Agent 只验证代理状态和阶段 3 所需安装端点。失败时先诊断，不执行后续 preflight 或安装。

### 阶段 3：环境确认

1. 只运行 `scripts/plan-installation.mjs` 的受控 preflight：单次 SSH 收集磁盘、权限、包管理器、现有软件和 PATH，批量解析 metadata，再通过受控 route probe 生成证据；不得临时拼接多轮 SSH 或逐项 `brew info`。
2. 把 profile 项目分为 `install`、`skip`、`update`、`conflict` 或 `manual`；默认使用最新稳定版，不做无关升级或降级。
3. 把 metadata 与 artifact 官方端点分别探测，按本次事实解析 `direct`、`clash` 或 `local`；不得按“国内/国外软件”猜测。
4. 只由以下 canonical CLI 生成 bundle，不运行内部模块或手写中间 JSON：

   ```text
   node <skill-directory>/scripts/plan-installation.mjs plan --profile <profile.json> --identity-receipt <identity.json> --controller-route <direct|clash> --target-route <direct|clash> --output-dir <new-plan-bundle-directory>
   ```

   若状态为 `route-probe-required`，切换对应位置的 route 后只续跑未解析 probe：

   ```text
   node <skill-directory>/scripts/plan-installation.mjs probe --plan-bundle <existing-plan-bundle-directory> --controller-route <direct|clash> --target-route <direct|clash> --output-dir <new-plan-bundle-directory>
   ```

   展示完整安装计划、每批最多 `3` 项的 schedule、明确标注控制机或目标机的联网切换点和人工任务；不得由 Agent 手写 `routeEvidence`、权限、依赖或 artifact 字段。full plan 不接受未绑定 canonical artifact request 的 `official-download` action；遗漏阶段 2 时必须 fail closed。
5. 用户一次确认 profile、增删项、profile SHA-256 与 schedule SHA-256；profile、schedule、目标身份或关键环境变化后重新确认。

### 阶段 4：执行与交付

1. 完整遵循 `references/execution.md`。只使用受控安装入口和原子 run-state；不得临时拼接远端安装命令。
2. 只通过 `scripts/installation-run.mjs advance` 每次推进一个最多 `3` 项、相同 route 与 installer 的批次，批次内逐项执行 `fetch → install → verify`。必须保持启动该 `advance` 的同一个前台 tool session 直到批次终态；需要中断时只向该 session 发送 `Ctrl-C`。不得 `nohup`、detach、另启 download owner，或直接执行低层 batch 模块。
3. 只从本地 run-state 观察活动状态，不用固定 sleep、重复 SSH、`pgrep` 或 package manager 查询轮询。route 变化只在没有活动 installer 的批次边界合并询问用户一次。
4. 显式取消只向启动 `advance` 的同一个前台 tool session 发送 `Ctrl-C`；owned runner 会先持久化 run-state cancel intent，再中断精确 owned process。不得单独启动另一个 `cancel` 进程：它无法取得 owned handle，也不得先改 state 或声称已经终止。没有 owned runner acknowledgement 时必须报告 `cancel-pending`，不猜测、不继续下一项。
5. 应用 profile 明确声明的设置；在目标机生成或复用 GitHub key 和通用 key。需要 passphrase 时合并为一个 controller-side interactive SSH TTY 人工步骤，不在 argv、聊天或日志中收集。
6. 修改现有文件前备份。单项失败只阻止其依赖项并保留部分成功；身份、完整性、权限模型或 package manager 系统性失败才阻止整个 run。
7. 验证 SSH、软件、PATH、设置和人工任务，汇总 `completed`、`manual`、`skipped`、`failed` 和 `not-verified`，并明确哪些仅完成下载。

## 底线

- 下载只使用官方 HTTPS 来源；expected digest 匹配只证明 bytes 一致，只有另外验证官方签名、notarization 或受信 publisher manifest 后才声称 publisher 完整性；否则只报告本地 SHA-256。
- 不自动卸载、降级、删除用户数据、替换 key、清除 host key 或关闭安全机制。
- 不执行 profile 中的字符串命令，也不把字段直接拼接为 shell。
- 不要求用户把秘密发送到聊天，不把秘密放进 argv、日志或 tool output。
- 身份或系统性边界变化时停止；单项命令失败按受控状态保留证据和部分成功，不通过忽略错误或扩大权限继续。
