# macOS 长期运行与合盖运行说明

## 能保证的范围

Mac Compose 默认只启动 `openclaw-gateway` 与 `context-recovery`，另有一次性 `qq-diagnostic-filter-init` 初始化服务。两个常驻服务都使用 `restart: unless-stopped`，Gateway 有 `/healthz` 健康检查，context-recovery 依赖 Gateway 健康后启动。Docker Desktop 或容器进程恢复后，Compose 会按这些策略恢复服务；这不等同于 QQ 外部消息已经送达。

建议使用以下入口确认状态：

```bash
cd /Users/mentat/qqshitbot
scripts/mac/check-env.sh
scripts/mac/status.sh
curl http://127.0.0.1:18789/healthz
```

控制台是宿主机 Python 进程，不是 Docker 容器。要让它在进程崩溃或用户登录后自动拉起：

```bash
scripts/mac/install-launch-agent.sh
```

该 LaunchAgent 只负责 Operations Console；卸载它不会停止 Gateway：

```bash
scripts/mac/uninstall-launch-agent.sh
```

控制台日志位于 `~/Library/Logs/qqshitbot/`，只包含启动和 HTTP 路径摘要，不应把其中内容当作 QQ 消息送达证据。

## 合盖的限制

MacBook 合盖后通常进入睡眠，Docker Desktop 的 Linux VM、Gateway、context-recovery 和控制台都会暂停。`restart: unless-stopped` 只能处理容器退出或 Docker daemon 重启，不能在宿主机睡眠期间执行任务。

不要通过软件绕过合盖睡眠。需要合盖运行时，只使用 macOS 支持的 clamshell 模式：连接 AC 电源、外接显示器和外接输入设备，并确认 Mac 仍保持唤醒。不要把 `caffeinate` 当成合盖运行保证；持续高负载应使用常开主机。

Docker Desktop 中启用 “Start Docker Desktop when you sign in”，并为项目保留足够的 Docker Desktop 磁盘空间。首次镜像下载、运行时状态、Gateway 日志和未来升级都占用磁盘；SenseNova 云视觉不会在 Mac 上下载 Qwen/Ollama 模型权重。建议至少保留 8 GB 可用磁盘用于镜像与日志，实际需求以 Docker Desktop 的镜像大小和日志增长为准。

资源和网络建议：Docker Desktop 至少分配 4 GB 内存，生产式长期运行更建议 8 GB；Mac 本机应保留至少 8 GB 可用磁盘。Gateway 需要稳定的出站 HTTPS/WSS 网络以连接 QQ 平台、`token.sensenova.cn` 和 `api.deepseek.com`；局域网面板只需要同一网段可达，不需要公网端口转发。Apple Silicon 已在当前 Mac 上验证；Intel Mac 没有本地 GPU/Qwen 依赖，但本次未做 Intel 实机验证，部署前应确认 Docker Desktop 能拉取该固定 OpenClaw 镜像的 `amd64` 变体。

## 故障定位

```bash
# Docker Desktop / Compose
docker info
docker compose --env-file deploy/openclaw/.env -f deploy/openclaw/docker-compose.mac.yml ps --all

# Gateway 与控制台监听
curl http://127.0.0.1:18789/healthz
curl http://127.0.0.1:18888/api/health
lsof -nP -iTCP:18789 -sTCP:LISTEN
lsof -nP -iTCP:18888 -sTCP:LISTEN

# 最近日志
scripts/mac/logs.sh 80
```

若 Mac 睡眠或网络切换后服务没有恢复，先唤醒 Docker Desktop，再运行 `scripts/mac/start.sh`；不要删除 named volume。无 Token 局域网模式必须继续绑定具体 Mac LAN IPv4，只开放脱敏只读控制台；需要更强保护时切回 `OPS_CONSOLE_AUTH_MODE=token`，两种模式都禁止路由器端口转发。
