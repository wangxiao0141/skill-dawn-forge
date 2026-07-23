# 装机 profile

## 作用

profile 使用 JSON 描述目标机最终需要的软件、非敏感设置和人工任务。目标机最终由运行时建立或复用的稳定 SSH alias 指定，不写进 profile；控制机平台由 Agent 自动探测。

以 `assets/dawn-forge.profile.example.json` 为空模板。`assets/dawn-forge.profile.macos.example.json` 是可复制修改的 macOS 完整示例，用于演示软件来源、可选项、SSH key 设置和人工任务。两个文件都不代表默认安装集；只有用户实际 profile 明确列出的软件才可进入安装计划。

## 发现与选择

1. 先完成目标电脑选择和 SSH 平台探测，再处理 profile。
2. 检查当前工作区 `profiles/` 下的 JSON 文件，不扫描 Skill 的 `assets/`。
3. 每个文件都必须运行 `scripts/validate-profile.mjs`；禁止通过 `Get-Content`、正则、字符位置或模型阅读自行判断 JSON 是否有效。
4. 只使用 validator 输出的 `profileName`、`platform`、`software`、`settings` 和 `manualTasks` 生成候选摘要。
5. 过滤目标平台不一致的候选。多个匹配候选时先让用户选择；只有一个匹配候选时将它标为“待确认候选”，不单独暂停确认。
6. 唯一候选明确包含 `required: true`、`official-download` 的 Clash 且目标机尚未安装时，始终生成同一联网 mini-plan；最小官方端点的目标机直连探测只决定实际 route 和是否必须先启用代理。用户确认该 mini-plan 后只下载、校验并传输匹配目标 OS 和 architecture 的 installer，不安装、不运行，也不处理 profile 中其他软件。`required: false` 不进入本阶段。
7. Clash 联网完成后执行完整环境预检，展示候选摘要和完整安装计划，用户一次确认 profile、增删项与执行计划；确认前不得安装或修改其他 profile 项目。
8. 没有有效候选时，报告 validator 的脱敏路径与固定原因。先自动完成只读诊断，再询问用户修复现有文件还是创建空模板。

不得只展示 profile 文件名或软件数量，不得要求用户手工输入已经发现的 profile 路径。唯一候选只允许自动进入只读预检和上述 Clash installer 传输，不能自动授权安装或其他修改。

## 顶层字段

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `schemaVersion` | 是 | 第一版固定为 `1` |
| `id` | 是 | profile 的稳定标识 |
| `name` | 是 | 展示名称 |
| `platform` | 是 | `macos` 或 `windows` |
| `software` | 是 | 期望安装的软件数组，可以为空 |
| `settings` | 否 | 非敏感 Git 和 SSH key 设置 |
| `manualTasks` | 否 | 最终检查表中的人工任务 |

## `software`

```json
{
  "id": "visual-studio-code",
  "name": "Visual Studio Code",
  "source": "auto",
  "required": true
}
```

- `id`：小写字母、数字和连字符组成的稳定标识。
- `name`：展示名称。
- `source`：可选，默认 `auto`。允许 `auto`、`brew-formula`、`brew-cask`、`mac-app-store`、`winget`、`microsoft-store`、`npm-global`、`volta-tool`、`official-download`、`manual`。
- `package`：可选的包标识提示，不是命令或 URL。显式包管理器来源必须提供。
- `version`：可选；缺省表示最新稳定版。
- `required`：可选，默认 `true`。

macOS profile 不得使用 `winget` 或 `microsoft-store`；Windows profile 不得使用 Homebrew 或 Mac App Store 来源。不要直接执行 `name` 或 `package`，先解析为受控安装参数并在计划中展示。

`package` 和 `version` 必须通过 validator 的受控 identifier 规则；不得包含 URL、路径穿越、前导 option、命令插值、shell operator 或控制字符。`manualTasks` 只作为最终检查表展示，绝不执行，也不得包含 URL 或命令。

`required: false` 表示默认不进入 resolved actions。只有用户在完整安装计划中明确选入后才安装；可选代理客户端不得仅因出现在唯一候选 profile 中就提前下载。

`npm-global` 与 `volta-tool` 可跨平台使用，必须提供 `package`。执行前分别验证目标机已有受控 Node.js/npm 或 Volta；缺少的 runtime 必须作为依赖显示在一次性安装计划中，不得静默安装。

目标机需要依靠代理客户端取得首次外网时，该客户端使用 `official-download`。Agent 在控制机下载并校验安装包，通过局域网传到目标机；用户在目标机手动安装。

## `settings`

Git identity：

```json
{
  "git": {
    "userName": "Alice",
    "userEmail": "alice@example.com",
    "defaultBranch": "main"
  }
}
```

目标机外部服务 key：

```json
{
  "ssh": {
    "githubKey": true,
    "generalKey": true
  }
}
```

未声明的设置保持目标机现状。`githubKey` 和 `generalKey` 只控制目标机外部服务 key，不影响控制机用于管理目标机的 SSH 身份。

## 禁止内容

profile 不得包含：

- password、token、API key、credential 或订阅地址；
- SSH private key 或 private key 内容；
- 带凭据的 URL；
- shell、PowerShell、AppleScript 或任意命令；
- 任意下载 URL。

遇到未知 `schemaVersion` 或未知字段时停止，不静默迁移。
