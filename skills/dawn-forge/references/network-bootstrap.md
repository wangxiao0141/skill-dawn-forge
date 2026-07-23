# 离线目标机网络引导

## 触发条件

出现任一情况时，在安装 Command Line Tools、Homebrew、Winget package 或其他联网依赖前执行本阶段：

- 用户明确说明目标机没有可用外网；
- 目标机无法访问本次计划需要的 GitHub、Homebrew、npm 或发布者官方端点。

只有 profile 已明确列出代理客户端时才能继续。未列出时先修改并重新校验 profile，再重新确认安装计划。

## 前提

- 控制机能够访问代理客户端的官方发布渠道；
- 控制机与目标机之间的局域网 SSH、`scp` 和管理身份已验证；
- 代理客户端使用 `official-download`，不得依赖目标机尚不可用的 package manager；
- 订阅、账号、password 和 token 由用户在目标机本地输入，或在用户明确授权后按 `references/secret-handoff.md` 通过剪贴板临时交接。

控制机也无法访问官方发布渠道时停止。用户可另行提供从官方渠道取得的安装包，但仍必须验证 release、文件名、architecture、digest 和签名。

## 执行顺序

1. 在控制机解析官方 latest stable Release，拒绝 draft、prerelease、Alpha、AutoBuild、fork 和第三方镜像。
2. 根据目标 OS 与 architecture 选择唯一安装资产；零个或多个匹配都停止。
3. 下载到控制机的 Dawn Forge artifact cache。记录 release、asset、官方 URL 和公开 digest，不记录代理地址或订阅。
4. publisher 提供 SHA-256 时必须核对；同时计算控制机本地 SHA-256。
5. 使用已验证的 `scp` 经局域网传到目标机 Downloads 目录。已有同名文件时先比较 SHA-256；不同则停止，不覆盖。
6. 在目标机重新计算 SHA-256，必须与控制机一致。
7. 按目标平台验证 code signature 或 Authenticode，再由用户完成 GUI 安装、系统扩展或 UAC 授权。需要传递订阅时，按 `references/secret-handoff.md` 把控制机剪贴板经 SSH stdin 写入目标机剪贴板，由用户粘贴、导入并启用 TUN/系统代理。
8. 读取目标机实际 proxy/TUN、进程和应用身份，并从目标机验证本次计划所需官方端点。
9. 只有网络门禁通过后，才允许执行剩余联网安装步骤。

本阶段属于同一个一次性安装计划，不额外逐软件确认；只在 GUI、管理员授权和秘密输入时暂停。

Clash Verge Rev 使用 Skill 自带解析器：

```text
node <skill-directory>/scripts/resolve-clash-verge-release.mjs --platform <macos|windows> --arch <arm64|x64> --download-dir <controller-artifact-cache>
```

解析器固定官方仓库、要求唯一 stable asset、拒绝不受信任 URL，并在 GitHub 提供 SHA-256 时完成下载校验。不得用 profile 字符串替换仓库或下载 URL。

## 恢复

- artifact 已通过官方 digest 和控制机 SHA-256 验证时可以复用，不重复下载。
- 上传中断后重新比较两端 SHA-256；不得直接执行部分文件。
- GUI 安装状态不明时先检查应用、签名、进程和系统扩展，不自动重装。
- 网络验证失败时保留 artifact，检查用户是否已完成订阅、节点选择和 TUN/系统代理授权；不索要订阅内容。
