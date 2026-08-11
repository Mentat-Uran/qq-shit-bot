#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"

# Compose interpolation uses the shell environment before values from .env.
# Use the logged-in macOS user's IDs so 0700/0600 bind mounts remain readable.
OPENCLAW_UID=$(id -u)
OPENCLAW_GID=$(id -g)
export OPENCLAW_UID OPENCLAW_GID

sh "$DEPLOY_DIR/validate-mac-env.sh" --env-file "$ENV_FILE"
mkdir -p "$DEPLOY_DIR/runtime/config" "$DEPLOY_DIR/runtime/workspace"
chmod 700 "$DEPLOY_DIR/runtime" "$DEPLOY_DIR/runtime/config" "$DEPLOY_DIR/runtime/workspace"
cp "$DEPLOY_DIR/openclaw.mac.json" "$DEPLOY_DIR/runtime/config/openclaw.json"
if [ ! -f "$DEPLOY_DIR/runtime/workspace/AGENTS.md" ]; then cp "$DEPLOY_DIR/bot-workspace/AGENTS.md" "$DEPLOY_DIR/runtime/workspace/AGENTS.md"; fi
if [ ! -f "$DEPLOY_DIR/runtime/workspace/SOUL.md" ]; then cp "$REPO_ROOT/SOUL.md" "$DEPLOY_DIR/runtime/workspace/SOUL.md"; fi
chmod 600 "$DEPLOY_DIR/runtime/config/openclaw.json" "$DEPLOY_DIR/runtime/workspace/AGENTS.md" "$DEPLOY_DIR/runtime/workspace/SOUL.md"
printf '%s\n' '{"image":true,"video":false}' > "$DEPLOY_DIR/runtime/config/media-capabilities.json"
chmod 600 "$DEPLOY_DIR/runtime/config/media-capabilities.json"

# Build the small Mac image once so its read-only web-search bundle patch is
# applied as root; the long-running gateway still uses the current macOS UID.
compose --profile cli build --pull openclaw-gateway openclaw-cli
compose run --rm --no-deps qq-diagnostic-filter-init

if ! compose --profile cli run --rm --no-deps openclaw-cli plugins inspect qqbot --json >/dev/null 2>&1; then
    plugin_spec=$(env_value OPENCLAW_QQBOT_PLUGIN)
    compose --profile cli run --rm --no-deps openclaw-cli plugins install "$plugin_spec" --force --pin
fi
compose --profile cli run --rm --no-deps openclaw-cli config validate
compose up -d openclaw-gateway context-recovery

register_proactive_review() {
    job_name=$1
    cron_expression=$2
    description=$3
    home_channel=$(env_value QQBOT_HOME_CHANNEL)
    case "$home_channel" in
        ''|replace-with-*) echo "QQBOT_HOME_CHANNEL is not set; skipping proactive review job: $job_name"; return 0 ;;
    esac
    prompt=$(cat "$DEPLOY_DIR/proactive-review-prompt.txt")
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
    echo "Failed to register proactive review job: $job_name" >&2
    return 1
}

if [ "$(env_value QQBOT_PROACTIVE_REVIEW_ENABLED)" = "true" ]; then
    register_proactive_review qqbot-proactive-review '*/10 8-23,0-1 * * *' 'Review one pending QQ group message every 10 minutes during daytime.'
    register_proactive_review qqbot-proactive-review-night '*/30 2-7 * * *' 'Review one pending QQ group message every 30 minutes overnight.'
else
    echo "QQBOT_PROACTIVE_REVIEW_ENABLED is not true; skipping proactive review job registration."
fi

compose ps openclaw-gateway context-recovery
printf '\nMac OpenClaw QQ Bot is running; Gateway port=%s; local vision services are not part of this stack.\n' "$(env_value OPENCLAW_GATEWAY_PORT)"
