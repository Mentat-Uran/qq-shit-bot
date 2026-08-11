import json
from pathlib import Path

import yaml

from scripts.sensenova_probe import content_from_response


ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy" / "openclaw"


def test_mac_compose_is_cloud_vision_only_and_keeps_windows_compose_separate():
    compose_path = DEPLOY / "docker-compose.mac.yml"
    compose = yaml.safe_load(compose_path.read_text(encoding="utf-8"))
    services = compose["services"]
    assert set(services) == {"qq-diagnostic-filter-init", "openclaw-gateway", "openclaw-cli", "context-recovery"}
    assert services["openclaw-gateway"]["ports"] == ["${OPENCLAW_GATEWAY_BIND_HOST:-127.0.0.1}:${OPENCLAW_GATEWAY_PORT:-18789}:18789"]
    assert services["openclaw-gateway"]["depends_on"]["qq-diagnostic-filter-init"]["condition"] == "service_completed_successfully"
    assert services["openclaw-gateway"]["restart"] == "unless-stopped"
    assert services["context-recovery"]["restart"] == "unless-stopped"
    assert services["openclaw-gateway"]["build"]["dockerfile"] == "Dockerfile.mac"
    assert "OPENCLAW_IMAGE" in services["openclaw-gateway"]["build"]["args"]
    assert "web-search-patch.mjs" in (DEPLOY / "Dockerfile.mac").read_text(encoding="utf-8")
    assert "web-search-patch.mjs" not in services["openclaw-gateway"]["command"][2]
    assert "gpus" not in json.dumps(compose).lower()
    assert not any(word in compose_path.read_text(encoding="utf-8").lower() for word in ("qwen", "ollama", "cuda", "nvidia"))
    assert "qwen-vision" in (DEPLOY / "docker-compose.yml").read_text(encoding="utf-8")


def test_mac_config_routes_image_to_sensenova_then_text_to_deepseek():
    config = json.loads((DEPLOY / "openclaw.mac.json").read_text(encoding="utf-8"))
    defaults = config["agents"]["defaults"]
    providers = config["models"]["providers"]
    assert defaults["model"] == {
        "primary": "sensenova-token/deepseek-v4-flash",
        "fallbacks": ["deepseek/deepseek-chat"],
    }
    assert defaults["imageModel"] == "sensenova-vision/sensenova-6.7-flash-lite"
    vision = providers["sensenova-vision"]["models"][0]
    assert vision["id"] == "sensenova-6.7-flash-lite"
    assert vision["input"] == ["text", "image"]
    assert config["tools"]["media"]["models"][0]["model"] == "sensenova-6.7-flash-lite"
    assert config["tools"]["media"]["video"]["enabled"] is False
    assert "local-vision" not in json.dumps(config)


def test_mac_shell_entries_are_unix_only_and_use_mac_compose():
    scripts = sorted((ROOT / "scripts" / "mac").glob("*.sh"))
    assert {script.name for script in scripts} >= {"start.sh", "stop.sh", "status.sh", "logs.sh", "check-env.sh", "console.sh", "configure-lan-console.sh"}
    assert "docker-compose.mac.yml" in (ROOT / "scripts" / "mac" / "lib.sh").read_text(encoding="utf-8")
    assert "OPENCLAW_UID=$(id -u)" in (ROOT / "scripts" / "mac" / "start.sh").read_text(encoding="utf-8")
    for script in scripts:
        text = script.read_text(encoding="utf-8")
        assert "powershell" not in text.lower()
        assert ".bat" not in text.lower()


def test_mac_console_can_run_without_docker_and_supports_launchagent_mode():
    library = (ROOT / "scripts" / "mac" / "lib.sh").read_text(encoding="utf-8")
    console = (ROOT / "scripts" / "mac" / "console.sh").read_text(encoding="utf-8")
    assert "require_env_file\n" in library
    assert "require_docker\n" not in library.split("compose()", 1)[0]
    assert "compose() {\n    require_docker" in library
    assert "--no-browser" in console
    assert 'cd "$REPO_ROOT"' in console


def test_mac_environment_template_has_explicit_lan_controls_without_real_values():
    env_text = (DEPLOY / ".env.example").read_text(encoding="utf-8")
    for key in ("OPENCLAW_GATEWAY_BIND_HOST", "OPENCLAW_GATEWAY_PUBLIC_HOST", "OPS_CONSOLE_BIND_HOST", "OPS_CONSOLE_PORT", "OPS_CONSOLE_AUTH_MODE", "OPS_CONSOLE_TOKEN", "SENSENOVA_VISION_MODEL"):
        assert f"{key}=" in env_text
    assert "sk-" not in env_text.lower()


def test_mac_console_launcher_exports_public_host_and_private_env_boundary():
    console = (ROOT / "scripts" / "mac" / "console.sh").read_text(encoding="utf-8")
    library = (ROOT / "scripts" / "mac" / "lib.sh").read_text(encoding="utf-8")
    assert "OPENCLAW_GATEWAY_PUBLIC_HOST=$(env_value OPENCLAW_GATEWAY_PUBLIC_HOST)" in console
    assert "replace-with-*) OPS_CONSOLE_TOKEN=" in console
    assert 'chmod 600 "$ENV_FILE"' in library


def test_sensenova_probe_accepts_reasoning_only_multimodal_response():
    response = {"choices": [{"message": {"role": "assistant", "reasoning": "一棵树"}}]}
    assert content_from_response(response) == "一棵树"
