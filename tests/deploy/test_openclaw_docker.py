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
    assert "openclaw-logs:/tmp/openclaw" in common["volumes"]
    assert gateway["depends_on"]["qq-diagnostic-filter-init"]["condition"] == "service_completed_successfully"
    assert "qqbot-history-media-patch.mjs" in " ".join(plugin_init["volumes"])
    assert "context-recovery.mjs" in " ".join(plugin_init["volumes"])
    assert "openclaw-logs:/tmp/openclaw" in " ".join(plugin_init["volumes"])
    assert plugin_init["command"] == [
        "mkdir -p /tmp/openclaw && chown ${OPENCLAW_UID:-1000}:${OPENCLAW_GID:-1000} /tmp/openclaw && cp /seed/qq-diagnostic-filter.mjs /opt/openclaw-local/qq-diagnostic-filter.mjs && cp /seed/openclaw.plugin.json /opt/openclaw-local/openclaw.plugin.json && cp /seed/qqbot-history-media-patch.mjs /opt/openclaw-local/qqbot-history-media-patch.mjs && cp /seed/context-recovery.mjs /opt/openclaw-local/context-recovery.mjs && chmod 0644 /opt/openclaw-local/qq-diagnostic-filter.mjs /opt/openclaw-local/openclaw.plugin.json /opt/openclaw-local/qqbot-history-media-patch.mjs /opt/openclaw-local/context-recovery.mjs"
    ]
    assert gateway["command"][:2] == ["sh", "-c"]
    assert "qqbot-history-media-patch.mjs" in gateway["command"][2]
    assert "exec node dist/index.js gateway" in gateway["command"][2]
    assert "tee -a" in gateway["command"][2]
    assert recovery["depends_on"]["openclaw-gateway"]["condition"] == "service_healthy"
    assert recovery["healthcheck"] == {"disable": True}
    assert recovery["command"] == ["node", "/opt/openclaw-local/context-recovery.mjs"]
    assert compose["volumes"]["qq-diagnostic-filter"]["name"] == "hermes-qq-openclaw_qq-diagnostic-filter"
    assert compose["volumes"]["openclaw-logs"]["name"] == "hermes-qq-openclaw_openclaw-logs"


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
    assert qqbot["clientSecret"] == {
        "source": "env",
        "provider": "default",
        "id": "QQBOT_CLIENT_SECRET",
    }
    assert qqbot["dmPolicy"] == "allowlist"
    assert qqbot["groupPolicy"] == "allowlist"
    assert qqbot["groups"]["*"]["requireMention"] is True
    assert config["gateway"]["terminal"]["enabled"] is False
    assert config["tools"]["deny"] == ["exec", "read", "write"]
    assert config["messages"]["suppressToolErrors"] is True
    assert config["agents"]["defaults"]["model"]["fallbacks"] == []
    assert "hermes-deepseek" not in config["models"]["providers"]
    assert config["tools"]["web"]["search"] == {
        "enabled": True,
        "provider": "duckduckgo",
    }


def test_openclaw_config_collects_group_context_and_keeps_vision_local():
    config = load_openclaw_config()

    defaults = config["agents"]["defaults"]
    assert defaults["contextTokens"] == 65536
    assert defaults["timeoutSeconds"] == 900
    assert defaults["utilityModel"] == ""
    assert defaults["imageModel"] == "local-vision/qwen2.5vl:7b"
    assert defaults["compaction"]["mode"] == "safeguard"
    assert config["session"]["resetByType"]["group"] == {
        "mode": "idle",
        "idleMinutes": 120,
    }

    local_qwen = config["models"]["providers"]["local-vision"]["models"][0]
    assert config["models"]["providers"]["local-vision"]["baseUrl"] == "http://qwen-vision:11434/v1"
    assert local_qwen["compat"]["supportsTools"] is False

    qqbot = config["channels"]["qqbot"]
    assert qqbot["contextVisibility"] == "all"
    assert qqbot["historyLimit"] == 50
    assert qqbot["groups"]["*"]["historyLimit"] == 50
    assert "NO_REPLY" in qqbot["groups"]["*"]["prompt"]
    assert "被艾特、回复机器人或私聊时" in qqbot["groups"]["*"]["prompt"]
    assert "不得输出 NO_REPLY" in qqbot["groups"]["*"]["prompt"]
    assert "never send provider, model, API, HTTP, 429" in qqbot["groups"]["*"]["prompt"]

    diagnostic_filter = (DEPLOY_DIR / "qq-diagnostic-filter.mjs").read_text(encoding="utf-8")
    assert '"reply_payload_sending"' in diagnostic_filter
    assert "payload.isError" in diagnostic_filter
    assert "payload.isFallbackNotice" in diagnostic_filter

    history_media_patch = (DEPLOY_DIR / "qqbot-history-media-patch.mjs").read_text(encoding="utf-8")
    assert "hermes-qq-history-media-v1" in history_media_patch
    assert "resolveLatestHistoricalMedia" in history_media_patch
    assert "videoAttachmentPaths" in history_media_patch
    assert "15 * 60 * 1000" in history_media_patch

    context_recovery = (DEPLOY_DIR / "context-recovery.mjs").read_text(encoding="utf-8")
    assert "sessions.reset" in context_recovery
    assert "context overflow detected" in context_recovery
    assert "stalled_agent_run" in context_recovery
    assert "OPENCLAW_GATEWAY_URL" in context_recovery
    assert "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS" in context_recovery

    assert config["messages"]["inbound"]["debounceMs"] == 2500
    assert config["messages"]["queue"] == {
        "mode": "collect",
        "debounceMs": 2500,
        "cap": 50,
        "drop": "summarize",
    }
    image_models = config["tools"]["media"]["models"]
    assert image_models[0]["type"] == "cli"
    assert image_models[0]["capabilities"] == ["image"]
    assert "nvidia-image-cli.mjs" in " ".join(image_models[0]["args"])
    assert image_models[1] == {
        "provider": "local-vision",
        "model": "qwen2.5vl:7b",
        "capabilities": ["image"],
        "timeoutSeconds": 180,
        "maxChars": 2000,
    }
    video = config["tools"]["media"]["video"]
    assert video["enabled"] is True
    assert video["timeoutSeconds"] == 1200
    assert video["models"][0]["type"] == "cli"
    assert video["models"][0]["capabilities"] == ["video"]
    assert "mage-video-cli.mjs" in " ".join(video["models"][0]["args"])

    serialized = json.dumps(config)
    assert "openai/" not in serialized
    assert "api.openai.com" not in serialized
    assert "gpt-" not in serialized


def test_env_example_pins_matching_openclaw_and_plugin_versions():
    env_text = (DEPLOY_DIR / ".env.example").read_text()

    assert "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.7.1" in env_text
    assert "OPENCLAW_QQBOT_PLUGIN=@openclaw/qqbot@2026.7.1" in env_text
    assert "QQBOT_CLIENT_SECRET=replace-with-qq-app-secret" in env_text
    assert "QQBOT_ALLOWED_USER_OPENID=replace-with-dm-user-openid" in env_text
    assert "QQBOT_ALLOWED_MEMBER_OPENID=replace-with-group-member-openid" in env_text
    assert "HERMES_DEEPSEEK_API_KEY" not in env_text
    assert "MAGE_MODEL_ID=microsoft/Mage-VL" in env_text
    assert "NVIDIA_IMAGE_MODEL_ID=nvidia/LocateAnything-3B" in env_text
    assert "QWEN_MODEL_ID=qwen2.5vl:7b" in env_text
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


def test_windows_launcher_and_local_compose_overlay_are_present():
    launcher = (DEPLOY_DIR / "Start-OpenClawDocker.ps1").read_text()
    watcher = (DEPLOY_DIR / "Watch-OpenClawModel.ps1").read_text()
    overlay = (DEPLOY_DIR / "docker-compose.local.yml").read_text()
    video_compose = (DEPLOY_DIR / "docker-compose.video.yml").read_text()
    bridge_cli = (DEPLOY_DIR / "video-bridge" / "mage-video-cli.mjs").read_text()

    assert "deepseek-api-key.dpapi" not in launcher
    assert "C:\\HermesWorkspace" in launcher
    assert "Watch-OpenClawModel.ps1" in launcher
    assert "SENSENOVA_API_KEY" in watcher
    assert "no paid fallback" in watcher
    assert "hermes-deepseek/deepseek-chat" not in watcher
    assert "*/10 8-23,0-1 * * *" in launcher
    assert "*/30 2-7 * * *" in launcher
    assert "Asia/Shanghai" in launcher
    assert "docker-compose.video.yml" in launcher
    assert "-NoVideo" in launcher
    assert "microsoft/Mage-VL" in video_compose
    assert "nvidia/LocateAnything-3B" in video_compose
    assert "vllm/vllm-openai" in video_compose
    assert "qwen-vision:" in video_compose
    assert "qwen-vision:11434" in video_compose
    assert "image-fusion" in video_compose
    assert "init: true" in video_compose
    assert "nvidia-image-cli.mjs" in video_compose
    assert "{{MediaPath}}" in bridge_cli or "--media-path" in bridge_cli
    assert "environment:" in overlay
    assert "HERMES_DEEPSEEK_API_KEY" not in overlay
    assert "api.deepseek.com" not in overlay
    assert "sk-" not in launcher
    assert "sk-" not in watcher
    assert "sk-" not in overlay
    assert "local-vision\\docker-compose.yml" not in launcher
    assert (DEPLOY_DIR / "Start-OpenClawVision.ps1").exists()
    assert (DEPLOY_DIR / "Stop-OpenClawVision.ps1").exists()
    assert (DEPLOY_DIR / "Set-OpenClawMediaCapabilities.ps1").exists()

    capability_script = (DEPLOY_DIR / "Set-OpenClawMediaCapabilities.ps1").read_text(encoding="utf-8")
    assert "media-capabilities.json" in capability_script
    assert "Never claim to have seen an image" in capability_script
    assert "ValidateSet('none', 'image', 'video', 'both')" in capability_script
    assert "Remove('imageModel')" in capability_script
    assert "Remove('local-vision')" in capability_script
    assert "switch ($RestartGateway)" in capability_script or "if ($RestartGateway)" in capability_script

    history_patch = (DEPLOY_DIR / "qqbot-history-media-patch.mjs").read_text(encoding="utf-8")
    assert "hermes-qq-media-capabilities-v1" in history_patch
    assert "filterMediaByCapability" in history_patch
    assert "local service is disabled" in history_patch
    vision_launcher = (DEPLOY_DIR / "Start-OpenClawVision.ps1").read_text(encoding="utf-8")
    assert "servicesToStop" in vision_launcher
    assert "Where-Object { $_ -notin $services }" in vision_launcher


def test_windows_batch_launcher_points_to_openclaw_startup_script():
    launcher = (ROOT / "Start-OpenClawQQBot.bat").read_text(encoding="utf-8")

    assert "deploy\\openclaw\\Start-OpenClawDocker.ps1" in launcher
    assert "ExecutionPolicy Bypass" in launcher
    assert "sk-" not in launcher
