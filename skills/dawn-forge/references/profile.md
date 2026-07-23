# 装机 profile

## 作用

profile 使用 JSON 描述目标机最终需要的软件、非敏感设置和人工任务。目标机由运行时提供的稳定 SSH alias 指定，不写进 profile；控制机平台由 Agent 自动探测。

以 `assets/dawn-forge.profile.example.json` 为空模板。`assets/dawn-forge.profile.macos.example.json` 是可复制修改的 macOS 完整示例，用于演示软件来源、可选项、SSH key 设置和人工任务。两个文件都不代表默认安装集；只有用户实际 profile 明确列出的软件才可进入安装计划。

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

`npm-global` 与 `volta-tool` 可跨平台使用，必须提供 `package`。执行前分别验证目标机已有受控 Node.js/npm 或 Volta；缺少的 runtime 必须作为依赖显示在一次性安装计划中，不得静默安装。

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
