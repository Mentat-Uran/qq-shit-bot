import json
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
DEPLOY_DIR = ROOT / "deploy" / "openclaw"


def test_compose_uses_pinned_image_and_loopback_port():
    compose = yaml.safe_load((DEPLOY_DIR / "docker-compose.yml").read_text())
    common = compose["x-openclaw-common"]
    gateway = compose["services"]["openclaw-gateway"]

    assert "ghcr.io/openclaw/openclaw:2026.7.1" in common["image"]
    assert gateway["ports"] == ["127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}:18789"]
    assert "/healthz" in gateway["healthcheck"]["test"][-1]
    assert common["cap_drop"] == ["NET_RAW", "NET_ADMIN"]
    assert common["security_opt"] == ["no-new-privileges:true"]
    assert common["environment"]["OPENCLAW_SKIP_STARTUP_MODEL_PREWARM"] == "1"


def test_openclaw_config_enables_qq_plugin_and_uses_secret_refs():
    config = json.loads((DEPLOY_DIR / "openclaw.json").read_text())

    assert config["plugins"]["allow"] == ["qqbot"]
    assert config["plugins"]["entries"]["qqbot"]["enabled"] is True
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
    assert config["agents"]["defaults"]["model"]["fallbacks"] == [
        "hermes-deepseek/deepseek-chat"
    ]


def test_env_example_pins_matching_openclaw_and_plugin_versions():
    env_text = (DEPLOY_DIR / ".env.example").read_text()

    assert "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.7.1" in env_text
    assert "OPENCLAW_QQBOT_PLUGIN=@openclaw/qqbot@2026.7.1" in env_text
    assert "QQBOT_CLIENT_SECRET=replace-with-qq-app-secret" in env_text
    assert "QQBOT_ALLOWED_USER_OPENID=replace-with-dm-user-openid" in env_text
    assert "QQBOT_ALLOWED_MEMBER_OPENID=replace-with-group-member-openid" in env_text
    assert "HERMES_DEEPSEEK_API_KEY=replace-with-deepseek-api-key" in env_text
    assert "sk-" not in env_text


def test_setup_invokes_openclaw_only_through_docker_compose():
    setup = (DEPLOY_DIR / "setup.sh").read_text()

    assert "compose run --rm --no-deps openclaw-cli plugins install" in setup
    assert "docker-compose" in setup
    assert "npm install" not in setup
    assert "pnpm install" not in setup
