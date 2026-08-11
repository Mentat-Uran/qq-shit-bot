# QQ Bot Operations Console（Phase 1）

这是一个与 OpenClaw Gateway 解耦的本机只读监控台。它只服务于判断当前 Docker QQ Bot 的本机运行证据，不替代 OpenClaw 原生 Control UI，也不证明 QQ 外部消息已经送达。

## 启动

先确保 Python 3.11+ 在 PATH 中，然后运行：

```powershell
.\scripts\windows\Start-QQBotConsole.bat
```

默认地址是 `http://127.0.0.1:18888/`。PowerShell 入口支持安全的数字端口参数：

```powershell
.\scripts\windows\Start-QQBotConsole.ps1 -Port 18888
```

控制台启动不会启动、停止或重启 OpenClaw。正式 QQ Bot 仍必须使用 `scripts/windows/Start-OpenClawQQBot.bat`，该入口和 `deploy/openclaw/Start-OpenClawDocker.ps1` 没有被替换。

macOS 使用 `scripts/mac/console.sh`。默认仍绑定 `127.0.0.1:18888`；需要同一局域网 Windows 或手机浏览器访问时，可运行 `scripts/mac/configure-lan-console.sh`，它会绑定具体 Mac LAN IPv4 并启用 `OPS_CONSOLE_AUTH_MODE=none`。该模式只开放脱敏只读数据，不接受任意命令、Docker Socket 或密钥，且禁止绑定 `0.0.0.0`/`::` 和公网转发。需要更强保护时将模式设为 `token`，再使用浏览器 Basic Auth（用户名任意、密码为 Token）或 `Authorization: Bearer <token>`；Token 不进入 URL、页面快照或日志。

从任意工作目录启动 Mac 控制台都可以使用 `scripts/mac/console.sh`；`--no-browser` 适合 LaunchAgent 或无图形会话。Docker Desktop 暂不可用时，控制台仍应能启动并返回降级快照；只有服务状态采集会显示为未知或降级。需要进程退出后自动拉起时，运行 `scripts/mac/install-launch-agent.sh`，卸载使用 `scripts/mac/uninstall-launch-agent.sh`。

如果 BAT 窗口显示 `Exit code: 9009`，新版启动器会明确提示缺失的是 Windows PowerShell 还是 Python 3.11+。也可以直接在 PowerShell 中运行入口来查看原始错误：

```powershell
.\scripts\windows\Start-QQBotConsole.ps1 -Port 18888
```

## 为什么选择标准库服务

仓库现有 `web/` 只有字体资源，`website/` 没有可复用的本机应用入口，也没有需要继承的前端依赖。Phase 1 采用 Python 标准库 `ThreadingHTTPServer` 加原生 HTML/CSS/JS，避免引入新的 Node 构建链、额外容器或 Docker socket 权限；后续如果需要 SSE，仍可以在这个固定 REST 边界上扩展。

目录结构：

```text
ops_console/
  server.py       本机 HTTP 服务、静态资源白名单和 REST API
  collectors.py   Docker / healthz / macOS 或 Windows 主机资源采集器
  models.py       observedAt / source / confidence 数据模型助手
  redaction.py    日志和错误摘要脱敏
  static/         单页控制台
scripts/windows/
  Start-QQBotConsole.bat
  Start-QQBotConsole.ps1
tests/ops_console/  控制台单元和 HTTP 边界测试
```

## 页面与 API

页面包含 Dashboard、Runtime / Resources、QQ Activity、Sessions / Context、Logs / Diagnostics 五个区域。Phase 1 的 Operations 只提供刷新、打开固定的 OpenClaw Control UI 地址和查看三项有效服务，不提供任意命令、任意路径、任意 URL、Docker socket、清理缓存或高风险重启。

Mac 模式的固定服务只有 `openclaw-gateway` 与 `context-recovery`；GPU VRAM 和 Ollama 显示为不适用，视觉模式显示 SenseNova 6.7 Flash-Lite。Windows 模式继续采集 Qwen/Ollama 与 NVIDIA 状态。

### 界面主题与语言

控制台默认使用深色主题，顶部的“浅色模式”按钮可以切换到浅色主题；切换结果只保存在当前浏览器的 `localStorage`（键名为 `qqbot-ops-theme`），不会写入后端、Compose 或 OpenClaw 配置。重新打开页面会恢复上次选择，清除浏览器站点数据后恢复深色默认。

界面采用中文作为主语言，状态、日志等级、可信度、数据来源、资源字段和证据边界均已中文化。OpenClaw、Docker、Ollama、Qwen、WebSocket、服务名、模型名、`healthz`、API 路径和 `observedAt` / `source` / `confidence` 等诊断标识保留原文，避免影响定位和与官方文档对照。

API 只有以下固定路由：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 控制台自身是否可访问 |
| GET | `/api/snapshot` | 当前 Dashboard、Runtime、Activity、Sessions、Logs 和 Operations 快照 |
| GET | `/api/diagnostics` | 同一份已脱敏快照，便于复制诊断摘要 |
| GET | `/api/operations/services` | 三项有效服务和只读操作清单 |
| POST | `/api/refresh` | 不接受请求体，强制执行一次采集 |

任何状态值都尽量带有：

- `observedAt`：本次采集时间；
- `source`：Docker Compose、OpenClaw `/healthz`、Ollama、`nvidia-smi`、固定日志尾部或本机 API；
- `confidence`：`direct`、`inferred` 或 `not_collected`。

Windows GPU 采集只报告 `nvidia-smi` 的 VRAM、利用率和温度；Docker `MEM USAGE` 单独作为系统 RAM，绝不转换成显存。Mac 云视觉模式明确返回 `not_applicable`，不会显示为 0 或伪造正常 GPU。

## 数据和隐私边界

控制台不会解析或返回 `deploy/openclaw/.env` 内容，也不会把认证头、API key、Gateway token、QQ secret、完整群号、用户 OpenID、私聊正文、图片或原始日志包送到前端。日志只读取固定服务的最多 80 行尾部，经过敏感字段、长标识、长数字、URL 查询参数和 payload-like 内容过滤后才进入 API；运行态历史最多保留 720 个采样点，默认采样缓存约 3 秒，页面轮询为 8 秒。

QQ Activity 现在会从 Docker 日志尾部提取不含正文的连接、入站、模型请求、回复发送和上下文恢复事件，统一标记为 `inferred`；页面只显示事件类型、阶段、服务和时间，不保存消息正文、群号、OpenID 或完整标识。状态 SQLite 中的入站/发送队列表会直读当前队列条数；会话目录只读取最后活动时间、模型名和最近一次模型输入 Token，并以哈希会话标识展示，页面最多显示最近 24 条。`deploy/openclaw/openclaw.json` 中的主备模型、上下文上限、历史条数、队列模式、汇聚等待、队列上限、会话空闲重置和压缩保留策略会以 `direct` 配置证据显示；如果模型路由 watcher 不存在，则只显示配置值，不冒充实时可用性探测。最近一次模型输入 Token 不等于当前会话占用，QQ WebSocket 和回复发送若从日志模式推断，也不能证明 QQ 外部消息最终送达。

## 证据层级

容器运行、容器健康检查、端口监听、OpenClaw `/healthz`、本地 Qwen/Ollama 模型可用、QQ WebSocket 日志状态、QQ 真实消息收发是不同证据层级。控制台只呈现本机可观察结果，页面不会把构建成功、容器运行或 healthz 通过写成 QQ 外部收发已验证。

## 当前未实现

- OpenClaw 结构化事件桥和实时上下文 Token 占用采集；当前队列条数、脱敏会话元数据、最近请求 Token、配置上限和日志推断事件已接入；
- SSE、资源趋势图、操作审计历史；
- 启动/停止服务、重启 Gateway、会话恢复、缓存清理和配置修改；
- Mage-VL 视频桥和图像融合服务；这些服务已删除，不属于当前支持形态。

## 测试

控制台测试：

```powershell
python -m pytest -q tests/ops_console
```

既有 OpenClaw Compose 回归测试仍使用：

```powershell
python -m pytest -q tests/deploy/test_openclaw_docker.py
```

控制台本身即使 Docker Desktop 停止也应该能启动并返回降级快照；这只证明本机监控页面可用，不证明 OpenClaw 或 QQ Bot 可用。
