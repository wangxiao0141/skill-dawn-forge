# 支持 macOS 与 Windows 的控制机和目标机组合

Dawn Forge 不绑定执行 Agent 所在电脑或单一目标平台：控制机和目标机分别支持 macOS、Windows，形成四种组合。装机 profile 声明目标平台和软件目标，Agent 在运行时建立或复用稳定 SSH alias，并通过 SSH 探测事实后路由到平台流程；软件示例不构成默认安装集，未在 profile 中声明的软件不得安装。
