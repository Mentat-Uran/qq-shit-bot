#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
ENV_FILE="$REPO_ROOT/deploy/openclaw/.env"
HOST_VALUE=${OPS_CONSOLE_LAN_IP:-}

if [ ! -f "$ENV_FILE" ]; then
    echo "Missing $ENV_FILE; create it from .env.example first." >&2
    exit 1
fi

if [ -z "$HOST_VALUE" ]; then
    for interface in en0 en1; do
        HOST_VALUE=$(ipconfig getifaddr "$interface" 2>/dev/null || true)
        [ -n "$HOST_VALUE" ] && break
    done
fi

if [ -z "$HOST_VALUE" ]; then
    echo 'Could not detect a Mac LAN IPv4 address; rerun with OPS_CONSOLE_LAN_IP=x.x.x.x.' >&2
    exit 1
fi

case "$HOST_VALUE" in
    127.*|169.254.*|0.0.0.0|*[!0-9.]*)
        echo 'OPS_CONSOLE_LAN_IP must be a concrete non-loopback IPv4 address.' >&2
        exit 1
        ;;
esac

set_env_value() {
    key=$1
    value=$2
    tmp_file=$(mktemp "${TMPDIR:-/tmp}/qqshitbot-env.XXXXXX")
    cleanup() { rm -f "$tmp_file"; }
    trap cleanup EXIT INT TERM
    awk -F= -v key="$key" -v value="$value" '
        $1 == key { print key "=" value; found=1; next }
        { print }
        END { if (!found) print key "=" value }
    ' "$ENV_FILE" > "$tmp_file"
    chmod 600 "$tmp_file"
    mv "$tmp_file" "$ENV_FILE"
    trap - EXIT INT TERM
}

chmod 600 "$ENV_FILE"
set_env_value OPENCLAW_GATEWAY_BIND_HOST "$HOST_VALUE"
set_env_value OPENCLAW_GATEWAY_PUBLIC_HOST "$HOST_VALUE"
set_env_value OPS_CONSOLE_BIND_HOST "$HOST_VALUE"
set_env_value OPS_CONSOLE_PORT 18888
set_env_value OPS_CONSOLE_AUTH_MODE token

if launchctl print "gui/$(id -u)/com.mentat.qqshitbot.ops-console" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/com.mentat.qqshitbot.ops-console"
    restart_status='restarted'
else
    restart_status='not-installed'
fi

printf 'LAN console configured: host=%s port=18888 auth=token launch-agent=%s\n' "$HOST_VALUE" "$restart_status"
printf 'This mode exposes only the redacted read-only console on the concrete LAN IP; do not forward the port publicly.\n'
