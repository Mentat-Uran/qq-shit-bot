# QQ Bot 工作区布局

根目录保留 Hermes 的标准入口、核心 Python 包和通用工程配置；QQ Bot 专用入口和说明按用途归档：

- `agent/`、`hermes_cli/`、`gateway/`、`providers/`：运行时代码与模型/凭据路由。
- `deploy/openclaw/`：QQ Docker 部署、启动脚本、OpenClaw 配置和媒体桥接服务。
- `assets/`：静态资源；`assets/test-media/` 只放本机手工测试媒体，不提交 Git。
- `docs/`：设计、运维、故障复盘和 QQ 行为说明。
- `docs/notes/`：不参与运行的项目说明和历史笔记。
- `tests/`：自动化测试；可提交的固定样本放 `tests/fixtures/`。
- `scripts/windows/`：Windows 启动入口和辅助脚本；QQ Bot 入口是 `Start-OpenClawQQBot.bat`。
- `.venv/`、`.pytest_cache/`、`.pytest-cache/`、`.ruff_cache/`、`__pycache__/`：本机生成物，不是源码；需要清理时直接删除并重新生成。

不要把 Key、Docker runtime、模型缓存或大体积临时媒体放回根目录；根目录的 `README.md`、`AGENTS.md`、`SOUL.md`、`pyproject.toml`、`package.json` 和 Hermes 标准入口属于项目约定入口，不能随意移动。
