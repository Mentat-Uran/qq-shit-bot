#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
. "$SCRIPT_DIR/lib.sh"

case "${1:-}" in
    --allow-placeholders|--diagnose)
        sh "$REPO_ROOT/deploy/openclaw/validate-mac-env.sh" --env-file "$ENV_FILE" --allow-placeholders
        ;;
    "")
        sh "$REPO_ROOT/deploy/openclaw/validate-mac-env.sh" --env-file "$ENV_FILE"
        ;;
    *)
        echo 'Usage: check-env.sh [--allow-placeholders]' >&2
        exit 2
        ;;
esac

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker compose --env-file "$ENV_FILE" -f "$REPO_ROOT/deploy/openclaw/docker-compose.mac.yml" config --quiet
    echo 'macOS Compose configuration is valid; secrets redacted.'
else
    echo 'Docker Compose not available; environment contract passed, Compose not checked.' >&2
fi
