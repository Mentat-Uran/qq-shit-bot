# Windows 启动入口

正常启动使用 `Start-OpenClawQQBot.bat`，它直接调用 Docker Compose，不调用 PowerShell。

启动器会从 `deploy/openclaw/.env` 读取已经配置的 QQ、模型和网关凭据，检查必填项后准备 `runtime/`，安装或验证 QQ 插件，启动 Qwen 视觉服务、OpenClaw 网关和上下文恢复服务。

`Bind-OpenClawQQBot.bat` 只适用于已经完成凭据配置的本机：它不回显密钥，也不执行 QR 凭据采集，只检查 QQ 凭据后调用正常启动器。首次绑定请先把凭据写入被 gitignore 的 `deploy/openclaw/.env`，或使用保留的旧 QR 辅助脚本。

启动失败时窗口会保留错误信息；不要把 `.env` 内容、AppSecret、模型密钥或网关 token 粘贴到聊天、截图或仓库中。
