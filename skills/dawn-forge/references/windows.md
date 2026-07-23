# Windows 装机工作流

## 目标机 preflight

SSH 建联后需要 Clash 联网时，先执行下方“可选 Clash Verge Rev”的最小检查和传输；联网完成后再一次执行本节完整只读检查：

- OS 必须为 Windows；
- profile `platform` 必须为 `windows`；
- 当前账号与 `ssh -G <target>` 解析的 `User` 一致；
- 当前 SSH token 是否具有 Administrator 权限；
- architecture、Windows edition/build 与稳定 `MachineGuid`；
- 系统盘可用空间；
- PowerShell 版本；
- `winget` 可用性与 source 状态；
- 已安装 package、应用、CLI、PATH、系统 proxy 和待重启状态。

个人工作站默认接受受支持的 64 位 Windows。profile 请求的软件不支持当前 architecture 或系统版本时标记 `conflict`，不要尝试兼容性绕过。SSH 会话不能通过 UAC 临时提权时，将需要管理员权限的操作转为目标机本地人工步骤。

## 来源解析

按以下顺序解析每个软件：

1. profile 显式提供的 `source` 和 `package`；
2. `auto` 时优先查找发布者在 Winget Community 或 Microsoft Store 的受信任 package；
3. package manager 不适用时，使用发布者官方 HTTPS 下载；
4. 无法确认 publisher、architecture、签名或下载来源时标记 `manual` 或 `conflict`。

安装计划至少包含：

| 软件 | 当前状态 | 计划动作 | 解析来源 | 版本策略 |
| --- | --- | --- | --- | --- |

用户一次确认整个软件集合后：

- 完整遵循 `references/execution.md`，只运行 `scripts/plan-installation.mjs` 与 `scripts/installation-run.mjs` 的 canonical 入口；内部排程器按依赖、实际官方 endpoint route、权限和 installer 拆分，每批最多 `3` 项；
- 同一批 Winget package 仍逐项执行并在每项 installer 退出后验证；不得用一个巨型命令或 detached download 等待全部完成；
- 使用精确 package ID、静默参数和 source agreement 参数；
- 不执行 profile 外安装，必要依赖除外；新增依赖必须先显示；
- 不自动卸载、降级或覆盖用户数据；
- 安装后通过 package receipt、Authenticode、CLI 或应用版本重新验证。

`status`/`observe` 只读本地 run-state，活动期间不重复执行 `winget list`、source refresh、进程名扫描或固定 `Start-Sleep`。Administrator group membership 不代表 SSH token 已 elevated；需要 UAC 的多个动作合并成一个目标机人工步骤，不能从 SSH 中循环尝试提权。

## 官方 installer

Winget 不适用而使用 `.msi` 或 `.exe` 时：

- 最初 URL 和最终 URL 都必须是无凭据 HTTPS；
- publisher 提供 digest 时必须核对；
- 下载后计算 SHA-256；
- `Get-AuthenticodeSignature` 必须为 `Valid`，并核对预期 publisher；
- installer 参数必须来自受控规则，不能直接采用 profile 字符串；
- `1641`、`3010` 等重启相关结果不得静默当作已完成，转入重启与恢复流程。

## 可选 Clash Verge Rev

Windows 目标机流程不在 V1 范围内；不得通过 `dawn target bootstrap` 注册 Windows Target。以下旧流程仅作后续版本设计参考：唯一匹配候选 profile 以 `required: true`、`official-download` 明确列出 `Clash Verge Rev` 且尚未安装时始终处理；最小官方端点直连探测只决定是否必须先启用代理和记录实际 route。

下载期间按 `references/configuration-handoff.md` 同时准备订阅或其他配置文件；缺少秘密时让用户在控制机本地运行 `scripts/collect-private-input.mjs`，不得在聊天中索要。installer 通过 Authenticode/publisher 校验后，用户手动安装、启动、应用已传配置并完成 GUI 授权。完成后读取目标机实际系统 proxy/TUN 状态，并验证当前安装计划所需的官方端点。

## 设置与人工任务

- 仅在 profile 提供 `settings.git` 时设置 Git identity。
- 只修改 Dawn Forge 标记块；修改前创建时间戳备份。
- Microsoft account、Store 登录、许可证、浏览器账号、UAC、driver、系统扩展和 GUI 首选项均为人工任务。
- 不安装 WSL、迁移应用数据或启用可选 Windows feature，除非 profile 明确要求且计划单独披露。
