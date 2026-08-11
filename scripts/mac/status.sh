#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"
compose ps --all || true
QQBOT_DEPLOYMENT=mac python3 "$REPO_ROOT/scripts/openclaw_diagnostic.py" \
    --mode health --deployment mac --env-file "$ENV_FILE" --compose-dir "$DEPLOY_DIR" --pretty
