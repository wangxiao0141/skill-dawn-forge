# 配置文件交接

安装需要额外配置时，Agent 负责从控制机本地受保护文件把配置放到目标机，用户负责手动应用。不得要求用户把 subscription、token 或其他秘密粘贴到聊天。

目标目录：

- macOS：`~/Downloads/dawn-forge/`
- Windows：`%USERPROFILE%\Downloads\dawn-forge\`

规则：

1. 用户已经提供位于当前 home 受保护目录、owner/ACL/mode 合格且未被 Git tracked 的本地文件时直接使用，不重复索要；普通 Downloads 等共享目录中的文件不直接传输。
2. 缺少文字秘密时，让用户在控制机自己的 Terminal/PowerShell 运行：

   ```text
   node <skill-directory>/scripts/collect-private-input.mjs --name <controlled-name>
   ```

   用户只在本地隐藏输入提示中输入内容。不得把值放到命令参数、聊天、tool call 或环境变量。
3. `collect-private-input.mjs` 只写入控制机固定路径 `~/.dawn-forge/private-inputs/<controlled-name>.txt`，不接受 `--output` 或其他路径。文件原子创建并默认拒绝覆盖；需要替换时显式使用 `--replace`。Agent 只读取其 JSON 元数据中的路径，不读取或回显文件内容。
4. 只通过受控入口传输，不手写 `scp` 或拼接 SSH 命令：

   ```text
   node <skill-directory>/scripts/transfer-private-input.mjs --input "<absolute-private-file>" --name clash-subscription-url.txt --target <finalized-alias> --config "<ssh-config>" --platform <macos|windows> --target-identity-sha256 <digest>
   ```

   `--name` 当前只允许 `clash-subscription-url.txt` 和 `clash-config.yaml`。`--target` 只能是 `prepare-ssh-bootstrap.mjs finalize` 已持久化的 alias；脚本同时校验本地 identity receipt、platform、SSH config、`targetIdentitySha256`，以及 finalize 已在目标机创建并验证的 owner-only `~/.dawn-forge/handoff/`。
5. 入口先拒绝 home 外路径、symlink/reparse point、非当前 owner、不安全 mode/ACL、Git tracked 文件，以及 worktree 内未被 ignore 的文件。随后以本次 nonce 临时名执行固定的一次 `scp` 和一次 `ssh`；`scp` 不保留 Windows 控制机上无意义的 POSIX mode，只能写入 receipt 绑定的 owner-only handoff 目录，因此第二次 SSH 未能启动时，orphan 仍不能被其他普通用户读取。远端不需要 Node.js。失败清理不使用 glob，只能删除本次 nonce 临时文件，以及由本次进程创建但尚未确认成功的目标文件。
6. 不把配置内容写入 profile、仓库、argv、输出、run-state 或日志。handoff 输出 receipt 只包含 SHA-256、size、`targetIdentitySha256`、受控文件名和目标路径。
7. macOS 目标目录权限设为 `0700`，文件权限和 owner 验证为当前用户的 `0600`；Windows 的 handoff、`Downloads/dawn-forge/` 和 artifact 子目录均使用关闭继承、仅当前用户 `FullControl` 且向子项继承的精确 DACL，目标文件也使用关闭继承、仅当前用户 `FullControl` 的精确 DACL，并在发布后复验。目标文件只在临时文件与 Downloads 位于同一 filesystem/volume 时原子发布；跨卷直接失败，不退化为非原子复制。已存在且 SHA-256/size/权限完全一致时幂等成功，否则拒绝覆盖。
8. 一次传完本轮需要的配置，不逐个要求确认。传输后只报告文件名和目标路径，不读取或回显内容。
9. 目标文件默认保留，用户可在完成配置后自行删除。控制机收集文件的保留/替换遵循脚本显式选项，不静默覆盖。

配置文件只用于交接，不由 Agent 自动执行、导入或解释。

installer artifact 使用独立受控入口，不复用秘密配置目录，也不在传输后自动安装或运行：

```text
node <skill-directory>/scripts/transfer-artifact.mjs --metadata "<canonical-cache-entry>/metadata.json" --mini-plan "<network-bootstrap-bundle>/mini-plan.json" --mini-plan-sha256 <digest> --target <finalized-alias> --config "<ssh-config>" --platform <macos|windows> --target-identity-sha256 <digest>
```

入口只接受 `artifact-cache.mjs` 产生的 canonical metadata，并逐项验证 network-bootstrap bundle 内 `mini-plan.json`、`profile.json`、`artifact-request.json` 的 digest、目标身份、action 与 artifact `requestDigest` 绑定。传输前后复验 SHA-256/size，并原子发布到 `~/Downloads/dawn-forge/artifacts/` 或 `%USERPROFILE%\Downloads\dawn-forge\artifacts\`。输出明确记录 `installed=false`、`executed=false`；只有用户完成对应 mini-plan 的手动安装步骤后，才能进入安装验证。
