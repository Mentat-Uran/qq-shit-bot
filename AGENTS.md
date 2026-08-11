# qq-shit-bot 项目开发约定

本文件只适用于 Codex 的仓库开发窗口，不属于 QQ 机器人运行时人格。Bot 运行时使用独立的 `deploy/openclaw/bot-workspace/AGENTS.md` 与根目录 `SOUL.md`；启动脚本会把它们复制到 OpenClaw runtime workspace，不要把本文件复制给 Bot。

## 项目现状

- 本仓库运行形态是 OpenClaw `2026.7.1`、官方 `@openclaw/qqbot` 插件和 Docker Compose；部署入口位于 `deploy/openclaw/`。
- Windows 使用默认 Compose 与本地 Qwen2.5-VL 7B 图像路径；macOS 使用 `docker-compose.mac.yml`，SenseNova 负责视觉，官方 DeepSeek V4 Flash 负责文字，默认思考级别为 `medium`。
- Mage-VL 视频桥和 NVIDIA LocateAnything-3B 图像融合路径已移除；不要重新接入已经退休的模型、镜像或 Compose 文件。
- Windows 正式入口是 `scripts/windows/Start-OpenClawQQBot.bat`；macOS 正式入口是 `scripts/mac/start.sh`、`stop.sh`、`status.sh`、`logs.sh` 和 `check-env.sh`。
- 当前上下文优化以短运行时规则、群历史上限 1、单次 @ 独立处理、steer 队列小上限、工具结果裁剪和 compaction 为核心；不要通过扩大历史或系统提示词解决上下文问题。
- 项目不启用软件强制合盖运行；不要新增 Lidless、`pmset disablesleep` 或其他绕过 macOS 睡眠策略的常驻控制。
- 本机 health、Compose 状态、模型探针和 CI 只证明各自范围内的证据；不能把它们写成真实 QQ 收发、第三方额度、生产可用性或局域网可达性的证明。

## 开发与交付边界

- 本地验证优先于云端检查：至少运行相关 `pytest`、Node 测试、Compose 配置校验、Windows/Unix 启动器静态检查和 `python3 scripts/security_audit.py --json`；缺少 Docker、模型或凭据时记录为未执行，不伪造运行证据。
- GitHub PR 只提交可审查的源码、文档和测试；运行时目录、日志、缓存、模型权重和 `.env` 不得进入提交。提交前检查 `git status --short`、差异、`git diff --check` 和敏感信息扫描。
- PR 检查通过只证明源码和 CI 路径通过，不证明外部 QQ 真实收发、Mac 局域网访问、第三方模型额度或生产运行状态；报告结果时必须区分本地、CI、在线服务和真实 QQ 交互证据。
- 凭据只允许来自被忽略的 `deploy/openclaw/.env`；不得提交、打印、复制或在面板/API 中返回 `.env`、API key、QQ Secret、会话正文、完整群号或私聊内容。
- 运行时规则与开发规则必须分离：修改 Bot 人格、群聊策略、敏感话题处理或图片引用策略时改 `deploy/openclaw/bot-workspace/AGENTS.md`、`SOUL.md` 或对应运行时配置，不要把它们塞回本文件；修改开发流程时只改本文件。

## 开发工作流

- 开始前检查当前 `main`、工作树、相关文档、测试和已有改动，保留无关变更；先确认运行时文件、Compose 文件和实际启动入口的复制关系。
- 普通可修复决策直接处理；只有真实阻塞、权限不足或重大产品歧义才暂停。用户明确授权持续开发和 PR 时，完成完整需求范围。
- 远程操作前先在本地运行相关测试、构建、静态检查、配置检查和安全检查；记录准确结果，并区分本地、CI、线上服务和真实 QQ 投递证据。
- 使用短生命周期 `codex/*` 分支，只提交有意变更；推送后创建 PR，检查最终 diff、CI 和评论，完成自审，必需检查通过且无未解决问题后再合并。
- 分支清理前先用 `git merge-base --is-ancestor <branch> main` 检查 ancestry，并确认远端分支已消失；不要因 squash merge 导致的非祖先关系直接误删未合并实验分支。
- 合并后同步本地 `main`、清理已合并或陈旧分支并确认工作树干净；不得提交密钥、运行时状态、日志、缓存或无关文件。

## 变更检查清单

- 修改模型路由时同时检查 `openclaw.json`、`openclaw.mac.json`、`.env.example`、启动器、探针和相关测试，明确区分视觉 provider 与文字 provider。
- 修改群上下文时检查 `historyLimit`、`contextVisibility`、`messages.queue`、`messages.inbound`、会话重置、compaction、媒体上限和主动巡检任务，避免一处收紧、另一处重新注入旧历史。
- 修改运行时规则或复制入口时检查 Unix、PowerShell、BAT、macOS 四条路径，以及 `deploy/openclaw/bot-workspace/AGENTS.md` 与 `SOUL.md` 的来源关系。
- 修改 QQ bundle patch 时必须验证官方插件 fixture 的首次应用、重复应用、升级旧 helper 和 `node --check`；图片禁用时不得让引用图片绕过能力门控。
- 修改删除、停止、迁移或清理逻辑时先确认精确目标和持久化边界；优先可恢复操作，不扩大到无关容器、volume、日志或用户文件。

具体开发路线见 `DEVELOPMENT.md`；该文件同样只属于仓库开发窗口，不属于 Bot 运行时上下文。
