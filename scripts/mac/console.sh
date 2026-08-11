#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"

OPEN_BROWSER=1
case "${1:-}" in
    "") ;;
    --no-browser) OPEN_BROWSER=0 ;;
    -h|--help)
        printf '%s\n' 'Usage: console.sh [--no-browser]'
        exit 0
        ;;
    *)
        echo 'Usage: console.sh [--no-browser]' >&2
        exit 2
        ;;
esac

export QQBOT_DEPLOYMENT=mac
export OPS_CONSOLE_BIND_HOST=$(env_value OPS_CONSOLE_BIND_HOST)
export OPS_CONSOLE_PORT=$(env_value OPS_CONSOLE_PORT)
export OPS_CONSOLE_TOKEN=$(env_value OPS_CONSOLE_TOKEN)
OPS_CONSOLE_BIND_HOST=${OPS_CONSOLE_BIND_HOST:-127.0.0.1}
OPS_CONSOLE_PORT=${OPS_CONSOLE_PORT:-18888}

PYTHON_BIN=${PYTHON_BIN:-}
if [ -z "$PYTHON_BIN" ]; then
    PYTHON_BIN=$(command -v python3 || true)
fi
if [ -z "$PYTHON_BIN" ] || [ ! -x "$PYTHON_BIN" ]; then
    echo 'Python 3 is required for the Operations Console.' >&2
    exit 1
fi

cd "$REPO_ROOT"
if [ "$OPEN_BROWSER" -eq 1 ]; then
    exec "$PYTHON_BIN" -m ops_console.server --deployment mac --host "$OPS_CONSOLE_BIND_HOST" --port "$OPS_CONSOLE_PORT" --open-browser
fi
exec "$PYTHON_BIN" -m ops_console.server --deployment mac --host "$OPS_CONSOLE_BIND_HOST" --port "$OPS_CONSOLE_PORT"
