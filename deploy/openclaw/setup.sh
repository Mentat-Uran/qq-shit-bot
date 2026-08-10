#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
ENV_FILE="$SCRIPT_DIR/.env"
RUNTIME_DIR="$SCRIPT_DIR/runtime"

replace_env_value() {
    key=$1
    value=$2
    temp_file="$ENV_FILE.tmp.$$"
    awk -v key="$key" -v value="$value" '
        BEGIN { replaced = 0 }
        index($0, key "=") == 1 {
            print key "=" value
            replaced = 1
            next
        }
        { print }
        END {
            if (!replaced) {
                print key "=" value
            }
        }
    ' "$ENV_FILE" > "$temp_file"
    mv "$temp_file" "$ENV_FILE"
}

env_value() {
    key=$1
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); value = $0 } END { print value }' "$ENV_FILE"
}

require_configured() {
    key=$1
    value=$(env_value "$key")
    case "$value" in
        ""|replace-with-*)
            printf 'Set %s in %s before running setup.\n' "$key" "$ENV_FILE" >&2
            exit 1
            ;;
    esac
}

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required; OpenClaw is not installed on the host." >&2
    exit 1
fi

if docker compose version >/dev/null 2>&1; then
    compose() {
        docker compose \
            -f "$SCRIPT_DIR/docker-compose.yml" \
            -f "$SCRIPT_DIR/docker-compose.local.yml" "$@"
    }
elif command -v docker-compose >/dev/null 2>&1; then
    compose() {
        docker-compose \
            -f "$SCRIPT_DIR/docker-compose.yml" \
            -f "$SCRIPT_DIR/docker-compose.local.yml" "$@"
    }
else
    echo "Docker Compose is required." >&2
    exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
    cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "Created $ENV_FILE. Fill in the QQ and model credentials, then rerun setup." >&2
    exit 1
fi
chmod 600 "$ENV_FILE"

replace_env_value OPENCLAW_UID "$(id -u)"
replace_env_value OPENCLAW_GID "$(id -g)"
replace_env_value QWEN_BASE_URL "http://qwen-vision:11434"
replace_env_value QWEN_MODEL_CACHE_VOLUME "qqshitbot-openclaw_qwen-vision-model-cache"
replace_env_value QWEN_MODEL_CACHE_EXTERNAL "false"

# Unix and Windows use the same contract, alias migration, and redacted checks.
sh "$SCRIPT_DIR/validate-env.sh" --migrate --generate-token

if ! docker info >/dev/null 2>&1; then
    echo "The Docker daemon is not running." >&2
    exit 1
fi

mkdir -p "$RUNTIME_DIR/config" "$RUNTIME_DIR/workspace"
chmod 700 "$RUNTIME_DIR" "$RUNTIME_DIR/config" "$RUNTIME_DIR/workspace"

if [ -f "$RUNTIME_DIR/config/openclaw.json" ]; then
    if grep -qE 'mage-video-cli\.mjs|nvidia-image-cli\.mjs' "$RUNTIME_DIR/config/openclaw.json"; then
        echo "Migrating retired video/image CLI routes out of $RUNTIME_DIR/config/openclaw.json." >&2
        cp "$SCRIPT_DIR/openclaw.json" "$RUNTIME_DIR/config/openclaw.json"
    fi
else
    cp "$SCRIPT_DIR/openclaw.json" "$RUNTIME_DIR/config/openclaw.json"
fi
for context_file in AGENTS.md SOUL.md; do
    if [ ! -f "$RUNTIME_DIR/workspace/$context_file" ]; then
        cp "$REPO_ROOT/$context_file" "$RUNTIME_DIR/workspace/$context_file"
    fi
done
chmod 600 "$RUNTIME_DIR/config/openclaw.json" "$RUNTIME_DIR/workspace/AGENTS.md" "$RUNTIME_DIR/workspace/SOUL.md"

cd "$SCRIPT_DIR"
compose pull openclaw-gateway openclaw-cli qwen-vision
compose run --rm --no-deps qq-diagnostic-filter-init

if ! compose run --rm --no-deps openclaw-cli plugins inspect qqbot --json >/dev/null 2>&1; then
    plugin_spec=$(env_value OPENCLAW_QQBOT_PLUGIN)
    compose run --rm --no-deps openclaw-cli plugins install "$plugin_spec" --force --pin
fi

compose run --rm --no-deps openclaw-cli config validate
compose up -d qwen-vision

qwen_ready=0
qwen_model_list=''
for attempt in $(seq 1 30); do
    if qwen_model_list=$(compose exec -T qwen-vision ollama list 2>/dev/null); then
        qwen_ready=1
        break
    fi
    sleep 2
done
if [ "$qwen_ready" -ne 1 ]; then
    echo 'The OpenClaw qwen-vision service did not become ready.' >&2
    exit 1
fi
if ! printf '%s\n' "$qwen_model_list" | grep -q '^qwen2\.5vl:7b[[:space:]]'; then
    compose exec -T qwen-vision ollama pull qwen2.5vl:7b
fi
compose up -d openclaw-gateway context-recovery
compose ps openclaw-gateway context-recovery

register_proactive_review() {
    job_name=$1
    cron_expression=$2
    description=$3
    prompt=$(cat "$SCRIPT_DIR/proactive-review-prompt.txt")
    home_channel=$(env_value QQBOT_HOME_CHANNEL)
    timezone=$(env_value OPENCLAW_TZ)
    session_key="agent:main:qqbot:group:$home_channel"
    target="qqbot:group:$home_channel"
    for attempt in 1 2 3 4; do
        if compose exec -T openclaw-gateway node dist/index.js cron add "$job_name" \
            --cron "$cron_expression" --tz "$timezone" --exact --message "$prompt" \
            --session-key "$session_key" --announce --channel qqbot --to "$target" \
            --best-effort-deliver --description "$description" \
            --declaration-key "$job_name" --timeout-seconds 180; then
            return 0
        fi
        sleep 5
    done
    echo "Failed to register declarative proactive review job: $job_name" >&2
    return 1
}

register_proactive_review \
    qqbot-proactive-review '*/10 8-23,0-1 * * *' \
    'Review collected QQ group context every 10 minutes during daytime.'
register_proactive_review \
    qqbot-proactive-review-night '*/30 2-7 * * *' \
    'Review collected QQ group context every 30 minutes overnight.'

printf '\nOpenClaw QQ Bot is running at http://127.0.0.1:%s\n' "$(env_value OPENCLAW_GATEWAY_PORT)"
