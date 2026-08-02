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
- The existing local Qwen2.5-VL 7B service is used for image understanding; no OpenAI model is configured.

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

## Group participation

The configured mode keeps `requireMention: true` so ordinary messages are collected as pending group context without triggering one model call per message. Mentions, replies, direct messages, and the periodic proactive review can trigger a model turn. The group history window is 50 messages; bursts are debounced and queued in collect mode so the stable system prefix and recent context are more cache-friendly.

The proactive review is intentionally periodic rather than per-message: it reads the full pending context and returns `NO_REPLY` when there is nothing useful to add. This preserves participation while limiting unnecessary model calls. To make every ordinary message an immediate model turn, edit `runtime/config/openclaw.json` and set:

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

The launcher reads QQ and model credentials from the existing Hermes local environment, decrypts the existing DPAPI-protected DeepSeek fallback key in memory, mounts `C:\HermesWorkspace` as the OpenClaw workspace, starts the existing local vision service, installs/validates the QQ plugin, and starts the quota watcher. It does not write credentials to the repository. Do not run the old Hermes gateway with the same QQ credentials at the same time.

## Updating the persona

`setup.sh` copies `AGENTS.md` and `SOUL.md` only when the runtime workspace does not already contain them, so local edits are preserved. Copy the repository versions again manually when you want to adopt later persona changes.
