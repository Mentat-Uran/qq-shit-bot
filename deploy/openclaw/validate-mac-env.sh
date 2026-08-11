#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE="$SCRIPT_DIR/.env"
ALLOW_PLACEHOLDERS=0

usage() {
    printf '%s\n' 'Usage: validate-mac-env.sh [--env-file PATH] [--allow-placeholders]' >&2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --env-file) [ "$#" -ge 2 ] || { usage; exit 2; }; ENV_FILE=$2; shift 2 ;;
        --allow-placeholders|--diagnose) ALLOW_PLACEHOLDERS=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage; exit 2 ;;
    esac
done

if [ ! -f "$ENV_FILE" ]; then
    echo "OpenClaw environment file is missing: $ENV_FILE" >&2
    exit 1
fi

env_value() {
    key=$1
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); value = $0 } END { print value }' "$ENV_FILE"
}

is_placeholder() {
    case "$1" in
        ""|replace-with-*) return 0 ;;
        *) return 1 ;;
    esac
}

check_value() {
    key=$1
    if is_placeholder "$(env_value "$key")"; then
        if [ "$ALLOW_PLACEHOLDERS" -eq 1 ]; then
            printf 'PLACEHOLDER %s (value redacted)\n' "$key"
        else
            printf 'MISSING %s (value redacted)\n' "$key" >&2
            exit 1
        fi
    fi
}

if [ "$ALLOW_PLACEHOLDERS" -eq 1 ]; then
    sh "$SCRIPT_DIR/validate-env.sh" --env-file "$ENV_FILE" --allow-placeholders
else
    sh "$SCRIPT_DIR/validate-env.sh" --env-file "$ENV_FILE"
fi

gateway_bind=$(env_value OPENCLAW_GATEWAY_BIND_HOST)
gateway_bind=${gateway_bind:-127.0.0.1}
gateway_public=$(env_value OPENCLAW_GATEWAY_PUBLIC_HOST)
gateway_public=${gateway_public:-127.0.0.1}
console_bind=$(env_value OPS_CONSOLE_BIND_HOST)
console_bind=${console_bind:-127.0.0.1}
console_port=$(env_value OPS_CONSOLE_PORT)
console_port=${console_port:-18888}

case "$console_port" in
    *[!0-9]*|"") echo 'OPS_CONSOLE_PORT must be numeric.' >&2; exit 1 ;;
esac
if [ "$console_port" -lt 1024 ] || [ "$console_port" -gt 65535 ]; then
    echo 'OPS_CONSOLE_PORT must be between 1024 and 65535.' >&2
    exit 1
fi

is_loopback() {
    case "$1" in
        127.0.0.1|localhost|::1) return 0 ;;
        *) return 1 ;;
    esac
}

if ! is_loopback "$gateway_bind" || ! is_loopback "$console_bind"; then
    check_value OPS_CONSOLE_TOKEN
fi

if ! is_loopback "$gateway_bind"; then
    if is_placeholder "$gateway_public"; then
        if [ "$ALLOW_PLACEHOLDERS" -eq 1 ]; then
            printf 'PLACEHOLDER OPENCLAW_GATEWAY_PUBLIC_HOST (value redacted)\n'
        else
            echo 'OPENCLAW_GATEWAY_PUBLIC_HOST is required when the Gateway leaves loopback.' >&2
            exit 1
        fi
    fi
    case "$gateway_bind" in
        0.0.0.0|::) echo 'WARNING Gateway is bound to all interfaces; enforce a Mac firewall rule.' >&2 ;;
    esac
fi

printf 'macOS environment validation passed: Gateway and Operations Console values checked; secrets redacted.\n'
