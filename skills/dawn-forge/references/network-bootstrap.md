# 离线目标机网络引导

目标机没有可用外网时，代理客户端是其余联网安装的前置门禁。

1. profile 必须把代理客户端声明为 `official-download`。
2. Agent 在控制机从发布者官方 stable 渠道下载与目标 OS、architecture 匹配的安装包。
3. 核对 publisher 提供的 digest，并计算控制机本地 SHA-256。
4. 通过已验证的 `scp` 把安装包传到目标机 Downloads 目录，再核对两端 SHA-256。
5. Agent 不挂载、不安装、不运行 installer；用户在目标机手动安装并完成 GUI 或系统授权。
6. 安装并启动后，按 `references/configuration-handoff.md` 一次传入所需配置。
7. 用户手动应用配置、选择节点并启用系统代理或 TUN。
8. Agent 验证系统 proxy/TUN 和本次安装计划所需端点。
9. 联网验证通过后，才执行剩余批量安装。

本阶段只在手动安装、GUI 和系统授权时暂停，不重复确认软件清单。
