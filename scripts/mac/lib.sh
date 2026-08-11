#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
DEPLOY_DIR="$REPO_ROOT/deploy/openclaw"
ENV_FILE="$DEPLOY_DIR/.env"

env_value() {
    key=$1
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); value = $0 } END { print value }' "$ENV_FILE"
}

require_env_file() {
    if [ ! -f "$ENV_FILE" ]; then
        echo "Missing $ENV_FILE; create it from .env.example without printing credentials." >&2
        exit 1
    fi
    if ! chmod 600 "$ENV_FILE"; then
        echo "Cannot enforce private permissions on $ENV_FILE." >&2
        exit 1
    fi
}

require_docker() {
    command -v docker >/dev/null 2>&1 || { echo 'Docker Desktop is required.' >&2; exit 1; }
    docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is required.' >&2; exit 1; }
}

compose() {
    require_docker
    docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.mac.yml" "$@"
}

require_env_file
