# qq-shit-bot + Docker

This deployment runs OpenClaw and the official `@openclaw/qqbot` plugin entirely in Docker. It does not install OpenClaw, Node.js packages, or the QQ plugin on the host.

This is the only supported deployment for the QQ bot. OpenClaw and all QQ bot services run in Docker; the host only needs Docker Desktop or Docker Engine.

The Compose project name is `qq-shit-bot`, matching the GitHub remote repository. Service containers therefore use names such as `qq-shit-bot-openclaw-gateway-1`; persistent volumes use the `qqshitbot-openclaw_*` prefix.

## What it configures

- OpenClaw `2026.7.1` and `@openclaw/qqbot` `2026.7.1`, pinned together.
- SenseNova `deepseek-v4-flash` as the primary paid text-model route, with the official DeepSeek `deepseek-chat` API as the configured fallback when SenseNova fails. The DeepSeek key is read from the ignored `.env` file and is not stored in the repository.
- The repository's `AGENTS.md` and `SOUL.md` as the OpenClaw workspace context.
- Token-authenticated Control UI published only on `127.0.0.1`.
- OpenClaw's operator terminal disabled.
- `exec`, `read`, and `write` agent tools denied globally and in QQ groups.
- Only the official QQ plugin and the local QQ diagnostic filter are allowlisted by default.
- The unrelated bundled Codex extension is explicitly disabled because it is not needed by the QQ bot and is incompatible with this pinned gateway runtime.
- Web search uses OpenClaw's bundled no-key DuckDuckGo provider; no search credential is copied or exposed.
- A local `reply_payload_sending` hook suppresses error and model-fallback payloads in QQ groups; the full diagnostic remains in the gateway log for local troubleshooting.
- QQ direct and group access restricted to configured owner identifiers by default.
- Startup model discovery disabled because all providers are declared explicitly; model loading still occurs on the first request.
- Qwen2.5-VL 7B is the only enabled image-understanding path. The NVIDIA LocateAnything-3B image-fusion fallback and the Microsoft Mage-VL video bridge are archived under `docs/retired-visual/`; they are no longer in the deployment path, built, or started, and their model routes are absent from `openclaw.json`. No video analysis is performed by the gateway.
- The Qwen2.5-VL Ollama service, OpenClaw gateway, and context-recovery sidecar are the active services in the Compose project. Qwen has no host port and is reached at `qwen-vision:11434` on the private Compose network.
- QQ image messages can use a two-message workflow for mobile clients: send the image first, then send a message that @mentions the bot. A media message that already includes the bot mention is passed directly; ordinary non-media chatter remains mention-gated.
- Group sessions have a 120-minute idle reset, and the `context-recovery` sidecar watches the gateway log for an unrecoverable context overflow or stalled agent run and resets the affected QQ group session automatically. Existing log contents are not replayed when the sidecar starts, so an old failure cannot reset a newly started session.

`Watch-OpenClawModel.ps1` probes SenseNova every five minutes with a one-token request. A 429 is logged locally and written as redacted route state; failed model requests can then use the configured official DeepSeek fallback. The watcher is started with the gateway by `Start-OpenClawDocker.ps1`.

QQ group delivery is guarded separately from model failover. Successful fallback replies are delivered normally, while `isError` and `isFallbackNotice` reply payloads are cancelled before the QQ adapter sees them. This prevents provider, quota, rate-limit, busy, and internal stack details from appearing in the group without hiding the corresponding gateway logs.

The Windows launcher reads the official DeepSeek key from the ignored `.env` file. It never writes the key to the repository.

## Start

```bash
cd deploy/openclaw
cp .env.example .env
```

Edit `.env` and replace every `replace-with-*` value. QQ direct messages use a user OpenID, while group messages use a member OpenID; do not assume they are identical.

Then run:

```bash
./setup.sh
```

The setup script and the Windows launcher share `environment-contract.txt`. They migrate supported legacy aliases, validate `QQBOT_HOME_CHANNEL` and `DEEPSEEK_API_KEY`, and never print secret values. For a no-Docker preflight use `./validate-env.sh --diagnose --allow-placeholders`.

The script creates `runtime/`, copies the repository persona files, installs the official QQ plugin inside a one-shot OpenClaw container, validates the config, ensures the in-project `qwen-vision` service has `qwen2.5vl:7b`, and starts the gateway plus the context-recovery sidecar. It accepts either the Docker Compose plugin (`docker compose`) or the standalone `docker-compose` command. Secrets and runtime state remain under ignored local paths.

Open the Control UI at `http://127.0.0.1:18789` and authenticate with `OPENCLAW_GATEWAY_TOKEN` from `.env`.

## Docker Compose commands

```bash
# Logs
docker compose logs -f openclaw-gateway

# OpenClaw status and configuration checks
docker compose run --rm openclaw-cli status
docker compose run --rm openclaw-cli config validate
docker compose run --rm openclaw-cli plugins inspect qqbot
docker compose exec qwen-vision ollama list

# Stop
docker compose down

# Pull the pinned image and restart
docker compose pull
docker compose up -d openclaw-gateway context-recovery
```

On Windows, use Docker Desktop with WSL or Git Bash to run `setup.sh`. The Compose file itself is platform-neutral; the equivalent manual sequence is to create `runtime/config` and `runtime/workspace`, copy `openclaw.json`, `AGENTS.md`, and `SOUL.md` into them, install the plugin with the `openclaw-cli` service, validate the config, start `qwen-vision`, ensure `qwen2.5vl:7b` is present, and start `openclaw-gateway context-recovery`.

For the local Windows deployment, double-click `scripts/windows/Start-OpenClawQQBot.bat` from the repository or use the desktop shortcut copy. It calls `deploy/openclaw/Start-OpenClawDocker.ps1`, which starts the gateway, recovery sidecar, and lightweight Qwen image service only; the model route watcher and proactive review jobs are also registered. The repository BAT resolves the project root relative to its own location, so it remains portable after the workspace is moved.

## Container and GPU management

The normal QQ runtime is split into these services:

- `openclaw-gateway`: QQ WebSocket, session/context handling, model routing, and final Chinese text replies. It does not load the heavy vision models.
- `context-recovery`: watches gateway logs and resets a stuck or overflowed QQ group session. It is CPU-only and small.
- `qwen-vision`: private Ollama `Qwen2.5-VL 7B` service for image understanding and OCR. It is GPU-enabled and loads its model on demand.
- `docs/retired-visual/`: archived image/video artifacts only; they are not part of the Compose files used by the supported deployment and are never built or started.
- `qq-diagnostic-filter-init`: one-shot initialization service that seeds the local QQ diagnostics and recovery scripts; it is not a persistent worker and does not use GPU.
- `openclaw-cli`: an optional `cli` profile for administrative commands; it normally remains stopped and does not use GPU.

Use `nvidia-smi` and `ollama ps` to see whether Qwen is currently loaded on CUDA. Docker's `MEM USAGE` column is system RAM, not VRAM.

To stop even the lightweight image service and keep only the QQ bot and recovery sidecar running:

```powershell
.\Stop-OpenClawVision.ps1
```

Stopping the services also writes a `none` media-capability profile into the runtime config. The media routes are removed for that runtime, and old group images/videos are never promoted into a new @mention.

The vision helper only starts the active Qwen image service:

```powershell
.\Start-OpenClawVision.ps1   # lightweight Qwen image path
```

The helper updates the runtime capability profile and recreates only the gateway/recovery containers so the model policy stays aligned. No video or heavy image-fusion capability is exposed by the current runtime.

The normal launcher starts the gateway and lightweight Qwen image service:

```powershell
.\Start-OpenClawDocker.ps1
```

The gateway and recovery sidecar should remain running for QQ replies. Only the Qwen image service is started by the supported launchers.

## Group participation

The configured mode keeps `requireMention: true` so ordinary messages are collected as pending group context without triggering one model call per message. Mentions, replies, direct messages, and the periodic proactive review can trigger a model turn. The group history window is 32 messages; each new @ message is treated as a fresh topic unless it explicitly quotes or continues the prior one. A prior image is never attached just because it was the latest image in the group.

The proactive review is intentionally periodic rather than per-message: it reads the full pending context and returns `NO_REPLY` only when there is nothing useful to add. Direct mentions and replies must receive a normal answer unless a workspace safety rule blocks the request. The schedule is every 10 minutes from 08:00 through 01:50, and every 30 minutes from 02:00 through 07:30, using `Asia/Shanghai` time. Group sessions are reset after 120 minutes without activity. If a model run reaches an unrecoverable context overflow or stalls in processing, `context-recovery` calls `sessions.reset` for that group session and keeps the technical diagnostic out of QQ. To make every ordinary message an immediate model turn, edit `runtime/config/openclaw.json` and set:

```json
"requireMention": false
```

On Windows, rerun the launcher after changing `.env` configuration:

```bash
powershell -ExecutionPolicy Bypass -File .\Start-OpenClawDocker.ps1 -NoWatcher
```

To allow more QQ users, add direct-message user OpenIDs to `allowFrom` and group member OpenIDs to `groupAllowFrom`. To restrict the bot to specific groups, replace the `"*"` entry under `channels.qqbot.groups` with the allowed group OpenIDs. Keep allowlists enabled on bots that are present in public groups.

## Windows local deployment

Start the complete local stack with:

```powershell
.\Start-OpenClawDocker.ps1
```

The launcher reads QQ and model credentials from the ignored `.env` file, uses `runtime/workspace` for the OpenClaw workspace, starts Qwen plus the OpenClaw gateway and context-recovery sidecar, installs/validates the QQ plugin, and starts the quota watcher. It does not write credentials to the repository.

Windows bind mounts appear world-writable inside Docker Desktop. The launcher therefore runs `qq-diagnostic-filter-init` first; it copies the local hook into a named volume with mode `0644`, so OpenClaw's plugin trust check can load it without weakening the security policy.

The Qwen service uses the RTX GPU and downloads public weights into a named Docker volume on first use. Qwen is private to the Compose network and is configured for one loaded model, one parallel request, and a bounded three-minute keep-alive so consecutive image replies do not reload the model. The archived image/video code has no active endpoint, build target, or route; re-enabling it requires a new dependency and license review documented in [`docs/DEPENDENCY_LICENSE_AUDIT.md`](../docs/DEPENDENCY_LICENSE_AUDIT.md).

## Verification boundary

The repository tests validate Compose shape, configuration, launcher wiring, environment migration, media/context behavior, and security boundaries. They do not prove that the current Docker Desktop has a working NVIDIA runtime, that a particular model fits the available VRAM, or that an actual QQ attachment event reaches the gateway. Use `python ../../scripts/openclaw_diagnostic.py --mode preflight --pretty` and `--mode health --pretty` for redacted local reports; GPU and model-device fields remain unknown when Docker is stopped. Real QQ delivery still requires external verification.

## Updating the persona

`setup.sh` copies `AGENTS.md` and `SOUL.md` only when the runtime workspace does not already contain them, so local edits are preserved. Copy the repository versions again manually when you want to adopt later persona changes.
