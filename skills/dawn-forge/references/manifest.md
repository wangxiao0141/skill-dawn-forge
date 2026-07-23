# 装机清单

## 作用

装机清单使用 JSON 描述目标状态。它只包含目标机地址、期望软件、有限的非敏感设置和人工任务，不包含命令、下载 URL 或秘密。

以 `assets/dawn-forge.example.json` 为唯一模板。复制后修改副本，不直接改 Skill 内的模板。

## 顶层字段

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `schemaVersion` | 是 | 第一版固定为 `1` |
| `target` | 是 | 目标机稳定标识、局域网域名和 macOS short username |
| `software` | 是 | 期望安装的软件数组，可以为空 |
| `settings` | 否 | 当前只支持非敏感 Git identity |
| `manualTasks` | 否 | 用户希望保留在最终检查表中的人工任务 |

## `target`

```json
{
  "id": "personal-mac-mini",
  "host": "mac-mini.home.arpa",
  "user": "alice"
}
```

- `id` 使用小写字母、数字和连字符，作为管理密钥与运行状态的稳定目录名。
- `host` 只接受局域网 DNS 名称，不接受 `user@host`、端口、URL 或 shell 字符。
- `user` 是目标机现有管理员账号的 short username。

## `software`

```json
{
  "name": "Visual Studio Code",
  "source": "auto",
  "package": "visual-studio-code",
  "required": true
}
```

字段语义：

- `name`：展示给用户的稳定名称。
- `source`：可选，默认 `auto`。允许 `auto`、`brew-formula`、`brew-cask`、`app-store`、`official-download`、`manual`。
- `package`：可选的包标识提示，不是命令或 URL。`brew-formula`、`brew-cask` 和 `app-store` 必须提供。
- `version`：可选。缺省表示最新稳定版；存在时表示固定版本请求。
- `required`：可选，默认 `true`。失败时是否阻止依赖它的后续项。

不要直接执行 `name` 或 `package`。先将其解析为受控安装参数，并在安装计划中展示来源。

## `settings.git`

只允许：

```json
{
  "userName": "Alice",
  "userEmail": "alice@example.com",
  "defaultBranch": "main"
}
```

未提供时保留目标机现状，不主动询问。

## 禁止内容

不得添加：

- Clash 订阅地址；
- password、token、API key、credential；
- SSH private key；
- 带用户名或密码的 URL；
- 任意 shell、PowerShell 或 AppleScript；
- 任意下载 URL。

校验器会拒绝常见秘密字段和 private key 内容，但校验不能代替人工检查。

## 版本与兼容

遇到未知 `schemaVersion` 时停止并说明不支持。不要静默迁移或丢弃未知字段。
