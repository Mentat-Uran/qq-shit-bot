#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONTRACT_FILE="$SCRIPT_DIR/environment-contract.txt"
ENV_FILE="$SCRIPT_DIR/.env"
ALLOW_PLACEHOLDERS=0
APPLY_MIGRATION=0
GENERATE_TOKEN=0

usage() {
    printf '%s\n' 'Usage: validate-env.sh [--env-file PATH] [--migrate] [--generate-token] [--allow-placeholders] [--diagnose]' >&2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --env-file) [ "$#" -ge 2 ] || { usage; exit 2; }; ENV_FILE=$2; shift 2 ;;
        --migrate) APPLY_MIGRATION=1; shift ;;
        --generate-token) GENERATE_TOKEN=1; shift ;;
        --allow-placeholders|--diagnose) ALLOW_PLACEHOLDERS=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage; exit 2 ;;
    esac
done

if [ ! -f "$CONTRACT_FILE" ]; then
    echo 'OpenClaw environment contract is missing.' >&2
    exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
    echo "OpenClaw environment file is missing: $ENV_FILE" >&2
    exit 1
fi

env_value() {
    key=$1
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); value = $0 } END { print value }' "$ENV_FILE"
}

is_placeholder() {
    value=$1
    case "$value" in
        ""|replace-with-*) return 0 ;;
        *) return 1 ;;
    esac
}

replace_env_value() {
    key=$1
    value=$2
    temp_file="$ENV_FILE.tmp.$$"
    awk -v key="$key" -v value="$value" '
        BEGIN { replaced = 0 }
        $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
            print key "=" value
            replaced = 1
            next
        }
        { print }
        END { if (!replaced) print key "=" value }
    ' "$ENV_FILE" > "$temp_file"
    mv "$temp_file" "$ENV_FILE"
}

if [ "$APPLY_MIGRATION" -eq 1 ]; then
    awk -F'|' 'NF == 2 && $1 !~ /^[[:space:]]*#/ && $1 != "" { print }' "$CONTRACT_FILE" |
    while IFS='|' read -r alias canonical; do
        current=$(env_value "$canonical")
        legacy=$(env_value "$alias")
        if is_placeholder "$current" && [ -n "$legacy" ] && ! is_placeholder "$legacy"; then
            replace_env_value "$canonical" "$legacy"
            printf 'Migrated environment alias %s to %s (value redacted).\n' "$alias" "$canonical"
        fi
    done
fi

if [ "$GENERATE_TOKEN" -eq 1 ]; then
    gateway_token=$(env_value OPENCLAW_GATEWAY_TOKEN)
    if is_placeholder "$gateway_token"; then
        command -v openssl >/dev/null 2>&1 || { echo 'openssl is required to generate OPENCLAW_GATEWAY_TOKEN.' >&2; exit 1; }
        replace_env_value OPENCLAW_GATEWAY_TOKEN "$(openssl rand -hex 32)"
        printf '%s\n' 'Generated OPENCLAW_GATEWAY_TOKEN (value redacted).'
    fi
fi

checked=0
while IFS='|' read -r key required placeholder; do
    case "$key" in ''|\#*) continue ;; esac
    [ "$required" = required ] || continue
    checked=$((checked + 1))
    value=$(env_value "$key")
    if is_placeholder "$value"; then
        if [ "$ALLOW_PLACEHOLDERS" -eq 1 ]; then
            printf 'PLACEHOLDER %s (value redacted)\n' "$key"
        else
            printf 'MISSING %s (value redacted)\n' "$key" >&2
            exit 1
        fi
    fi
done < "$CONTRACT_FILE"

case "$(uname -s 2>/dev/null || true)" in
    Linux|Darwin)
        mode=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || true)
        case "$mode" in 600|400|640) : ;; *) printf 'WARNING env file permissions are %s; use chmod 600 %s\n' "${mode:-unknown}" "$ENV_FILE" >&2 ;; esac
        ;;
esac

printf 'OpenClaw environment validation passed: %s required entries checked; secrets redacted.\n' "$checked"
