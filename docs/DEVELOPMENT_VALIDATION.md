# 开发路线验收记录

本文件记录可复现的本地验收结果；它不把静态检查、CI 或本机容器状态描述成真实 QQ 投递证据。

| 路线项 | 实现 | 本地结果 | 证据边界 |
| --- | --- | --- | --- |
| 环境变量校验/迁移与诊断 | `environment-contract.txt`、Unix/Windows 校验器、`openclaw_diagnostic.py` | `.env.example` 脱敏校验：通过；PowerShell 9 项通过；Unix `sh -n` 与诊断通过；本机真实 `.env` preflight 因必要 QQ/模型凭据未配置返回 1 | 不输出密钥；真实账号仍需本地配置 |
| CI 重构 | `.github/workflows/openclaw-validation.yml` | Compose `config --quiet` 通过；CI 已拆为 deployment/Compose/JavaScript/PowerShell/shell/hygiene 六个职责 job，部署 job 覆盖 `tests/deploy/` 与 `tests/ops_console/` | GitHub runner 检查不等于线上服务 |
| 媒体与上下文行为 | Node 行为模块与测试 | `node --check` 全部通过；`node --test tests/node/*.test.mjs`：8 passed | 离线行为测试不等于 QQ 事件已投递 |
| 运行态健康报告 | `openclaw_diagnostic.py --mode health` | 报告生成通过；本机当前 Gateway/context-recovery/Qwen 容器未运行，Gateway HTTP/GPU/日志/模型设备按边界报告 unknown/not_found | GPU/容器状态不等于模型回答质量 |
| 依赖/许可证/安全治理 | `security_audit.py`、依赖许可证审计、运行维护说明 | `python scripts/security_audit.py --json`：passed，0 findings；镜像、QQ 插件和测试依赖均有版本约束 | 版本约束不替代上游法律审查 |
| 重型视觉代码处置与文档同步 | README/部署文档 | 旧 Compose/源码已删除，活动 Compose 无 video/image-fusion 引用；部署、维护、安全和 Windows 文档已同步 | 历史材料不属于当前部署 |

补充本地结果：`python -m pytest -q` 为 `33 passed, 1 skipped`（Windows 主机无 Unix shell 的迁移测试按平台跳过）；`python scripts/security_audit.py --json` 为 0 findings；`git diff --check` 通过；Docker Compose 形状通过，但未启动或拉取运行镜像。

真实 QQ 投递：未在本地自动化中验证，需外部授权账号/群的单独验收。
