# Hermes QQ Bot

这是一个基于 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的 QQ Bot 开源版本，包含当前 QQ 群聊适配、上下文管理、主动参与、引用消息与图片处理，以及商汤 DeepSeek / 官方 DeepSeek 的额度故障切换方案。

本仓库保留 Hermes Agent 的完整源码，方便群友复现、提交 Issue 和继续开发。上游项目说明保存在 [`docs/UPSTREAM_README.md`](docs/UPSTREAM_README.md)。

## 功能

- QQ 私聊、群聊和明确 @ 触发。
- 群聊未 @ 时，根据近期上下文自主判断是否参与。
- 群聊上下文按群独立维护，并带冷却、去重、打断和发送限制。
- 引用文本、图片、语音、文件和 QQ 小程序卡片摘要处理。
- QQ 小程序有标题时，要求先搜索标题，再进行解读；查不到时不编造正文。
- 商汤 `deepseek-v4-flash` 额度耗尽时自动切换到官方 DeepSeek，额度恢复后自动切回。
- Windows Gateway 启动脚本会自动启动额度切换监控，并使用互斥锁防止重复运行。

## Windows 快速开始

1. 在 PowerShell 中运行 [`scripts/install.ps1`](scripts/install.ps1) 安装 Hermes Agent 依赖并完成基础配置。
2. 复制 `.env.example` 为本地 `.env`，设置 QQ Bot 凭据和模型 API key。真实 `.env` 永远不要提交。
3. 复制 [`config.example.yaml`](config.example.yaml) 为 Hermes 的 `config.yaml`，填入自己的 QQ App ID、群白名单和模型配置。
4. 按需修改 [`AGENTS.md`](AGENTS.md) 和 [`SOUL.md`](SOUL.md)。它们是机器人运行时的行为规则，不是密钥文件。
5. 运行 [`scripts/windows/启动HermesGateway.bat`](scripts/windows/启动HermesGateway.bat)。Gateway 启动后会自动拉起额度切换监控。

如果使用 Windows 计划任务，参照 [`scripts/windows/Hermes_Gateway.cmd`](scripts/windows/Hermes_Gateway.cmd) 配置任务入口；该入口同样会自动启动监控脚本。

## OpenClaw + Docker

仓库同时提供一套独立的 OpenClaw 部署配置，使用 OpenClaw 官方 QQ 插件，并将 OpenClaw、插件及其依赖全部运行在 Docker 中，不会在宿主机安装 OpenClaw：

```bash
cd deploy/openclaw
cp .env.example .env
# 填写 .env 中的 QQ 与模型凭据
./setup.sh
```

该方案默认复用本仓库的 `AGENTS.md`、`SOUL.md`、SenseNova 主模型与 DeepSeek fallback，并关闭 OpenClaw 终端及文件/命令工具。完整配置、安全边界与 Windows 使用方式见 [`deploy/openclaw/README.md`](deploy/openclaw/README.md)。

## 模型额度切换

额度监控脚本是 [`scripts/windows/watch-sensenova-v4-recovery.ps1`](scripts/windows/watch-sensenova-v4-recovery.ps1)。它每 60 秒探测商汤接口：

- 商汤返回额度或 RPM 限制时切到官方 DeepSeek。
- 商汤恢复可用时切回商汤。
- 切换后继续监控，不会因为一次切换而退出。
- 官方 DeepSeek key 可通过 `DEEPSEEK_API_KEY` 环境变量提供，也可以使用 Hermes 本机的 DPAPI 密钥文件；密钥内容不进入仓库。

不同机器请通过 `HERMES_HOME` 和 `HERMES_WORKSPACE` 指定 Hermes 目录与运行工作区。

## QQ 主动参与配置

参见 [`docs/QQ_PROACTIVE_GROUP_CHAT.md`](docs/QQ_PROACTIVE_GROUP_CHAT.md)。默认建议使用群白名单：

```yaml
platforms:
  qqbot:
    enabled: true
    extra:
      proactive_group_chat_enabled: true
      proactive_group_allowlist:
        - "your-group-openid"
```

QQ 管理后台还需要打开接收完整群消息事件的权限。明确 @ 触发不依赖主动参与链路。

## 开发和 Issue

提交 Issue 时请尽量提供：

- Hermes 版本、Windows/Python 版本和当前模型提供商。
- 发生时间、脱敏后的日志片段和是否明确 @ 机器人。
- 可复现步骤和期望行为。

不要上传 `.env`、API key、QQ App Secret、会话数据库、聊天归档、完整群号或私聊内容。

## 许可证

本项目使用 MIT License。上游 Hermes Agent 的版权和许可证声明保留在 [`LICENSE`](LICENSE) 中。

