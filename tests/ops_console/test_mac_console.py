import base64
import json
import socket
import threading
import urllib.error
import urllib.request

import pytest

from ops_console.collectors import CommandResult, HostCollector, parse_compose_rows
from ops_console.server import HOST, build_server


class FakeState:
    port = None

    def snapshot(self, force=False):
        return {"schemaVersion": "qqbot-ops/v1", "secretsRedacted": True, "force": force}


class MacHostRunner:
    def run(self, args, cwd, timeout=3.0):
        if args[:3] == ["ps", "-A", "-o"]:
            return CommandResult(0, "1.0\n2.0\n")
        if args == ["sysctl", "-n", "hw.memsize"]:
            return CommandResult(0, "1000")
        if args == ["vm_stat"]:
            return CommandResult(0, "Mach Virtual Memory Statistics: (page size of 100 bytes)\nPages free: 2.\nPages inactive: 3.\nPages speculative: 1.\n")
        return CommandResult(1, stderr="not mocked")


def free_port():
    with socket.socket() as sock:
        sock.bind((HOST, 0))
        return sock.getsockname()[1]


def test_mac_compose_parser_has_only_gateway_and_recovery_services():
    output = "\n".join([
        json.dumps({"Service": "openclaw-gateway", "Name": "gateway", "State": "running"}),
        json.dumps({"Service": "context-recovery", "Name": "recovery", "State": "running"}),
        json.dumps({"Service": "qwen-vision", "Name": "retired", "State": "running"}),
    ])
    rows = parse_compose_rows(output, ("openclaw-gateway", "context-recovery"))
    assert [row["service"] for row in rows] == ["openclaw-gateway", "context-recovery"]


def test_macos_host_collector_reads_cpu_memory_and_disk_without_windows_api(tmp_path):
    result = HostCollector(tmp_path, MacHostRunner()).collect()
    assert result["cpu"]["status"] == "available"
    assert result["memory"]["status"] == "available"
    assert result["memory"]["totalBytes"] == 1000
    assert result["memory"]["availableBytes"] == 600
    assert result["disk"]["status"] == "available"


def test_lan_console_requires_auth_and_accepts_basic_auth():
    server = build_server(free_port(), state=FakeState(), host="0.0.0.0", auth_token="test-token", deployment="mac")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(base + "/api/health", timeout=2)
        assert error.value.code == 401
        credentials = base64.b64encode(b"ops:test-token").decode("ascii")
        request = urllib.request.Request(base + "/api/health", headers={"Authorization": f"Basic {credentials}"})
        with urllib.request.urlopen(request, timeout=2) as response:
            health = json.loads(response.read())
        assert health["bind"] == "0.0.0.0"
        assert health["authRequired"] is True
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_explicit_no_token_mode_is_available(monkeypatch):
    monkeypatch.setenv("OPS_CONSOLE_AUTH_MODE", "none")
    server = build_server(free_port(), state=FakeState(), host="127.0.0.1", deployment="mac")
    try:
        assert server.console_auth_token is None
        assert server.console_auth_mode == "none"
    finally:
        server.server_close()
