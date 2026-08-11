# QQ Bot 工作区布局

仓库根目录只保留 OpenClaw Docker 入口和 QQ Bot 专用说明：

- `deploy/openclaw/`：QQ Docker 部署、启动脚本、OpenClaw 配置和媒体桥接服务。
- `docs/`：OpenClaw 运维和 QQ 行为说明。
- `tests/deploy/`：OpenClaw Docker 配置测试。
- `scripts/windows/`：Windows 启动入口；QQ Bot 入口是 `Start-OpenClawQQBot.bat`。
- `deploy/openclaw/bot-workspace/AGENTS.md`：Bot 运行时规则源，与根目录开发规则分开；启动脚本将它复制为 runtime workspace 的 `AGENTS.md`。
- `.venv/`、`.pytest_cache/`、`.pytest-cache/`、`.ruff_cache/`、`__pycache__/`：本机生成物，不是源码；需要清理时直接删除并重新生成。

不要把 Key、Docker runtime、模型缓存或大体积临时媒体放回根目录；根目录的 `README.md`、开发用 `AGENTS.md` 和 `SOUL.md` 属于项目约定入口，Bot 运行时规则只从 `deploy/openclaw/bot-workspace/AGENTS.md` 获取。
