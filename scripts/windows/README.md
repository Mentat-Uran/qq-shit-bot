# Windows scripts

这些脚本用于 Windows 本地运行 Hermes QQ Bot：

- `启动HermesGateway.bat`：启动 Gateway；同时启动额度切换监控。
- `StartHermesGatewayWindow.ps1`：Gateway 启动器和单实例监控拉起逻辑。
- `watch-sensenova-v4-recovery.ps1`：每 60 秒检测商汤额度，并在商汤与官方 DeepSeek 之间切换。
- `Hermes_Gateway.cmd`：Windows 计划任务入口模板，启动 Gateway 前先拉起额度监控。
- `启动Hermes监控.bat`：可选的日志观察窗口，不是 Gateway 运行必需项。

脚本默认使用 `%LOCALAPPDATA%\hermes`，也支持通过 `HERMES_HOME` 和 `HERMES_WORKSPACE` 覆盖目录。API key 只从环境变量或本机 DPAPI 密钥文件读取，仓库不包含真实密钥。

