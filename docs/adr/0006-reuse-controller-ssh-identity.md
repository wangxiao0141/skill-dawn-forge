# 使用控制机默认 ED25519 身份建立 SSH

Dawn Forge 默认从尚未建联开始。控制机使用 `~/.ssh/id_ed25519`：key pair 已存在时验证并复用，两端都不存在时由建联计划直接生成 ED25519 key，不单独确认，绝不覆盖不完整或不匹配的文件。

`dawn target bootstrap` 根据用户称呼生成稳定 `targetId` 和受控 SSH alias。CLI 显示唯一授权命令，用户只在控制机运行该命令并输入一次目标机密码；Engine 按 key material 远程幂等写入 `authorized_keys`，并以控制机主机名作为 comment，便于识别允许连接的来源机器。公钥连接、host key 和机器身份验证成功后，才将 alias、独立 SSH config 和身份凭据原子发布为 Target。

控制机 key 不复制到目标机；目标机持有的 GitHub key 和通用 key 仍分别在目标机生成。
