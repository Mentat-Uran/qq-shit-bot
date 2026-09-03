# 跨平台 Docker + Codex 反代验收记录模板

文件名保留用于兼容旧文档链接；当前内容描述的是统一后的跨平台部署，
不是独立的 Mac 模型迁移路线。这份记录只填写实际观察到的证据。Compose、
healthz、控制台和 Codex 探针不能替代真实 QQ 收发证据；没有执行的项目写
“未验证”。不要粘贴 `.env`、Token、API 响应正文、QQ 号、OpenID、图片或完整日志。

## 本机与 Docker

| 项目 | 命令/证据 | 结果 |
| --- | --- | --- |
| 操作系统与 Docker | 系统版本、`docker compose version`、`docker info` | 未验证 |
| 环境检查 | `deploy/openclaw/validate-env.sh` 或对应平台入口 | 未验证；只记录脱敏结果 |
| 标准 Compose 解析 | `docker compose --env-file deploy/openclaw/.env -f deploy/openclaw/docker-compose.yml -f deploy/openclaw/docker-compose.local.yml config --quiet` | 未验证 |
| macOS Compose 解析 | `docker compose --env-file deploy/openclaw/.env -f deploy/openclaw/docker-compose.mac.yml config --quiet` | 未验证 |
| Linux Codex overlay 解析 | 三个 Compose 文件加 `docker-compose.codex.yml` 的 `config --quiet` | 未验证 |
| 核心服务范围 | Compose `ps --all` | 应只有初始化服务、`openclaw-gateway`、`context-recovery`；未验证 |
| 停止链路 | 对应平台的 `down` 命令 | 未验证；named volumes 应保留 |

## 统一 Codex 文字/图片路由

| 项目 | 命令/证据 | 结果 |
| --- | --- | --- |
| 配置路由 | `openclaw.json`、`openclaw.mac.json`、`openclaw.codex.json` | 应为 `codex-proxy/gpt-5.6-luna`，文字和图片共用同一 provider；未验证 |
| 反代地址 | `.env` 中 `CODEX_PROXY_BASE_URL` 的存在性检查 | 已配置/未验证；不得记录实际值 |
| 反代 token | `.env` 中 `CODEX_PROXY_TOKEN` 的存在性检查 | 已配置/未验证；不得记录 token |
| Codex 反代文本探针 | `python3 scripts/codex_proxy_probe.py --env-file deploy/openclaw/.env` | 未验证；只记录脱敏状态 |
| Codex 反代图片探针 | `python3 scripts/codex_proxy_probe.py --env-file deploy/openclaw/.env --image <本地测试图片>` | 未验证；探针不打印图片或回复正文 |
| Codex 不可达降级 | 受控断网/错误配置后的诊断或安全 fallback 观察 | 未验证 |
| Gateway 图片入口 | QQ 事件或允许的本机请求证据 | 未验证；反代探针不证明附件到达 Gateway |

Docker Desktop 通常使用 `host.docker.internal` 访问宿主机反代；Linux
Codex overlay 使用 host networking 时可以使用 `127.0.0.1:18317`。这两个
边界都只证明容器到反代的网络路径，不证明 QQ 客户端已经完成发送或接收。

## 控制台与局域网

| 项目 | 证据 | 结果 |
| --- | --- | --- |
| 默认回环边界 | 未设置 LAN 地址时访问 `127.0.0.1`，并从另一设备确认不可达 | 未验证 |
| 控制台降级快照 | Docker 未运行时访问 `/api/health`、`/api/snapshot` | 未验证 |
| Codex 状态显示 | 页面区分配置状态、探针请求和 QQ 真实交互 | 未验证 |
| 局域网控制台 | 具体 LAN IPv4 的访问结果与 `OPS_CONSOLE_AUTH_MODE` | 未验证 |
| 未授权访问 | token 模式无 `Authorization` 时的 HTTP 401 | 未验证 |
| Docker 边界 | 浏览器没有 Docker Socket、任意命令、任意路径或任意 URL 入口 | 源码/运行分别记录；未验证 |

LAN 模式默认关闭。需要同网段访问时只能绑定具体 LAN IPv4；无 Token
模式只允许脱敏只读控制台，不得绑定 `0.0.0.0`/`::`，也不得做公网转发。

## 真实 QQ

| 项目 | 证据 | 结果 |
| --- | --- | --- |
| QQ Gateway 在线连接 | 脱敏 Gateway 日志中的 QQ WebSocket 状态 | 未验证 |
| 真实 QQ 文字消息 | 已授权账号、时间和范围，不记录正文 | 未验证 |
| 真实 QQ 图片消息 | 当前消息附图并按项目规则触发，不记录图片 | 未验证 |
| 先图后 @ 流程 | 脱敏日志和客户端确认附件仍可取得 | 未验证 |
| Codex 回复送达 | QQ 客户端可见回复与 Gateway 脱敏证据 | 未验证 |
| 短回复/门控/降级 | 脱敏观察结果 | 未验证 |

## 平台回归

Windows、macOS、Linux 和 WSL 的 Bot 运行都必须经过 Docker Compose。平台
入口可以不同，但不得重新引入宿主机模型进程或另一套文字/图片 provider。
CI、Compose 解析、Python/Node 测试和脚本静态检查只证明源码与本地检查
路径通过，不能用其中任何一项代替真实 QQ 交互。
