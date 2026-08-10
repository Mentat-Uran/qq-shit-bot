# 维护说明

每次修改模型、插件、环境变量、媒体策略或 OpenClaw 版本时，先更新 `environment-contract.txt`、`.env.example`、Compose/配置和本文档，再执行本地验证。

推荐顺序：

1. `deploy/openclaw/validate-env.sh --diagnose --allow-placeholders` 或 Windows 环境校验器。
2. `docker compose -f deploy/openclaw/docker-compose.yml -f deploy/openclaw/docker-compose.local.yml config --quiet`。
3. `node --test tests/node/*.test.mjs`、PowerShell 解析/行为检查、`python -m pytest tests/deploy -q`。
4. `python scripts/openclaw_diagnostic.py --mode preflight --pretty`、`--mode health --pretty` 和 `python scripts/security_audit.py`。

媒体策略的验收必须区分“当前消息实际附件”和历史占位符；视频继续要求当前事件有效 @ 机器人，普通图片/表情只做简短反应。context-recovery 的 reset 只能作用于格式正确的群 session key，并受 TTL、并发和冷却保护。

不要把 `deploy/openclaw/runtime/`、`.env`、Docker 日志、模型缓存或真实 QQ 投递截图加入提交。任何真实 QQ 投递结论都要在变更说明中单独标为外部验证。
