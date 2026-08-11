import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
DEPLOY_DIR = ROOT / "deploy" / "openclaw"


def run(*args, cwd=ROOT):
    if args and args[0] == "python" and shutil.which("python") is None:
        args = (sys.executable, *args[1:])
    return subprocess.run(args, cwd=cwd, check=False, capture_output=True, text=True, encoding="utf-8")


def test_unix_environment_validator_is_redacted_and_supports_legacy_migration(tmp_path):
    if shutil.which("sh") is None:
        pytest.skip("Unix shell is not available on this Windows host")
    env_file = tmp_path / ".env"
    env_file.write_text((DEPLOY_DIR / ".env.example").read_text(encoding="utf-8") + "HERMES_DEEPSEEK_API_KEY=legacy-test\n", encoding="utf-8")
    result = run("sh", str(DEPLOY_DIR / "validate-env.sh"), "--env-file", str(env_file), "--migrate", "--allow-placeholders")
    assert result.returncode == 0, result.stderr
    assert "legacy-test" not in result.stdout
    assert "legacy-test" not in result.stderr
    assert "DEEPSEEK_API_KEY=legacy-test" in env_file.read_text(encoding="utf-8")


def test_diagnostic_report_is_structured_and_redacted():
    result = run(
        "python",
        "scripts/openclaw_diagnostic.py",
        "--mode",
        "preflight",
        "--env-file",
        str(DEPLOY_DIR / ".env.example"),
        "--compose-dir",
        str(DEPLOY_DIR),
        "--skip-docker",
    )
    assert result.returncode == 0
    report = json.loads(result.stdout)
    assert report["mode"] == "preflight"
    assert report["environment"]["secrets_redacted"] is True
    assert "replace-with" not in result.stdout


def test_runtime_and_cache_paths_are_not_tracked():
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, check=True, capture_output=True, text=True).stdout.splitlines()
    assert not any(path.startswith("deploy/openclaw/runtime/") for path in tracked)
    assert "test_durations.json" not in tracked
