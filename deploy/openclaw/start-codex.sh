#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
ENV_FILE="$SCRIPT_DIR/.env"
RUNTIME_DIR="$SCRIPT_DIR/runtime"
GAME_STATE_DIR="$RUNTIME_DIR/game-state"
COMPOSE_BASE="$SCRIPT_DIR/docker-compose.yml"
COMPOSE_LOCAL="$SCRIPT_DIR/docker-compose.local.yml"
COMPOSE_CODEX="$SCRIPT_DIR/docker-compose.codex.yml"
USER_SYSTEMD_DIR="/home/mentat/.config/systemd/user"
GPU_GATE_UNIT_SOURCE="$SCRIPT_DIR/qqbot-tts-gpu-gate.service"
GPU_GATE_UNIT_TARGET="$USER_SYSTEMD_DIR/qqbot-tts-gpu-gate.service"
COMFY_GATE_DROPIN_DIR="$USER_SYSTEMD_DIR/comfyui-z-image.service.d"
COMFY_GATE_DROPIN_SOURCE="$SCRIPT_DIR/comfyui-tts-gpu-gate.conf"
COMFY_GATE_DROPIN_TARGET="$COMFY_GATE_DROPIN_DIR/tts-gpu-gate.conf"

env_value() {
    key=$1
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); value = $0 } END { print value }' "$ENV_FILE"
}

require_configured() {
    key=$1
    value=$(env_value "$key")
    case "$value" in
        ""|replace-with-*)
            printf 'Set %s in %s before running this launcher.\n' "$key" "$ENV_FILE" >&2
            exit 1
            ;;
    esac
}

if [ ! -f "$ENV_FILE" ]; then
    echo "Missing $ENV_FILE; copy .env.example and fill the local values first." >&2
    exit 1
fi
chmod 600 "$ENV_FILE"

for key in OPENCLAW_IMAGE OPENCLAW_QQBOT_PLUGIN OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN OPENCLAW_TZ QQBOT_APP_ID QQBOT_CLIENT_SECRET; do
    require_configured "$key"
done

if [ "$(env_value OPENCLAW_GATEWAY_PORT)" != "18789" ]; then
    echo "This Linux Codex overlay requires OPENCLAW_GATEWAY_PORT=18789." >&2
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required." >&2
    exit 1
fi
if ! docker info >/dev/null 2>&1; then
    echo "The Docker daemon is not running." >&2
    exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
    echo "The Docker Compose plugin is required." >&2
    exit 1
fi
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
    XDG_RUNTIME_DIR="/run/user/$(id -u)"
    export XDG_RUNTIME_DIR
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ]; then
    DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
    export DBUS_SESSION_BUS_ADDRESS
fi
user_manager_ready=false
attempt=1
while [ "$attempt" -le 3 ]; do
    if systemctl --user show -p Id >/dev/null 2>&1; then
        user_manager_ready=true
        break
    fi
    sleep 1
    attempt=$((attempt + 1))
done
if [ "$user_manager_ready" != true ]; then
    echo "A running systemd user manager is required for the TTS GPU gate." >&2
    exit 1
fi

compose() {
    docker compose \
        --env-file "$ENV_FILE" \
        -f "$COMPOSE_BASE" \
        -f "$COMPOSE_LOCAL" \
        -f "$COMPOSE_CODEX" "$@"
}

relocate_legacy_qqbot_project() {
    projects_dir="$RUNTIME_DIR/config/npm/projects"
    legacy_dir="$RUNTIME_DIR/config/npm/legacy-plugins"
    [ -d "$projects_dir" ] || return 0
    for legacy_project in "$projects_dir"/*; do
        [ -d "$legacy_project/node_modules/@openclaw/qqbot" ] || continue
        mkdir -p "$legacy_dir"
        target="$legacy_dir/$(basename "$legacy_project")"
        if [ -e "$target" ]; then
            target="$target-$(date +%s)"
        fi
        mv "$legacy_project" "$target"
        echo "Quarantined legacy @openclaw/qqbot project under $target."
    done
}

mkdir -p "$RUNTIME_DIR/config" "$RUNTIME_DIR/workspace" "$GAME_STATE_DIR" "$USER_SYSTEMD_DIR" "$COMFY_GATE_DROPIN_DIR"
install -m 0644 "$GPU_GATE_UNIT_SOURCE" "$GPU_GATE_UNIT_TARGET"
install -m 0644 "$COMFY_GATE_DROPIN_SOURCE" "$COMFY_GATE_DROPIN_TARGET"
systemctl --user daemon-reload
systemctl --user enable --now qqbot-tts-gpu-gate.service
chmod 700 "$RUNTIME_DIR" "$RUNTIME_DIR/config" "$RUNTIME_DIR/workspace" "$GAME_STATE_DIR"
cp "$SCRIPT_DIR/openclaw.codex.json" "$RUNTIME_DIR/config/openclaw.json"
cp "$SCRIPT_DIR/media-capabilities.codex.json" "$RUNTIME_DIR/config/media-capabilities.json"
cp "$SCRIPT_DIR/bot-workspace/AGENTS.md" "$RUNTIME_DIR/workspace/AGENTS.md"
cp "$REPO_ROOT/SOUL.md" "$RUNTIME_DIR/workspace/SOUL.md"
chmod 600 "$RUNTIME_DIR/config/openclaw.json" "$RUNTIME_DIR/config/media-capabilities.json" "$RUNTIME_DIR/workspace/AGENTS.md" "$RUNTIME_DIR/workspace/SOUL.md"

compose config --quiet
compose build qqbot-game
compose pull openclaw-gateway openclaw-cli
compose run --rm --no-deps qq-diagnostic-filter-init
relocate_legacy_qqbot_project

if ! compose run --rm --no-deps openclaw-cli plugins inspect openclaw-qqbot --json 2>/dev/null | grep -F '2.0.3' >/dev/null; then
    plugin_spec=$(env_value OPENCLAW_QQBOT_PLUGIN)
    compose run --rm --no-deps openclaw-cli plugins install "$plugin_spec" --force --pin --accept-capabilities
fi
if ! compose run --rm --no-deps openclaw-cli plugins inspect duckduckgo --json 2>/dev/null | grep -F '2026.8.2' >/dev/null; then
    compose run --rm --no-deps openclaw-cli plugins install '@openclaw/duckduckgo-plugin@2026.8.2' --force --pin --accept-capabilities
fi

compose run --rm --no-deps openclaw-cli config validate
compose up -d --force-recreate qqbot-game openclaw-gateway context-recovery
compose ps qqbot-game openclaw-gateway context-recovery
