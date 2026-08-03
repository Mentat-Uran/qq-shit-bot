# qq-shit-bot + Docker

This deployment runs OpenClaw and the official `@openclaw/qqbot` plugin entirely in Docker. It does not install OpenClaw, Node.js packages, or the QQ plugin on the host.

The deployment is independent of the repository's Hermes container. Both can exist on the same machine, but only one process should connect with a given QQ Bot credential at a time.

The Compose project name is `qq-shit-bot`, matching the GitHub remote repository. Service containers therefore use names such as `qq-shit-bot-openclaw-gateway-1`; the existing model and log volumes keep their old names so the downloaded weights and runtime logs are not copied or redownloaded during the rename.

## What it configures

- OpenClaw `2026.7.1` and `@openclaw/qqbot` `2026.7.1`, pinned together.
- SenseNova `deepseek-v4-flash` as the only paid text-model route. There is no DeepSeek API fallback, so a SenseNova quota failure does not silently create DeepSeek charges.
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
- NVIDIA LocateAnything-3B and the in-project Qwen2.5-VL 7B service jointly analyze images: LocateAnything supplies grounding/location evidence, while Qwen supplies scene understanding and OCR. The local fusion bridge runs them serially to keep the RTX 5070 Ti within its 16 GiB budget.
- Microsoft Mage-VL is loaded directly through Transformers for video understanding. Videos longer than the configured 60-second segment window are analyzed segment by segment with timestamps, then OpenClaw's primary language model turns the intermediate result into the final QQ reply; no video leaves the machine.
- The Qwen2.5-VL Ollama service, NVIDIA image-fusion service, Microsoft video bridge, OpenClaw gateway, and context-recovery sidecar are all services in the same Compose project. Qwen has no host port; image and video services reach it at `qwen-vision:11434` on the private Compose network.
- QQ media uses a two-message workflow for mobile clients: send the image or video first, then send a message that @mentions the bot. The gateway records skipped group attachments locally and promotes the most recent downloaded image or video from the previous 15 minutes into the @mention turn. A media message that already includes the bot mention is also passed directly; ordinary non-media chatter remains mention-gated.
- Group sessions have a 120-minute idle reset, and the `context-recovery` sidecar watches the gateway log for an unrecoverable context overflow or stalled agent run and resets the affected QQ group session automatically. Existing log contents are not replayed when the sidecar starts, so an old failure cannot reset a newly started session.

`Watch-OpenClawModel.ps1` probes SenseNova every five minutes with a one-token request. A 429 is logged locally, but the deployment has no paid fallback and does not switch to DeepSeek. The watcher is started with the gateway by `Start-OpenClawDocker.ps1`.

QQ group delivery is guarded separately from model failover. Successful fallback replies are delivered normally, while `isError` and `isFallbackNotice` reply payloads are cancelled before the QQ adapter sees them. This prevents provider, quota, rate-limit, busy, and internal stack details from appearing in the group without hiding the corresponding gateway logs.

The deployment deliberately does not inject a DeepSeek key. The old standalone Hermes gateway must not run at the same time as this QQ gateway, because it can independently fall back to `api.deepseek.com`.

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

For the local Windows deployment, double-click `Start-OpenClawQQBot.bat` in the repository root. It calls `Start-OpenClawDocker.ps1`, which starts the entire vision and OpenClaw Compose project, the model route watcher, and proactive review jobs. The repository BAT is portable because it resolves the PowerShell launcher relative to its own location; a desktop copy should point to the cloned repository path.

## Container and GPU management

The normal QQ runtime is split into these services:

- `openclaw-gateway`: QQ WebSocket, session/context handling, model routing, and final Chinese text replies. It does not load the heavy vision models.
- `context-recovery`: watches gateway logs and resets a stuck or overflowed QQ group session. It is CPU-only and small.
- `qwen-vision`: private Ollama `Qwen2.5-VL 7B` service for image understanding and OCR. It is GPU-enabled and loads its model on demand.
- `image-fusion`: GPU-enabled NVIDIA LocateAnything-3B grounding plus Qwen content/OCR fusion. This is the main image-analysis VRAM consumer when its model is loaded.
- `video-bridge`: GPU-enabled Microsoft Mage-VL video analysis and long-video segmentation. It is the main video-analysis VRAM consumer when its model is loaded.
- `qq-diagnostic-filter-init`: one-shot initialization service that seeds the local QQ diagnostics and recovery scripts; it is not a persistent worker and does not use GPU.
- `openclaw-cli`: an optional `cli` profile for administrative commands; it normally remains stopped and does not use GPU.

Windows cannot reliably attribute the global `nvidia-smi` allocation to individual Docker containers. The reliable distinction is which services have `gpus: all`; use `nvidia-smi` for total VRAM and `ollama ps` or the image/video health endpoints to see whether a model is currently loaded. Docker's `MEM USAGE` column is system RAM, not VRAM.

To keep only the QQ bot and recovery sidecar running, stop the three GPU services:

```powershell
.\Stop-OpenClawVision.ps1
```

Stopping the services also writes a `none` media-capability profile into the runtime config. The image model/provider and media routes are removed for that runtime, and the QQ historical-media patch refuses to promote image/video paths. This prevents the language model from being given a stale media path and tells it not to claim that it saw disabled media.

When an image or video needs to be processed, start only the required GPU capability without restarting the whole deployment:

```powershell
.\Start-OpenClawVision.ps1 -Mode image   # Qwen + LocateAnything image path
.\Start-OpenClawVision.ps1 -Mode video   # Mage-VL video path
.\Start-OpenClawVision.ps1 -Mode both    # both paths
```

The helper updates the runtime capability profile and restarts only the gateway/recovery containers so the model sees the current capability policy. `image`, `video`, and `both` are mutually exclusive runtime profiles; the default is `both`.

Docker Desktop's Start/Stop buttons can also start or stop the individual GPU containers, but they do not change OpenClaw's capability profile. After starting containers from the UI, run `Set-OpenClawMediaCapabilities.ps1 -Mode image`, `-Mode video`, or `-Mode both` with `-RestartGateway`; after stopping them, run `Stop-OpenClawVision.ps1` (or set `-Mode none`) so the language model is not told that disabled media abilities are available.

The complete launcher still starts the gateway and the vision group together:

```powershell
.\Start-OpenClawDocker.ps1
```

The gateway and recovery sidecar should remain running for QQ replies. Stop `qwen-vision`, `image-fusion`, and `video-bridge` when no media work is expected; start them again before sending a media request. Because the image and video bridges share a GPU lock and unload models after requests, they are serialized to avoid exceeding the RTX 5070 Ti's available VRAM.

## Group participation

The configured mode keeps `requireMention: true` so ordinary messages are collected as pending group context without triggering one model call per message. Mentions, replies, direct messages, and the periodic proactive review can trigger a model turn. The group history window is 50 messages; bursts are debounced and queued in collect mode so the stable system prefix and recent context are more cache-friendly.

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

The launcher reads QQ and the SenseNova credential from the existing Hermes local environment, mounts `C:\HermesWorkspace` as the OpenClaw workspace, starts Qwen, Mage-VL, LocateAnything, image fusion, the OpenClaw gateway, and the context-recovery sidecar in one Compose project, installs/validates the QQ plugin, and starts the quota watcher. During migration it reuses the existing `local-vision_hermes-vision-model-cache` volume when present, then removes the legacy `hermes-vision` container after the in-project Qwen service is ready. It does not write credentials to the repository. Do not run the old Hermes gateway with the same QQ credentials at the same time.

Windows bind mounts appear world-writable inside Docker Desktop. The launcher therefore runs `qq-diagnostic-filter-init` first; it copies the local hook into a named volume with mode `0644`, so OpenClaw's plugin trust check can load it without weakening the security policy.

The Qwen, video, and image services use the RTX GPU and download public weights into the named Docker volumes on first use. Qwen is private to the Compose network and is configured for one loaded model, one parallel request, and zero keep-alive; the image-fusion and video bridge share a file lock and unload their models after each request. This keeps the heavyweight routes serialized and avoids the old separately exposed `hermes-vision` service. The video API is local at `http://127.0.0.1:30000`; the image-fusion API is local at `http://127.0.0.1:30001`. The default video limit is 50 MiB, 16 sampled frames per segment, 60 seconds per segment, and 12 segments. `-NoVideo` starts the text-only gateway without the media overlay; use `Start-OpenClawVision.ps1` for an image-only or video-only profile. LocateAnything-3B is under NVIDIA's non-commercial research license; check that license before any commercial use.

## Local verification record

The stack was verified locally on 2026-08-03 before the launcher and deployment documentation were finalized:

- `tests/deploy/test_openclaw_docker.py`: 7 tests passed; Compose parsing, the idle-reset and overflow-recovery wiring, config validation, the official QQ plugin, media routes, video segmentation settings, and Windows launchers were checked.
- OpenClaw gateway: `/healthz` returned `ok/live`; the official QQ plugin was loaded and trusted. With the existing Hermes credentials, QQ access-token acquisition and the QQ WebSocket both reached `Gateway ready`.
- Container grouping: `qwen-vision`, `image-fusion`, `video-bridge`, `openclaw-gateway`, and `context-recovery` were running in the same Compose project; the gateway, Qwen, image, and video health checks passed, the legacy `hermes-vision` container was absent, Qwen exposed only the private Compose port, and host port `8010` was closed.
- Image path: `NVIDIA LocateAnything-3B` returned localization evidence, the local `Qwen2.5-VL 7B` service returned scene/OCR content, and the primary SenseNova language model produced the final Chinese answer.
- Video path: Microsoft `Mage-VL` returned a real answer for a short video and analyzed a 61-second video as two segments (`0.0-30.5s` and `30.5-61.0s`). The primary SenseNova language model then produced the final Chinese answer.
- Search path: Hermes selected its actual no-key `ddgs` backend and returned a result; OpenClaw's bundled `duckduckgo` provider also returned a result. No paid search credential is required by this deployment.
- Context recovery: a synthetic overflow line appended to the shared gateway log caused the sidecar to call `sessions.reset` successfully; the test log was then removed.
- Concurrent image/video requests completed successfully. The measured peak was 15,823 MiB of 16,303 MiB total GPU memory, below the limit; the shared lock is the guard that prevents the two heavyweight vision models from loading at the same time.

The measured GPU peak leaves only a small margin, so it is not safe to infer that another GPU-heavy host application can remain active during media inference. Check total usage with `nvidia-smi` before enabling a media profile; stopped containers do not prove that the host GPU is free.

The runtime now logs `QQ historical video promoted for @mention` or `QQ historical image promoted for @mention` when this two-message path is exercised. A real QQ attachment acceptance test still requires an actual image/video event from an allowed account; direct local Mage-VL service verification does not prove that external QQ delivery path.

## Updating the persona

`setup.sh` copies `AGENTS.md` and `SOUL.md` only when the runtime workspace does not already contain them, so local edits are preserved. Copy the repository versions again manually when you want to adopt later persona changes.
