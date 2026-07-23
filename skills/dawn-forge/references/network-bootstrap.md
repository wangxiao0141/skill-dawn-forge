# Clash 网络引导与 canonical artifact

唯一匹配候选把 Clash Verge Rev 声明为 `required: true`、`official-download` 且目标机尚未安装时，阶段 2 始终生成同一份 canonical mini-plan。目标机直连探测只决定后续是否必须先启用代理以及记录哪条实际 route，不再决定是否跳过 required Clash。只有 Clash 已安装或 `required: false` 时才不生成 artifact 请求。

SSH `finalizeCommand` 成功后，只运行受控入口：

```text
node <skill-directory>/scripts/plan-installation.mjs network-bootstrap --profile <profile.json> --identity-receipt <identity.json> --controller-route <direct|clash> --target-route direct --output-dir <new-network-bundle-directory>
```

输出目录必须是尚不存在的新目录。固定文件为 `profile.json`、`identity.json`、`mini-plan.json`，需要下载时另有 `artifact-request.json`。不得由 Agent 手写或从聊天拼装这些 JSON。

1. 只做目标 OS、architecture、代理客户端是否已安装，以及控制机能否访问官方 stable 下载源这组最小检查。
2. 生成只包含代理客户端 artifact、控制机 `networkLocation`/route、传输、签名校验、手动安装/授权和配置交接的 mini-plan。在同一条确认消息中复用已有配置，或让用户在控制机终端运行 `scripts/collect-private-input.mjs`；用户确认前不下载、不传输、不修改目标机。
3. 确认后只把 bundle 中的受控请求文件直接交给 canonical cache，不拆字段、不把 URL 放进 argv：

   ```text
   node <skill-directory>/scripts/artifact-cache.mjs fetch --request <network-bundle-directory>/artifact-request.json
   ```

   控制机只使用 `~/.dawn-forge/artifacts/`。请求文件必须是非 symlink 的有界普通文件并通过严格 schema、secret、HTTPS 和 host allowlist 校验；`signed-download` 只允许受控 HTTPS redirect 携带校验过且不落盘的签名 query。
4. cache 未命中时只启动一个前台 download owner，先写 `.partial`，支持来源允许的安全续传；完整下载并校验后原子 rename。禁止 detached job 或重复下载同一 artifact。
5. expected SHA-256 只证明下载 bytes 与调用方提供的 digest 一致，记录为 `publisherDigestMatched`，不能单独证明 digest 的 publisher provenance。只有另外验证官方签名、notarization 或受信 publisher manifest 后才可声称 publisher 完整性；否则只记录本地 SHA-256。
6. 只通过 `scripts/transfer-artifact.mjs` 把 canonical cache metadata 对应的安装包传到目标机 `Downloads/dawn-forge/artifacts/`；入口绑定已确认的 mini-plan digest、finalized target identity、SSH trust files，并核对两端 SHA-256/size。不得手写 `scp`。macOS installer 在用户开始人工步骤前按平台流程验证 Gatekeeper/notarization 和签名。
7. Agent 不安装、不运行 installer；用户在一个合并人工步骤中手动安装，完成 GUI 或系统授权，再手动应用配置、选择节点并启用系统代理或 TUN。
8. Agent 验证系统 proxy/TUN 和完整环境 preflight 所需端点。
9. Clash 安装完成后再执行完整环境 preflight；若最小探测原本直连失败，还必须先验证 proxy/TUN 和阶段 3 所需端点。随后让用户一次确认 profile 与安装计划。

本阶段有一次 mini-plan 确认和一次合并的手动安装/GUI/系统授权/配置导入暂停；订阅收集必须并入这次确认，不得安装后再次索要。安全校验在人工步骤开始前完成，不再插入中途确认。除代理客户端 installer 和用户提供的配置外，不传输或修改其他 profile 项目。
