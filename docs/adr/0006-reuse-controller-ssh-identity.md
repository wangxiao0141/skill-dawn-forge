# 使用控制机默认 ED25519 身份建立 SSH

Dawn Forge 默认从尚未建联开始。控制机使用 `~/.ssh/id_ed25519`：key pair 已存在时验证并复用，不存在时经确认生成 ED25519 key，绝不覆盖不完整或不匹配的文件。

目标机 alias 根据用户称呼和已确认的局域网 hostname/IP 推荐。用户只在控制机运行 Skill 生成的 `installKeyCommand` 并输入目标机密码；脚本远程幂等写入 `authorized_keys`。公钥连接验证成功后才保存 alias。

控制机 key 不复制到目标机；目标机持有的 GitHub key 和通用 key 仍分别在目标机生成。
