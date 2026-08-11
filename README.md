# QQ Shit Bot

这是一个 QQ 群聊机器人项目。当前唯一运行形态是 **OpenClaw + Docker**:OpenClaw `2026.7.1` 与官方 `@openclaw/qqbot` 插件全部运行在 Docker 中,宿主机不安装 OpenClaw、Node.js 或 QQ 插件。

仓库只保留 OpenClaw Docker 运行链路与 QQ 机器人相关文档,不再维护宿主机上的 OpenClaw 或其他本地运行方案。Windows 保留本地 Qwen 视觉链路；macOS 使用独立 Compose 文件，通过 SenseNova 6.7 Flash-Lite 识图，再由 DeepSeek 文本模型生成最终 QQ 回复。迁移约束见 [`MAC_MIGRATION_SENSENOVA_LAN_REQUIREMENTS.md`](MAC_MIGRATION_SENSENOVA_LAN_REQUIREMENTS.md)。

## 功能

- QQ 私聊、群聊和明确 @ 触发;网关可接收群消息，但运行时人格仍要求群聊回复以当前 @ 或直接提问为触发条件。
- 群聊上下文按群独立维护:32 条历史窗口、收集式消息队列(上限 32 条、超出自动摘要)、120 分钟空闲自动重置、compaction safeguard 模式;`context-recovery` 守护进程在上下文溢出或模型卡死时自动重置对应群会话。
- 引用文本、图片、语音、文件和 QQ 小程序卡片摘要处理;小程序有标题时先搜索标题再解读,查不到时不编造正文。
- 商汤 SenseNova `deepseek-v4-flash` 为主模型,官方 DeepSeek `deepseek-chat` 兜底;正常请求失败时由 OpenClaw 使用已配置的 fallback,不向群里发送 provider 诊断信息。
- 本地 GPU 视觉:Qwen2.5-VL 7B(Ollama)是唯一启用的视觉路径。Mage-VL 视频桥与 NVIDIA LocateAnything-3B 图像融合方案已删除，不再构建或启动。
- Mac 云视觉：`deploy/openclaw/docker-compose.mac.yml` 默认只启动 OpenClaw Gateway 与 `context-recovery`，不包含本地模型、GPU 或视频服务；图片模型是 `sensenova-6.7-flash-lite`，最终文本模型是 `deepseek/deepseek-chat`。
- 关闭 OpenClaw 终端、Control UI 仅绑定 `127.0.0.1` 且需 token 认证;`exec`/`read`/`write` 工具全局禁用;QQ 私聊和群聊 @ 默认开放，群聊回复仍受运行时触发规则限制。

## 快速开始(OpenClaw + Docker)

完整配置、安全边界与运行方式见 [`deploy/openclaw/README.md`](deploy/openclaw/README.md)，安全维护和证据边界见 [`docs/SECURITY_OPERATIONS.md`](docs/SECURITY_OPERATIONS.md)。

### Linux / WSL / Git Bash

```bash
cd deploy/openclaw
cp .env.example .env
# 填写 .env 中的 QQ、模型凭据与 OPENCLAW_GATEWAY_TOKEN
./setup.sh
```

### Windows

直接运行 [`scripts/windows/Start-OpenClawQQBot.bat`](scripts/windows/Start-OpenClawQQBot.bat)(或桌面快捷方式)。它是纯 BAT 入口,直接调用 Docker Compose,从 `deploy/openclaw/.env` 读取 QQ 与模型凭据;密钥永不写入仓库。

启动后打开 Control UI:`http://127.0.0.1:18789`,用 `.env` 里的 `OPENCLAW_GATEWAY_TOKEN` 认证。

### macOS + Docker Desktop

Mac 使用 Unix 入口，不依赖 BAT 或 PowerShell：

```bash
cd /Users/mentat/qqshitbot
scripts/mac/check-env.sh
scripts/mac/start.sh
scripts/mac/status.sh
scripts/mac/console.sh
```

停止、日志和环境检查分别使用 `scripts/mac/stop.sh`、`scripts/mac/logs.sh` 和 `scripts/mac/check-env.sh`。Mac 启动只加载 `docker-compose.mac.yml`，不会启动 Windows Compose 中的本地视觉服务；运行时配置使用 `deploy/openclaw/openclaw.mac.json`。默认 Gateway 与 Operations Console 都绑定 `127.0.0.1`，需要局域网访问时必须显式设置 Mac 局域网地址和 `OPS_CONSOLE_TOKEN`，不要把 Token 放进 URL，也不要做公网端口转发。

### 常用命令

```bash
cd deploy/openclaw
docker compose logs -f openclaw-gateway
docker compose run --rm openclaw-cli status
docker compose run --rm openclaw-cli config validate
docker compose run --rm openclaw-cli plugins inspect qqbot
docker compose exec qwen-vision ollama list
python ../../scripts/openclaw_diagnostic.py --mode health --pretty
```

## 模型与额度切换

- 主模型:SenseNova `deepseek-v4-flash`(`https://token.sensenova.cn/v1`)。
- 兜底模型:官方 DeepSeek `deepseek-chat`(`https://api.deepseek.com/v1`),key 由 `DEEPSEEK_API_KEY` 环境变量提供。
- 请求失败时由 OpenClaw 使用已配置的 DeepSeek 兜底。错误、兜底与内部诊断 payload 会被本地 `reply_payload_sending` 钩子过滤,只留在网关日志里。
- Mac 路由：`sensenova-vision/sensenova-6.7-flash-lite` 只负责当前图片理解；视觉结果进入官方 `deepseek/deepseek-chat` 生成最终短回复，SenseNova `deepseek-v4-flash` 仅作为文本 fallback。

## 部署架构

- `openclaw-gateway`:QQ WebSocket、会话/上下文、模型路由与最终中文回复,不加载重型视觉模型。
- `qwen-vision`:私有 Ollama `Qwen2.5-VL 7B` 图片理解与 OCR,GPU 按需加载,`OLLAMA_KEEP_ALIVE=3m` 短保活。
- `docker-compose.mac.yml`:Mac 专用服务集合，只包含 Gateway、`context-recovery` 和一次性诊断过滤初始化；图片数据由 SenseNova 6.7 Flash-Lite 处理，不产生本地模型权重。
- 重型视觉源码和历史 Compose 已删除，当前部署只保留 Qwen2.5-VL 视觉路径。
- `context-recovery`:监控网关日志,上下文溢出或会话卡死时自动重置对应群会话。
- `qq-diagnostic-filter-init`:一次性初始化服务,把本地钩子与补丁脚本以 `0644` 种入命名卷。

Qwen 不暴露宿主机端口;图片服务在 Compose 私有网络内访问 `qwen-vision:11434`。

## 访问与证据边界

默认配置允许 QQ 私聊和群 @ 进入 OpenClaw，但群聊仍由运行时规则控制是否回复；需要公开群部署时，应先在 `openclaw.json` 中改回 allowlist 并配置 OpenID。控制台、healthz、容器状态和 CI 只说明本机或源码路径状态，不能单独证明第三方模型可用、Mac 局域网访问或 QQ 已真实收发。

## 上下文管理

- 群历史窗口 `historyLimit: 32`;未 @ 的普通消息作为待处理上下文收集,不触发模型调用。
- 消息队列 `collect` 模式,2.5s 去抖,上限 32 条,超出时摘要丢弃(`drop: summarize`)。
- `contextTokens: 131072`(与 DeepSeek 兜底模型窗口一致,远低于 SenseNova 的 1M 窗口);compaction `safeguard` 模式,压缩后保留最近 20000 token 与最近 8 轮。
- 群会话 120 分钟无活动自动重置;`context-recovery` 兜底处理溢出/卡死,技术细节不出现在群里。
- 主动巡检:白天每 10 分钟、夜间每 30 分钟(Asia/Shanghai)读取待处理上下文,无补充价值时输出 `NO_REPLY`。

## 开发和 Issue

提交 Issue 时请尽量提供:

- 部署方式(OpenClaw Docker / 手动)、Docker Desktop 版本、显卡与显存型号。
- 发生时间、脱敏后的网关日志片段和是否明确 @ 机器人。
- 可复现步骤和期望行为。

不要上传 `.env`、API key、QQ App Secret、会话数据库、聊天归档、完整群号或私聊内容。

## 许可证

本项目使用 MIT License,详见 [`LICENSE`](LICENSE)。

## 本机 QQ Bot Operations Console

Phase 1 的只读本机控制台见 [docs/QQBOT_CONTROL_CONSOLE.md](docs/QQBOT_CONTROL_CONSOLE.md)，入口是 `scripts/windows/Start-QQBotConsole.bat`，默认只监听 `127.0.0.1:18888`。它与正式的 `Start-OpenClawQQBot.bat` 启动链路分离，不读取或返回 `.env` 密钥，也不把本机 healthz 或容器状态当成 QQ 外部收发证明。

Mac 入口是 `scripts/mac/console.sh`。它支持 `OPS_CONSOLE_BIND_HOST` 和 `OPS_CONSOLE_PORT`；绑定非回环地址时，后端要求 `OPS_CONSOLE_TOKEN`，浏览器可用 Basic Auth 或 Bearer Token 访问。控制台后端只调用固定的 Mac Compose 服务和固定健康检查，不暴露 Docker Socket、任意 Shell、密钥或会话正文。

## 开发验证

部署、Windows 启动器、控制台和安全审计的本地验证入口见 [`docs/DEVELOPMENT_VALIDATION.md`](docs/DEVELOPMENT_VALIDATION.md)。提交前不要加入 `.env`、`deploy/openclaw/runtime/`、日志、缓存、模型权重或会话正文；发布 PR 后仍需单独查看 GitHub Actions 检查结果。
