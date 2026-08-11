import json
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
DEPLOY_DIR = ROOT / "deploy" / "openclaw"


def load_openclaw_config():
    return json.loads((DEPLOY_DIR / "openclaw.json").read_text(encoding="utf-8"))


def test_compose_uses_pinned_image_and_loopback_port():
    compose = yaml.safe_load((DEPLOY_DIR / "docker-compose.yml").read_text())
    common = compose["x-openclaw-common"]
    qwen = compose["services"]["qwen-vision"]
    gateway = compose["services"]["openclaw-gateway"]
    plugin_init = compose["services"]["qq-diagnostic-filter-init"]
    recovery = compose["services"]["context-recovery"]

    assert compose["name"] == "qq-shit-bot"
    assert "ghcr.io/openclaw/openclaw:2026.7.1" in common["image"]
    assert gateway["ports"] == ["127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}:18789"]
    assert "/healthz" in gateway["healthcheck"]["test"][-1]
    assert common["cap_drop"] == ["NET_RAW", "NET_ADMIN"]
    assert common["security_opt"] == ["no-new-privileges:true"]
    assert common["environment"]["OPENCLAW_SKIP_STARTUP_MODEL_PREWARM"] == "1"
    assert qwen["gpus"] == "all"
    assert qwen["environment"]["OLLAMA_MAX_LOADED_MODELS"] == "1"
    assert qwen["environment"]["OLLAMA_KEEP_ALIVE"] == "${OLLAMA_KEEP_ALIVE:-3m}"
    assert qwen["mem_limit"] == "${QWEN_MEMORY_LIMIT:-6g}"
    assert qwen["cpus"] == "${QWEN_CPUS:-2.0}"
    assert "openclaw-logs:/tmp/openclaw" in common["volumes"]
    assert "openclaw-state:/home/node/.openclaw/state" in common["volumes"]
    assert gateway["depends_on"]["qq-diagnostic-filter-init"]["condition"] == "service_completed_successfully"
    assert "qqbot-history-media-patch.mjs" in " ".join(plugin_init["volumes"])
    assert "media-policy.mjs" in " ".join(plugin_init["volumes"])
    assert "diagnostic-policy.mjs" in " ".join(plugin_init["volumes"])
    assert "web-search-patch.mjs" in " ".join(plugin_init["volumes"])
    assert "context-recovery.mjs" in " ".join(plugin_init["volumes"])
    assert "context-recovery-core.mjs" in " ".join(plugin_init["volumes"])
    assert "openclaw-state:/home/node/.openclaw/state" in " ".join(plugin_init["volumes"])
    assert "openclaw-logs:/tmp/openclaw" in " ".join(plugin_init["volumes"])
    init_command = plugin_init["command"][0]
    assert "chown -R ${OPENCLAW_UID:-1000}:${OPENCLAW_GID:-1000} /home/node/.openclaw/state" in init_command
    for name in ("media-policy.mjs", "diagnostic-policy.mjs", "context-recovery-core.mjs"):
        assert f"cp /seed/{name} /opt/openclaw-local/{name}" in init_command
    assert gateway["command"][:2] == ["sh", "-c"]
    assert "qqbot-history-media-patch.mjs" in gateway["command"][2]
    assert "web-search-patch.mjs" in gateway["command"][2]
    assert "exec node dist/index.js gateway" in gateway["command"][2]
    assert "tee -a" in gateway["command"][2]
    assert recovery["depends_on"]["openclaw-gateway"]["condition"] == "service_healthy"
    assert recovery["healthcheck"] == {"disable": True}
    assert recovery["command"] == ["node", "/opt/openclaw-local/context-recovery.mjs"]
    assert compose["volumes"]["qq-diagnostic-filter"]["name"] == "qqshitbot-openclaw_qq-diagnostic-filter"
    assert compose["volumes"]["openclaw-logs"]["name"] == "qqshitbot-openclaw_openclaw-logs"
    assert compose["volumes"]["openclaw-state"]["name"] == "qqshitbot-openclaw_openclaw-state"


def test_openclaw_config_enables_qq_plugin_and_uses_secret_refs():
    config = load_openclaw_config()

    assert config["plugins"]["allow"] == ["qqbot", "qq-diagnostic-filter", "duckduckgo"]
    assert config["plugins"]["entries"]["qqbot"]["enabled"] is True
    assert config["plugins"]["entries"]["qq-diagnostic-filter"]["enabled"] is True
    assert config["plugins"]["entries"]["duckduckgo"]["enabled"] is True
    assert config["plugins"]["entries"]["codex"]["enabled"] is False
    assert config["plugins"]["load"]["paths"] == [
        "/opt/openclaw-local/qq-diagnostic-filter.mjs"
    ]
    qqbot = config["channels"]["qqbot"]
    assert qqbot["clientSecret"] == "${QQBOT_CLIENT_SECRET}"
    assert qqbot["dmPolicy"] == "open"
    assert qqbot["groupPolicy"] == "open"
    assert qqbot["groups"]["*"]["requireMention"] is True
    assert config["gateway"]["terminal"]["enabled"] is False
    assert config["tools"]["deny"] == ["exec", "read", "write"]
    assert config["messages"]["suppressToolErrors"] is True
    assert config["agents"]["defaults"]["model"]["fallbacks"] == ["deepseek/deepseek-chat"]
    assert config["models"]["providers"]["deepseek"]["baseUrl"] == "https://api.deepseek.com/v1"
    assert config["models"]["providers"]["deepseek"]["apiKey"]["id"] == "DEEPSEEK_API_KEY"
    assert config["tools"]["web"]["search"] == {
        "enabled": True,
        "provider": "duckduckgo",
    }


def test_openclaw_config_collects_group_context_and_keeps_vision_local():
    config = load_openclaw_config()

    defaults = config["agents"]["defaults"]
    assert defaults["contextTokens"] == 32768
    assert defaults["timeoutSeconds"] == 900
    assert defaults["utilityModel"] == ""
    assert defaults["imageModel"] == "local-vision/qwen2.5vl:7b"
    assert defaults["contextInjection"] == "continuation-skip"
    assert defaults["bootstrapMaxChars"] == 4500
    assert defaults["bootstrapTotalMaxChars"] == 7500
    assert defaults["imageMaxDimensionPx"] == 768
    assert defaults["imageQuality"] == "efficient"
    assert defaults["contextLimits"] == {"postCompactionMaxChars": 800, "toolResultMaxChars": 6000}
    assert defaults["compaction"] == {
        "mode": "safeguard",
        "keepRecentTokens": 8000,
        "recentTurnsPreserve": 2,
        "maxHistoryShare": 0.4,
        "truncateAfterCompaction": True,
        "postCompactionSections": [],
        "memoryFlush": {"enabled": False},
    }
    assert config["session"]["resetByType"]["group"] == {
        "mode": "idle",
        "idleMinutes": 60,
    }

    local_qwen = config["models"]["providers"]["local-vision"]["models"][0]
    assert config["models"]["providers"]["local-vision"]["baseUrl"] == "http://qwen-vision:11434/v1"
    assert local_qwen["compat"]["supportsTools"] is False

    qqbot = config["channels"]["qqbot"]
    assert qqbot["contextVisibility"] == "allowlist_quote"
    assert qqbot["historyLimit"] == 1
    assert qqbot["groups"]["*"]["historyLimit"] == 1
    assert qqbot["groups"]["*"]["ignoreOtherMentions"] is True
    assert "NO_REPLY" in qqbot["groups"]["*"]["prompt"]
    assert "每次艾特按独立话题处理" in qqbot["groups"]["*"]["prompt"]
    assert "明确引用若实际带图" in qqbot["groups"]["*"]["prompt"]
    assert "政治或高风险问题用俏皮打岔" in qqbot["groups"]["*"]["prompt"]

    diagnostic_filter = (DEPLOY_DIR / "qq-diagnostic-filter.mjs").read_text(encoding="utf-8")
    assert '"reply_payload_sending"' in diagnostic_filter
    assert "shouldSuppressQQPayload" in diagnostic_filter
    policy = (DEPLOY_DIR / "diagnostic-policy.mjs").read_text(encoding="utf-8")
    assert "payload.isError" in policy
    assert "payload.isFallbackNotice" in policy
    assert "isProcessPreamble" in policy
    assert "qqbot_process_preamble_suppressed" in policy

    history_media_patch = (DEPLOY_DIR / "qqbot-history-media-patch.mjs").read_text(encoding="utf-8")
    assert "qqbot-history-media-v1" in history_media_patch
    assert "function resolveLatestHistoricalMedia" not in history_media_patch
    assert "function promoteHistoricalMedia" not in history_media_patch
    assert "qqbot-historical-media-disabled-v2" in history_media_patch
    assert "disableHistoricalMediaPromotion" in history_media_patch
    assert "videoAttachmentPaths" in history_media_patch
    assert "qqbot-video-mention-gate-v2" in history_media_patch
    assert "video-gate-after-group-info" in history_media_patch
    assert "qqbot-video-mention-gate-v1" in history_media_patch
    assert "filterVideoByMention" in history_media_patch
    assert "effectiveWasMentioned === true" in history_media_patch
    assert "qqbot-single-image-context-v1" in history_media_patch
    assert "imageMediaFromAttachments" in history_media_patch
    assert "selectRecentGroupImage" in history_media_patch
    assert "processed = mergeSingleQuotedImage(processed" in history_media_patch

    context_recovery = (DEPLOY_DIR / "context-recovery.mjs").read_text(encoding="utf-8")
    context_recovery_core = (DEPLOY_DIR / "context-recovery-core.mjs").read_text(encoding="utf-8")
    assert "sessions.reset" in context_recovery
    assert "context overflow detected" in context_recovery_core
    assert "stalled_agent_run" in context_recovery_core
    assert "OPENCLAW_GATEWAY_URL" in context_recovery
    assert "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS" in context_recovery

    assert config["messages"]["inbound"]["debounceMs"] == 700
    assert config["messages"]["queue"] == {
        "mode": "steer",
        "debounceMs": 700,
        "cap": 2,
        "drop": "old",
    }
    image_models = config["tools"]["media"]["models"]
    assert image_models == [
        {
            "provider": "local-vision",
            "model": "qwen2.5vl:7b",
            "capabilities": ["image"],
            "timeoutSeconds": 180,
            "maxChars": 400,
        }
    ]
    assert config["tools"]["media"]["video"]["enabled"] is False
    assert "nvidia-image-cli.mjs" not in json.dumps(config)
    assert "mage-video-cli.mjs" not in json.dumps(config)

    serialized = json.dumps(config)
    assert "openai/" not in serialized
    assert "api.openai.com" not in serialized
    assert "gpt-" not in serialized


def test_env_example_pins_matching_openclaw_and_plugin_versions():
    env_text = (DEPLOY_DIR / ".env.example").read_text()

    assert "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.7.1" in env_text
    assert "OPENCLAW_QQBOT_PLUGIN=@openclaw/qqbot@2026.7.1" in env_text
    assert "QQBOT_CLIENT_SECRET=replace-with-qq-app-secret" in env_text
    assert "QQBOT_ALLOWED_USER_OPENID=" in env_text
    assert "QQBOT_ALLOWED_MEMBER_OPENID=" in env_text
    assert "QQBOT_PROACTIVE_REVIEW_ENABLED=false" in env_text
    assert "DEEPSEEK_API_KEY=replace-with-deepseek-api-key" in env_text
    assert "microsoft/Mage-VL" not in env_text
    assert "nvidia/LocateAnything-3B" not in env_text
    assert "QWEN_MODEL_ID=qwen2.5vl:7b" in env_text
    assert "QWEN_MEMORY_LIMIT=6g" in env_text
    assert "QWEN_BASE_URL=http://qwen-vision:11434" in env_text
    assert "QWEN_MODEL_CACHE_VOLUME=" in env_text
    assert "QWEN_MODEL_CACHE_EXTERNAL=false" in env_text
    assert "sk-" not in env_text


def test_setup_invokes_openclaw_only_through_docker_compose():
    setup = (DEPLOY_DIR / "setup.sh").read_text()

    assert "compose run --rm --no-deps openclaw-cli plugins install" in setup
    assert "docker-compose" in setup
    assert "npm install" not in setup
    assert "pnpm install" not in setup
    assert 'case "$home_channel" in' in setup
    assert "''|replace-with-*)" in setup
    assert "QQBOT_PROACTIVE_REVIEW_ENABLED" in setup


def test_setup_requires_fallback_key_and_migrates_legacy_media_config():
    setup = (DEPLOY_DIR / "setup.sh").read_text()

    assert "validate-env.sh" in setup
    assert "--migrate --generate-token" in setup
    assert "--declaration-key" in setup
    assert "qqbot-proactive-review-night" in setup
    assert "skipping proactive review job registration" in setup
    assert "environment-contract.txt" in (DEPLOY_DIR / "validate-env.sh").read_text()
    assert "DEEPSEEK_API_KEY=replace-with-deepseek-api-key" in (DEPLOY_DIR / ".env.example").read_text()
    assert "Refreshing $RUNTIME_DIR/config/openclaw.json from the versioned defaults." in setup
    assert "cron list --all --json" in setup
    assert "cron remove" in setup


def test_windows_launcher_and_local_compose_overlay_are_present():
    launcher = (DEPLOY_DIR / "Start-OpenClawDocker.ps1").read_text()
    watcher = (DEPLOY_DIR / "Watch-OpenClawModel.ps1").read_text()
    overlay = (DEPLOY_DIR / "docker-compose.local.yml").read_text()

    assert "DEEPSEEK_API_KEY" in launcher
    assert "deepseek-api-key.dpapi" not in launcher
    assert "Watch-OpenClawModel.ps1" in launcher
    assert "SENSENOVA_API_KEY" in watcher
    assert "fallback" in watcher.lower()
    assert "deepseek/deepseek-chat" not in watcher
    assert "*/10 8-23,0-1 * * *" in launcher
    assert "QQBOT_PROACTIVE_REVIEW_ENABLED" in launcher
    assert "*/30 2-7 * * *" in launcher
    assert "Asia/Shanghai" in launcher
    assert "environment:" in overlay
    assert "DEEPSEEK_API_KEY" in overlay
    assert "api.deepseek.com" not in overlay
    assert "sk-" not in launcher
    assert "sk-" not in watcher
    assert "sk-" not in overlay
    assert "local-vision\\docker-compose.yml" not in launcher
    assert (DEPLOY_DIR / "Start-OpenClawVision.ps1").exists()
    assert (DEPLOY_DIR / "Stop-OpenClawVision.ps1").exists()
    assert (DEPLOY_DIR / "Set-OpenClawMediaCapabilities.ps1").exists()
    assert (DEPLOY_DIR / "Test-OpenClawEnvironment.ps1").exists()
    assert "Test-OpenClawEnvironment.ps1" in launcher
    assert "QQBOT_HOME_CHANNEL" in launcher
    assert "'cron', 'list'" in launcher
    assert "'cron', 'remove'" in launcher

    capability_script = (DEPLOY_DIR / "Set-OpenClawMediaCapabilities.ps1").read_text(encoding="utf-8")
    assert "media-capabilities.json" in capability_script
    assert "Never claim to have seen an image" in capability_script
    assert "ValidateSet('none', 'image')" in capability_script
    assert "Remove('imageModel')" in capability_script
    assert "Remove('local-vision')" in capability_script
    assert "switch ($RestartGateway)" in capability_script or "if ($RestartGateway)" in capability_script
    assert "$videoEnabled = $false" in capability_script

    history_patch = (DEPLOY_DIR / "qqbot-history-media-patch.mjs").read_text(encoding="utf-8")
    assert "qqbot-media-capabilities-v1" in history_patch
    assert "filterMediaByCapability" in history_patch
    assert "readMediaCapabilities" in history_patch
    assert "qqbot-video-mention-gate-v2" in history_patch
    assert "video-gate-after-group-info" in history_patch
    assert "!event?.groupOpenid || groupInfo?.gate?.effectiveWasMentioned === true" in history_patch
    assert "hermes-qq-history-media-v1" in history_patch
    assert "normalizeLegacyMarkers" in history_patch
    vision_launcher = (DEPLOY_DIR / "Start-OpenClawVision.ps1").read_text(encoding="utf-8")
    assert "qwen-vision" in vision_launcher
    assert "--force-recreate" in vision_launcher


def test_retired_visual_code_is_removed_and_not_active():
    archive = ROOT / "docs" / "retired-visual"
    assert not archive.exists()
    assert not (DEPLOY_DIR / "docker-compose.video.yml").exists()
    assert "video-bridge" not in (DEPLOY_DIR / "docker-compose.yml").read_text(encoding="utf-8")
    assert "image-fusion" not in (DEPLOY_DIR / "docker-compose.yml").read_text(encoding="utf-8")
    assert "microsoft/Mage-VL" not in json.dumps(load_openclaw_config())
    assert "nvidia/LocateAnything-3B" not in json.dumps(load_openclaw_config())


def test_windows_batch_launcher_points_to_openclaw_startup_script():
    launcher = (ROOT / "scripts" / "windows" / "Start-OpenClawQQBot.bat").read_text(encoding="utf-8")

    assert "deploy\\openclaw\\Start-OpenClawDocker.ps1" not in launcher
    assert "%~dp0..\\.." in launcher
    assert "docker compose" in launcher
    assert "qwen2.5vl:7b" in launcher
    assert "--pull never" in launcher
    assert "powershell" not in launcher.lower()
    assert "sk-" not in launcher
    assert "migrate_env_alias DEEPSEEK_API_KEY HERMES_DEEPSEEK_API_KEY" in launcher
    assert "migrate_env_alias QQBOT_HOME_CHANNEL QQBOT_GROUP_OPENID" in launcher
    assert 'copy /y "openclaw.json" "runtime\\config\\openclaw.json" >nul\nif errorlevel 1 goto :fail_after_pushd' in launcher
    assert 'copy /y "%DEPLOY_DIR%\\bot-workspace\\AGENTS.md" "runtime\\workspace\\AGENTS.md" >nul\nif errorlevel 1 goto :fail_after_pushd' in launcher
    assert 'copy /y "%PROJECT_DIR%\\SOUL.md" "runtime\\workspace\\SOUL.md" >nul\nif errorlevel 1 goto :fail_after_pushd' in launcher


def test_bot_runtime_agents_is_separate_from_repository_agents():
    repository_agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    bot_agents_path = DEPLOY_DIR / "bot-workspace" / "AGENTS.md"
    bot_agents = bot_agents_path.read_text(encoding="utf-8")
    assert bot_agents_path.exists()
    assert "QQ Group Runtime Rules" in bot_agents
    assert "QQ Group Runtime Rules" not in repository_agents
    assert "Codex" in repository_agents
    assert "bot-workspace/AGENTS.md" in repository_agents

    setup = (DEPLOY_DIR / "setup.sh").read_text(encoding="utf-8")
    docker_launcher = (DEPLOY_DIR / "Start-OpenClawDocker.ps1").read_text(encoding="utf-8")
    bind_launcher = (ROOT / "scripts" / "windows" / "Bind-OpenClawQQBot.ps1").read_text(encoding="utf-8")
    mac_launcher = (ROOT / "scripts" / "mac" / "start.sh").read_text(encoding="utf-8")
    assert "bot-workspace/AGENTS.md" in setup
    assert "bot-workspace\\AGENTS.md" in docker_launcher
    assert "bot-workspace\\AGENTS.md" in bind_launcher
    assert "bot-workspace/AGENTS.md" in mac_launcher
