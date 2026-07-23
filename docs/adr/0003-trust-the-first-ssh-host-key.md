# 首次连接记录 SSH host key

为避免在新目标机输入命令，控制机首次通过用户从系统界面读取的局域网 hostname/IP 连接时使用 `StrictHostKeyChecking=accept-new` 记录 host key。后续 host key 发生变化时停止连接，不自动清除 `known_hosts`，也不允许关闭 host-key 验证。
