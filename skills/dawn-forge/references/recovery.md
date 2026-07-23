# 状态、恢复与验证

Dawn Engine 在控制机的 `~/.dawn-forge/runs/<runId>/` 保存不可变 `plan.json`、JSONL Journal 和原子更新的 `snapshot.json`。状态不包含密码、token、订阅 URL、私钥或远端原始输出。

## 恢复

1. 运行 `dawn run show --run <runId>` 查看持久化状态。
2. Target 身份、Plan hash 或 Catalog 绑定变化时停止，不恢复旧 Run。
3. `needs_user` 只在用户完成事件中的当前步骤后恢复。
4. 崩溃遗留的 `running` Action 首次 `resume` 会 fail closed；确认没有遗留远端安装进程后，再次运行 `resume` 才会选择性重试。
5. 已成功 Action 先复验；发现 drift 后只重新评估受影响 Action 及其下游，不重放无关成功项。

## 完成条件

- Run 已进入 `completed`，且没有未披露的失败或阻塞；
- 每个成功 Action 均完成 Provider verify；
- `dawn verify --run <runId>` 返回 `0`；
- Target identity 仍与注册记录一致。

退出码 `40` 表示 Action 失败或安全停止，`50` 表示只读 verify 发现 drift。不得删除 Journal、锁或 Target 记录来绕过恢复规则。
