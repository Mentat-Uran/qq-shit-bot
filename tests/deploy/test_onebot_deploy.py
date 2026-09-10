import json
import os
import subprocess
import tempfile
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
    assert service["ports"] == ["${NAPCAT_WEBUI_BIND_ADDRESS:-127.0.0.1}:${NAPCAT_WEBUI_PORT:-6099}:6099"]
    assert "./runtime/napcat/qq:/app/.config/QQ" in service["volumes"]
    assert "QQ_PASSWORD" not in service["environment"]
    assert "QQ_SECRET" not in service["environment"]
    codex = load_yaml("docker-compose.napcat.codex.yml")
    assert codex["services"]["napcat"]["network_mode"] == "host"
    assert codex["services"]["napcat"]["ports"] == []


def test_napcat_webui_configurator_changes_only_the_bind_host():
    script = DEPLOY_DIR / "configure-napcat-webui.sh"
    assert os.access(script, os.X_OK)
    with tempfile.TemporaryDirectory() as temporary_dir:
        config_path = Path(temporary_dir) / "webui.json"
        config_path.write_text(
            json.dumps({"host": "::", "port": 6099, "token": "preserve-this-value"}),
            encoding="utf-8",
        )
        environment = os.environ.copy()
        environment["NAPCAT_WEBUI_CONFIG"] = str(config_path)
        environment["NAPCAT_WEBUI_BIND_ADDRESS"] = "192.0.2.175"

        first = subprocess.run(
            [str(script)],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        assert first.returncode == 0
        assert first.stdout == ""
        assert first.stderr == ""
        assert json.loads(config_path.read_text(encoding="utf-8")) == {
            "host": "192.0.2.175",
            "port": 6099,
            "token": "preserve-this-value",
        }

        second = subprocess.run(
            [str(script)],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        assert second.returncode == 4

        environment["NAPCAT_WEBUI_BIND_ADDRESS"] = "0.0.0.0"
        invalid = subprocess.run(
            [str(script)],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        assert invalid.returncode == 1
        assert json.loads(config_path.read_text(encoding="utf-8"))["host"] == "192.0.2.175"


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
        "NAPCAT_WEBUI_BIND_ADDRESS=127.0.0.1",
    ):
        assert key in env_text
    launcher = (DEPLOY_DIR / "start-onebot.sh").read_text(encoding="utf-8")
    assert "ONEBOT_ACCESS_TOKEN ONEBOT_ALLOWED_GROUP_IDS ONEBOT_ADMIN_USER_IDS" in launcher
    assert "start-codex.sh" in launcher
    assert "--with-napcat" in launcher
    assert "--no-recreate" in launcher
    assert "NAPCAT_WEBUI_BIND_ADDRESS" in launcher
    assert "configure-napcat-webui.sh" in launcher
    assert "--pull missing --force-recreate onebot-adapter napcat" in launcher
    assert "--pull missing --no-recreate onebot-adapter napcat" in launcher
    assert "--pull never --no-recreate onebot-adapter" in launcher
    contract = (DEPLOY_DIR / "environment-contract.txt").read_text(encoding="utf-8")
    for key in ("ONEBOT_ACCESS_TOKEN|optional", "ONEBOT_ALLOWED_GROUP_IDS|optional", "NAPCAT_IMAGE|optional"):
        assert key in contract


def test_napcat_systemd_unit_is_user_scoped_and_secret_free():
    unit = (DEPLOY_DIR / "qq-shit-bot-napcat.service").read_text(encoding="utf-8")
    assert "Type=oneshot" in unit
    assert "RemainAfterExit=yes" in unit
    assert "WantedBy=default.target" in unit
    assert "ONEBOT_SKIP_CORE_START=true" in unit
    assert "start-onebot.sh --with-napcat --no-recreate" in unit
    assert "docker compose" in unit
    assert "stop onebot-adapter napcat" in unit
    assert "CODEX_PROXY_TOKEN" not in unit
    assert "ONEBOT_ACCESS_TOKEN" not in unit
    assert "QQBOT_CLIENT_SECRET" not in unit
