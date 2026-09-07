# 开发路线验收记录

本文件记录可复现的本地验收结果；它不把静态检查、CI 或本机容器状态描述成真实 QQ 投递证据。

| 路线项 | 实现 | 本地结果 | 证据边界 |
| --- | --- | --- | --- |
| 环境变量校验/迁移与诊断 | `environment-contract.txt`、Unix/Windows 校验器、`openclaw_diagnostic.py` | `.env.example` 脱敏校验、Unix `sh -n` 与诊断通过；Windows PowerShell 检查由 CI 执行，本机未安装 `pwsh` | 不输出密钥；真实账号仍需本地配置 |
| CI 重构 | `.github/workflows/openclaw-validation.yml` | Compose `config --quiet` 通过；CI 已拆为 deployment/Compose/JavaScript/PowerShell/shell/hygiene 六个职责 job，部署 job 覆盖 `tests/deploy/`、`tests/games/` 与 `tests/ops_console/` | GitHub runner 检查不等于线上服务 |
| 媒体与上下文行为 | Node 行为模块与测试 | `node --check` 全部通过；`node --test tests/node/*.test.mjs`：22 passed | 离线行为测试不等于 QQ 事件已投递 |
| 群聊小游戏、行测与信息差 | `chat_games.py`、`structured_games.py`、本地题库、QQ 交互 patch、海龟汤 adapter | 定向 Python 游戏/题库测试：12 passed；部署静态测试：14 passed；Node 全量交互测试：28 passed；本地题库审计：4200 条结构化题目（行测 4148 条，13 个规则/题库入口共 52 条），所有 16 个结构化游戏均可启动一局 | 静态/规则测试不等于镜像已部署；loopback API 不等于真实 QQ 收发；进行中的游戏仍是内存态 |
| 运行态健康报告 | `openclaw_diagnostic.py --mode health` | 报告生成通过；本机容器状态、Gateway HTTP、Codex 反代配置、日志和可选辅助资源按各自证据范围报告 | 反代配置/请求证据和容器状态不等于模型回答质量 |
| 依赖/许可证/安全治理 | `security_audit.py`、依赖许可证审计、运行维护说明 | `python scripts/security_audit.py --json`：passed，0 findings；镜像、QQ 插件、成语库源码提交和测试依赖均有版本约束 | 版本约束不替代上游法律审查 |
| 重型视觉代码处置与文档同步 | README/部署文档 | 旧 Compose/源码已删除，活动 Compose 无 video/image-fusion 引用；部署、维护、安全和 Windows 文档已同步 | 历史材料不属于当前部署 |

历史基线：`python -m pytest -q` 曾为 `33 passed, 1 skipped`（Windows 主机无 Unix shell 的迁移测试按平台跳过）。本轮最终本地复验使用 `tests/requirements-deploy.txt` 临时虚拟环境，部署/游戏/控制台 Python 测试为 `71 passed`；Node 行为测试为 `22 passed`；两套 Compose 形状检查、部署 JavaScript `node --check`、Unix `sh -n`、占位符环境诊断和 `python scripts/security_audit.py --json` 均通过，安全审计为 0 findings。正式 Codex overlay 未在本地启动或重建；本地运行态健康报告和 Codex 探针只提供分层状态，不等于真实 QQ 投递。

真实 QQ 投递：未在本地自动化中验证，需外部授权账号/群的单独验收。
