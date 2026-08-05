# Windows 启动入口

`Start-OpenClawQQBot.bat` 是 Windows 本地启动 QQ 机器人的唯一入口。

它调用 `deploy/openclaw/Start-OpenClawDocker.ps1`，凭据统一读取
`deploy/openclaw/.env`，运行时状态保存在 `deploy/openclaw/runtime/`。
