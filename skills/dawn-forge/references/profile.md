# Dawn Engine V1 Profile

CLI Profile 是严格 JSON 对象：

```json
{
  "schemaVersion": 1,
  "platform": "macos",
  "catalogVersion": "v1",
  "packages": [
    { "id": "homebrew", "state": "present" },
    { "id": "git", "state": "present" },
    {
      "id": "git-identity",
      "state": "present",
      "params": {
        "name": "Your Name",
        "email": "you@example.com"
      }
    },
    { "id": "node", "state": "present" },
    { "id": "vscode", "state": "present" }
  ]
}
```

## 规则

- `schemaVersion` 固定为 `1`，`platform` 固定为 `macos`。
- `catalogVersion` 必须对应随 Skill 发布的 Catalog。
- 每个 `packages` 条目必须是对象，且 `id` 不得重复。
- `state` 只能是 `present` 或 `absent`。
- 软件 ID 只能来自对应 Catalog；Agent 不得自行发明 Provider 或参数。
- 只有 `git-identity` 允许 `params`，且必须同时提供非空的 `name` 和合法 `email`。其他软件参数由 Catalog 固定。
- `absent` 在 V1 只用于冲突检测；Engine 不自动卸载软件。
- 未知字段、控制字符、命令、URL、路径、密码、token、订阅或私钥都会被拒绝。

`assets/dawn-engine.profile.example.json` 是 CLI 空模板。其他 `dawn-forge.profile.*` 文件属于保留的 legacy validator 格式，不得传给 `dawn plan`。
