# qq-shit-bot Docker deployment

This directory contains the only supported QQ Bot deployment shape. Windows,
macOS, Linux, WSL, and different CPU/GPU machines all run OpenClaw, the
Tencent QQ plugin, the Gateway, and recovery services in Docker Compose. The
host provides Docker Desktop or Docker Engine and network access; it does not
install OpenClaw or the QQ plugin directly.

The Bot's text and image-understanding route is the same on every platform:
`codex-proxy/gpt-5.6-luna`, reached through an OpenAI-compatible Codex reverse
proxy. The token is read from the ignored local `.env`; it is never committed,
printed, copied into the runtime workspace, or returned by the diagnostics API.
The optional Linux voice and game sidecars are also Docker services. Voice
sidecars are auxiliary media services and do not change the core text/image
route.

The Compose project name is `qq-shit-bot`. Persistent volumes use the
`qqshitbot-openclaw_*` prefix for the default deployment and
`qqshitbot-openclaw-mac_*` for the macOS image.

## Route and required environment

Copy the template before starting:

```bash
cd deploy/openclaw
cp .env.example .env
chmod 600 .env                         # Unix-like hosts
```

Fill in the QQ credentials, Gateway token, and these Codex proxy values:

```dotenv
CODEX_PROXY_BASE_URL=http://host.docker.internal:18317/v1
CODEX_PROXY_TOKEN=replace-with-codex-proxy-token
```

`CODEX_PROXY_BASE_URL` must be reachable from the Docker container. Docker
Desktop normally resolves `host.docker.internal` to the host. The Linux
Codex overlay uses host networking and can instead point at the host loopback
proxy, for example `http://127.0.0.1:18317/v1`. Do not publish the proxy or
the Gateway to the public Internet as a troubleshooting shortcut.

The other required values are `QQBOT_APP_ID`, `QQBOT_CLIENT_SECRET`,
`OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_TZ`, and the pinned image/plugin values in
`.env.example`. `OPENCLAW_GATEWAY_TOKEN` protects the OpenClaw Control UI and
is unrelated to `CODEX_PROXY_TOKEN`. QQ allowlist OpenIDs and the optional
proactive-review home channel remain local configuration values.

Use the redacted environment check before starting:

```bash
./validate-env.sh --diagnose --allow-placeholders
```

The normal validation command rejects placeholders. Both validators report
presence only and never output credential values.

## Standard Docker Compose deployment

The standard Compose files are platform-neutral and are used for Windows,
WSL, and a normal Docker Engine host:

```bash
cd deploy/openclaw
./validate-env.sh
./setup.sh
```

`setup.sh` prepares the ignored `runtime/` directories, copies the current
Bot workspace files, seeds the local diagnostic/filter patches, installs the
pinned Tencent QQ and DuckDuckGo plugins in a one-shot Docker CLI container,
validates the config, and starts `openclaw-gateway` plus `context-recovery`.
It does not start a host-side model server.

The standard core services are:

| Service | Role | Default exposure |
| --- | --- | --- |
| `qq-diagnostic-filter-init` | Seed local patches and runtime ownership | One-shot container |
| `openclaw-gateway` | OpenClaw Gateway and QQ WebSocket adapter | `127.0.0.1:18789` |
| `openclaw-cli` | One-shot Docker CLI for plugin/config operations | Compose `cli` profile |
| `context-recovery` | Bounded context-overflow and stalled-run recovery | Internal Compose network |

The standard and macOS Compose files do not contain a local vision model. The
Gateway declares text and image input on the Codex route and explicitly keeps
video analysis disabled. The historical local vision, video-bridge, and
image-fusion paths are not supported and must not be reintroduced through a
launcher or an additional Compose service.

Open the local Control UI at `http://127.0.0.1:18789` and authenticate with
`OPENCLAW_GATEWAY_TOKEN`. This proves only that the local UI is reachable; it
does not prove a QQ message was received, answered, or delivered externally.

## Windows

The formal Windows entrypoint is a pure BAT launcher and uses Docker Compose
only:

```bat
scripts\windows\Start-OpenClawQQBot.bat
```

It locates the repository relative to the BAT file, checks the ignored
`deploy\openclaw\.env`, prepares runtime files, validates Compose, installs or
checks the pinned plugins, validates the OpenClaw configuration, and starts
the Gateway and recovery service. It requires both `CODEX_PROXY_BASE_URL` and
`CODEX_PROXY_TOKEN`; no local model executable is started. The optional
PowerShell helper `deploy/openclaw/Start-OpenClawDocker.ps1` follows the same
Docker-only route. Credential binding helpers must write only to the ignored
`.env` file.

For a provider-level, redacted request check from a configured environment:

```powershell
python scripts/codex_proxy_probe.py --env-file deploy/openclaw/.env
```

The probe checks one OpenAI-compatible Codex request and prints only status
and capability information. It does not prove that a QQ attachment reached
the Gateway or that a reply reached a QQ client.

## macOS and Docker Desktop

macOS uses the same Codex route and Docker-only Bot runtime with the
Mac-specific image and Compose file. From the repository root:

```bash
scripts/mac/check-env.sh
scripts/mac/start.sh
scripts/mac/status.sh
scripts/mac/logs.sh 80
scripts/mac/console.sh
scripts/mac/stop.sh
```

`start.sh` builds the small macOS image, copies `openclaw.mac.json` into the
ignored runtime config, seeds the local patches, validates the pinned plugins,
and starts only the core Gateway and recovery containers. Docker Desktop must
be running; enable its start-at-login option when unattended recovery is
desired. The host Operations Console is an optional read-only Python process,
not a replacement for the Docker Bot runtime.

The default macOS bindings are loopback-only. For a trusted LAN, use
`scripts/mac/configure-lan-console.sh` to bind to one detected concrete LAN
IPv4 and expose only redacted read-only console data. Never use wildcard
bindings or router port forwarding. A MacBook sleeps with its Docker Desktop
VM when the lid closes; supported clamshell hardware and power conditions are
required for continuous operation. Do not add a permanent lid-sleep bypass.
See [`docs/MAC_RUNTIME_STABILITY.md`](../../docs/MAC_RUNTIME_STABILITY.md) for
the recovery runbook.

## Linux Codex overlay

The Linux overlay is still Docker-based, but adds the local host-network
services used by this host for optional games and voice features. It is useful
when the Codex reverse proxy listens only on the Linux host loopback:

```bash
cd deploy/openclaw
./start-codex.sh
```

The overlay copies `openclaw.codex.json`, uses host networking for the Gateway
and recovery path so `127.0.0.1:18317` is reachable, and keeps the Gateway
bound to its local port. It requires a running Docker daemon, Compose plugin,
the configured Codex values, and a systemd user manager because the optional
GPU lease service coordinates voice sidecars.

The overlay adds these Docker-only auxiliary services:

- `qqbot-game`: CPU-limited game API on `127.0.0.1:18104`; its AI referee uses
  the same Codex base URL/token, while the text-first games and local 行测题库
  use deterministic rules without a model call. See
  [`docs/QQBOT_CHAT_GAMES.md`](../../docs/QQBOT_CHAT_GAMES.md) for the game
  catalog and the reproducible text-only bank import;
- `qwen-tts` and `qwen-asr`: on-demand voice sidecars behind the loopback GPU
  gate, with their model caches and device access kept local to this overlay;
- the existing ComfyUI integration: coordinated by the same GPU lease and
  not part of the core text/image-understanding path.

### Linux LAN NapCat WebUI and systemd

For the optional ordinary-QQ path, set `NAPCAT_WEBUI_BIND_ADDRESS` to the
concrete LAN IPv4 assigned to this host and keep `NAPCAT_WEBUI_PORT=6099`.
The WebUI is then available at
`http://<宿主机局域网IPv4>:6099/webui/`; keep the WebUI password/token enabled
and allow TCP 6099 only from the trusted LAN in the host firewall. Do not bind
to `0.0.0.0`, forward the port from the router, or expose the OneBot adapter's
16700 port.

To keep the NapCat/OneBot path manageable across reboots, install the supplied
user-level unit (the current Linux host has user lingering enabled):

```bash
cd /home/mentat/services/qq-shit-bot/deploy/openclaw
mkdir -p ~/.config/systemd/user
install -m 0644 qq-shit-bot-napcat.service \
  ~/.config/systemd/user/qq-shit-bot-napcat.service
systemctl --user daemon-reload
systemctl --user enable --now qq-shit-bot-napcat.service
```

Use `systemctl --user status|start|stop|restart qq-shit-bot-napcat.service` for
daily lifecycle management and
`journalctl --user -u qq-shit-bot-napcat.service -f` for its startup output.
The unit only manages the two optional Compose services, uses the existing
ignored `.env`, and never stores QQ credentials or tokens in the unit. Its
`active (exited)` status is expected: Docker's `restart: unless-stopped`
policy keeps the containers resident, while the unit provides the boot and
manual lifecycle hook. A `restart` briefly disconnects NapCat/OneBot but keeps
the existing QQ session directory.

Only the auxiliary voice/generation services use local GPU model resources.
Their availability must not be reported as proof that the Codex route or QQ
delivery works. The game and voice state is local runtime state and remains
outside Git.

## NapCatQQ + OneBot 11 reverse WebSocket

The optional ordinary-QQ path is documented in
[`../../docs/ONEBOT_NAPCAT.md`](../../docs/ONEBOT_NAPCAT.md). It adds the
independent `onebot-adapter` service through `docker-compose.onebot.yml` and
the optional `napcat` Compose profile through `docker-compose.napcat.yml`;
the official `openclaw-qqbot` adapter remains available in parallel. The
Linux Codex overlay uses `docker-compose.onebot.codex.yml` and
`docker-compose.napcat.codex.yml` to keep the adapter, Gateway, game sidecar,
and NapCat on the existing host-local path. The adapter and its OneBot
WebSocket remain loopback-only; the NapCat login WebUI has a separate,
explicitly configurable bind address.

On Linux, after filling the OneBot access token, exact group allowlist, and
administrator QQ values in the ignored `.env`, use:

```bash
cd deploy/openclaw
./start-onebot.sh
# Add --with-napcat to start the optional NapCat container as well.
```

For manual QQ login from a trusted LAN device, set a concrete IPv4 address
assigned to this host in the ignored `.env` before starting NapCat:

```dotenv
NAPCAT_WEBUI_BIND_ADDRESS=192.0.2.10
NAPCAT_WEBUI_PORT=6099
```

Replace the example address with the host's actual LAN address. The launcher
rejects wildcard addresses such as `0.0.0.0` and `::`, and in the Linux
host-network overlay it updates only NapCat's persisted WebUI `host` field.
The OneBot adapter stays on `127.0.0.1:16700`.

Login, QR/device verification, and the NapCat WebSocket-client configuration
are manual WebUI operations. The adapter reuses the current runtime rules,
Codex image route, bounded group context, all text games, quoted/@ messages,
and the configured ASR/TTS path, while its outbound messages use OneBot
`send_*_msg` actions rather than the Tencent SDK.

When the LAN bind is enabled, open the following URL from a machine on the
same trusted network and complete the NapCat WebUI authentication and QQ
login manually:

```text
http://<宿主机局域网IPv4>:6099/webui/
```

Port `6099` is an account-control surface, not a public service. Keep the
NapCat WebUI password/token non-default, do not use router port forwarding,
and do not expose it on a wildcard or public interface. A successful page
load proves only LAN WebUI reachability; QQ login and device verification
still require the actual browser/client result.

To inspect or stop the overlay, reuse the complete file set:

```bash
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.codex.yml \
  -f docker-compose.onebot.yml -f docker-compose.onebot.codex.yml \
  ps
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.codex.yml \
  -f docker-compose.onebot.yml -f docker-compose.onebot.codex.yml \
  down
```

If `--with-napcat` was used, append `-f docker-compose.napcat.yml
-f docker-compose.napcat.codex.yml` to both commands and add `--profile napcat`
when inspecting the profile. `down` keeps the NapCat QQ data directory; it does
not delete volumes or the ignored runtime data.

## QQ media, context, and voice boundaries

The QQ media patch accepts a direct image attachment or the supported
two-message flow where the image is sent first and the bot is mentioned in a
follow-up. Signed QQ media URLs are fetched into canonical local image context
only after the event is allowed; they are not passed to a generic unrestricted
URL tool. Video remains disabled. A forwarded chat record is expanded only
when its message nodes are present; a title or preview alone is incomplete.

The runtime workspace copies `bot-workspace/AGENTS.md` and the repository
`SOUL.md`. The root repository `AGENTS.md` is a development handbook and is
never copied into the Bot workspace. Runtime rules keep command execution,
arbitrary file access, host control, and private-data disclosure denied.

Voice is an explicit delivery feature rather than a conversation mode. Text
replies remain text unless the user requests a voice action or the configured
private/group voice preference applies. A failed voice service falls back to
one text answer. These delivery behaviors are independent from the Codex
text/image request route.

## Verification and evidence boundaries

Run the redacted local checks from the repository root:

```bash
python3 scripts/openclaw_diagnostic.py --mode preflight --pretty
python3 scripts/openclaw_diagnostic.py --mode health --pretty
python3 scripts/codex_proxy_probe.py --env-file deploy/openclaw/.env
python3 scripts/security_audit.py --json
```

The repository tests and CI validate source behavior, Compose shape, launch
wiring, and secret boundaries. The health report separates container state,
Gateway health, configured Codex route, and log observations. The Codex probe
adds request-level evidence when a real local token and reachable proxy are
available. None of these checks proves external QQ delivery, third-party
quota, a user-visible client result, or a production deployment.

Do not place `.env`, tokens, API responses, QQ identifiers, message bodies,
images, Docker volumes, logs, model caches, or generated runtime state in a
commit. Before pushing, inspect `git status --short`, `git diff --check`, and
the tracked-file security audit.

## Stop and recovery

Stop the core standard deployment with:

```bash
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.local.yml \
  down
```

Use `down` without `-v` so named volumes and the ignored runtime remain
recoverable. For macOS use `-f docker-compose.mac.yml`; for the Linux overlay
include `docker-compose.codex.yml`. Do not delete volumes or runtime files as
a routine diagnostic step.
