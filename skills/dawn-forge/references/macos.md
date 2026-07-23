# macOS 装机工作流

## 目标机 preflight

SSH 建联后只读检查：

- `uname -s` 必须为 `Darwin`；
- `uname -m` 必须为受支持的 `arm64` 或 `x86_64`；
- `sw_vers` 与 Apple 当前支持范围；
- 当前账号与 `ssh -G <target>` 解析的 `User`；
- 可用磁盘空间；
- `xcode-select -p`；
- `/opt/homebrew/bin/brew`；
- `/Applications` 和 `~/Applications` 中的现有应用；
- `command -v` 可发现的 CLI；
- `scutil --proxy` 和当前网络连通性。

平台、架构或用户不匹配时停止。不要根据文件是否存在单独断言软件可用。

## Clash Verge Rev 网络引导

仅当 profile 明确列出 `Clash Verge Rev` 时处理。只使用官方仓库：

```text
https://github.com/clash-verge-rev/clash-verge-rev
```

用户说明目标机离线，或目标机无法访问本次计划所需官方端点时，完整执行 `references/network-bootstrap.md`。必须由控制机下载官方安装包并通过局域网 `scp` 传到目标机；在代理/TUN 联网验证通过前，不运行 `xcode-select --install`、Homebrew 安装或其他联网步骤。

每次执行都核实当前官方 stable Release，不固定历史版本：

1. 排除 Alpha、AutoBuild、fork 和第三方下载站。
2. 根据目标架构从 release assets 选择唯一的 macOS `aarch64`/`arm64` 或 `x86_64` 安装包。
3. 要求无凭据 HTTPS URL，并确认最终下载仍来自 GitHub 官方资产域名。
4. publisher 提供 SHA-256 digest 时必须核对；没有 digest 时明确说明只计算本地 SHA-256 作为传输校验。
5. 上传前后分别计算 SHA-256，必须一致。
6. 在目标机挂载或安装前后使用 `codesign --verify --deep --strict` 和 `spctl --assess` 检查 app；失败即停止。

把安装包传到 `~/Downloads/`。已有同名文件时先比较 SHA-256，不覆盖不同内容。由用户在 GUI 中：

- 安装并首次打开；
- 处理 Gatekeeper、网络扩展、helper 或系统代理授权；
- 本地输入订阅；
- 选择节点并启用系统代理或 TUN。

Agent 不读取订阅，不截取 GUI 配置文件，不创建订阅临时文件。

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
