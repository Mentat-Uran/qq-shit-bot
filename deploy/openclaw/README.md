# OpenClaw + Docker

This deployment runs OpenClaw and the official `@openclaw/qqbot` plugin entirely in Docker. It does not install OpenClaw, Node.js packages, or the QQ plugin on the host.

The deployment is independent of the repository's Hermes container. Both can exist on the same machine, but only one process should connect with a given QQ Bot credential at a time.

## What it configures

- OpenClaw `2026.7.1` and `@openclaw/qqbot` `2026.7.1`, pinned together.
- The same SenseNova primary model and official DeepSeek fallback as `config.example.yaml`.
- The repository's `AGENTS.md` and `SOUL.md` as the OpenClaw workspace context.
- Token-authenticated Control UI published only on `127.0.0.1`.
- OpenClaw's operator terminal disabled.
- `exec`, `read`, and `write` agent tools denied globally and in QQ groups.
- Only the official QQ plugin allowlisted by default.
- QQ direct and group access restricted to configured owner identifiers by default.
- Startup model discovery disabled because all providers are declared explicitly; model loading still occurs on the first request.
- NVIDIA LocateAnything-3B and the existing local Qwen2.5-VL 7B service jointly analyze images: LocateAnything supplies grounding/location evidence, while Qwen supplies scene understanding and OCR. The local fusion bridge runs them serially to keep the RTX 5070 Ti within its 16 GiB budget.
- Microsoft Mage-VL is loaded directly through Transformers for video understanding. Videos longer than the configured 60-second segment window are analyzed segment by segment with timestamps, then OpenClaw's primary language model turns the intermediate result into the final QQ reply; no video leaves the machine.

OpenClaw's normal model fallback remains available, and `Watch-OpenClawModel.ps1` probes SenseNova every five minutes with a one-token request. A 429 switches the primary route to official DeepSeek; recovery switches it back to SenseNova. The watcher is started with the gateway by `Start-OpenClawDocker.ps1`.

The fallback key uses `HERMES_DEEPSEEK_API_KEY` instead of the conventional `DEEPSEEK_API_KEY`. This prevents OpenClaw from treating the environment variable as a request to install its separate DeepSeek provider plugin; the deployment already defines a compatible custom provider.

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

The script creates `runtime/`, copies the repository persona files, installs the official QQ plugin inside a one-shot OpenClaw container, validates the config, and starts the gateway. It accepts either the Docker Compose plugin (`docker compose`) or the standalone `docker-compose` command. Secrets and runtime state remain under ignored local paths.

Open the Control UI at `http://127.0.0.1:18789` and authenticate with `OPENCLAW_GATEWAY_TOKEN` from `.env`.

## Docker Compose commands

```bash
# Logs
docker compose logs -f openclaw-gateway

# OpenClaw status and configuration checks
docker compose run --rm openclaw-cli status
docker compose run --rm openclaw-cli config validate
docker compose run --rm openclaw-cli plugins inspect qqbot

# Stop
docker compose down

# Pull the pinned image and restart
docker compose pull
docker compose up -d openclaw-gateway
```

On Windows, use Docker Desktop with WSL or Git Bash to run `setup.sh`. The Compose file itself is platform-neutral; the equivalent manual sequence is to create `runtime/config` and `runtime/workspace`, copy `openclaw.json`, `AGENTS.md`, and `SOUL.md` into them, install the plugin with the `openclaw-cli` service, validate the config, and start `openclaw-gateway`.

For the local Windows deployment, double-click `Start-OpenClawQQBot.bat` in the repository root. It calls `Start-OpenClawDocker.ps1`, which starts the Gateway, local vision stack, model route watcher, and proactive review jobs. The repository BAT is portable because it resolves the PowerShell launcher relative to its own location; a desktop copy should point to the cloned repository path.

## Group participation

The configured mode keeps `requireMention: true` so ordinary messages are collected as pending group context without triggering one model call per message. Mentions, replies, direct messages, and the periodic proactive review can trigger a model turn. The group history window is 50 messages; bursts are debounced and queued in collect mode so the stable system prefix and recent context are more cache-friendly.

The proactive review is intentionally periodic rather than per-message: it reads the full pending context and returns `NO_REPLY` only when there is nothing useful to add. Direct mentions and replies must receive a normal answer unless a workspace safety rule blocks the request. The schedule is every 10 minutes from 08:00 through 01:50, and every 30 minutes from 02:00 through 07:30, using `Asia/Shanghai` time. This keeps daytime participation higher while reducing overnight model calls. To make every ordinary message an immediate model turn, edit `runtime/config/openclaw.json` and set:

```json
"requireMention": false
```

Restart the gateway after changing configuration:

```bash
docker compose restart openclaw-gateway
```

To allow more QQ users, add direct-message user OpenIDs to `allowFrom` and group member OpenIDs to `groupAllowFrom`. To restrict the bot to specific groups, replace the `"*"` entry under `channels.qqbot.groups` with the allowed group OpenIDs. Keep allowlists enabled on bots that are present in public groups.

## Windows local deployment

When the prior Hermes installation is under `C:\HermesWorkspace`, start the complete local stack with:

```powershell
.\Start-OpenClawDocker.ps1
```

The launcher reads QQ and model credentials from the existing Hermes local environment, decrypts the existing DPAPI-protected DeepSeek fallback key in memory, mounts `C:\HermesWorkspace` as the OpenClaw workspace, starts the existing local Qwen service, starts the Mage-VL video service and the LocateAnything/Qwen image-fusion service, installs/validates the QQ plugin, and starts the quota watcher. It does not write credentials to the repository. Do not run the old Hermes gateway with the same QQ credentials at the same time.

The two new services use the RTX GPU and download public weights into the named Docker volume `mage-vl-hf-cache` on first use. The video API is local at `http://127.0.0.1:30000`; the image-fusion API is local at `http://127.0.0.1:30001`. A shared file lock serializes heavyweight GPU work across the two containers, and each request unloads its local model before releasing the lock; Qwen is also asked to release its model after an image call. This prevents simultaneous model residency from exceeding the 16 GiB GPU budget at the cost of cold-start latency. The default video limit is 50 MiB, 16 sampled frames per segment, 60 seconds per segment, and 12 segments. `-NoVideo` starts only the image/QQ stack when the GPU is needed elsewhere. LocateAnything-3B is under NVIDIA's non-commercial research license; check that license before any commercial use.

## Local verification record

The stack was verified locally on 2026-08-03 before the launcher and deployment documentation were finalized:

- `tests/deploy/test_openclaw_docker.py`: 7 tests passed; Compose parsing, config validation, the official QQ plugin, media routes, video segmentation settings, and Windows launchers were checked.
- OpenClaw gateway: `/healthz` returned `ok/live`; the official QQ plugin was loaded and trusted. With the existing Hermes credentials, QQ access-token acquisition and the QQ WebSocket both reached `Gateway ready`.
- Image path: `NVIDIA LocateAnything-3B` returned localization evidence, the local `Qwen2.5-VL 7B` service returned scene/OCR content, and the primary SenseNova language model produced the final Chinese answer.
- Video path: Microsoft `Mage-VL` returned a real answer for a short video and analyzed a 61-second video as two segments (`0.0-30.5s` and `30.5-61.0s`). The primary SenseNova language model then produced the final Chinese answer.
- Concurrent image/video requests completed successfully. The measured peak was 15,823 MiB of 16,303 MiB total GPU memory, below the limit; the shared lock is the guard that prevents the two heavyweight vision models from loading at the same time.

The test used local media fixtures and the live configured gateway credentials, but did not send a real user video or image through QQ. A later QQ media acceptance test still needs an actual attachment event from an allowed account.

## Updating the persona

`setup.sh` copies `AGENTS.md` and `SOUL.md` only when the runtime workspace does not already contain them, so local edits are preserved. Copy the repository versions again manually when you want to adopt later persona changes.
