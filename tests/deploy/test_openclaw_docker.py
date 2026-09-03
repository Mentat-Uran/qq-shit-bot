import json
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
DEPLOY_DIR = ROOT / "deploy" / "openclaw"


def load_openclaw_config():
    return json.loads((DEPLOY_DIR / "openclaw.json").read_text(encoding="utf-8"))


def load_codex_config():
    return json.loads((DEPLOY_DIR / "openclaw.codex.json").read_text(encoding="utf-8"))


def test_codex_overlay_routes_text_and_images_to_the_codex_proxy():
    config = load_codex_config()
    defaults = config["agents"]["defaults"]
    provider = config["models"]["providers"]["codex-proxy"]
    model = provider["models"][0]
    media = config["tools"]["media"]

    assert defaults["model"] == {"primary": "codex-proxy/gpt-5.6-luna", "fallbacks": []}
    assert defaults["imageModel"] == "codex-proxy/gpt-5.6-luna"
    assert provider["baseUrl"] == "${CODEX_PROXY_BASE_URL}"
    assert provider["apiKey"] == {
        "source": "env",
        "provider": "default",
        "id": "CODEX_PROXY_TOKEN",
    }
    assert model["id"] == "gpt-5.6-luna"
    assert model["input"] == ["text", "image"]
    assert model["reasoning"] is True
    assert media["models"] == [{
        "provider": "codex-proxy",
        "model": "gpt-5.6-luna",
        "capabilities": ["image"],
        "timeoutSeconds": 180,
        "maxChars": 1200,
    }]
    assert media["image"] == {
        "enabled": True,
        "attachments": {"mode": "first", "maxAttachments": 1},
        "timeoutSeconds": 180,
        "maxChars": 1200,
    }
    assert media["video"]["enabled"] is False
    assert config["agents"]["defaults"]["thinkingDefault"] == "max"
    assert provider["models"][0]["params"]["reasoning_effort"] == "max"
    assert provider["models"][0]["compat"]["supportsPromptCacheKey"] is True
    assert "max" in provider["models"][0]["compat"]["supportedReasoningEfforts"]
    assert provider["models"][0]["compat"]["reasoningEffortMap"]["max"] == "max"
    assert provider["models"][0]["contextWindow"] == 262144
    group_prompt = config["channels"]["qqbot"]["groups"]["*"]["prompt"]
    assert config["channels"]["qqbot"]["groups"]["*"]["historyLimit"] == 12
    assert "latest 12 non-mentioned group messages as candidate context" in group_prompt
    assert "history item only when it is directly or clearly related" in group_prompt
    assert "When actual image pixels are available, briefly summarize what is visible" in group_prompt
    assert "keep it compact and natural" in group_prompt
    assert "For QQ merged-forward or chat-record cards, inspect the entries and nested records" in group_prompt
    assert "ordinary images only get a short reaction" not in group_prompt
    launcher = (DEPLOY_DIR / "start-codex.sh").read_text(encoding="utf-8")
    assert 'media-capabilities.codex.json' in launcher
    capabilities = json.loads(
        (DEPLOY_DIR / "media-capabilities.codex.json").read_text(encoding="utf-8")
    )
    assert capabilities == {"image": True, "video": False}
    soul = (ROOT / "SOUL.md").read_text(encoding="utf-8")
    runtime_rules = (DEPLOY_DIR / "bot-workspace" / "AGENTS.md").read_text(encoding="utf-8")
    assert "summarize the salient visible content first" in soul
    assert "There is no hard character cap" in soul
    assert "absolute maximum is 18" not in soul
    assert "first summarize the visible content" in runtime_rules
    assert "never more than 18" not in runtime_rules


def test_compose_uses_current_stable_image_and_loopback_port():
    compose = yaml.safe_load((DEPLOY_DIR / "docker-compose.yml").read_text())
    common = compose["x-openclaw-common"]
    gateway = compose["services"]["openclaw-gateway"]
    plugin_init = compose["services"]["qq-diagnostic-filter-init"]
    recovery = compose["services"]["context-recovery"]

    assert compose["name"] == "qq-shit-bot"
    assert set(compose["services"]) == {"qq-diagnostic-filter-init", "openclaw-gateway", "openclaw-cli", "context-recovery"}
    assert "ghcr.io/openclaw/openclaw:2026.8.2" in common["image"]
    assert gateway["ports"] == ["127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}:18789"]
    assert "/healthz" in gateway["healthcheck"]["test"][-1]
    assert common["cap_drop"] == ["NET_RAW", "NET_ADMIN"]
    assert common["security_opt"] == ["no-new-privileges:true"]
    assert common["environment"]["OPENCLAW_SKIP_STARTUP_MODEL_PREWARM"] == "1"
    assert common["environment"]["CODEX_PROXY_BASE_URL"] == "${CODEX_PROXY_BASE_URL}"
    assert common["environment"]["CODEX_PROXY_TOKEN"] == "${CODEX_PROXY_TOKEN}"
    assert common["extra_hosts"] == ["host.docker.internal:host-gateway"]
    assert "openclaw-logs:/tmp/openclaw" in common["volumes"]
    assert "openclaw-state:/home/node/.openclaw/state" in common["volumes"]
    assert gateway["depends_on"]["qq-diagnostic-filter-init"]["condition"] == "service_completed_successfully"
    assert "qqbot-history-media-patch.mjs" in " ".join(plugin_init["volumes"])
    assert "qqbot-context-policy-core.mjs" in " ".join(plugin_init["volumes"])
    assert "media-policy.mjs" in " ".join(plugin_init["volumes"])
    assert "diagnostic-policy.mjs" in " ".join(plugin_init["volumes"])
    assert "web-search-patch.mjs" in " ".join(plugin_init["volumes"])
    assert "context-recovery.mjs" in " ".join(plugin_init["volumes"])
    assert "context-recovery-core.mjs" in " ".join(plugin_init["volumes"])
    assert "openclaw-state:/home/node/.openclaw/state" in " ".join(plugin_init["volumes"])
    assert "openclaw-logs:/tmp/openclaw" in " ".join(plugin_init["volumes"])
    init_command = plugin_init["command"][0]
    assert "chown -R ${OPENCLAW_UID:-1000}:${OPENCLAW_GID:-1000} /home/node/.openclaw/state" in init_command
    for name in ("media-policy.mjs", "diagnostic-policy.mjs", "context-recovery-core.mjs", "qqbot-context-policy-core.mjs"):
        assert f"cp /seed/{name} /opt/openclaw-local/{name}" in init_command
    assert gateway["command"][:2] == ["sh", "-c"]
    assert "qqbot-history-media-patch.mjs" in gateway["command"][2]
    assert "web-search-patch.mjs" in gateway["command"][2]
    assert gateway["command"][2].index("qqbot-interactive-features-patch.mjs") < gateway["command"][2].index("qqbot-history-media-patch.mjs")
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

    assert config["plugins"]["allow"] == ["openclaw-qqbot", "qq-diagnostic-filter", "duckduckgo"]
    assert config["plugins"]["entries"]["openclaw-qqbot"]["enabled"] is True
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
    assert config["agents"]["defaults"]["model"] == {"primary": "codex-proxy/gpt-5.6-luna", "fallbacks": []}
    assert set(config["models"]["providers"]) == {"codex-proxy"}
    assert config["models"]["providers"]["codex-proxy"]["apiKey"]["id"] == "CODEX_PROXY_TOKEN"
    assert config["tools"]["web"]["search"] == {
        "enabled": True,
        "provider": "duckduckgo",
    }


def test_openclaw_config_collects_group_context_and_uses_codex_for_images():
    config = load_openclaw_config()

    defaults = config["agents"]["defaults"]
    assert "contextTokens" not in defaults
    assert defaults["timeoutSeconds"] == 900
    assert defaults["utilityModel"] == ""
    assert defaults["imageModel"] == "codex-proxy/gpt-5.6-luna"
    assert defaults["thinkingDefault"] == "max"
    assert defaults["reasoningDefault"] == "off"
    assert defaults["contextInjection"] == "continuation-skip"
    assert defaults["bootstrapMaxChars"] == 4500
    assert defaults["bootstrapTotalMaxChars"] == 7500
    assert defaults["imageMaxDimensionPx"] == 768
    assert defaults["imageQuality"] == "efficient"
    assert defaults["contextLimits"] == {"postCompactionMaxChars": 800}
    assert defaults["compaction"] == {
        "mode": "safeguard",
        "keepRecentTokens": 8000,
        "recentTurnsPreserve": 2,
        "postCompactionSections": [],
        "memoryFlush": {"enabled": False},
    }
    assert config["session"]["resetByType"]["group"] == {
        "mode": "idle",
        "idleMinutes": 60,
    }

    codex_model = config["models"]["providers"]["codex-proxy"]["models"][0]
    assert config["models"]["providers"]["codex-proxy"]["baseUrl"] == "${CODEX_PROXY_BASE_URL}"
    assert config["models"]["providers"]["codex-proxy"]["apiKey"]["id"] == "CODEX_PROXY_TOKEN"
    assert codex_model["input"] == ["text", "image"]
    assert codex_model["compat"]["supportsTools"] is True

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
    context_policy_core = (DEPLOY_DIR / "qqbot-context-policy-core.mjs").read_text(encoding="utf-8")
    assert "qqbot-history-media-v1" in history_media_patch
    assert "qqbot-tencent-media-overlay-v1" in history_media_patch
    assert "qqbot-context-policy-v1" in context_policy_core
    assert "QQBOT_CONTEXT_POLICY_MARKER" in history_media_patch
    assert "qqbotContextSelectRelevantGroupHistory(buffered, ctx.message.content)" in history_media_patch
    assert "qqbot-forward-record-v1" in history_media_patch
    assert "qqbotOverlayPrepareForwardRecord(ctx, ctx.log)" in history_media_patch
    assert "qqbotBuildNestedQuoteText" not in history_media_patch
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
    assert "qqbot-quote-media-prefetch-v1" in history_media_patch
    assert "imageMediaFromAttachments" in history_media_patch
    assert "selectRecentGroupImage" in history_media_patch
    assert "resolveQuoteImageMedia" in history_media_patch
    assert "ensureLocalQqImage" in history_media_patch
    assert "sanitizeQqMediaUrls" in history_media_patch
    assert "processed = mergeSingleQuotedImage(processed" in history_media_patch
    assert "qqbot-canonical-inbound-media-v1" in history_media_patch
    assert "qqbotOverlayBuildInboundMediaFacts" in history_media_patch
    assert "kind: \"image\"" in history_media_patch
    assert "qqbot-tencent-attachment-normalization-v1" in history_media_patch
    assert "rawAttachment" in history_media_patch
    assert "message.msgElements" in history_media_patch
    assert "ctx?.message?.raw?.msg_elements" in history_media_patch

    context_recovery = (DEPLOY_DIR / "context-recovery.mjs").read_text(encoding="utf-8")
    context_recovery_core = (DEPLOY_DIR / "context-recovery-core.mjs").read_text(encoding="utf-8")
    assert "sessions.reset" in context_recovery
    assert "context overflow detected" in context_recovery_core
    assert "stalled_agent_run" in context_recovery_core
    assert "OPENCLAW_GATEWAY_URL" in context_recovery
    assert "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS" in context_recovery

    assert config["messages"]["inbound"]["debounceMs"] == 700
    assert config["messages"]["queue"] == {"mode": "steer", "cap": 2, "drop": "old"}
    image_models = config["tools"]["media"]["models"]
    assert image_models == [
        {
            "provider": "codex-proxy",
            "model": "gpt-5.6-luna",
            "capabilities": ["image"],
            "timeoutSeconds": 180,
            "maxChars": 1200,
        }
    ]
    assert config["tools"]["media"]["video"]["enabled"] is False
    assert "nvidia-image-cli.mjs" not in json.dumps(config)
    assert "mage-video-cli.mjs" not in json.dumps(config)

    serialized = json.dumps(config)
    assert "openai/" not in serialized
    assert "api.openai.com" not in serialized
    assert "sensenova" not in serialized.lower()
    assert "deepseek" not in serialized.lower()
    assert "qwen-vision" not in serialized.lower()


def test_env_example_pins_current_stable_openclaw_and_qqbot_versions():
    env_text = (DEPLOY_DIR / ".env.example").read_text()

    assert "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.8.2" in env_text
    assert "OPENCLAW_QQBOT_PLUGIN=@tencent-connect/openclaw-qqbot@2.0.3" in env_text
    assert "QQBOT_CLIENT_SECRET=replace-with-qq-app-secret" in env_text
    assert "QQBOT_ALLOWED_USER_OPENID=" in env_text
    assert "QQBOT_ALLOWED_MEMBER_OPENID=" in env_text
    assert "QQBOT_PROACTIVE_REVIEW_ENABLED=false" in env_text
    assert "CODEX_PROXY_BASE_URL=http://host.docker.internal:18317/v1" in env_text
    assert "CODEX_PROXY_TOKEN=replace-with-codex-proxy-token" in env_text
    assert "microsoft/Mage-VL" not in env_text
    assert "nvidia/LocateAnything-3B" not in env_text
    assert "QWEN_ASR_GPU_MEMORY_UTILIZATION=0.75" in env_text
    assert "QWEN_ASR_MAX_MODEL_LEN=2048" in env_text
    assert "SENSENOVA_API_KEY" not in env_text
    assert "DEEPSEEK_API_KEY" not in env_text
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


def test_setup_requires_codex_proxy_and_migrates_legacy_media_config():
    setup = (DEPLOY_DIR / "setup.sh").read_text()

    assert "validate-env.sh" in setup
    assert "--migrate --generate-token" in setup
    assert "--declaration-key" in setup
    assert "qqbot-proactive-review-night" in setup
    assert "skipping proactive review job registration" in setup
    assert "environment-contract.txt" in (DEPLOY_DIR / "validate-env.sh").read_text()
    assert "CODEX_PROXY_TOKEN=replace-with-codex-proxy-token" in (DEPLOY_DIR / ".env.example").read_text()
    assert "qwen-vision" not in setup
    assert "Refreshing $RUNTIME_DIR/config/openclaw.json from the versioned defaults." in setup
    assert "cron list --all --json" in setup
    assert "cron remove" in setup


def test_windows_launcher_and_local_compose_overlay_are_present():
    launcher = (DEPLOY_DIR / "Start-OpenClawDocker.ps1").read_text()
    overlay = (DEPLOY_DIR / "docker-compose.local.yml").read_text()

    assert "CODEX_PROXY_BASE_URL" in launcher
    assert "CODEX_PROXY_TOKEN" in launcher
    assert "deepseek-api-key.dpapi" not in launcher
    assert "Watch-OpenClawModel.ps1" not in launcher
    assert "*/10 8-23,0-1 * * *" in launcher
    assert "QQBOT_PROACTIVE_REVIEW_ENABLED" in launcher
    assert "*/30 2-7 * * *" in launcher
    assert "Asia/Shanghai" in launcher
    assert "environment:" in overlay
    assert "CODEX_PROXY_TOKEN" in overlay
    assert "sk-" not in launcher
    assert "sk-" not in overlay
    assert "local-vision\\docker-compose.yml" not in launcher
    assert not (DEPLOY_DIR / "Start-OpenClawVision.ps1").exists()
    assert not (DEPLOY_DIR / "Stop-OpenClawVision.ps1").exists()
    assert not (DEPLOY_DIR / "Set-OpenClawMediaCapabilities.ps1").exists()
    assert not (DEPLOY_DIR / "Watch-OpenClawModel.ps1").exists()
    assert (ROOT / "scripts" / "codex_proxy_probe.py").exists()
    assert (DEPLOY_DIR / "Test-OpenClawEnvironment.ps1").exists()
    assert "Test-OpenClawEnvironment.ps1" in launcher
    assert "QQBOT_HOME_CHANNEL" in launcher
    assert "'cron', 'list'" in launcher
    assert "'cron', 'remove'" in launcher

    history_patch = (DEPLOY_DIR / "qqbot-history-media-patch.mjs").read_text(encoding="utf-8")
    assert "qqbot-media-capabilities-v1" in history_patch
    assert "filterMediaByCapability" in history_patch
    assert "readMediaCapabilities" in history_patch
    assert "qqbot-video-mention-gate-v2" in history_patch
    assert "video-gate-after-group-info" in history_patch
    assert "!event?.groupOpenid || groupInfo?.gate?.effectiveWasMentioned === true" in history_patch
    assert "hermes-qq-history-media-v1" in history_patch
    assert "normalizeLegacyMarkers" in history_patch
    assert "codex-proxy" in (DEPLOY_DIR / "openclaw.json").read_text(encoding="utf-8")


def test_codex_overlay_uses_the_host_proxy_only_for_external_fetches():
    overlay_text = (DEPLOY_DIR / "docker-compose.codex.yml").read_text()
    overlay = yaml.safe_load(overlay_text.replace("!reset ", ""))
    gateway = overlay["services"]["openclaw-gateway"]

    assert gateway["network_mode"] == "host"
    assert gateway["environment"]["NODE_USE_ENV_PROXY"] == "1"
    assert gateway["environment"]["HTTPS_PROXY"] == "${OPENCLAW_HTTPS_PROXY:-http://127.0.0.1:7890}"
    no_proxy = gateway["environment"]["NO_PROXY"]
    assert "127.0.0.1" in no_proxy
    assert "api.sgroup.qq.com" in no_proxy
    assert "bots.qq.com" in no_proxy
    assert "multimedia.nt.qq.com.cn" not in no_proxy


def test_codex_overlay_serializes_tts_and_asr_through_the_loopback_gpu_gate():
    overlay_text = (DEPLOY_DIR / "docker-compose.codex.yml").read_text(encoding="utf-8")
    overlay = yaml.safe_load(overlay_text.replace("!reset ", ""))
    tts = overlay["services"]["qwen-tts"]
    asr = overlay["services"]["qwen-asr"]
    config = load_codex_config()

    assert tts["network_mode"] == "host"
    assert asr["network_mode"] == "host"
    assert "127.0.0.1:18101" in tts["healthcheck"]["test"][-1]
    assert "127.0.0.1:18103" in asr["healthcheck"]["test"][-1]
    assert "QWEN_ASR_GPU_MEMORY_UTILIZATION:-0.75" in " ".join(asr["command"])
    assert "QWEN_ASR_MAX_MODEL_LEN:-2048" in " ".join(asr["command"])
    assert "--enforce-eager" in asr["command"]
    assert "qwen3-asr-hf-cache" in " ".join(asr["volumes"])
    assert config["channels"]["qqbot"]["stt"] == {
        "enabled": True,
        "provider": "openai",
        "baseUrl": "http://127.0.0.1:18102/v1",
        "apiKey": "local",
        "model": "Qwen/Qwen3-ASR-1.7B",
    }
    assert config["tts"]["providers"]["openai"]["baseUrl"] == "http://127.0.0.1:18102/v1"
    gate = (DEPLOY_DIR / "tts-comfy-gate.py").read_text(encoding="utf-8")
    assert 'if path == "/v1/audio/transcriptions":' in gate
    assert "self.gate.prepare_asr()" in gate
    assert "forward_asr" in gate


def test_codex_overlay_adds_a_cpu_only_reusable_turtle_soup_sidecar():
    overlay_text = (DEPLOY_DIR / "docker-compose.codex.yml").read_text(encoding="utf-8")
    overlay = yaml.safe_load(overlay_text.replace("!reset ", ""))
    game = overlay["services"]["qqbot-game"]
    gateway = overlay["services"]["openclaw-gateway"]

    assert game["build"]["context"] == "./games/ai-turtle-soup"
    assert game["network_mode"] == "host"
    assert "gpus" not in game
    assert "devices" not in game
    assert game["cpus"] == "${QQBOT_GAME_CPUS:-1.0}"
    assert game["mem_limit"] == "${QQBOT_GAME_MEMORY_LIMIT:-768m}"
    assert "127.0.0.1:18104/health" in game["healthcheck"]["test"][-1]
    assert game["environment"]["GAME_PUZZLE_SELECTION_STATE_PATH"] == "${GAME_PUZZLE_SELECTION_STATE_PATH:-/var/lib/qq-game/selection.json}"
    assert "./runtime/game-state:/var/lib/qq-game" in game["volumes"]
    assert game["environment"]["GAME_LLM_MODEL"] == "${GAME_LLM_MODEL:-gpt-5.6-luna}"
    assert game["environment"]["GAME_LLM_REASONING_EFFORT"] == "${GAME_LLM_REASONING_EFFORT:-max}"
    assert game["environment"]["GAME_AI_GENERATION_TIMEOUT"] == "${GAME_AI_GENERATION_TIMEOUT:-45}"
    assert game["environment"]["GAME_LLM_GENERATE_MAX_TOKENS"] == "${GAME_LLM_GENERATE_MAX_TOKENS:-256}"
    assert game["environment"]["GAME_LLM_JUDGE_MAX_TOKENS"] == "${GAME_LLM_JUDGE_MAX_TOKENS:-256}"
    assert game["environment"]["GAME_PUZZLE_SOURCE"] == "${GAME_PUZZLE_SOURCE:-local}"
    assert game["environment"]["GAME_PUZZLE_SELECTION_MAX_GROUPS"] == "${GAME_PUZZLE_SELECTION_MAX_GROUPS:-2048}"
    assert game["environment"]["GAME_CHAT_CHAIN_MAX_ROUNDS"] == "${GAME_CHAT_CHAIN_MAX_ROUNDS:-30}"
    assert game["environment"]["GAME_CHAT_WORDLE_MAX_GUESSES"] == "${GAME_CHAT_WORDLE_MAX_GUESSES:-10}"
    assert game["environment"]["GAME_CHAT_MAX_SESSIONS"] == "${GAME_CHAT_MAX_SESSIONS:-2048}"
    assert gateway["depends_on"]["qqbot-game"]["condition"] == "service_healthy"
    assert gateway["environment"]["QQBOT_GAME_SERVICE_URL"] == "${QQBOT_GAME_SERVICE_URL:-http://127.0.0.1:18104}"

    game_dir = DEPLOY_DIR / "games" / "ai-turtle-soup"
    sample_puzzles = json.loads((game_dir / "sample_soups.json").read_text(encoding="utf-8"))
    assert len(sample_puzzles) == 50
    assert len({puzzle["id"] for puzzle in sample_puzzles}) == 50
    assert len({puzzle["puzzle_setting"].rstrip("。！？!?") for puzzle in sample_puzzles}) == 50
    horror_puzzles = [
        puzzle
        for puzzle in sample_puzzles
        if {"悬疑", "惊悚", "恐怖"} <= set(puzzle.get("tags", []))
    ]
    assert len(horror_puzzles) == 30
    assert all("原创" in puzzle["tags"] for puzzle in horror_puzzles)
    assert all({"title", "puzzle_setting", "solution", "supplementary_info"} <= puzzle.keys() for puzzle in sample_puzzles)
    assert all(isinstance(puzzle["supplementary_info"], list) for puzzle in sample_puzzles)
    service = (game_dir / "service.py").read_text(encoding="utf-8")
    chat_games = (game_dir / "chat_games.py").read_text(encoding="utf-8")
    selection = (game_dir / "selection.py").read_text(encoding="utf-8")
    upstream = (game_dir / "UPSTREAM.md").read_text(encoding="utf-8")
    chat_upstream = (game_dir / "CHAT_GAMES_UPSTREAM.md").read_text(encoding="utf-8")
    interactive = (DEPLOY_DIR / "qqbot-interactive-features-patch.mjs").read_text(encoding="utf-8")
    launcher = (DEPLOY_DIR / "start-codex.sh").read_text(encoding="utf-8")
    assert "nonebot-plugin-ai-turtle-soup==1.0.9" in (game_dir / "Dockerfile").read_text(encoding="utf-8")
    assert "china-idiom @ https://github.com/sfyc23/China-idiom/archive/78606b0294a22e798633c4469a4009b78ad60f26.tar.gz" in (game_dir / "Dockerfile").read_text(encoding="utf-8")
    assert 'COPY chat_games.py /opt/qq-game/chat_games.py' in (game_dir / "Dockerfile").read_text(encoding="utf-8")
    assert "create_local_game" in service
    assert "_create_rotating_local_game" in service
    assert "GAME_PUZZLE_SELECTION_STATE_PATH" in service
    assert "available" in service and "previous_key" in service
    assert "PuzzleSelectionStore" in service
    assert 'COPY selection.py /opt/qq-game/selection.py' in (game_dir / "Dockerfile").read_text(encoding="utf-8")
    assert 'STATE_VERSION = 2' in selection
    assert '"groups"' in selection
    assert "selection_scope_key" in selection
    assert "为保证不重复" in selection
    assert "GAME_PUZZLE_SOURCE" in service
    assert "filter_puzzles_by_theme" in service
    assert '"question": question_preview' in service
    assert "questioner_id" not in service
    assert "若用户主题提示包含悬疑、惊悚、恐怖、灵异" in service
    assert "/v1/chat-games/start" in service
    assert "CHAT_GAME_MANAGER" in service
    assert "IdiomCatalog" in chat_games
    assert "idiom-chain" in chat_games and "idiom-wordle" in chat_games
    assert '"title": str(puzzle' not in service
    assert '"title"' in service  # upstream generation schema remains internal only
    assert '"local_puzzle_count"' in service
    assert '"selection_scope": "per-conversation"' in service
    assert "reasoning_effort" in service
    assert "asyncio.wait_for" in service
    assert "local-fallback" in service
    assert "DuckDuckGo" in service
    assert "haiguitang-coop" in upstream
    assert "CC BY 4.0" in upstream
    assert "China-idiom" in chat_upstream
    assert "noneplugin/nonebot-plugin-handle" in chat_upstream
    assert "qqbot:game:start" in interactive
    assert "qqbot:game:idiom-chain" in interactive
    assert "qqbot:game:idiom-wordle" in interactive
    assert "qqbot:tts:tone:gentle" in interactive
    assert "qqbot:tts:tone:status" in interactive
    assert "温柔读" in interactive
    assert "qqbot-interactive-features-v8" in interactive
    assert "❓问题：" in interactive
    assert "qqbotInteractiveQuestionSummary" in interactive
    assert "questioner_id" not in interactive
    assert "data.title" not in interactive
    assert "qqbotInteractiveHasSuccessfulVoiceTranscript" in interactive
    assert "qqbotInteractiveForceVoiceReply" in interactive
    assert "autoVoiceReply: ctx?.state?.qqbotInteractiveVoiceReply === true" in interactive
    assert "语音模式" not in interactive
    assert "qqbot:voice:" not in interactive
    assert "qqbotInteractiveVoiceModes" not in interactive
    assert "骰子" not in interactive
    assert "硬币" not in interactive
    assert "猜数字" not in interactive
    assert "compose build qqbot-game" in launcher
    assert "compose up -d --force-recreate qqbot-game" in launcher
    assert 'GAME_STATE_DIR="$RUNTIME_DIR/game-state"' in launcher


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
    assert "CODEX_PROXY_BASE_URL" in launcher
    assert "CODEX_PROXY_TOKEN" in launcher
    assert "qwen2.5vl:7b" not in launcher
    assert "--pull never" in launcher
    assert "powershell" not in launcher.lower()
    assert "sk-" not in launcher
    assert "migrate_env_alias DEEPSEEK_API_KEY HERMES_DEEPSEEK_API_KEY" not in launcher
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
