import json
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
DEPLOY_DIR = ROOT / "deploy" / "openclaw"
ONEBOT_DIR = DEPLOY_DIR / "onebot"


class ComposeLoader(yaml.SafeLoader):
    pass


ComposeLoader.add_constructor("!reset", lambda loader, node: loader.construct_sequence(node, deep=True))


def load_yaml(name: str):
    return yaml.load((DEPLOY_DIR / name).read_text(encoding="utf-8"), Loader=ComposeLoader)


def test_onebot_adapter_is_an_independent_protocol_boundary():
    source = (ONEBOT_DIR / "onebot-adapter.mjs").read_text(encoding="utf-8").lower()
    core = (ONEBOT_DIR / "onebot-core.mjs").read_text(encoding="utf-8").lower()
    assert "nonebot" not in source
    assert "koishi" not in source
    assert "astrbot" not in source
    assert "nonebot" not in core
    assert "normalizeonebotevent" in core
    assert "send_group_msg" in source
    assert "send_private_msg" in source
    assert "get_msg" in source
    assert "get_image" in source
    assert "get_forward_msg" in source
    assert 'get_forward_msg", { id:' in source
    assert 'get_forward_msg", { message_id:' not in source
    assert "event.self_id" in source
    assert "x-openclaw-session-key" in source
    assert "x-openclaw-message-channel" in source


def test_onebot_compose_keeps_the_adapter_separate_and_loopback_published():
    compose = load_yaml("docker-compose.onebot.yml")
    service = compose["services"]["onebot-adapter"]
    assert set(compose["services"]) == {"onebot-adapter"}
    assert service["command"] == ["node", "/app/onebot/onebot-adapter.mjs"]
    assert service["ports"] == ["127.0.0.1:${ONEBOT_WS_PORT:-16700}:${ONEBOT_WS_PORT:-16700}"]
    assert service["depends_on"]["openclaw-gateway"]["condition"] == "service_healthy"
    assert "./onebot:/app/onebot:ro" in service["volumes"]
    assert "openclaw-logs:/tmp/openclaw:ro" in service["volumes"]
    assert compose["volumes"]["openclaw-logs"]["name"] == "qqshitbot-openclaw_openclaw-logs"
    assert "ONEBOT_ACCESS_TOKEN" in service["environment"]
    assert service["environment"]["ONEBOT_GATEWAY_URL"] == "${ONEBOT_GATEWAY_URL:-http://openclaw-gateway:18789}"
    assert service["environment"]["ONEBOT_INBOUND_DEBOUNCE_MS"] == "${ONEBOT_INBOUND_DEBOUNCE_MS:-700}"
    assert service["environment"]["ONEBOT_QUEUE_CAP"] == "${ONEBOT_QUEUE_CAP:-2}"
    assert "ONEBOT_ASR_URL" in service["environment"]
    assert "ONEBOT_TTS_URL" in service["environment"]
    assert "/health" in service["healthcheck"]["test"][-1]

    codex = load_yaml("docker-compose.onebot.codex.yml")
    codex_service = codex["services"]["onebot-adapter"]
    assert codex_service["network_mode"] == "host"
    assert codex_service["ports"] == []
    assert codex_service["environment"]["ONEBOT_WS_HOST"] == "${ONEBOT_CODEX_WS_HOST:-127.0.0.1}"
    assert codex_service["environment"]["ONEBOT_GATEWAY_URL"] == "${ONEBOT_CODEX_GATEWAY_URL:-http://127.0.0.1:18789}"
    assert codex_service["environment"]["ONEBOT_GAME_SERVICE_URL"] == "${ONEBOT_CODEX_GAME_SERVICE_URL:-http://127.0.0.1:18104}"
    assert codex_service["environment"]["ONEBOT_ASR_URL"] == "${ONEBOT_CODEX_ASR_URL:-http://127.0.0.1:18102/v1}"
    assert codex_service["environment"]["ONEBOT_TTS_URL"] == "${ONEBOT_CODEX_TTS_URL:-http://127.0.0.1:18102/v1}"


def test_napcat_compose_is_optional_and_does_not_contain_account_credentials():
    compose = load_yaml("docker-compose.napcat.yml")
    service = compose["services"]["napcat"]
    assert service["profiles"] == ["napcat"]
    assert service["image"] == "${NAPCAT_IMAGE:-mlikiowa/napcat-docker:latest}"
    assert service["ports"] == ["127.0.0.1:${NAPCAT_WEBUI_PORT:-6099}:6099"]
    assert "./runtime/napcat/qq:/app/.config/QQ" in service["volumes"]
    assert "QQ_PASSWORD" not in service["environment"]
    assert "QQ_SECRET" not in service["environment"]
    codex = load_yaml("docker-compose.napcat.codex.yml")
    assert codex["services"]["napcat"]["network_mode"] == "host"
    assert codex["services"]["napcat"]["ports"] == []


def test_chat_completions_endpoint_is_enabled_in_all_versioned_configs():
    for name in ("openclaw.json", "openclaw.mac.json", "openclaw.codex.json"):
        config = json.loads((DEPLOY_DIR / name).read_text(encoding="utf-8"))
        assert config["gateway"]["http"]["endpoints"]["chatCompletions"] == {"enabled": True}


def test_onebot_environment_and_launcher_have_the_explicit_boundary_values():
    env_text = (DEPLOY_DIR / ".env.example").read_text(encoding="utf-8")
    for key in (
        "ONEBOT_ACCESS_TOKEN=",
        "ONEBOT_ALLOWED_GROUP_IDS=",
        "ONEBOT_ADMIN_USER_IDS=",
        "ONEBOT_WS_PATH=/onebot/v11/ws",
        "ONEBOT_CODEX_GATEWAY_URL=http://127.0.0.1:18789",
        "ONEBOT_CODEX_GAME_SERVICE_URL=http://127.0.0.1:18104",
        "ONEBOT_GROUP_REQUIRE_MENTION=true",
        "ONEBOT_STRICT_GROUP_MENTION=true",
        "ONEBOT_COMMANDS_BYPASS_MENTION=true",
        "ONEBOT_GATEWAY_MESSAGE_CHANNEL=qqbot",
        "ONEBOT_ASR_URL=",
        "ONEBOT_TTS_URL=",
        "NAPCAT_IMAGE=",
    ):
        assert key in env_text
    launcher = (DEPLOY_DIR / "start-onebot.sh").read_text(encoding="utf-8")
    assert "ONEBOT_ACCESS_TOKEN ONEBOT_ALLOWED_GROUP_IDS ONEBOT_ADMIN_USER_IDS" in launcher
    assert "start-codex.sh" in launcher
    assert "--with-napcat" in launcher
    assert "--pull missing --force-recreate onebot-adapter napcat" in launcher
    contract = (DEPLOY_DIR / "environment-contract.txt").read_text(encoding="utf-8")
    for key in ("ONEBOT_ACCESS_TOKEN|optional", "ONEBOT_ALLOWED_GROUP_IDS|optional", "NAPCAT_IMAGE|optional"):
        assert key in contract
