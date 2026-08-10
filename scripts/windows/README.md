# Windows 启动入口

`Start-OpenClawQQBot.bat` 是 Windows 本地启动 QQ 机器人的唯一入口。

它调用 `deploy/openclaw/Start-OpenClawDocker.ps1`，凭据统一读取
`deploy/openclaw/.env`，运行时状态保存在 `deploy/openclaw/runtime/`。

启动器会先调用 `Test-OpenClawEnvironment.ps1`，按共享的
`deploy/openclaw/environment-contract.txt` 校验配置并迁移旧别名；输出只包含状态，不包含密钥。
诊断和健康报告使用仓库根目录的 `python scripts/openclaw_diagnostic.py --mode preflight|health --pretty`。
