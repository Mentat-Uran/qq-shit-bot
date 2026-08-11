# macOS 迁移验收记录模板

这份记录只填写实际观察到的证据。Compose、healthz、面板和模型探针不能替代真实 QQ 收发证据；没有执行的项目写“未验证”。不要粘贴 `.env`、Token、API 响应正文、QQ 号、OpenID、图片或完整日志。

## 本机与源码

| 项目 | 命令/证据 | 结果 |
| --- | --- | --- |
| macOS / Docker Desktop | `sw_vers`、`docker compose version` | 已验证：macOS 27.0、Compose v5.3.1、Docker daemon ready |
| Mac 环境检查 | `scripts/mac/check-env.sh` | 已验证：必需环境项存在性通过，输出脱敏 |
| Mac Compose 解析 | `scripts/mac/check-env.sh --allow-placeholders` | 已验证：Mac Compose 配置有效 |
| 默认服务范围 | `scripts/mac/status.sh`；只应有 Gateway 与 context-recovery | 已验证：Gateway healthy、context-recovery running；无本地视觉服务 |
| 停止链路 | `scripts/mac/stop.sh` | 已验证：容器和网络停止，named volumes 保留 |
| 日志链路 | `scripts/mac/logs.sh 80` | 已验证：跟随日志入口可启动；未保留完整日志 |
| macOS CPU/RAM/磁盘采集 | Operations Console `/api/snapshot` | 已验证：CPU/RAM 可采集；输出只保留状态和来源 |

## SenseNova -> DeepSeek

| 项目 | 命令/证据 | 结果 |
| --- | --- | --- |
| SenseNova 文本/视觉探针 | `python3 scripts/sensenova_probe.py --env-file deploy/openclaw/.env --image <本地测试图片>` | 已验证：图片请求 HTTP 200、视觉内容可用 |
| 图片模型 | `sensenova-6.7-flash-lite` | 已验证：在线图片请求成功 |
| 最终文本模型 | `sensenova-token/deepseek-v4-flash` | 已验证：SenseNova 文本请求 HTTP 200、最终内容可用；官方 `deepseek/deepseek-chat` 未在本次默认探针中调用 |
| OpenClaw Gateway 图片入口 | 本机 `/v1/chat/completions` 图片请求 | 未验证：当前 Mac 配置未启用该 HTTP 入口，返回 404；不代表 QQ 插件路径失败 |
| 视觉失败降级 | 记录短回复/无诊断泄露行为 | 未验证 |
| QQ 实际图片附件进入视觉模型 | 真实 QQ 事件与脱敏 Gateway 证据 | 未验证 |

探针会把本地图片编码为请求内 data URL，只打印 HTTP 状态和是否得到内容，不打印密钥、图片、模型回复或请求正文。它验证供应商链路，不证明 QQ 插件已把附件传到 Gateway。

## 局域网

| 项目 | 证据 | 结果 |
| --- | --- | --- |
| 默认回环边界 | 未设置 LAN 地址时 `127.0.0.1` 可访问、局域网地址拒绝 | 已验证源码默认回环；未做另一台机器访问 |
| Mac 面板 | Mac 浏览器访问具体 LAN IPv4 的 `http://<mac-lan-ip>:18888/` | 已验证：`/api/health` 成功，`deployment=mac`、`authMode=none`、`authRequired=false`；第二设备访问未验证 |
| Windows 浏览器访问 Mac 面板 | 同一局域网 Windows 浏览器 + 认证 | 未验证 |
| 未授权访问 | 无 `Authorization` 时 HTTP 401 | 已验证 token 模式模拟返回 401；当前实际 LAN 模式为明确配置的无 Token 脱敏只读访问 |
| Control UI | 通过 Mac 广播地址访问并输入 Gateway Token | 未验证 |
| Docker 边界 | 浏览器没有 Docker Socket/任意命令入口 | 源码边界已声明；运行验证未验证 |

LAN 模式默认关闭。需要同网段 Windows 或手机访问时可运行 `scripts/mac/configure-lan-console.sh`，显式绑定具体 Mac 局域网 IPv4 并启用仅脱敏只读数据的 `OPS_CONSOLE_AUTH_MODE=none`；不允许无 Token 模式绑定 `0.0.0.0`/`::`，也禁止公网端口转发。需要更强保护时使用 `OPS_CONSOLE_AUTH_MODE=token` 和 `OPS_CONSOLE_TOKEN`。

## 真实 QQ

| 项目 | 证据 | 结果 |
| --- | --- | --- |
| QQ Gateway 在线连接 | 脱敏 Gateway 日志中的 QQ WebSocket 连接状态 | 已验证：WebSocket connected；未验证实际收发 |
| 真实 QQ 文字消息 | 账号、时间、群/私聊范围，不记录正文 | 未验证 |
| 真实 QQ 图片消息 | 当前消息附图并按项目规则触发，不记录图片 | 未验证 |
| 先图后 @ 流程 | 记录实际附件仍可取得 | 未验证 |
| 短回复/门控/降级 | 脱敏观察结果 | 未验证 |

## Windows 回归

Windows 的 `deploy/openclaw/docker-compose.yml`、`docker-compose.local.yml`、`scripts/windows/Start-OpenClawQQBot.bat` 和 PowerShell 辅助入口属于独立链路；Mac 变更不得把 Mac Compose 文件替换进 Windows 启动器。本次已验证 Windows Compose 解析、Python/Node 测试和 BAT/PS1 文本 wiring；PowerShell parser、Windows Docker/Qwen 实机和 Windows 局域网仍未验证，不能用 Mac 的云视觉证据代替。
