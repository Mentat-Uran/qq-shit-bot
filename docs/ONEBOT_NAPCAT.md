# NapCatQQ + OneBot 11 普通 QQ 账号迁移

本路径让一个普通 QQ 账号通过 NapCatQQ 接入现有 `qq-shit-bot`。它是
OpenClaw 官方 QQ Adapter 之外的并行入口，不替换现有 Tencent QQ Open
Platform 配置，也不引入 NoneBot、Koishi 或 AstrBot。

## 迁移后的链路

```text
普通 QQ 账号
    │ 登录、收发、媒体下载
    ▼
NapCatQQ ── OneBot 11 reverse WebSocket ──► onebot-adapter
                                                │ 归一化、白名单、引用/图片取回
                 ┌──────────────────────────────┴──────────────────────────────┐
                 ▼                                                             ▼
       OpenClaw /v1/chat/completions                                    qqbot-game :18104
       Codex proxy + 现有运行时规则                                    现有全部文字小游戏
                 │                                                             │
                 └────────────── OneBot send_*_msg ◄──────────────────────────┘
```

适配器是协议边界。业务代码只看到统一的 `user_id`、`conversation_id`、
`message_id`、文字、图片、文件/卡片摘要、引用和媒体能力；OneBot 的事件 JSON、发送
Action 和 QQ 数字 ID 不传进 OpenClaw prompt 或小游戏 payload。群/私聊的
原始目标只在适配器的发送边界使用，日志只记录连接、状态和错误类型，不
记录 token、聊天正文或完整 QQ 标识。

## 先准备配置

只在本机操作被忽略的 `deploy/openclaw/.env`，不要把它复制到提交、日志、
截图或聊天中：

```bash
cd deploy/openclaw
cp .env.example .env       # 仅当 .env 尚不存在时执行
chmod 600 .env
```

填写现有 OpenClaw/Codex 配置，并补齐 OneBot 边界字段：

```dotenv
ONEBOT_ACCESS_TOKEN=<本机生成并保存在密码管理器中的随机 token>
ONEBOT_ALLOWED_GROUP_IDS=<允许接入的群号，可用逗号分隔多个>
ONEBOT_ADMIN_USER_IDS=<管理员 QQ，可用逗号分隔多个>
ONEBOT_ALLOWED_USER_IDS=<可选：允许私聊的 QQ，逗号分隔>
ONEBOT_DM_POLICY=allowlist
ONEBOT_GROUP_REQUIRE_MENTION=true
ONEBOT_STRICT_GROUP_MENTION=true
ONEBOT_COMMANDS_BYPASS_MENTION=true
ONEBOT_REPLY_TO_MESSAGE=true
```

严格 @ 模式下，群里的每一条消息都必须明确 @ 机器人才能处理；未 @ 的
普通消息、命令、回复和进行中的游戏输入都会忽略。若确实需要让命令或
游戏输入免 @，才将 `ONEBOT_STRICT_GROUP_MENTION` 改为 `false`。

图片下载默认只接受现有 QQ 签名媒体域名；如果 NapCat 实际返回其他 QQ
CDN 域名，把域名逐项写入 `ONEBOT_IMAGE_ALLOWED_HOSTS`。这里是精确主机名
白名单，不要填通配符、完整 URL 或不必要的内网地址；不在白名单中的 URL
会回退到 OneBot 的 `get_image`，仍无法安全取回时只保留图片占位文本。

不要把 `ONEBOT_ALLOW_ALL_GROUPS=true` 当成联通性测试方式；默认的精确群
白名单和私聊白名单应保留。`ONEBOT_SELF_ID` 可以留空，NapCat 的
`meta_event` 会填充机器人账号；如果实现不发送该事件，再手工填本机 QQ
号。`ONEBOT_ACCESS_TOKEN` 与 `OPENCLAW_GATEWAY_TOKEN`、
`CODEX_PROXY_TOKEN` 是三个不同用途的 token。

NapCat Compose 使用 NapCat 官方 Docker 项目示例中的
`mlikiowa/napcat-docker:latest`；该镜像的 QQ 持久化目录是
`/app/.config/QQ`，NapCat 配置目录是 `/app/napcat/config`，WebUI 使用
6099 端口。首次执行 `--with-napcat` 时才会按 `--pull missing` 拉取它；本机
不需要提前下载，也不要把账号数据目录放入 Git。镜像与路径依据见
[NapCat-Docker 官方 README](https://github.com/NapNeko/NapCat-Docker/blob/main/README.md)。

Linux Codex overlay 的模板通过独立的 `ONEBOT_CODEX_*` 覆盖项把游戏、ASR
和 TTS 指向现有 loopback 服务；通用 `ONEBOT_*` 地址仍保留给 bridge 网络：

```dotenv
ONEBOT_GATEWAY_URL=http://openclaw-gateway:18789
ONEBOT_GAME_SERVICE_URL=http://qqbot-game:18104
ONEBOT_CODEX_GATEWAY_URL=http://127.0.0.1:18789
ONEBOT_CODEX_GAME_SERVICE_URL=http://127.0.0.1:18104
ONEBOT_CODEX_ASR_URL=http://127.0.0.1:18102/v1
ONEBOT_CODEX_TTS_URL=http://127.0.0.1:18102/v1
```

`docker-compose.onebot.codex.yml` 会在 Linux host-network overlay 中再次
固定 Gateway 和游戏地址，并把适配器默认绑定在本机 loopback。若 NapCat
运行在另一台受信任机器上，才需要改成具体 LAN 地址并配合现有防火墙/隧道
策略；本项目不自动新增公网暴露、路由或防火墙规则。

## 启动顺序

### 1. 先启动现有核心和独立适配器

```bash
cd deploy/openclaw
./validate-env.sh
./start-onebot.sh
```

`start-onebot.sh` 会调用已有的 `start-codex.sh`，因此会准备并重建当前
OpenClaw Gateway、`context-recovery`、CPU 游戏 sidecar 和官方 QQ Adapter；
随后以 `docker-compose.onebot.yml` 加入 `onebot-adapter`。这一步可能短暂中断
现有官方 QQ 会话，应安排在维护窗口；它不会重启或替换无关容器，也不会执行
QQ 登录。

如果当前核心已经健康运行、希望只加入 OneBot 适配器，可在确认现有核心状态
和配置已经准备好的前提下使用：

```bash
ONEBOT_SKIP_CORE_START=true ./start-onebot.sh
```

该选项不会替代核心配置校验；如果 Gateway 或游戏 sidecar 尚未运行，适配器
会保持失败或等待，不能把它当作首次部署捷径。

如果想由 Compose 同时启动 NapCat 容器，可以使用：

```bash
./start-onebot.sh --with-napcat
```

NapCat 镜像和其 QQ 配置目录是独立的 `runtime/napcat/`；该目录被忽略，
不要将 QR 会话、登录缓存或账号数据提交到 Git。也可以只运行第一条命令，
之后再由完整 Compose 文件启动 NapCat。

### 2. 在 NapCat 中登录普通 QQ

默认 WebUI 仍然只绑定本机。若要从可信局域网中的另一台机器完成首次
登录，在被忽略的 `.env` 中设置一个确实分配给此宿主机的具体 IPv4 地址：

```dotenv
NAPCAT_WEBUI_BIND_ADDRESS=192.0.2.10
NAPCAT_WEBUI_PORT=6099
```

把示例地址替换成这台宿主机的实际 LAN 地址，然后执行：

```bash
./start-onebot.sh --with-napcat
```

启动器会拒绝 `0.0.0.0`、`::` 等通配绑定，并验证该具体地址确实存在于
Linux 宿主机；bridge Compose 使用该地址发布 `6099`，Linux host-network
overlay 则只更新 NapCat 持久化 `webui.json` 的 `host` 字段，不改 WebUI
token、QQ 会话或 OneBot 配置。NapCat 首次初始化时可能会在容器启动后被
单独重启一次以加载该绑定。

然后在同一可信局域网的机器上打开：

```text
http://<宿主机局域网IPv4>:6099/webui/
```

如果宿主机启用了 UFW，只允许局域网访问这个控制面端口；在确认没有同等
规则后由宿主机管理员手动执行：

```bash
sudo ufw allow in from 192.0.2.0/24 to 192.0.2.10 port 6099 proto tcp comment 'NapCat WebUI LAN'
sudo ufw reload
sudo ufw status numbered
```

上面的地址应替换为实际宿主机 LAN IPv4；不要把来源改成 `anywhere`，也不要
为 `16700` 添加 LAN 放行规则。Windows 客户端可用
`Test-NetConnection <宿主机局域网IPv4> -Port 6099` 验证 TCP 握手，再打开
上面的 WebUI 地址。

在 NapCat WebUI 中完成普通 QQ 账号的登录。密码、短信验证、设备验证和
二维码只由用户手工完成，适配器和启动脚本不读取这些凭据。

`6099` 是账号控制面，必须保留非默认 WebUI 密码/token，不要使用路由器
端口转发或把它绑定到公网；页面能打开只证明 LAN WebUI 可达，不等于 QQ
账号已登录或客户端已经完成设备验证。

登录成功后进入 NapCat 的网络/插件网络配置，添加 OneBot 11 WebSocket
客户端，选择反向 WebSocket，填写：

```text
URL:   ws://127.0.0.1:16700/onebot/v11/ws
Token: 与 ONEBOT_ACCESS_TOKEN 相同的本机 token
```

NapCat 在其他容器但仍使用本机 host network 时也使用上面的 URL；若使用
普通 bridge 网络，应改为可解析的 Compose 服务地址：

```text
ws://onebot-adapter:16700/onebot/v11/ws
```

OneBot 反向 WS 由 NapCat 主动连入；NapCat 断开时适配器保留可重连的服务
监听，不会把异常传播成进程崩溃。请在 NapCat 的客户端配置中设置合理的
重连间隔。官方 OneBot reverse WebSocket 规范规定了连接 URL、协议头和
Bearer token 边界，NapCat 官方集成文档也使用 WebSocket 客户端模式。

### 3. 设置为 systemd 常驻服务

项目提供了一个不携带任何凭据的 user-level systemd unit。它使用当前
`.env` 和 `start-onebot.sh`，只管理 `onebot-adapter` 与 `napcat` 两个
Compose 服务；现有容器使用 `--no-recreate` 启动，避免每次开机都重建 QQ
会话。当前主机已启用 user lingering，因此该 unit 可以在没有图形登录时由
systemd user manager 启动；如果迁移到其他主机，需要先确认：

```bash
loginctl show-user "$(id -un)" -p Linger
```

安装并立即启用：

```bash
cd /home/mentat/services/qq-shit-bot/deploy/openclaw
mkdir -p ~/.config/systemd/user
install -m 0644 qq-shit-bot-napcat.service \
  ~/.config/systemd/user/qq-shit-bot-napcat.service
systemctl --user daemon-reload
systemctl --user enable --now qq-shit-bot-napcat.service
systemctl --user status qq-shit-bot-napcat.service --no-pager
```

日常管理：

```bash
systemctl --user restart qq-shit-bot-napcat.service  # 登录失效或需要重连时
systemctl --user stop qq-shit-bot-napcat.service     # 停止 NapCat/OneBot
systemctl --user start qq-shit-bot-napcat.service    # 再次启动
journalctl --user -u qq-shit-bot-napcat.service -f  # 查看启动日志
```

该 unit 显示为 `active (exited)` 是正常的：systemd 负责 Compose 生命周期，
容器自身的 `restart: unless-stopped` 负责运行期间常驻。`restart` 会短暂断开
NapCat 与 OneBot，并保留现有 `runtime/napcat/qq` 登录缓存；是否需要重新扫码
由 QQ/NapCat 的实际登录状态决定。`stop` 只停止目标容器，不删除 volume 或
运行时目录。

### 4. 做最小功能验收

先看不含密钥和消息正文的本机状态：

```bash
curl -fsS http://127.0.0.1:16700/health
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.codex.yml \
  -f docker-compose.onebot.yml -f docker-compose.onebot.codex.yml \
  ps onebot-adapter openclaw-gateway qqbot-game
```

配置检查只使用上面的 `config --quiet` 或 `ps` 结果。不要运行或分享完整的
`docker compose config` 展开结果：Compose 会把 `.env` 中的 token 和 QQ
凭据展开到输出中。

然后由白名单 QQ 在白名单群发送以下最小序列：

1. `/menu`：应返回文本菜单；OneBot 路径不依赖官方 QQ 的键盘卡片。
2. `数字炸弹` 或 `开始海龟汤`：应进入当前游戏 sidecar。
3. 发送一个游戏答案、`提示`、`查看进度`、`答案/解析`、`下一题`或`放弃`：应使用同一群房间继续控制。
4. `@机器人 你好`：应进入现有 OpenClaw/Codex LLM 路径。
5. 发送图片并 `@机器人`，再测试回复引用图片：模型请求中最多带一张优先图片；图片像素由适配器在边界内取回，不把无限制 URL 工具交给 Bot。
6. 发送 `读：测试文字`：如果 loopback GPU gate 与 TTS 已配置，应返回 OneBot 语音；TTS 不可用时回退为文字。
7. 发送普通 QQ 语音：如果 ASR URL 已配置，先转写再走 LLM；语音回复优先尝试 TTS，失败回退文字。

最后关闭/重连 NapCat 的 OneBot 客户端，再确认适配器仍然在线并能处理一
条新消息。容器状态、`/health` 和本地 Gateway HTTP 200 都只是
`server-side only`/传输证据；只有 QQ 客户端实际看见菜单、模型回复、图片
或语音，才算 `client-confirmed`。

## 当前功能如何映射

| 普通 QQ 输入 | 适配器处理 | 复用的现有实现 |
| --- | --- | --- |
| 私聊、群消息 | 白名单、@/回复门控、稳定会话键 | OpenClaw runtime persona、安全规则、上下文策略 |
| `/menu`、小游戏名称和控制词 | 文本菜单、游戏命令解析、OneBot `send_*_msg` | 当前 interactive patch 的完整游戏目录和渲染语义 |
| 海龟汤、成语、行测及结构化小游戏 | 发送相同的抽象 session/player payload | 当前 `qqbot-game` API、题库、积分和排行榜 |
| 普通文字/@提问 | OpenAI-compatible Chat Completions | OpenClaw -> `codex-proxy/gpt-5.6-luna` |
| 图片、引用图片 | `get_msg`/`get_image`、限大小下载为 data URL | 同一 Codex 图片模型和单图媒体策略 |
| 引用文字、@机器人 | 统一 `quote`、`mentions` 字段 | 现有“明确引用优先、回复机器人正常响应”规则 |
| 文件、JSON/XML/分享卡片 | 文件名和受限卡片标题/说明摘要 | 现有“非图片附件只作描述，不把占位或 URL 当正文”的边界 |
| OneBot 合并转发 | `get_forward_msg`，仅展开实际返回的节点 | 现有“不编造仅标题/预览”的转发边界 |
| `读：`、语音入站 | loopback TTS/ASR gate，失败文字回退 | 当前 Qwen TTS/ASR 与语调设置 |

OneBot 适配器与官方 Tencent Adapter 的目标是行为并行，不是让两个传输层
共享相同的私有 SDK 对象。官方 QQ 的键盘交互在普通 QQ 路径改为可复制的
文本命令；所有当前游戏、LLM、图片、引用、@、语音和媒体安全边界仍留在
适配器与现有业务服务的明确接口内。

文件段只传递有限的文件名/类型描述，不自动读取、上传或执行文件；JSON/XML/分享
段只提取有限的标题/说明字段。卡片里的 URL、应用包名和未提供的正文不会被当成
已验证内容，也不会作为任意 URL 工具交给 Bot。

这里的“图片”包含入站图片理解和适配器明确拿到的出站 `MEDIA:`、
`mediaUrl` 或结构化媒体结果。OpenClaw 标准 `/v1/chat/completions` 返回体
通常只暴露文字；如果内部 `image_generate` 结果没有以这些媒体字段返回，
适配器不会把一条文字响应误报成已经生成并投递了图片。出站生图必须在账号
接入后用真实 QQ 客户端验收。

## 相关 Compose 文件

- `docker-compose.onebot.yml`：bridge 网络下的独立 OneBot 适配器。
- `docker-compose.onebot.codex.yml`：Linux host-network overlay，固定本机
  Gateway/游戏地址并保持 loopback。
- `docker-compose.napcat.yml`：可选 `napcat` profile、独立 QQ 配置目录和
  `NAPCAT_WEBUI_BIND_ADDRESS` 端口绑定。
- `docker-compose.napcat.codex.yml`：Linux 下让 NapCat 与适配器共享本机
  host network；启动器按 `NAPCAT_WEBUI_BIND_ADDRESS` 更新 WebUI 监听，
  不包含账号凭据。
- `configure-napcat-webui.sh`：只修改持久化 `webui.json` 的 `host` 字段，
  拒绝 wildcard/IPv6/非地址值，不输出 token 或 QQ 数据。
- `start-onebot.sh`：先启动现有 Codex 栈，再启动适配器；加
  `--with-napcat` 才会启动 NapCat 容器，systemd 使用额外的
  `--no-recreate` 幂等模式。
- `qq-shit-bot-napcat.service`：user-level systemd 常驻入口，不包含任何
  Token 或 QQ 登录凭据。

## 外部状态与证据边界

本次代码和配置迁移不执行 QQ 登录，也没有可用于生产连接验收的 QQ 账号
凭据。因此在账号接入前，OneBot 连接、`/menu`、真实 LLM 投递、图片像素
到达、游戏回复、重连和 QQ 客户端可见结果均是 `unverified`。本地 Node/Python
测试、Compose config、OpenClaw config validate 和 security audit 只能证明
源码/配置边界，不能替代普通 QQ 客户端确认。
