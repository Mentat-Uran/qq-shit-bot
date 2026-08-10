"""Local-only HTTP server for the QQ Bot Operations Console."""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import webbrowser
from collections import deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .collectors import DEFAULT_GATEWAY_PORT, MAX_HISTORY_SAMPLES, SnapshotBuilder
from .models import unknown, utc_now
from .redaction import public_error


HOST = "127.0.0.1"
DEFAULT_PORT = 18888
STATIC_DIR = Path(__file__).resolve().parent / "static"


def _empty_services(observed_at: str) -> list[dict[str, Any]]:
    return [
        {
            "service": service,
            "state": "unknown",
            "status": "unknown",
            "health": "unknown",
            "observedAt": observed_at,
            "source": "console fallback",
            "confidence": "not_collected",
        }
        for service in ("openclaw-gateway", "context-recovery", "qwen-vision")
    ]


def degraded_snapshot(detail: str) -> dict[str, Any]:
    observed_at = utc_now()
    services = _empty_services(observed_at)
    unknown_host = {
        "cpu": unknown("host CPU", detail, observed_at),
        "memory": unknown("host memory", detail, observed_at),
        "disk": unknown("host disk", detail, observed_at),
    }
    unknown_configuration = unknown("deploy/openclaw/openclaw.json", detail, observed_at)
    errors = [{
        "id": "console-collector-error",
        "service": "console",
        "level": "error",
        "summary": detail,
        "observedAt": observed_at,
        "source": "console snapshot",
        "confidence": "direct",
    }]
    return {
        "schemaVersion": "qqbot-ops/v1",
        "observedAt": observed_at,
        "console": {"status": "degraded", "detail": detail, "bind": HOST, "port": None, "source": "local console snapshot", "confidence": "direct"},
        "dashboard": {
            "status": "degraded",
            "detail": detail,
            "gateway": unknown("OpenClaw /healthz on loopback", detail, observed_at),
            "services": services,
            "websocket": unknown("gateway log pattern", detail, observed_at),
            "recentEventAt": None,
            "recentModelRequestAt": None,
            "recentSuccessfulReplyAt": None,
            "modelRoute": unknown("model route state", detail, observed_at),
            "recentErrors": errors,
            "host": unknown_host,
            "gpu": unknown("nvidia-smi / qwen-vision", detail, observed_at),
            "ollama": unknown("ollama ps via qwen-vision", detail, observed_at),
            "lastRefreshAt": observed_at,
        },
        "runtime": {
            "services": services,
            "docker": unknown("docker compose", detail, observed_at),
            "gpu": unknown("nvidia-smi / qwen-vision", detail, observed_at),
            "ollama": unknown("ollama ps via qwen-vision", detail, observed_at),
            "host": unknown_host,
            "configuration": unknown_configuration,
            "history": [],
        },
        "activity": {
            "events": [],
            "connection": unknown("gateway log pattern", detail, observed_at),
            "queueLength": unknown("structured local event model", "队列长度未采集", observed_at),
            "queueConfiguration": unknown_configuration,
            "eventCollection": unknown("docker compose logs --tail 80", detail, observed_at),
            "recentEventAt": unknown("structured local event model", "事件未采集", observed_at),
            "recentModelRequestAt": unknown("structured local event model", "模型请求未采集", observed_at),
            "recentSuccessfulReplyAt": unknown("structured local event model", "成功回复未采集", observed_at),
            "privacy": "仅展示脱敏元数据",
        },
        "sessions": {
            "sessions": [],
            "summary": unknown("structured local session model", "会话未采集", observed_at),
            "contextTokens": unknown("OpenClaw session adapter", "token 数未采集", observed_at),
            "contextTokenConfiguration": unknown_configuration,
            "compactionConfiguration": unknown_configuration,
            "recovery": unknown("docker compose logs --tail 80", detail, observed_at),
            "queueConfiguration": unknown_configuration,
            "privacy": "不展示完整消息、图片、OpenID 或完整群号",
        },
        "logs": {"status": unknown("docker compose logs", detail, observed_at), "records": errors, "recentErrors": errors, "retention": {"tailLines": 80, "maxRecords": 80, "rawPayloadsStored": False}},
        "operations": {"allowed": ["refresh", "open_control_ui", "view_services"], "gatewayUrl": f"http://{HOST}:{DEFAULT_GATEWAY_PORT}/", "services": [item["service"] for item in services], "note": "Phase 1 只读"},
        "evidenceBoundary": ["采集器异常不代表服务正常或外部 QQ 可用", "QQ 真实收发仍未被本地页面证明"],
        "secretsRedacted": True,
    }


class SnapshotService:
    def __init__(self, root: Path):
        self.builder = SnapshotBuilder(root)
        self._cache: dict[str, Any] | None = None
        self._cache_at = 0.0
        self._lock = threading.RLock()
        self._history: deque[dict[str, Any]] = deque(maxlen=MAX_HISTORY_SAMPLES)
        self.port: int | None = None

    def _history_sample(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        runtime = snapshot.get("runtime", {})
        host = runtime.get("host", {})
        docker = runtime.get("docker", {})
        gpu = runtime.get("gpu", {})
        return {
            "observedAt": snapshot.get("observedAt"),
            "hostCpuPercent": (host.get("cpu") or {}).get("percent"),
            "hostMemoryPercent": (host.get("memory") or {}).get("usedPercent"),
            "dockerRamBytes": (docker.get("systemRam") or {}).get("bytes"),
            "gpuUtilizationPercent": gpu.get("utilizationPercent"),
            "gpuVramUsedBytes": gpu.get("vramUsedBytes"),
        }

    def snapshot(self, force: bool = False) -> dict[str, Any]:
        with self._lock:
            if not force and self._cache is not None and time.monotonic() - self._cache_at < 3.0:
                return self._cache
            try:
                payload = self.builder.build(list(self._history))
            except Exception as exc:  # The page must survive a collector failure.
                payload = degraded_snapshot(public_error(str(exc), fallback="采集器异常"))
            payload["console"]["port"] = self.port
            self._history.append(self._history_sample(payload))
            payload["runtime"]["history"] = list(self._history)
            self._cache = payload
            self._cache_at = time.monotonic()
            return payload


class ConsoleHandler(BaseHTTPRequestHandler):
    server_version = "QQBotOps/0.1"
    protocol_version = "HTTP/1.1"

    @property
    def state(self) -> SnapshotService:
        return self.server.console_state  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        # Never echo the raw request target; query strings are not part of the API.
        method = self.command
        path = urlsplit(self.path).path[:80]
        sys.stderr.write(f"[qqbot-ops] {method} {path}\n")

    def _headers(self, content_type: str, length: int) -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")

    def _send_json(self, payload: dict[str, Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self._headers("application/json; charset=utf-8", len(body))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, body: bytes, content_type: str, status: int = HTTPStatus.OK) -> None:
        self.send_response(status)
        self._headers(content_type, len(body))
        self.end_headers()
        self.wfile.write(body)

    def _not_found(self) -> None:
        self._send_json({"error": "not_found", "message": "资源不存在"}, HTTPStatus.NOT_FOUND)

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path == "/api/health":
            self._send_json({"ok": True, "bind": HOST, "port": self.state.port, "observedAt": utc_now(), "secretsRedacted": True})
            return
        if path == "/api/snapshot" or path == "/api/diagnostics":
            self._send_json(self.state.snapshot())
            return
        if path == "/api/operations/services":
            snapshot = self.state.snapshot()
            self._send_json({"services": snapshot["operations"]["services"], "allowed": snapshot["operations"]["allowed"], "observedAt": snapshot["observedAt"]})
            return
        if path == "/" or path == "/index.html":
            self._send_bytes((STATIC_DIR / "index.html").read_bytes(), "text/html; charset=utf-8")
            return
        if path == "/favicon.ico":
            self._send_bytes(b"", "image/x-icon")
            return
        static_files = {"/app.js": "app.js", "/styles.css": "styles.css"}
        if path in static_files:
            filename = STATIC_DIR / static_files[path]
            content_type = "application/javascript; charset=utf-8" if path.endswith(".js") else "text/css; charset=utf-8"
            self._send_bytes(filename.read_bytes(), content_type)
            return
        self._not_found()

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path != "/api/refresh":
            self._not_found()
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > 0:
            self._send_json({"error": "body_not_allowed", "message": "刷新接口不接受请求体"}, HTTPStatus.BAD_REQUEST)
            return
        self._send_json(self.state.snapshot(force=True))


def build_server(port: int = DEFAULT_PORT, *, state: SnapshotService | None = None, host: str = HOST) -> ThreadingHTTPServer:
    if host != HOST:
        raise ValueError("控制台只允许绑定 127.0.0.1")
    if not 1024 <= port <= 65535:
        raise ValueError("控制台端口必须在 1024-65535 之间")
    service = state or SnapshotService(Path(__file__).resolve().parents[1])
    server = ThreadingHTTPServer((HOST, port), ConsoleHandler)
    server.daemon_threads = True
    server.console_state = service  # type: ignore[attr-defined]
    service.port = int(server.server_address[1])
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the local-only QQ Bot Operations Console")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--open-browser", action="store_true")
    args = parser.parse_args(argv)
    try:
        server = build_server(args.port)
    except (OSError, ValueError) as exc:
        print(f"QQ Bot Operations Console 启动失败：{public_error(str(exc), fallback='端口不可用')}", file=sys.stderr)
        return 1
    url = f"http://{HOST}:{server.server_address[1]}/"
    print(f"QQ Bot Operations Console: {url}", flush=True)
    if args.open_browser:
        threading.Timer(0.35, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
