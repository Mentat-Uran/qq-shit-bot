# QQ Shit Bot

这是一个 QQ 群聊机器人项目。当前唯一运行形态是 **OpenClaw + Docker**:OpenClaw `2026.7.1` 与官方 `@openclaw/qqbot` 插件全部运行在 Docker 中,宿主机不安装 OpenClaw、Node.js 或 QQ 插件。

仓库只保留 OpenClaw Docker 运行链路与 QQ 机器人相关文档,不再维护本地运行代码或其他部署方案。

## 功能

- QQ 私聊、群聊和明确 @ 触发;群聊未 @ 时按需自主判断是否参与。
- 群聊上下文按群独立维护:32 条历史窗口、收集式消息队列(上限 32 条、超出自动摘要)、120 分钟空闲自动重置、compaction safeguard 模式;`context-recovery` 守护进程在上下文溢出或模型卡死时自动重置对应群会话。
- 引用文本、图片、语音、文件和 QQ 小程序卡片摘要处理;小程序有标题时先搜索标题再解读,查不到时不编造正文。
- 商汤 SenseNova `deepseek-v4-flash` 为主模型,官方 DeepSeek `deepseek-chat` 兜底;`Watch-OpenClawModel.ps1` 每五分钟探测商汤额度,将本地配置状态写入忽略的 runtime 文件,切换过程不向群里发送诊断信息。
- 本地 GPU 视觉:Qwen2.5-VL 7B(Ollama)是唯一启用的视觉路径。Mage-VL 视频桥与 NVIDIA LocateAnything-3B 图像融合已移出部署路径并归档到 [`docs/retired-visual/`](docs/retired-visual/)，不再构建或启动。
- 关闭 OpenClaw 终端、Control UI 仅绑定 `127.0.0.1` 且需 token 认证;`exec`/`read`/`write` 工具全局禁用;QQ 私聊与群聊默认白名单。

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

直接运行 [`scripts/windows/Start-OpenClawQQBot.bat`](scripts/windows/Start-OpenClawQQBot.bat)(或桌面快捷方式)。它调用 `deploy/openclaw/Start-OpenClawDocker.ps1`,从 `deploy/openclaw/.env` 读取 QQ 与模型凭据;密钥永不写入仓库。

启动后打开 Control UI:`http://127.0.0.1:18789`,用 `.env` 里的 `OPENCLAW_GATEWAY_TOKEN` 认证。

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
- `Watch-OpenClawModel.ps1` 每 5 分钟以 1-token 请求探测商汤;429/额度受限记入本地日志和脱敏 runtime 状态,请求失败时由 OpenClaw 使用已配置的 DeepSeek 兜底。错误、兜底与内部诊断 payload 会被本地 `reply_payload_sending` 钩子过滤,只留在网关日志里。

## 部署架构

- `openclaw-gateway`:QQ WebSocket、会话/上下文、模型路由与最终中文回复,不加载重型视觉模型。
- `qwen-vision`:私有 Ollama `Qwen2.5-VL 7B` 图片理解与 OCR,GPU 按需加载,`OLLAMA_KEEP_ALIVE=3m` 短保活。
- `docs/retired-visual/`:已归档的重型视觉源码和历史 Compose，仅供审计和恢复参考；当前部署不读取、不构建、不启动。
- `context-recovery`:监控网关日志,上下文溢出或会话卡死时自动重置对应群会话。
- `qq-diagnostic-filter-init`:一次性初始化服务,把本地钩子与补丁脚本以 `0644` 种入命名卷。

Qwen 不暴露宿主机端口;图片服务在 Compose 私有网络内访问 `qwen-vision:11434`。

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
