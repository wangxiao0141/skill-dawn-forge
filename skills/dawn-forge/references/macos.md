# macOS 装机工作流

## 目标机 preflight

SSH 建联后需要 Clash 联网时，先执行下方“Clash Verge Rev 网络引导”的最小检查和传输；联网完成后再用一个受控 probe 一次执行本节完整只读检查：

- `uname -s` 必须为 `Darwin`；
- `uname -m` 必须为受支持的 `arm64` 或 `x86_64`；
- `sw_vers` 与 Apple 当前支持范围；
- 当前账号与 `ssh -G <target>` 解析的 `User`；
- `scutil --get LocalHostName`、`scutil --get ComputerName` 和可选的 `scutil --get HostName`；
- machine ID；
- 可用磁盘空间；
- 仅在计划使用 Homebrew/formula 时检查 `xcode-select -p`、`xcrun --find clang` 和 `pkgutil --pkg-info=com.apple.pkg.CLTools_Executables`；
- `/opt/homebrew/bin/brew`；
- `/Applications` 和 `~/Applications` 中的现有应用；
- `command -v` 可发现的 CLI；
- `scutil --proxy` 和当前网络连通性。

平台、架构或用户不匹配时停止。不要根据文件是否存在单独断言软件可用。

macOS 的名称各自含义不同：

- `<LocalHostName>.local` 是 Bonjour/mDNS 连接地址，应与用户从 `Remote Login` 面板读取的 `.local` 地址比较；
- `ComputerName` 是界面显示名称，可以与连接地址不同；
- `HostName` 可以未设置；
- shell 的 `hostname` 可能回退为 `anonymous`，只作信息记录。

当 `LocalHostName` 与 `.local` 地址匹配，且账号、`Darwin`、architecture 和 SSH host key 均符合时，直接记录 machine ID 并继续。不得因为 `hostname` 为 `anonymous`、`HostName` 未设置或 `ComputerName` 不同而暂停询问用户。

## Clash Verge Rev 网络引导

唯一匹配候选 profile 以 `required: true`、`official-download` 明确列出 `Clash Verge Rev` 且尚未安装时始终处理；最小官方端点直连探测只决定是否必须先启用代理和记录实际 route。`required: false` 不进入本阶段。`dawn target bootstrap` 成功并写入 Target 后，Agent 只检查目标 architecture、`/Applications/Clash Verge.app` 是否存在、最小直连端点和控制机官方 stable 下载源，然后处理 installer：

- 未安装时，先用 `scripts/plan-installation.mjs network-bootstrap` 发布 bundle，再把其 `artifact-request.json` 直接交给 `scripts/artifact-cache.mjs fetch --request`；按 `references/network-bootstrap.md` 的 canonical cache、单一前台 owner 和 `.partial` 原子发布规则取得与目标架构匹配的官方 stable artifact，再通过 `scripts/transfer-artifact.mjs` 传到 `~/Downloads/dawn-forge/artifacts/` 并核对两端 SHA-256/size；
- 已安装时，不重复下载安装包；
- 目标机没有外网时，完整执行 `references/network-bootstrap.md`。

下载期间同时准备配置交接；已存在的本地配置直接使用，缺少秘密时在同一条消息中让用户运行 `scripts/collect-private-input.mjs`，不得在安装完成后再额外索要订阅 URL。也不先扫描完整应用列表、CLI、PATH、Homebrew 或所有安装端点。

人工安装开始前按顺序校验：

1. 核对 publisher digest（如有）和两端 SHA-256；
2. 对 `.dmg`/`.pkg` 做 Gatekeeper assessment，校验 notarization、签名、signer/team identifier；`.dmg` 内含 app 时先只读挂载并校验其主 executable；
3. 校验通过后让用户在一个合并人工步骤中安装、首次打开、授权和导入已经传好的配置；
4. 启动后再把已安装 app 的严格 code signature 校验作为验收，不在下载与人工安装之间增加第二次等待。

由用户在 GUI 中：

- 安装；校验通过后首次打开；
- 处理 Gatekeeper、网络扩展、helper 或系统代理授权；
- 从 `~/Downloads/dawn-forge/` 读取 Agent 传入的配置并手动导入；
- 选择节点并启用系统代理或 TUN。

Clash 订阅 URL 作为 `clash-subscription-url.txt` 传入；其他配置文件使用受控文件名传入。Agent 不复制 app、不替用户安装 Clash 或操作 GUI。首次启动后的 app support 文件变化不能单独当作 publisher 签名失败；只有主 executable、designated requirement、signer/team identifier 或 Gatekeeper 证据不符时阻止继续。

完成后读取 `scutil --proxy`、进程和应用 bundle 信息，验证代理真实运行。根据系统代理实际 host/port 为当前下载进程设置临时环境；不要把 proxy URL 写入 profile 或运行状态。至少验证当前安装计划所需的官方端点。

## Homebrew

只使用 Homebrew 官方 [Installation](https://docs.brew.sh/Installation)、[Manpage](https://docs.brew.sh/Manpage) 和官方仓库。每次执行时核实当前 macOS requirements，不在 Skill 中固定版本或假定内部下载顺序。

- Apple Silicon 默认 prefix 必须为 `/opt/homebrew`。
- Command Line Tools 不是所有 GUI 软件的全局门禁。只有本次 Homebrew/formula 路径需要时才检查；使用 `xcode-select -p`、`xcrun --find clang` 和 CLT package receipt，不用 `xcodebuild` 的 CLT-only 报错判断失败。
- CLT 缺失时只有一个 owner：在一个合并人工步骤中引导用户运行 `xcode-select --install` 并完成 GUI。不得同时启动第二个 `softwareupdate`、后台 downloader 或固定等待轮询。
- Homebrew 已存在时先运行只读检查，不默认执行全局 `brew upgrade`。
- “账号属于 Administrators”不等于当前 SSH session 已取得 `sudo`。首次安装确实需要 `sudo` 时，只创建一个 controller-side interactive TTY 人工步骤，让用户在控制机输入一次目标机密码；不得循环运行 `sudo -n` 或扩大权限。
- Homebrew 准备完成后在同一步核对实际 prefix，并向 shell profile 写入受标记的 `brew shellenv` 块；修改前备份，随后在非交互 SSH 中显式加载该环境。

## 来源解析

按以下顺序解析每个软件：

1. profile 显式提供的受支持 `source` 和 `package`。
2. `auto` 时优先查找官方 Homebrew formula 或 cask。
3. Homebrew 不适用时，查找软件发布者的官方 HTTPS 渠道，并验证 macOS code signature。
4. Mac App Store 软件转为人工登录/安装，除非 `mas` 已可用且用户已批准。
5. 无法确认 publisher、架构、签名或下载来源时标记 `manual` 或 `conflict`，不尝试第三方镜像。

安装计划至少包含：

| 软件 | 当前状态 | 计划动作 | 解析来源 | 版本策略 |
| --- | --- | --- | --- | --- |

用户一次确认整个软件集合后：

- 完整遵循 `references/execution.md`，只运行 `scripts/plan-installation.mjs` 的 canonical `plan`/`probe` 入口；内部排程器按依赖、实际官方 endpoint route 和 installer 拆分，每批最多 `3` 项；
- 不得把全部 formula 或 cask 合并为一个 Homebrew 命令；批次内逐项 `fetch → install → verify`，前一项验证后立即可见；
- Homebrew 当前版本的多项 install 可能先把请求项加入下载队列再进入安装，但这不是稳定 CLI 契约。不得回答“Homebrew 只能全部下载完才安装”；Dawn Forge 通过逐项命令主动避免长时间只下载而看不到软件；
- 显式 `brew update-if-needed` 每个 run 最多一次。后续 formula/cask 命令只对当前进程设置 `HOMEBREW_NO_AUTO_UPDATE=1` 和 `HOMEBREW_NO_INSTALL_CLEANUP=1`，避免每个小批重复 update/cleanup；不得持久化这些环境变量或默认执行 `brew cleanup`；
- 默认保留 Homebrew 受支持的下载并发。用户明确要求限制当前下载带宽时，只对当前前台 owner 设置 `HOMEBREW_DOWNLOAD_CONCURRENCY=1`；不得另起后台 owner；
- 计划阶段读取受控 cask metadata；普通 `.app` cask 保持自动化，只有 `pkg`、真正 interactive installer、明确要求系统权限或重启的 caveat 才形成 manual barrier，并单独分组；
- 只在 installer 退出后用本地 receipt、Cellar/Caskroom、app bundle 或 CLI 证据验证；活动期间的 `status` 不运行 `brew list`、`brew info` 或 `brew doctor`；
- 不执行清单外安装，必要依赖除外；新增依赖必须显示在计划中；
- 不自动卸载、降级或覆盖用户数据。

## 设置与人工任务

- 仅在 profile 提供 `settings.git` 时设置 Git identity。
- 只修改 Dawn Forge 标记块；已有不同设置视为 `conflict`。
- Apple ID、App Store、许可证、浏览器账号、系统扩展和 GUI 首选项均为人工任务。
- 不迁移浏览器资料、聊天记录、数据库、容器数据、项目 secret 或软件许可证。
