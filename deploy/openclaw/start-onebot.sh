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
WITH_NAPCAT=false

usage() {
    printf '%s\n' 'Usage: start-onebot.sh [--with-napcat]' >&2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --with-napcat) WITH_NAPCAT=true; shift ;;
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

mkdir -p "$SCRIPT_DIR/runtime/napcat/config" "$SCRIPT_DIR/runtime/napcat/qq"
chmod 700 "$SCRIPT_DIR/runtime/napcat" "$SCRIPT_DIR/runtime/napcat/config" "$SCRIPT_DIR/runtime/napcat/qq"

if [ "$WITH_NAPCAT" = true ]; then
    compose_with_napcat config --quiet
    # The adapter image is normally prepared by start-codex.sh; NapCat may be
    # a first-time install, so allow Docker to pull that optional image when
    # it is not present locally.
    compose_with_napcat --profile napcat up -d --pull missing --force-recreate onebot-adapter napcat
    compose_with_napcat ps onebot-adapter napcat
else
    compose config --quiet
    compose up -d --pull never --force-recreate onebot-adapter
    compose ps onebot-adapter
fi
