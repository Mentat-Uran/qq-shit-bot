# qq-shit-bot + Docker

This deployment runs OpenClaw and the official `@openclaw/qqbot` plugin entirely in Docker. It does not install OpenClaw, Node.js packages, or the QQ plugin on the host.

The deployment is independent of the repository's Hermes container. Both can exist on the same machine, but only one process should connect with a given QQ Bot credential at a time.

The Compose project name is `qq-shit-bot`, matching the GitHub remote repository. Service containers therefore use names such as `qq-shit-bot-openclaw-gateway-1`; the existing model and log volumes keep their old names so the downloaded weights and runtime logs are not copied or redownloaded during the rename.

## What it configures

- OpenClaw `2026.7.1` and `@openclaw/qqbot` `2026.7.1`, pinned together.
- SenseNova `deepseek-v4-flash` as the primary paid text-model route, with the official DeepSeek `deepseek-chat` API as the configured fallback when SenseNova fails. The DeepSeek key is loaded from the existing Hermes DPAPI secret at Windows launcher time and is not stored in the repository.
- The repository's `AGENTS.md` and `SOUL.md` as the OpenClaw workspace context.
- Token-authenticated Control UI published only on `127.0.0.1`.
- OpenClaw's operator terminal disabled.
- `exec`, `read`, and `write` agent tools denied globally and in QQ groups.
- Only the official QQ plugin and the local QQ diagnostic filter are allowlisted by default.
- The unrelated bundled Codex extension is explicitly disabled because it is not needed by the QQ bot and is incompatible with this pinned gateway runtime.
- Web search uses OpenClaw's bundled DuckDuckGo provider, matching Hermes' currently auto-detected no-key `ddgs` backend; no search credential is copied or exposed.
- A local `reply_payload_sending` hook suppresses error and model-fallback payloads in QQ groups; the full diagnostic remains in the gateway log for local troubleshooting.
- QQ direct and group access restricted to configured owner identifiers by default.
- Startup model discovery disabled because all providers are declared explicitly; model loading still occurs on the first request.
- Qwen2.5-VL 7B is the normal image-understanding path for fast replies. NVIDIA LocateAnything-3B remains an optional image-fusion fallback for cases where Qwen fails; it is not run serially for every ordinary image, which avoids loading two heavyweight vision paths unnecessarily.
- Microsoft Mage-VL is loaded directly through Transformers for video understanding. Videos longer than the configured 60-second segment window are analyzed segment by segment with timestamps, then OpenClaw's primary language model turns the intermediate result into the final QQ reply; no video leaves the machine.
- The Qwen2.5-VL Ollama service, NVIDIA image-fusion service, Microsoft video bridge, OpenClaw gateway, and context-recovery sidecar are all services in the same Compose project. Qwen has no host port; image and video services reach it at `qwen-vision:11434` on the private Compose network.
- QQ image messages can use a two-message workflow for mobile clients: send the image first, then send a message that @mentions the bot. Videos are heavier and are analyzed in a group only when the current message directly @mentions the bot or explicitly quotes/replies to that video while mentioning the bot; an old video is never promoted from history. A media message that already includes the bot mention is passed directly; ordinary non-media chatter remains mention-gated.
- Group sessions have a 120-minute idle reset, and the `context-recovery` sidecar watches the gateway log for an unrecoverable context overflow or stalled agent run and resets the affected QQ group session automatically. Existing log contents are not replayed when the sidecar starts, so an old failure cannot reset a newly started session.

`Watch-OpenClawModel.ps1` probes SenseNova every five minutes with a one-token request. A 429 is logged locally; failed model requests can then use the configured official DeepSeek fallback. The watcher is started with the gateway by `Start-OpenClawDocker.ps1`.

QQ group delivery is guarded separately from model failover. Successful fallback replies are delivered normally, while `isError` and `isFallbackNotice` reply payloads are cancelled before the QQ adapter sees them. This prevents provider, quota, rate-limit, busy, and internal stack details from appearing in the group without hiding the corresponding gateway logs.

The Windows launcher injects the official DeepSeek key into the gateway process from Hermes' local DPAPI secret when that secret is available. It never writes the key to the repository. The old standalone Hermes gateway must not run at the same time as this QQ gateway, because it can independently connect with the same QQ credentials.

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

For the local Windows deployment, double-click `scripts/windows/Start-OpenClawQQBot.bat` from the repository or use the desktop shortcut copy. It calls `deploy/openclaw/Start-OpenClawDocker.ps1`, which starts the gateway, recovery sidecar, and lightweight Qwen image service only; the model route watcher and proactive review jobs are also registered. Heavy video and LocateAnything services are opt-in. The repository BAT resolves the project root relative to its own location, so it remains portable after the workspace is moved.

## Container and GPU management

The normal QQ runtime is split into these services:

- `openclaw-gateway`: QQ WebSocket, session/context handling, model routing, and final Chinese text replies. It does not load the heavy vision models.
- `context-recovery`: watches gateway logs and resets a stuck or overflowed QQ group session. It is CPU-only and small.
- `qwen-vision`: private Ollama `Qwen2.5-VL 7B` service for image understanding and OCR. It is GPU-enabled and loads its model on demand.
- `image-fusion`: optional GPU-enabled NVIDIA LocateAnything-3B grounding plus Qwen content/OCR fusion. It is under the `heavy-media` Compose profile.
- `video-bridge`: optional GPU-enabled Microsoft Mage-VL video analysis and long-video segmentation. It is under the `heavy-media` Compose profile.
- `qq-diagnostic-filter-init`: one-shot initialization service that seeds the local QQ diagnostics and recovery scripts; it is not a persistent worker and does not use GPU.
- `openclaw-cli`: an optional `cli` profile for administrative commands; it normally remains stopped and does not use GPU.

Windows cannot reliably attribute the global `nvidia-smi` allocation to individual Docker containers. The reliable distinction is which services have `gpus: all`; use `nvidia-smi`, `ollama ps`, and the image/video `/healthz` endpoints to see whether a model is currently loaded and whether it is on CUDA. Docker's `MEM USAGE` column is system RAM, not VRAM.

To stop even the lightweight image service and keep only the QQ bot and recovery sidecar running:

```powershell
.\Stop-OpenClawVision.ps1
```

Stopping the services also writes a `none` media-capability profile into the runtime config. The media routes are removed for that runtime, and old group images/videos are never promoted into a new @mention.

When an image or video needs to be processed, start only the required capability:

```powershell
.\Start-OpenClawVision.ps1 -Mode image   # lightweight Qwen image path
.\Start-OpenClawVision.ps1 -Mode video   # Mage-VL video path
.\Start-OpenClawVision.ps1 -Mode both    # explicit heavy image + video paths
```

The helper updates the runtime capability profile and recreates only the gateway/recovery containers so the model policy and mounted media tools stay aligned. `image`, `video`, and `both` are mutually exclusive runtime profiles; the default is `image`.

Docker Desktop's Start/Stop buttons can also start or stop the individual GPU containers, but they do not change OpenClaw's capability profile. After starting containers from the UI, run `Set-OpenClawMediaCapabilities.ps1 -Mode image`, `-Mode video`, or `-Mode both` with `-RestartGateway`; after stopping them, run `Stop-OpenClawVision.ps1` (or set `-Mode none`) so the language model is not told that disabled media abilities are available.

The normal launcher starts the gateway and lightweight Qwen image service:

```powershell
.\Start-OpenClawDocker.ps1
```

The gateway and recovery sidecar should remain running for QQ replies. Use `Start-OpenClawVision.ps1 -Mode video` only while video work is needed, and stop it afterwards. `both` is intentionally explicit because it starts both heavyweight bridges. The bridges use a shared GPU lock, force model placement on CUDA, cap CPU/RAM, and use a 2 GiB shared-memory segment instead of the former 16 GiB setting.

Every video is first transcoded to a local H.264/AAC proxy at up to 960 pixels, 24 fps, and CRF 30 before Mage-VL sees it. The original upload and proxy are temporary files removed with the request workspace.

## Group participation

The configured mode keeps `requireMention: true` so ordinary messages are collected as pending group context without triggering one model call per message. Mentions, replies, direct messages, and the periodic proactive review can trigger a model turn. The group history window is 32 messages; each new @ message is treated as a fresh topic unless it explicitly quotes or continues the prior one. A prior image is never attached just because it was the latest image in the group.

The proactive review is intentionally periodic rather than per-message: it reads the full pending context and returns `NO_REPLY` only when there is nothing useful to add. Direct mentions and replies must receive a normal answer unless a workspace safety rule blocks the request. The schedule is every 10 minutes from 08:00 through 01:50, and every 30 minutes from 02:00 through 07:30, using `Asia/Shanghai` time. Group sessions are reset after 120 minutes without activity. If a model run reaches an unrecoverable context overflow or stalls in processing, `context-recovery` calls `sessions.reset` for that group session and keeps the technical diagnostic out of QQ. To make every ordinary message an immediate model turn, edit `runtime/config/openclaw.json` and set:

```json
"requireMention": false
```

On Windows, rerun the launcher after changing configuration so the Hermes QQ credentials are injected again:

```bash
powershell -ExecutionPolicy Bypass -File .\Start-OpenClawDocker.ps1 -NoWatcher
```

To allow more QQ users, add direct-message user OpenIDs to `allowFrom` and group member OpenIDs to `groupAllowFrom`. To restrict the bot to specific groups, replace the `"*"` entry under `channels.qqbot.groups` with the allowed group OpenIDs. Keep allowlists enabled on bots that are present in public groups.

## Windows local deployment

When the prior Hermes installation is under `C:\HermesWorkspace`, start the complete local stack with:

```powershell
.\Start-OpenClawDocker.ps1
```

The launcher reads QQ and the SenseNova credential from the existing Hermes local environment, mounts `C:\HermesWorkspace` as the OpenClaw workspace, starts Qwen plus the OpenClaw gateway and context-recovery sidecar, installs/validates the QQ plugin, and starts the quota watcher. During migration it reuses the existing `local-vision_hermes-vision-model-cache` volume when present, then removes the legacy `hermes-vision` container after the in-project Qwen service is ready. Use `-AllMedia` only when you deliberately want all GPU services at once. It does not write credentials to the repository. Do not run the old Hermes gateway with the same QQ credentials at the same time.

Windows bind mounts appear world-writable inside Docker Desktop. The launcher therefore runs `qq-diagnostic-filter-init` first; it copies the local hook into a named volume with mode `0644`, so OpenClaw's plugin trust check can load it without weakening the security policy.

The Qwen, video, and image services use the RTX GPU and download public weights into named Docker volumes on first use. Qwen is private to the Compose network and is configured for one loaded model, one parallel request, and a bounded three-minute keep-alive so consecutive image replies do not reload the model. The optional image-fusion and video bridge refuse `device_map=auto` CPU offload: if CUDA is unavailable or any model parameter lands on CPU, the request fails instead of consuming host RAM silently. The video API is local at `http://127.0.0.1:30000`; the image-fusion API is local at `http://127.0.0.1:30001`. The default video upload limit is 200 MiB, and the temporary proxy is limited to 100 MiB, 8 sampled frames per segment, 60 seconds per segment, and 8 segments. LocateAnything-3B is under NVIDIA's non-commercial research license; check that license before any commercial use.

## Verification boundary

The repository tests validate Compose shape, configuration, launcher wiring, and the media safety patch. They do not prove that the current Docker Desktop has a working NVIDIA runtime, that a particular model fits the available VRAM, or that an actual QQ attachment event reaches the gateway. Verify those separately with `nvidia-smi`, `docker compose ps`, `docker compose exec qwen-vision ollama ps`, and the optional image/video `/healthz` endpoints. The health responses expose `cudaAvailable`, `modelDevice`, and loaded parameter devices so a CPU fallback is visible.

## Updating the persona

`setup.sh` copies `AGENTS.md` and `SOUL.md` only when the runtime workspace does not already contain them, so local edits are preserved. Copy the repository versions again manually when you want to adopt later persona changes.
