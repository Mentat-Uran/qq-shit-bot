# QQ Shit Bot

这是一个 QQ 群聊机器人项目。当前唯一运行形态是 **OpenClaw + Docker**:OpenClaw `2026.7.1` 与官方 `@openclaw/qqbot` 插件全部运行在 Docker 中,宿主机不安装 OpenClaw、Node.js 或 QQ 插件。

本仓库保留上游 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的完整源码(见 [`docs/UPSTREAM_README.md`](docs/UPSTREAM_README.md)),方便群友复现和继续开发;但 **Hermes 网关已废弃**,不再是本项目的运行方式。

## 功能

- QQ 私聊、群聊和明确 @ 触发;群聊未 @ 时按需自主判断是否参与。
- 群聊上下文按群独立维护:32 条历史窗口、收集式消息队列(上限 32 条、超出自动摘要)、120 分钟空闲自动重置、compaction safeguard 模式;`context-recovery` 守护进程在上下文溢出或模型卡死时自动重置对应群会话。
- 引用文本、图片、语音、文件和 QQ 小程序卡片摘要处理;小程序有标题时先搜索标题再解读,查不到时不编造正文。
- 商汤 SenseNova `deepseek-v4-flash` 为主模型,官方 DeepSeek `deepseek-chat` 兜底;`Watch-OpenClawModel.ps1` 每五分钟探测商汤额度,失败时自动走 DeepSeek,恢复后自动切回,切换过程不向群里发送诊断信息。
- 本地 GPU 视觉:Qwen2.5-VL 7B(Ollama)作为常规图片理解路径;Mage-VL 视频桥(`127.0.0.1:30000`)与 NVIDIA LocateAnything-3B 图像融合(`127.0.0.1:30001`)属于可选 `heavy-media` 服务,视频只识别当前消息直接 @ 或明确引用该视频的请求。
- 关闭 OpenClaw 终端、Control UI 仅绑定 `127.0.0.1` 且需 token 认证;`exec`/`read`/`write` 工具全局禁用;QQ 私聊与群聊默认白名单。

## 快速开始(OpenClaw + Docker)

完整配置、安全边界与运行方式见 [`deploy/openclaw/README.md`](deploy/openclaw/README.md)。

### Linux / WSL / Git Bash

```bash
cd deploy/openclaw
cp .env.example .env
# 填写 .env 中的 QQ、模型凭据与 OPENCLAW_GATEWAY_TOKEN
./setup.sh
```

### Windows

直接运行 [`scripts/windows/Start-OpenClawQQBot.bat`](scripts/windows/Start-OpenClawQQBot.bat)(或桌面快捷方式)。它调用 `deploy/openclaw/Start-OpenClawDocker.ps1`,从本地 Hermes 环境读取 QQ 与 SenseNova 凭据,并把官方 DeepSeek key 从 Windows DPAPI 注入运行环境;密钥永不写入仓库。

启动后打开 Control UI:`http://127.0.0.1:18789`,用 `.env` 里的 `OPENCLAW_GATEWAY_TOKEN` 认证。

### 常用命令

```bash
cd deploy/openclaw
docker compose logs -f openclaw-gateway
docker compose run --rm openclaw-cli status
docker compose run --rm openclaw-cli config validate
docker compose run --rm openclaw-cli plugins inspect qqbot
docker compose exec qwen-vision ollama list
```

## 模型与额度切换

- 主模型:SenseNova `deepseek-v4-flash`(`https://token.sensenova.cn/v1`)。
- 兜底模型:官方 DeepSeek `deepseek-chat`(`https://api.deepseek.com/v1`),key 由 Windows 启动器从 Hermes DPAPI 解密注入,或由 `DEEPSEEK_API_KEY` 环境变量提供。
- `Watch-OpenClawModel.ps1` 每 5 分钟以 1-token 请求探测商汤;429/额度受限记入本地日志,模型请求失败时自动走 DeepSeek 兜底。错误、兜底与内部诊断 payload 会被本地 `reply_payload_sending` 钩子过滤,只留在网关日志里。

## 部署架构

- `openclaw-gateway`:QQ WebSocket、会话/上下文、模型路由与最终中文回复,不加载重型视觉模型。
- `qwen-vision`:私有 Ollama `Qwen2.5-VL 7B` 图片理解与 OCR,GPU 按需加载,`OLLAMA_KEEP_ALIVE=3m` 短保活。
- `video-bridge`(可选 `heavy-media`):Microsoft Mage-VL 视频分段理解,拒绝 CPU offload。
- `image-fusion`(可选 `heavy-media`):NVIDIA LocateAnything-3B 定位 + Qwen 内容/OCR 融合,拒绝 CPU offload。
- `context-recovery`:监控网关日志,上下文溢出或会话卡死时自动重置对应群会话。
- `qq-diagnostic-filter-init`:一次性初始化服务,把本地钩子与补丁脚本以 `0644` 种入命名卷。

Qwen 不暴露宿主机端口;图片/视频服务在 Compose 私有网络内访问 `qwen-vision:11434`。重型服务共享 GPU 锁,一次只驻留一个重型模型。

## 上下文管理

- 群历史窗口 `historyLimit: 32`;未 @ 的普通消息作为待处理上下文收集,不触发模型调用。
- 消息队列 `collect` 模式,2.5s 去抖,上限 32 条,超出时摘要丢弃(`drop: summarize`)。
- `contextTokens: 65536`;compaction `safeguard` 模式,压缩后保留最近 16000 token 与最近 8 轮。
- 群会话 120 分钟无活动自动重置;`context-recovery` 兜底处理溢出/卡死,技术细节不出现在群里。
- 主动巡检:白天每 10 分钟、夜间每 30 分钟(Asia/Shanghai)读取待处理上下文,无补充价值时输出 `NO_REPLY`。

## Hermes 旧版(已废弃)

- 上游 Hermes Agent 源码保留在仓库中(见 [`docs/UPSTREAM_README.md`](docs/UPSTREAM_README.md)),仅作参考与复现。
- 根目录 `docker-compose.yml` / `docker-compose.windows.yml`、`scripts/windows/` 下的 Hermes 启动脚本(如 `启动HermesGateway.bat`)、`config.example.yaml` 等均为遗留物,不再维护;不要据此判断当前部署。
- 旧版 Hermes 网关与 OpenClaw QQ 网关不能同时连接同一 QQ 凭据。

## 开发和 Issue

提交 Issue 时请尽量提供:

- 部署方式(OpenClaw Docker / 手动)、Docker Desktop 版本、显卡与显存型号。
- 发生时间、脱敏后的网关日志片段和是否明确 @ 机器人。
- 可复现步骤和期望行为。

不要上传 `.env`、API key、QQ App Secret、会话数据库、聊天归档、完整群号或私聊内容。

## 许可证

本项目使用 MIT License。上游 Hermes Agent 的版权和许可证声明保留在 [`LICENSE`](LICENSE) 中。
