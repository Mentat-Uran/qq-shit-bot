# 依赖、镜像与许可证审计

本记录只覆盖仓库中可见的版本约束和发布边界，不把静态检查当成上游许可证授予，也不把本地镜像拉取当成已完成的法律审查。

| 项目 | 当前约束 | 运行边界 | 许可证证据边界 |
| --- | --- | --- | --- |
| 本仓库 | `LICENSE` 的 MIT 文本 | 仓库代码与文档 | 以仓库根目录 `LICENSE` 为准 |
| OpenClaw 镜像 | `ghcr.io/openclaw/openclaw:2026.7.1` | Docker 内 Gateway/CLI | 升级前须按上游发布物重新核对许可证和镜像摘要 |
| `@openclaw/qqbot` | `@openclaw/qqbot@2026.7.1`，安装命令使用 `--pin` | Docker 内官方 QQ 适配器 | 升级前须按 npm 包元数据重新核对许可证 |
| Ollama | `ollama/ollama:0.32.5` | 仅提供私有 Qwen 图片路径 | 升级前须按镜像和 Ollama 上游元数据重新核对许可证 |
| Qwen 模型 | `qwen2.5vl:7b` | 私有 Compose 网络、按需加载 | 模型权重许可和使用范围不由本仓库 MIT 文本覆盖，使用者需单独核对 |
| 部署测试工具 | `tests/requirements-deploy.txt` 中的 pytest/PyYAML 精确版本 | 仅 CI/本地验收，不进入运行镜像 | 各包许可证仍以其发布元数据为准，升级时重新核对 |
| 重型视频/图像融合代码 | 已移入 `docs/retired-visual/`，不再构建或启动 | 仅保留历史审计材料 | 不属于当前运行依赖；重新启用前必须单独审计模型和 Python 依赖 |

`scripts/security_audit.py` 会阻止未固定镜像、未固定 QQ 插件和已跟踪 runtime/密钥文件进入提交。它不会声称完成上游法律审查；版本升级必须重新运行本地审计并更新本表。
