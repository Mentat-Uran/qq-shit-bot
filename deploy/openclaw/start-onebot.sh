#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE="$SCRIPT_DIR/.env"
COMPOSE_BASE="$SCRIPT_DIR/docker-compose.yml"
COMPOSE_LOCAL="$SCRIPT_DIR/docker-compose.local.yml"
COMPOSE_CODEX="$SCRIPT_DIR/docker-compose.codex.yml"
COMPOSE_ONEBOT="$SCRIPT_DIR/docker-compose.onebot.yml"
COMPOSE_ONEBOT_CODEX="$SCRIPT_DIR/docker-compose.onebot.codex.yml"
COMPOSE_NAPCAT="$SCRIPT_DIR/docker-compose.napcat.yml"
COMPOSE_NAPCAT_CODEX="$SCRIPT_DIR/docker-compose.napcat.codex.yml"
NAPCAT_WEBUI_CONFIGURATOR="$SCRIPT_DIR/configure-napcat-webui.sh"
WITH_NAPCAT=false
FORCE_RECREATE=true

usage() {
    printf '%s\n' 'Usage: start-onebot.sh [--with-napcat] [--no-recreate]' >&2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --with-napcat) WITH_NAPCAT=true; shift ;;
        --no-recreate) FORCE_RECREATE=false; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage; exit 2 ;;
    esac
done

if [ ! -f "$ENV_FILE" ]; then
    echo "Missing $ENV_FILE; copy .env.example and fill the local values first." >&2
    exit 1
fi
chmod 600 "$ENV_FILE"

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

for key in ONEBOT_ACCESS_TOKEN ONEBOT_ALLOWED_GROUP_IDS ONEBOT_ADMIN_USER_IDS; do
    require_configured "$key"
done

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    echo "A running Docker daemon is required." >&2
    exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
    echo "The Docker Compose plugin is required." >&2
    exit 1
fi

if [ "${ONEBOT_SKIP_CORE_START:-false}" != "true" ]; then
    "$SCRIPT_DIR/start-codex.sh"
fi

compose() {
    docker compose \
        --env-file "$ENV_FILE" \
        -f "$COMPOSE_BASE" \
        -f "$COMPOSE_LOCAL" \
        -f "$COMPOSE_CODEX" \
        -f "$COMPOSE_ONEBOT" \
        -f "$COMPOSE_ONEBOT_CODEX" "$@"
}

compose_with_napcat() {
    docker compose \
        --env-file "$ENV_FILE" \
        -f "$COMPOSE_BASE" \
        -f "$COMPOSE_LOCAL" \
        -f "$COMPOSE_CODEX" \
        -f "$COMPOSE_ONEBOT" \
        -f "$COMPOSE_ONEBOT_CODEX" \
        -f "$COMPOSE_NAPCAT" \
        -f "$COMPOSE_NAPCAT_CODEX" "$@"
}

validate_napcat_webui_bind_address() {
    configured_bind_address=$(env_value NAPCAT_WEBUI_BIND_ADDRESS)
    if [ -z "${NAPCAT_WEBUI_BIND_ADDRESS:-}" ]; then
        NAPCAT_WEBUI_BIND_ADDRESS="$configured_bind_address"
    fi
    if [ -z "$NAPCAT_WEBUI_BIND_ADDRESS" ]; then
        NAPCAT_WEBUI_BIND_ADDRESS=127.0.0.1
    fi
    export NAPCAT_WEBUI_BIND_ADDRESS

    python3 - "$NAPCAT_WEBUI_BIND_ADDRESS" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1])
except ValueError:
    raise SystemExit("NAPCAT_WEBUI_BIND_ADDRESS must be a concrete IPv4 address")

if not isinstance(address, ipaddress.IPv4Address) or address.is_unspecified or address.is_multicast:
    raise SystemExit("NAPCAT_WEBUI_BIND_ADDRESS must be a concrete IPv4 address")
PY

    if [ "$NAPCAT_WEBUI_BIND_ADDRESS" != "127.0.0.1" ]; then
        if ! command -v ip >/dev/null 2>&1; then
            echo "The ip command is required when NapCat WebUI uses a LAN address." >&2
            exit 1
        fi
        if ! ip -4 -o addr show | awk -v target="$NAPCAT_WEBUI_BIND_ADDRESS" '
            { split($4, address, "/"); if (address[1] == target) found = 1 }
            END { exit(found ? 0 : 1) }
        '; then
            printf 'NAPCAT_WEBUI_BIND_ADDRESS is not assigned on this host: %s\n' \
                "$NAPCAT_WEBUI_BIND_ADDRESS" >&2
            exit 1
        fi
    fi
}

configure_existing_napcat_webui() {
    local_status=0
    if "$NAPCAT_WEBUI_CONFIGURATOR"; then
        local_status=0
    else
        local_status=$?
    fi
    case "$local_status" in
        0|3|4) return "$local_status" ;;
        *)
            echo "Unable to update NapCat WebUI binding without changing other config." >&2
            return "$local_status"
            ;;
    esac
}

mkdir -p "$SCRIPT_DIR/runtime/napcat/config" "$SCRIPT_DIR/runtime/napcat/qq"
chmod 700 "$SCRIPT_DIR/runtime/napcat" "$SCRIPT_DIR/runtime/napcat/config" "$SCRIPT_DIR/runtime/napcat/qq"

if [ "$WITH_NAPCAT" = true ]; then
    validate_napcat_webui_bind_address
    # Apply the host before a normal recreation. If NapCat has not generated
    # webui.json yet, the post-start pass below handles the first run.
    webui_status=0
    webui_restart_needed=false
    if configure_existing_napcat_webui; then
        webui_status=0
        if [ "$FORCE_RECREATE" = false ]; then
            webui_restart_needed=true
        fi
    else
        webui_status=$?
    fi
    case "${webui_status:-0}" in
        0|3|4) ;;
        *) exit "${webui_status}" ;;
    esac
    compose_with_napcat config --quiet
    # The adapter image is normally prepared by start-codex.sh; NapCat may be
    # a first-time install, so allow Docker to pull that optional image when
    # it is not present locally.
    if [ "$FORCE_RECREATE" = true ]; then
        compose_with_napcat --profile napcat up -d --pull missing --force-recreate onebot-adapter napcat
    else
        compose_with_napcat --profile napcat up -d --pull missing --no-recreate onebot-adapter napcat
    fi

    # A first-run NapCat container creates webui.json during initialization.
    # Wait briefly for that file, then restart only NapCat if the binding was
    # applied after startup so its listener uses the requested address.
    webui_status=3
    attempts=0
    while [ "$webui_status" -eq 3 ] && [ "$attempts" -lt 30 ]; do
        if [ -f "$SCRIPT_DIR/runtime/napcat/config/webui.json" ]; then
            if configure_existing_napcat_webui; then
                webui_status=0
                webui_restart_needed=true
            else
                webui_status=$?
            fi
        fi
        if [ "$webui_status" -eq 3 ]; then
            attempts=$((attempts + 1))
            sleep 1
        fi
    done
    case "$webui_status" in
        0|4)
            if [ "$webui_restart_needed" = true ]; then
                compose_with_napcat --profile napcat restart napcat
            fi
            ;;
        3)
            echo "NapCat did not create its WebUI config within 30 seconds." >&2
            exit 1
            ;;
        *) exit "$webui_status" ;;
    esac
    compose_with_napcat ps onebot-adapter napcat
else
    compose config --quiet
    if [ "$FORCE_RECREATE" = true ]; then
        compose up -d --pull never --force-recreate onebot-adapter
    else
        compose up -d --pull never --no-recreate onebot-adapter
    fi
    compose ps onebot-adapter
fi
