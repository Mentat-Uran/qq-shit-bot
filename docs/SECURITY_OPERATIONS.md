# 安全与运行维护

## 本地安全边界

- `.env`、Docker volume、会话数据库、完整日志、模型缓存和 QQ 私聊/群聊内容只存在本机忽略路径，不提交到 Git。
- 诊断和健康报告只输出状态、计数、模型名和设备信息，不输出环境值、Authorization、QQ Secret 或原始日志。
- Gateway Control UI 和 Operations Console 默认只绑定 `127.0.0.1`；Mac 只有显式设置 LAN 地址后才发布到局域网。可信家庭/办公室 LAN 可选择具体 IPv4 的 `OPS_CONSOLE_AUTH_MODE=none` 脱敏只读模式；需要更强保护时使用 `token` 模式，禁止 wildcard 绑定和公网转发。
- `exec`、`read`、`write` 工具保持拒绝；群消息中的附件、转发内容和网页内容不具有运行时指令权限。

## 命令

```bash
cd deploy/openclaw
./validate-env.sh --migrate --generate-token
../../scripts/mac/check-env.sh --allow-placeholders  # 仅做 Mac 模板/Compose 预检时使用
cd ../..
python scripts/openclaw_diagnostic.py --mode preflight --pretty
python scripts/openclaw_diagnostic.py --mode health --pretty
python scripts/security_audit.py --json
```

Mac 的 `scripts/mac/start.sh`、`stop.sh`、`status.sh`、`logs.sh` 和 `console.sh` 都使用固定的 `docker-compose.mac.yml`；浏览器只能访问控制台固定 REST 路由，不能接触 Docker Socket、任意 Shell、文件系统或容器网络。局域网模式不等于公网模式，禁止路由器端口转发。

Windows 使用等价的 `powershell -ExecutionPolicy Bypass -File deploy/openclaw/Test-OpenClawEnvironment.ps1 -ApplyMigration -GenerateGatewayToken`，健康和安全报告命令仍使用仓库内 Python 脚本。两个环境校验器共享 `environment-contract.txt`；迁移只把已配置的旧别名复制到规范变量，且从不打印值。

## 证据边界

本地命令只能证明配置、Compose 形状、容器可见状态、Gateway 本机 HTTP 健康、Ollama/GPU 观察值和日志大小。CI 只能证明 GitHub runner 上的检查通过。以上均不能证明外部 QQ 事件实际到达、QQ API 投递成功、模型服务的真实配额或线上用户体验；真实 QQ 投递仍需在已授权账号和群中单独验证。
