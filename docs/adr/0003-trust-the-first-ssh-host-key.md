# 首次连接核对 SSH host key

用户先在目标机本地取得 SSH host-key fingerprint，再从控制机终端首次连接。终端提示的 fingerprint 必须一致，用户才接受并继续输入密码。后续 host key 发生变化时停止连接，不自动清除 `known_hosts`，也不允许关闭 host-key 验证。
