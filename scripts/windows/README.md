# Windows 启动入口

正常启动使用 `Start-OpenClawQQBot.bat`，它直接调用 Docker Compose，不调用 PowerShell。

启动器会从 `deploy/openclaw/.env` 读取已经配置的 QQ、Codex 反代和网关凭据，检查必填项后准备 `runtime/`，安装或验证 QQ 插件，并通过 Docker Compose 启动 OpenClaw 网关和上下文恢复服务。文字和图片理解均使用 `codex-proxy/gpt-5.6-luna`，不会启动本地视觉模型。

`Bind-OpenClawQQBot.bat` 只适用于已经完成凭据配置的本机：它不回显密钥，也不执行 QR 凭据采集，只检查 QQ 凭据后调用正常启动器。首次绑定请先把 QQ 凭据和 Codex 反代 token 写入被 gitignore 的 `deploy/openclaw/.env`。

启动失败时窗口会保留错误信息；不要把 `.env` 内容、AppSecret、Codex token 或网关 token 粘贴到聊天、截图或仓库中。
