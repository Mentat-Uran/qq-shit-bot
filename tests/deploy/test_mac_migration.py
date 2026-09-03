import json
from pathlib import Path

import yaml

from scripts.codex_proxy_probe import CODEX_PROXY_MODEL, CODEX_PROXY_REASONING_EFFORT, content_from_response


ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy" / "openclaw"
CONFIG_NAMES = ("openclaw.json", "openclaw.mac.json", "openclaw.codex.json")


def load_config(name: str) -> dict:
    return json.loads((DEPLOY / name).read_text(encoding="utf-8"))


def test_every_compose_platform_uses_docker_and_has_the_same_core_services():
    compose = yaml.safe_load((DEPLOY / "docker-compose.yml").read_text(encoding="utf-8"))
    mac_compose = yaml.safe_load((DEPLOY / "docker-compose.mac.yml").read_text(encoding="utf-8"))
    expected = {"qq-diagnostic-filter-init", "openclaw-gateway", "openclaw-cli", "context-recovery"}

    assert set(compose["services"]) == expected
    assert set(mac_compose["services"]) == expected
    assert compose["x-openclaw-common"]["environment"]["CODEX_PROXY_TOKEN"] == "${CODEX_PROXY_TOKEN}"
    assert compose["x-openclaw-common"]["extra_hosts"] == ["host.docker.internal:host-gateway"]
    assert mac_compose["x-openclaw-common"]["environment"]["CODEX_PROXY_BASE_URL"] == "${CODEX_PROXY_BASE_URL}"
    assert mac_compose["x-openclaw-common"]["extra_hosts"] == ["host.docker.internal:host-gateway"]
    assert "qwen-vision" not in json.dumps(compose).lower()
    assert not any(word in json.dumps(mac_compose).lower() for word in ("qwen", "ollama", "cuda", "nvidia"))


def test_all_platform_configs_route_text_and_images_to_the_same_codex_proxy():
    for name in CONFIG_NAMES:
        config = load_config(name)
        defaults = config["agents"]["defaults"]
        provider = config["models"]["providers"]["codex-proxy"]
        model = provider["models"][0]
        media = config["tools"]["media"]

        assert defaults["model"] == {"primary": "codex-proxy/gpt-5.6-luna", "fallbacks": []}
        assert defaults["imageModel"] == "codex-proxy/gpt-5.6-luna"
        assert config["models"]["mode"] == "replace"
        assert set(config["models"]["providers"]) == {"codex-proxy"}
        assert provider["baseUrl"] == "${CODEX_PROXY_BASE_URL}"
        assert provider["apiKey"] == {
            "source": "env",
            "provider": "default",
            "id": "CODEX_PROXY_TOKEN",
        }
        assert model["id"] == CODEX_PROXY_MODEL
        assert model["input"] == ["text", "image"]
        assert model["params"]["reasoning_effort"] == CODEX_PROXY_REASONING_EFFORT
        assert media["models"][0]["provider"] == "codex-proxy"
        assert media["models"][0]["model"] == CODEX_PROXY_MODEL
        assert media["image"]["enabled"] is True
        assert media["video"]["enabled"] is False
        serialized = json.dumps(config).lower()
        assert "sensenova" not in serialized
        assert "deepseek" not in serialized
        assert "qwen-vision" not in serialized


def test_codex_probe_uses_one_redacted_openai_compatible_multimodal_request():
    probe = (ROOT / "scripts" / "codex_proxy_probe.py").read_text(encoding="utf-8")
    assert "CODEX_PROXY_BASE_URL" in probe
    assert "CODEX_PROXY_TOKEN" in probe
    assert "Bearer" in probe
    assert "request_json" in probe
    assert "image_url" in probe
    assert "sensenova" not in probe.lower()
    assert "deepseek" not in probe.lower()
    response = {"choices": [{"message": {"role": "assistant", "reasoning": "反代响应"}}]}
    assert content_from_response(response) == "反代响应"


def test_unix_entries_are_docker_only_and_use_the_platform_compose_file():
    scripts = sorted((ROOT / "scripts" / "mac").glob("*.sh"))
    assert {script.name for script in scripts} >= {"start.sh", "stop.sh", "status.sh", "logs.sh", "check-env.sh", "console.sh", "configure-lan-console.sh"}
    assert "docker-compose.mac.yml" in (ROOT / "scripts" / "mac" / "lib.sh").read_text(encoding="utf-8")
    assert "OPENCLAW_UID=$(id -u)" in (ROOT / "scripts" / "mac" / "start.sh").read_text(encoding="utf-8")
    assert "bot-workspace/AGENTS.md" in (ROOT / "scripts" / "mac" / "start.sh").read_text(encoding="utf-8")
    assert "QQBOT_PROACTIVE_REVIEW_ENABLED" in (ROOT / "scripts" / "mac" / "start.sh").read_text(encoding="utf-8")
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


def test_environment_template_has_codex_token_and_explicit_console_controls():
    env_text = (DEPLOY / ".env.example").read_text(encoding="utf-8")
    for key in (
        "CODEX_PROXY_BASE_URL",
        "CODEX_PROXY_TOKEN",
        "OPENCLAW_GATEWAY_BIND_HOST",
        "OPENCLAW_GATEWAY_PUBLIC_HOST",
        "OPS_CONSOLE_BIND_HOST",
        "OPS_CONSOLE_PORT",
        "OPS_CONSOLE_AUTH_MODE",
        "OPS_CONSOLE_TOKEN",
    ):
        assert f"{key}=" in env_text
    assert "SENSENOVA_API_KEY" not in env_text
    assert "DEEPSEEK_API_KEY" not in env_text
    assert "sk-" not in env_text.lower()


def test_readme_and_development_handbook_describe_the_universal_docker_codex_route():
    root_readme = (ROOT / "README.md").read_text(encoding="utf-8")
    deploy_readme = (DEPLOY / "README.md").read_text(encoding="utf-8")
    handbook = (ROOT / "AGENTS.md").read_text(encoding="utf-8")

    for document in (root_readme, deploy_readme, handbook):
        assert "Docker Compose" in document
        assert "CODEX_PROXY_TOKEN" in document
        assert "codex-proxy/gpt-5.6-luna" in document
    assert "Windows keeps the Qwen/Ollama Compose path" not in deploy_readme
    assert "SenseNova" not in deploy_readme
    assert "qwen-vision" not in deploy_readme


def test_mac_console_launcher_exports_public_host_and_private_env_boundary():
    console = (ROOT / "scripts" / "mac" / "console.sh").read_text(encoding="utf-8")
    library = (ROOT / "scripts" / "mac" / "lib.sh").read_text(encoding="utf-8")
    assert "OPENCLAW_GATEWAY_PUBLIC_HOST=$(env_value OPENCLAW_GATEWAY_PUBLIC_HOST)" in console
    assert "replace-with-*) OPS_CONSOLE_TOKEN=" in console
    assert 'chmod 600 "$ENV_FILE"' in library
