# Windows 目标机范围

Dawn Engine V1 不支持 Windows 目标机。Windows 只能作为运行 Node.js 20+ 和 Dawn Engine CLI 的控制机。

不得通过 `dawn target bootstrap` 注册 Windows Target，也不得把 Winget、Microsoft Store、UAC、Windows installer 或 Windows proxy 操作拼接到 macOS V1 Plan。需要 Windows 目标机支持时，应等待后续版本扩展 Platform、Inspector、Catalog 和 Provider 合同。
