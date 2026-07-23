# macOS 装机工作流

## 目标机 preflight

SSH 建联后只读检查：

- `uname -s` 必须为 `Darwin`；
- `uname -m` 必须为受支持的 `arm64` 或 `x86_64`；
- `sw_vers` 与 Apple 当前支持范围；
- 当前账号与 `ssh -G <target>` 解析的 `User`；
- `scutil --get LocalHostName`、`scutil --get ComputerName` 和可选的 `scutil --get HostName`；
- machine ID；
- 可用磁盘空间；
- `xcode-select -p`；
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

仅当 profile 以 `official-download` 明确列出 `Clash Verge Rev` 时处理。Agent 先检查 `/Applications/Clash Verge.app`、签名和进程：

- 未安装时，在控制机从官方 stable GitHub Release 下载与目标架构匹配的安装包，校验 digest 后通过 `scp` 传到 `~/Downloads/`，并核对两端 SHA-256；
- 已安装时，不重复下载安装包；
- 目标机没有外网时，完整执行 `references/network-bootstrap.md`。

由用户在 GUI 中：

- 安装并首次打开；
- 处理 Gatekeeper、网络扩展、helper 或系统代理授权；
- 从 `~/Downloads/dawn-forge/` 读取 Agent 传入的配置并手动导入；
- 选择节点并启用系统代理或 TUN。

Clash 订阅 URL 作为 `clash-subscription-url.txt` 传入；其他配置文件使用原文件名传入。Agent 不挂载 DMG、不复制 app、不替用户安装 Clash 或操作 GUI。用户安装完成后，Agent 再验证已安装 app 的签名。

完成后读取 `scutil --proxy`、进程和应用 bundle 信息，验证代理真实运行。根据系统代理实际 host/port 为当前下载进程设置临时环境；不要把 proxy URL 写入 profile 或运行状态。至少验证当前安装计划所需的官方端点。

## Homebrew

只使用 Homebrew 官方 [Installation](https://docs.brew.sh/Installation) 说明和官方仓库。每次执行时核实当前 macOS requirements，不在 Skill 中固定版本。

- Apple Silicon 默认 prefix 必须为 `/opt/homebrew`。
- Command Line Tools 缺失时，引导用户运行 `xcode-select --install` 并完成 GUI。
- Homebrew 已存在时先运行只读检查，不默认执行全局 `brew upgrade`。
- 首次安装需要管理员权限时，将其合并到一个人工阶段。
- 只在确认后向 shell profile 写入受标记的 `brew shellenv` 块；修改前备份。

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

- 把 formula 合并为一次 `brew install`；
- 把 cask 合并为一次 `brew install --cask`；
- 保持依赖顺序；
- 不执行清单外安装，必要依赖除外；新增依赖必须显示在计划中；
- 不自动卸载、降级或覆盖用户数据。

## 设置与人工任务

- 仅在 profile 提供 `settings.git` 时设置 Git identity。
- 只修改 Dawn Forge 标记块；已有不同设置视为 `conflict`。
- Apple ID、App Store、许可证、浏览器账号、系统扩展和 GUI 首选项均为人工任务。
- 不迁移浏览器资料、聊天记录、数据库、容器数据、项目 secret 或软件许可证。
