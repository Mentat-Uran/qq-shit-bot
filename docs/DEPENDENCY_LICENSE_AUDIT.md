# 依赖、镜像与许可证审计

本记录只覆盖仓库中可见的版本约束和发布边界，不把静态检查当成上游许可证授予，也不把本地镜像拉取当成已完成的法律审查。

| 项目 | 当前约束 | 运行边界 | 许可证证据边界 |
| --- | --- | --- | --- |
| 本仓库 | `LICENSE` 的 MIT 文本 | 仓库代码与文档 | 以仓库根目录 `LICENSE` 为准 |
| OpenClaw 镜像 | `ghcr.io/openclaw/openclaw:2026.8.2` | Docker 内 Gateway/CLI | 升级前须按上游发布物重新核对许可证和镜像摘要 |
| `@tencent-connect/openclaw-qqbot` | `@tencent-connect/openclaw-qqbot@2.0.3`，安装命令使用 `--pin` | Docker 内官方 QQBot 2.x 适配器 | 升级前须按 npm 包元数据重新核对许可证 |
| `@openclaw/duckduckgo-plugin` | `@openclaw/duckduckgo-plugin@2026.8.2`，安装命令使用 `--pin` | Docker 内无密钥 DuckDuckGo 搜索适配器 | 升级前须按 npm 包元数据重新核对许可证 |
| Codex-compatible reverse proxy | `CODEX_PROXY_BASE_URL` 与 `CODEX_PROXY_TOKEN` 由部署者在被忽略的 `.env` 中提供 | 所有平台 Docker Bot 的统一文字/图片请求上游 | 本仓库不重新分发反代服务或其模型；使用者须按实际上游服务条款和许可证核对 |
| `China-idiom` | GitHub 提交 `78606b0294a22e798633c4469a4009b78ad60f26` 的源码归档 | `qqbot-game` 内的四字成语校验、接龙候选和释义 | 上游仓库声明 MIT；更换提交前须重新核对许可证与数据来源 |
| `nonebot-plugin-handle`（规则参考） | 参考提交 `61ba1243d15e5f7b173146b8c6f2d122c51d69a7`，不作为运行依赖 | 猜成语的重复字计分规则参考 | 上游仓库声明 MIT；本项目未复制其图片渲染和 NoneBot matcher |
| Qwen3 TTS/ASR bridge images | `docker-compose.codex.yml` 中的固定 image digest | 仅 Linux overlay 的按需语音辅助服务；不承担核心文字/图片路由 | 升级前须按镜像、模型权重和上游使用条款重新核对许可证 |
| 部署测试工具 | `tests/requirements-deploy.txt` 中的 pytest/PyYAML 精确版本 | 仅 CI/本地验收，不进入运行镜像 | 各包许可证仍以其发布元数据为准，升级时重新核对 |
| 重型视频/图像融合代码 | 已从仓库和部署环境删除 | 不属于当前运行依赖 | 如需恢复，必须重新引入并单独审计模型、许可证和 Python 依赖 |

`scripts/security_audit.py` 会阻止未固定镜像、未固定 QQ 插件和已跟踪 runtime/密钥文件进入提交。它不会声称完成上游法律审查；版本升级必须重新运行本地审计并更新本表。
