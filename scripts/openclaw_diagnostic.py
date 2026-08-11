#!/usr/bin/env python3
"""Redacted OpenClaw preflight and runtime health report.

The report deliberately returns states and counts, never environment values or
raw logs. It is local evidence only; it cannot prove real QQ delivery.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


REQUIRED_ENV = (
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_TZ",
    "QQBOT_APP_ID",
    "QQBOT_CLIENT_SECRET",
    "SENSENOVA_API_KEY",
    "DEEPSEEK_API_KEY",
)
OPTIONAL_ENV = (
    "QQBOT_ALLOWED_USER_OPENID",
    "QQBOT_ALLOWED_MEMBER_OPENID",
    "QQBOT_HOME_CHANNEL",
)
PLACEHOLDER_PREFIX = "replace-with-"


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", raw)
        if match:
            value = match.group(2)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[match.group(1)] = value
    return values


def configured(value: str | None) -> bool:
    return bool(value and not value.startswith(PLACEHOLDER_PREFIX))


def run_command(args: list[str], cwd: Path, timeout: int = 20) -> tuple[int, str]:
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return 127, ""
    return result.returncode, result.stdout


def compose_command(compose_dir: Path, env_file: Path, deployment: str = "windows") -> list[str]:
    files = [compose_dir / "docker-compose.mac.yml"] if deployment == "mac" else [
        compose_dir / "docker-compose.yml",
        compose_dir / "docker-compose.local.yml",
    ]
    command = [
        "docker",
        "compose",
        "--env-file",
        str(env_file),
    ]
    for compose_file in files:
        command.extend(["-f", str(compose_file)])
    return command


def probe_http(port: int, host: str = "127.0.0.1") -> dict[str, Any]:
    probe_host = host if host not in {"0.0.0.0", "::"} else "127.0.0.1"
    url = f"http://{probe_host}:{port}/healthz"
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return {"reachable": True, "status": response.status}
    except urllib.error.HTTPError as error:
        return {"reachable": True, "status": error.code}
    except (OSError, urllib.error.URLError, ValueError):
        return {"reachable": False, "status": None}


def service_rows(output: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in output.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(
                {
                    "service": value.get("Service") or value.get("Name"),
                    "state": value.get("State"),
                    "health": value.get("Health"),
                }
            )
    return rows


def env_report(env_file: Path) -> dict[str, Any]:
    values = parse_env(env_file)
    checks = {key: configured(values.get(key)) for key in REQUIRED_ENV}
    return {
        "file_present": env_file.is_file(),
        "required": checks,
        "optional_configured": {key: configured(values.get(key)) for key in OPTIONAL_ENV},
        "all_required_configured": all(checks.values()),
        "secrets_redacted": True,
    }


def preflight(args: argparse.Namespace) -> dict[str, Any]:
    env_file = args.env_file.resolve()
    compose_dir = args.compose_dir.resolve()
    report: dict[str, Any] = {"mode": "preflight", "environment": env_report(env_file)}
    if args.skip_docker:
        report["docker"] = {"skipped": True}
        return report

    code, _ = run_command(["docker", "info"], compose_dir)
    report["docker"] = {"available": code == 0, "daemon_ready": code == 0}
    command = compose_command(compose_dir, env_file, args.deployment)
    code, _ = run_command(command + ["config", "--quiet"], compose_dir)
    report["compose"] = {"config_valid": code == 0}
    if code != 0:
        return report
    code, output = run_command(command + ["ps", "--all", "--format", "json"], compose_dir)
    report["services"] = service_rows(output) if code == 0 else []
    return report


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def health(args: argparse.Namespace) -> dict[str, Any]:
    env_file = args.env_file.resolve()
    compose_dir = args.compose_dir.resolve()
    values = parse_env(env_file)
    port = int(values.get("OPENCLAW_GATEWAY_PORT") or 18789)
    deployment = args.deployment
    configured_gateway_host = values.get("OPENCLAW_GATEWAY_BIND_HOST")
    gateway_host = configured_gateway_host if configured(configured_gateway_host) else "127.0.0.1"
    vision_status = {
        "status": "not_applicable",
        "detail": "Mac 使用 SenseNova 云端视觉；本地视觉服务未启用",
        "source": "docker-compose.mac.yml",
        "secrets_redacted": True,
    } if deployment == "mac" else {"status": "unknown", "model_device": "unknown"}
    report: dict[str, Any] = {
        "mode": "health",
        "deployment": deployment,
        "gateway": {"http": probe_http(port, gateway_host)},
        "context_recovery": {"status": "unknown"},
        "qwen_ollama": vision_status,
        "gpu": vision_status if deployment == "mac" else {"status": "unknown", "devices": []},
        "logs": {"status": "unknown", "bytes": None, "max_bytes": 64 * 1024 * 1024},
        "model_route": {"status": "unknown", "evidence": "no local watcher state"},
        "qq_delivery_verification": "not_verified_externally",
        "secrets_redacted": True,
    }
    if args.skip_docker:
        report["docker"] = {"skipped": True}
        return report

    command = compose_command(compose_dir, env_file, deployment)
    code, output = run_command(command + ["ps", "--all", "--format", "json"], compose_dir)
    rows = service_rows(output) if code == 0 else []
    by_service = {str(row.get("service")): row for row in rows}
    gateway = by_service.get("openclaw-gateway", {})
    recovery = by_service.get("context-recovery", {})
    report["gateway"]["container"] = gateway
    report["context_recovery"] = recovery or {"status": "not_found"}
    if deployment != "mac":
        qwen = by_service.get("qwen-vision", {})
        report["qwen_ollama"]["container"] = qwen or {"status": "not_found"}

    if deployment != "mac" and qwen:
        code, output = run_command(command + ["exec", "-T", "qwen-vision", "ollama", "ps"], compose_dir)
        report["qwen_ollama"]["ollama_ps"] = output.strip() if code == 0 else "unavailable"
        report["qwen_ollama"]["status"] = "ready" if code == 0 else "unavailable"
        report["qwen_ollama"]["model_device"] = (
            "cuda_or_gpu_reported" if code == 0 and re.search(r"(?i)gpu|cuda", output) else "not_reported"
        )
        code, output = run_command(
            command
            + [
                "exec",
                "-T",
                "qwen-vision",
                "nvidia-smi",
                "--query-gpu=name,driver_version,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            compose_dir,
        )
        if code == 0:
            report["gpu"] = {"status": "available", "devices": [line.strip() for line in output.splitlines() if line.strip()]}
        else:
            report["gpu"] = {"status": "unavailable_or_not_exposed", "devices": []}

    code, output = run_command(
        command + ["exec", "-T", "openclaw-gateway", "sh", "-c", "wc -c < /tmp/openclaw/gateway.log"], compose_dir
    )
    if code == 0:
        try:
            size = int(output.strip())
        except ValueError:
            size = None
        report["logs"] = {
            "status": "within_limit" if size is not None and size <= 64 * 1024 * 1024 else "over_limit",
            "bytes": size,
            "max_bytes": 64 * 1024 * 1024,
        }

    state = read_json(compose_dir / "runtime" / "model-route-state.json")
    if state:
        report["model_route"] = {
            "status": state.get("route", "unknown"),
            "last_probe": state.get("lastProbeAt"),
            "status_code": state.get("statusCode"),
            "evidence": "local watcher state; request-level fallback is not externally verified",
        }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("preflight", "health"), default="preflight")
    parser.add_argument("--env-file", type=Path, default=Path("deploy/openclaw/.env"))
    parser.add_argument("--compose-dir", type=Path, default=Path("deploy/openclaw"))
    parser.add_argument("--deployment", choices=("windows", "mac"), default="windows")
    parser.add_argument("--skip-docker", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    report = preflight(args) if args.mode == "preflight" else health(args)
    print(json.dumps(report, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True))
    if args.mode == "preflight" and not args.skip_docker:
        return 0 if report["environment"]["all_required_configured"] and report.get("compose", {}).get("config_valid") else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
