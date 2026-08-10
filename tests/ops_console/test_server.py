import json
import socket
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from ops_console.server import HOST, build_server


class FakeState:
    port = None

    def snapshot(self, force=False):
        return {"schemaVersion": "qqbot-ops/v1", "secretsRedacted": True, "force": force}


def free_port():
    with socket.socket() as sock:
        sock.bind((HOST, 0))
        return sock.getsockname()[1]


def test_server_rejects_non_loopback_binding():
    with pytest.raises(ValueError):
        build_server(free_port(), state=FakeState(), host="0.0.0.0")


def test_server_reports_port_conflict_without_fallback_binding():
    port = free_port()
    blocker = socket.socket()
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        blocker.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    blocker.bind((HOST, port))
    blocker.listen(1)
    try:
        with pytest.raises(OSError):
            build_server(port, state=FakeState())
    finally:
        blocker.close()


def test_server_serves_health_static_and_refresh_without_request_body():
    server = build_server(free_port(), state=FakeState())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://{HOST}:{server.server_address[1]}"
    try:
        with urllib.request.urlopen(base + "/api/health", timeout=2) as response:
            health = json.loads(response.read())
        with urllib.request.urlopen(base + "/", timeout=2) as response:
            html = response.read().decode("utf-8")
        request = urllib.request.Request(base + "/api/refresh", method="POST")
        with urllib.request.urlopen(request, timeout=2) as response:
            refreshed = json.loads(response.read())

        assert health["ok"] is True
        assert health["bind"] == HOST
        assert "QQ BOT" in html
        assert refreshed["force"] is True
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_server_rejects_refresh_request_body():
    server = build_server(free_port(), state=FakeState())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://{HOST}:{server.server_address[1]}"
    try:
        request = urllib.request.Request(base + "/api/refresh", data=b"{}", method="POST")
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request, timeout=2)
        assert error.value.code == 400
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
