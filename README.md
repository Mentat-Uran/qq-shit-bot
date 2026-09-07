# QQ Shit Bot

这是一个 QQ 群聊机器人项目。当前唯一运行形态是 **OpenClaw + Docker**:OpenClaw `2026.8.2` 与官方 QQBot 2.x 插件 `@tencent-connect/openclaw-qqbot` `2.0.3` 全部运行在 Docker 中,宿主机不安装 OpenClaw、Node.js 或 QQ 插件。

无论 Windows、macOS、Linux、WSL 还是硬件型号，Bot 都使用 Docker Compose 运行；文字和图片理解统一通过 OpenAI-compatible Codex 反代调用 `gpt-5.6-luna`。反代地址与 token 只从被 gitignore 的 `deploy/openclaw/.env` 读取，不把任何真实凭据写入仓库。Docker Desktop 默认使用 `host.docker.internal` 访问宿主机反代，Linux Codex overlay 使用 host network 时可以填写 `http://127.0.0.1:18317/v1`。

## 功能

- QQ 私聊、群聊和明确 @ 触发;网关可接收群消息，但运行时人格仍要求群聊回复以当前 @ 或直接提问为触发条件。
- 群聊上下文按群独立维护:Linux Codex overlay 每个 @ 默认带当前消息和最近 12 条未 @ 消息作为候选上下文，模型先判断历史和当前消息的关系，相关才纳入推理，无关就忽略；队列使用小容量 steer 模式，60 分钟空闲自动重置；`context-recovery` 守护进程在上下文溢出或模型卡死时自动重置对应群会话。
- Linux Codex overlay 还提供 CPU-only 群聊小游戏：保留海龟汤、成语接龙和猜成语，并新增数字炸弹、24 点、猜人物、猜作品、知识抢答、真假判断、找不同、词语分类、一句话推理、脑筋急转弯、谜语、飞花令、诗词接龙、排序题和线索竞拍。统一从 `小游戏` 查看分组目录，也可以直接发送游戏名、常用别名或 `小游戏 1` 按编号启动；所有规则型游戏共用群房间、玩家积分、排行榜、提示、答案、下一题和结束流程，不依赖私聊、匿名身份或私密发牌。海龟汤复用开源 `nonebot-plugin-ai-turtle-soup` 引擎，开始/状态只展示汤面，不展示会泄露信息的标题；默认使用 50 道本地题库，支持 `开始海龟汤 悬疑惊悚恐怖`、`开始海龟汤 恐怖医院` 等自然主题提示词，LunaMax 负责是/否裁判，联网检索出题可通过 `GAME_PUZZLE_SOURCE=ai` 开启。海龟汤每次主持回答开头都会显示当前问题的短摘要，便于多人对应。成语接龙和猜成语使用固定 MIT 成语库，不需要模型调用，直接在群里发四字成语即可；详细游戏和题库导入说明见 [`docs/QQBOT_CHAT_GAMES.md`](docs/QQBOT_CHAT_GAMES.md)。
- 同一个 CPU-only sidecar 还提供行测刷题/抢答：常识判断、言语理解、判断推理、数量关系和资料分析均从本地结构化题库随机抽取，可指定模块，支持答案、解析、得分和正确率；基础题干与判分不依赖 LLM。题库导入保留可用的文字题，图表/示意图等必须看图的题不进入纯文字出题路径。
- Linux Codex overlay 的 QQ 菜单提供显式 TTS 朗读和语调选择：普通文字回复始终是文字，使用 `读：内容` 发语音；成功转写的 QQ 语音入站会把一次 AI 回答转成一次原生语音，菜单可选择温柔、播音、戏剧或正常语调。
- 可选的普通 QQ 账号路径使用 NapCatQQ + OneBot 11 反向 WebSocket；独立适配器把群聊/私聊、@、引用、图片、语音、文件/卡片摘要和合并转发归一化后复用同一套 OpenClaw、Codex、小游戏、上下文和媒体逻辑，现有官方 QQ Adapter 仍可并行运行。完整流程见 [`docs/ONEBOT_NAPCAT.md`](docs/ONEBOT_NAPCAT.md)。
- 引用文本、图片、语音、文件和 QQ 小程序卡片摘要处理;小程序有标题时先搜索标题再解读,查不到时不编造正文。
- 所有平台的文字、图片理解和 QQ 最终回复都使用 `codex-proxy/gpt-5.6-luna`，默认 `max` 推理；图片像素在同一 OpenAI-compatible 请求中发送给 Codex 反代。
- 主 Bot 栈不包含本地视觉模型、Ollama、SenseNova 或官方 DeepSeek provider；视频分析仍明确关闭。Linux overlay 的 Qwen3-TTS/ASR 和 ComfyUI 只属于按需启动的独立 Docker 辅助能力，不改变核心模型路由。
- `deploy/openclaw/docker-compose.yml`、`docker-compose.mac.yml` 和 Linux Codex overlay 都运行 Docker 服务；macOS 的 Operations Console 是可选的宿主机只读进程，不是 Bot 运行时或模型服务。
- 关闭 OpenClaw 终端、Control UI 默认仅绑定 `127.0.0.1` 且需 token 认证;明确启用 Mac LAN 模式后，Operations Console 可绑定具体局域网 IPv4 并使用无 Token 的脱敏只读访问;`exec`/`read`/`write` 工具全局禁用;QQ 私聊和群聊 @ 默认开放，群聊回复仍受运行时触发规则限制。

## 快速开始(OpenClaw + Docker)

完整配置、安全边界与运行方式见 [`deploy/openclaw/README.md`](deploy/openclaw/README.md)，安全维护和证据边界见 [`docs/SECURITY_OPERATIONS.md`](docs/SECURITY_OPERATIONS.md)。

### Linux / WSL / Git Bash

```bash
cd deploy/openclaw
cp .env.example .env
# 填写 .env 中的 QQ 凭据、CODEX_PROXY_BASE_URL、CODEX_PROXY_TOKEN 与 OPENCLAW_GATEWAY_TOKEN
./setup.sh
```

若宿主机已有 Codex 兼容反代，Linux 可使用 `./start-codex.sh` 启动带小游戏、TTS/ASR 和更大上下文策略的 Docker overlay；它仍从同一 `.env` 读取 `CODEX_PROXY_BASE_URL` 与 `CODEX_PROXY_TOKEN`，并把文字和图片请求发送到 `gpt-5.6-luna`。引用或最近图片若只有 QQ 签名下载地址，会先通过精确限制的 QQ 媒体下载路径转成本地图片，不把签名 URL 交给通用图像工具，也不关闭全局 SSRF 防护。详细命令见 [`deploy/openclaw/README.md`](deploy/openclaw/README.md)。

普通 QQ 账号接入在同一目录使用独立入口：先按文档填写 OneBot token、群白名单和管理员 QQ，再运行 `./start-onebot.sh`；需要同时启动 NapCat 容器时运行 `./start-onebot.sh --with-napcat`，登录和反向 WebSocket 配置仍在 NapCat WebUI 手动完成。

### Windows

直接运行 [`scripts/windows/Start-OpenClawQQBot.bat`](scripts/windows/Start-OpenClawQQBot.bat)(或桌面快捷方式)。它是纯 BAT 入口，直接调用 Docker Compose，从 `deploy/openclaw/.env` 读取 QQ 凭据和 Codex 反代 token；密钥永不写入仓库。

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

停止、日志和环境检查分别使用 `scripts/mac/stop.sh`、`scripts/mac/logs.sh` 和 `scripts/mac/check-env.sh`。Mac 启动只加载 `docker-compose.mac.yml`，运行时配置使用 `deploy/openclaw/openclaw.mac.json`，文字与图片同样经 `CODEX_PROXY_BASE_URL` 调用 Codex 反代。默认 Gateway 与 Operations Console 都绑定 `127.0.0.1`，需要同网段 Windows 或手机访问时运行 `scripts/mac/configure-lan-console.sh`；它会绑定具体 Mac 局域网 IPv4 并启用不带 Token 的脱敏只读控制台。不要绑定 `0.0.0.0`/`::`，也不要做公网端口转发。合盖运行只按 macOS 支持的 clamshell 模式处理，不由 Bot 修改系统睡眠策略。

### Windows 常用命令

```bash
cd deploy/openclaw
docker compose logs -f openclaw-gateway
docker compose run --rm openclaw-cli status
docker compose run --rm openclaw-cli config validate
docker compose run --rm openclaw-cli plugins inspect openclaw-qqbot
python ../../scripts/codex_proxy_probe.py --env-file .env
python ../../scripts/openclaw_diagnostic.py --mode health --pretty
```

### macOS 常用命令

Mac 必须通过 Mac 入口选择 `docker-compose.mac.yml`，不要在 Mac 上直接使用下面的 Windows Compose 命令：

```bash
cd /Users/mentat/qqshitbot
scripts/mac/status.sh
scripts/mac/logs.sh
scripts/mac/check-env.sh
python scripts/openclaw_diagnostic.py --mode health --deployment mac \
  --env-file deploy/openclaw/.env --compose-dir deploy/openclaw --pretty
```

## 模型与反代 token

- 三份平台配置 `openclaw.json`、`openclaw.mac.json` 和 `openclaw.codex.json` 都将文字与图片路由固定为 `codex-proxy/gpt-5.6-luna`，不配置 provider fallback。
- 在 `deploy/openclaw/.env` 中设置 `CODEX_PROXY_BASE_URL` 与 `CODEX_PROXY_TOKEN`。Docker Desktop 推荐 `http://host.docker.internal:18317/v1`；Linux host-network overlay 推荐 `http://127.0.0.1:18317/v1`。`CODEX_PROXY_TOKEN` 是反代认证 token，与 QQ AppSecret、Gateway token 是三种不同凭据。
- 请求失败时错误与内部诊断 payload 会被本地 `reply_payload_sending` 钩子过滤,只留在网关日志里。

## 部署架构

- `openclaw-gateway`:QQ WebSocket、会话/上下文、Codex 反代模型路由与最终中文回复；同一个 Codex 模型声明同时接收文字和图片。
- `docker-compose.yml` 与 `docker-compose.mac.yml`:跨平台的 Docker Bot 服务集合，都包含 Gateway、`context-recovery` 和一次性诊断过滤初始化；Docker Desktop 通过 `host.docker.internal` 访问宿主机 Codex 反代。
- `docker-compose.codex.yml`:Linux host-network overlay，复用同一 Codex token，并按需提供 CPU-only 游戏和独立的 TTS/ASR/ComfyUI Docker 辅助服务。
- `context-recovery`:监控网关日志,上下文溢出或会话卡死时自动重置对应群会话。
- `qq-diagnostic-filter-init`:一次性初始化服务,把本地钩子与补丁脚本以 `0644` 种入命名卷。

## 访问与证据边界

默认配置允许 QQ 私聊和群 @ 进入 OpenClaw，但群聊仍由运行时规则控制是否回复；需要公开群部署时，应先在 `openclaw.json` 中改回 allowlist 并配置 OpenID。控制台、healthz、容器状态和 CI 只说明本机或源码路径状态，不能单独证明第三方模型可用、Mac 局域网访问或 QQ 已真实收发。

## 上下文管理

- 群历史窗口 `historyLimit: 12`;未 @ 的普通消息最多保留最近 12 条作为候选上下文，模型会先判断每条消息与当前消息是否相关，相关才纳入推理，无关内容忽略。明确 QQ 引用和合并转发优先，图片最多带 1 张；没有引用时只有文字明确指向上图/刚才的图才考虑最近图片。
- 入站消息使用 700ms 去抖；消息队列使用 `steer` 模式、上限 2 条，超出丢弃旧消息。
- `gpt-5.6-luna` 声明 262144-token 上下文窗口，启动续话跳过重复 bootstrap；工具结果和压缩后的历史也有独立字符上限，compaction 保留最近 8000 token 与最近 2 轮。
- 群会话 60 分钟无活动自动重置;`context-recovery` 兜底处理溢出/卡死,技术细节不出现在群里。
- 主动巡检默认关闭；只有明确设置 `QQBOT_PROACTIVE_REVIEW_ENABLED=true` 才注册低频任务，避免后台定时扫描消耗 API。

## 开发和 Issue

提交 Issue 时请尽量提供:

- 部署方式（必须为 OpenClaw Docker）、操作系统/架构、Docker Desktop 或 Docker Engine 版本，以及可选的显卡信息。
- 发生时间、脱敏后的网关日志片段和是否明确 @ 机器人。
- 可复现步骤和期望行为。

不要上传 `.env`、API key、QQ App Secret、会话数据库、聊天归档、完整群号或私聊内容。

## 许可证

本项目使用 MIT License,详见 [`LICENSE`](LICENSE)。

## 本机 QQ Bot Operations Console

Phase 1 的只读本机控制台见 [docs/QQBOT_CONTROL_CONSOLE.md](docs/QQBOT_CONTROL_CONSOLE.md)，入口是 `scripts/windows/Start-QQBotConsole.bat`，默认只监听 `127.0.0.1:18888`。它与正式的 `Start-OpenClawQQBot.bat` 启动链路分离，不读取或返回 `.env` 密钥，也不把本机 healthz 或容器状态当成 QQ 外部收发证明。

Mac 入口是 `scripts/mac/console.sh`。它支持 `OPS_CONSOLE_BIND_HOST`、`OPS_CONSOLE_PORT` 和 `OPS_CONSOLE_AUTH_MODE`；具体 LAN IP 可启用无 Token 的脱敏只读模式，也可使用 Token 认证。控制台后端只调用固定的 Mac Compose 服务和固定健康检查，不暴露 Docker Socket、任意 Shell、密钥或会话正文。

## 开发验证

部署、Windows 启动器、控制台和安全审计的本地验证入口见 [`docs/DEVELOPMENT_VALIDATION.md`](docs/DEVELOPMENT_VALIDATION.md)。提交前不要加入 `.env`、`deploy/openclaw/runtime/`、日志、缓存、模型权重或会话正文；发布 PR 后仍需单独查看 GitHub Actions 检查结果。
