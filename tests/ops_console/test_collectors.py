import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ops_console.collectors import CommandResult, DockerCollector, ModelRouteCollector, RuntimeStateCollector, SnapshotBuilder, parse_compose_rows, parse_docker_stats, parse_runtime_events


ROOT = Path(__file__).resolve().parents[2]


class FakeRunner:
    def __init__(self, healthy=True):
        self.healthy = healthy
        self.calls = []

    def run(self, args, cwd, timeout=3.0):
        self.calls.append((args, cwd, timeout))
        joined = " ".join(args)
        if not self.healthy:
            return CommandResult(1, stderr="Cannot connect to the Docker daemon")
        if "ps --all" in joined:
            rows = [
                {"Service": "openclaw-gateway", "Name": "qq-shit-bot-openclaw-gateway-1", "Image": "openclaw:2026.7.1", "State": "running", "Health": "healthy"},
                {"Service": "context-recovery", "Name": "qq-shit-bot-context-recovery-1", "Image": "openclaw:2026.7.1", "State": "running", "Health": ""},
                {"Service": "qwen-vision", "Name": "qq-shit-bot-qwen-vision-1", "Image": "ollama:0.32.5", "State": "running", "Health": "healthy"},
            ]
            return CommandResult(0, "\n".join(json.dumps(row) for row in rows))
        if "docker stats" in joined:
            return CommandResult(0, '\n'.join([
                json.dumps({"Name": "qq-shit-bot-openclaw-gateway-1", "CPUPerc": "2.1%", "MemUsage": "128MiB / 1GiB", "MemPerc": "12.5%"}),
                json.dumps({"Name": "qq-shit-bot-qwen-vision-1", "CPUPerc": "4.2%", "MemUsage": "512MiB / 6GiB", "MemPerc": "8.3%"}),
            ]))
        if "nvidia-smi" in joined:
            return CommandResult(0, "12, 54, 2048, 8192, NVIDIA Test GPU")
        if "ollama ps" in joined:
            return CommandResult(0, "NAME ID SIZE PROCESSOR UNTIL\nqwen2.5vl:7b abc 5.0GB 100% GPU 2 minutes")
        if "compose port" in joined:
            return CommandResult(0, "127.0.0.1:18789\n")
        if " logs " in f" {joined} ":
            return CommandResult(0, "\n".join([
                "openclaw-gateway-1 | 2026-08-10T10:00:00Z WebSocket connected",
                "openclaw-gateway-1 | 2026-08-10T10:00:01Z Processing message from sender {\"type\":\"group\"}",
                "openclaw-gateway-1 | 2026-08-10T10:00:02Z [provider-transport-fetch] [model-fetch] start provider=local model=deepseek-v4-flash",
                "openclaw-gateway-1 | 2026-08-10T10:00:03Z [provider-transport-fetch] [model-fetch] response provider=local model=deepseek-v4-flash status=200",
                "openclaw-gateway-1 | 2026-08-10T10:00:04Z Sent markdown chunk (1/1 chars) (group)",
                "openclaw-gateway-1 | 2026-08-10T10:00:05Z gateway request timed out",
                "openclaw-gateway-1 | authorization: Bearer example-redacted-value",
            ]))
        return CommandResult(0, "")


class QueueAdapterRunner(FakeRunner):
    def run(self, args, cwd, timeout=3.0):
        if "node" in args and "-e" in args:
            self.calls.append((args, cwd, timeout))
            return CommandResult(0, json.dumps({
                "channel_ingress_events": [{"status": "pending", "count": 2}],
                "delivery_queue_entries": [{"status": "sent", "count": 1}],
            }))
        return super().run(args, cwd, timeout)


def test_compose_rows_are_limited_to_supported_services():
    rows = parse_compose_rows(json.dumps({"Service": "other", "State": "running"}) + "\n" + json.dumps({"Service": "qwen-vision", "State": "running"}))

    assert [row["service"] for row in rows] == ["qwen-vision"]


def test_docker_stats_are_system_ram_not_vram():
    stats = parse_docker_stats(json.dumps({"Name": "container", "MemUsage": "512MiB / 1GiB", "CPUPerc": "5.5%"}))

    assert stats["container"]["memoryBytes"] == 512 * 1024 * 1024
    assert stats["container"]["memoryKind"] == "system_ram"
    assert "not GPU VRAM" in stats["container"]["source"]


def test_docker_stats_are_scoped_to_running_compose_containers():
    runner = FakeRunner()
    collector = DockerCollector(ROOT, runner)

    collector._stats([
        {"name": "qq-shit-bot-openclaw-gateway-1", "state": "running"},
        {"name": "qq-shit-bot-qwen-vision-1", "state": "running"},
        {"name": "qq-shit-bot-context-recovery-1", "state": "exited"},
    ])

    stats_call = next(args for args, _, _ in runner.calls if args[:2] == ["docker", "stats"])
    assert stats_call[-2:] == ["qq-shit-bot-openclaw-gateway-1", "qq-shit-bot-qwen-vision-1"]


def test_queue_state_uses_fixed_scope_container_adapter():
    runtime = DockerCollector(ROOT, QueueAdapterRunner()).collect()

    assert runtime["queueState"]["status"] == "available"
    assert runtime["queueState"]["value"] == 2


def test_healthy_snapshot_separates_gpu_vram_and_ollama_model():
    runner = FakeRunner()
    runtime = DockerCollector(ROOT, runner).collect()

    assert runtime["status"]["status"] == "available"
    assert runtime["gpu"]["status"] == "available"
    assert runtime["gpu"]["memoryKind"] == "gpu_vram"
    assert runtime["gpu"]["vramUsedBytes"] == 2048 * 1024 * 1024
    assert runtime["ollama"]["currentModel"] == "qwen2.5vl:7b"
    assert runtime["systemRam"]["memoryKind"] == "system_ram"
    assert {event["type"] for event in runtime["events"]} >= {"qq_connection", "qq_inbound", "model_request", "qq_reply"}
    assert all("example-redacted" not in record["summary"] for record in runtime["logRecords"])


def test_runtime_event_parser_keeps_only_safe_metadata():
    events = parse_runtime_events(
        'openclaw-gateway-1 | 2026-08-11T02:00:00Z Processing message from private-content {"type":"group","messageId":"secret"}'
    )

    assert events[0]["type"] == "qq_inbound"
    assert events[0]["channel"] == "group"
    assert "private-content" not in json.dumps(events)
    assert "messageId" not in json.dumps(events)


def test_snapshot_collects_openclaw_configuration_without_secrets():
    snapshot = SnapshotBuilder(ROOT, FakeRunner()).build()
    configuration = snapshot["runtime"]["configuration"]

    assert configuration["status"] == "available"
    assert configuration["contextTokens"] == 32768
    assert configuration["queueMode"] == "steer"
    assert configuration["queueCap"] == 2
    assert snapshot["sessions"]["contextTokenConfiguration"]["value"] == 32768
    assert ".env" not in json.dumps(snapshot)


def test_runtime_state_reads_queue_and_recent_input_tokens_without_payloads(tmp_path):
    state_db = tmp_path / "openclaw.sqlite"
    connection = sqlite3.connect(state_db)
    connection.executescript("""
        CREATE TABLE channel_ingress_events (status TEXT, payload_json TEXT);
        CREATE TABLE delivery_queue_entries (status TEXT, entry_json TEXT);
    """)
    connection.execute("INSERT INTO channel_ingress_events VALUES ('pending', '{\"private\":\"payload\"}')")
    connection.execute("INSERT INTO delivery_queue_entries VALUES ('sent', '{\"private\":\"payload\"}')")
    connection.commit()
    connection.close()

    session_dir = tmp_path / "sessions"
    session_dir.mkdir()
    (session_dir / "052446b3-6933-42d1-9dba-0bdbd2a56a63.jsonl").write_text("\n".join([
        json.dumps({"type": "session", "timestamp": "2026-08-10T18:00:00Z"}),
        json.dumps({"type": "message", "timestamp": "2026-08-10T18:00:01Z", "message": {"role": "assistant", "model": "deepseek-chat", "usage": {"input": 1234}}}),
    ]), encoding="utf-8")

    state = RuntimeStateCollector(state_db, session_dir).collect(idle_minutes=120)

    assert state["queueLength"]["status"] == "available"
    assert state["queueLength"]["value"] == 1
    assert state["contextTokens"]["value"] == 1234
    assert state["sessions"][0]["id"].startswith("session-")
    assert "payload" not in json.dumps(state)


def test_runtime_state_accepts_only_safe_container_queue_metadata(tmp_path):
    state = RuntimeStateCollector(tmp_path / "hidden-state.sqlite", tmp_path / "missing-sessions").collect(
        queue_override={"status": "available", "value": 2, "source": "fixed adapter"}
    )

    assert state["queueLength"]["value"] == 2
    assert "payload" not in json.dumps(state)


def test_model_route_falls_back_to_safe_openclaw_configuration(tmp_path):
    watcher = tmp_path / "missing-model-route-state.json"
    config = tmp_path / "openclaw.json"
    config.write_text(json.dumps({
        "agents": {"defaults": {"model": {"primary": "sensenova-token/deepseek-v4-flash", "fallbacks": ["deepseek/deepseek-chat"]}}},
        "models": {"providers": {"deepseek": {"apiKey": "must-not-appear"}}},
    }), encoding="utf-8")

    result = ModelRouteCollector(watcher, config).collect()

    assert result["status"] == "available"
    assert result["source"] == "deploy/openclaw/openclaw.json"
    assert result["confidence"] == "direct"
    assert result["primary"] == "sensenova-token/deepseek-v4-flash"
    assert result["fallback"] == "deepseek/deepseek-chat"
    assert result["lastProbeAt"] is None
    assert "must-not-appear" not in json.dumps(result, ensure_ascii=False)


def test_model_route_ignores_stale_watcher_state(tmp_path):
    config = tmp_path / "openclaw.json"
    config.write_text(json.dumps({
        "agents": {"defaults": {"model": {"primary": "configured-primary", "fallbacks": ["configured-fallback"]}}},
    }), encoding="utf-8")
    watcher = tmp_path / "model-route-state.json"
    watcher.write_text(json.dumps({
        "primary": "stale-primary",
        "fallback": "stale-fallback",
        "route": "primary-configured",
        "primaryAvailable": True,
        "statusCode": 200,
        "lastProbeAt": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
    }), encoding="utf-8")

    result = ModelRouteCollector(watcher, config).collect()

    assert result["source"] == "deploy/openclaw/openclaw.json"
    assert result["primary"] == "configured-primary"
    assert result["lastProbeAt"] is None


def test_unhealthy_service_cannot_make_dashboard_operational():
    services = [
        {"status": "running", "health": "healthy"},
        {"status": "running", "health": "not_configured"},
        {"status": "running", "health": "unhealthy"},
    ]

    status, _ = SnapshotBuilder._overall(services, {"status": "healthy"}, {"status": "available"})

    assert status == "degraded"


def test_docker_failure_is_unknown_or_degraded_and_never_zero():
    snapshot = SnapshotBuilder(ROOT, FakeRunner(healthy=False)).build()
    encoded = json.dumps(snapshot, ensure_ascii=False)

    assert snapshot["dashboard"]["status"] == "degraded"
    assert snapshot["runtime"]["docker"]["status"] == "unavailable"
    assert snapshot["runtime"]["gpu"]["status"] == "unknown"
    assert snapshot["runtime"]["gpu"].get("vramUsedBytes") is None
    assert snapshot["secretsRedacted"] is True
    assert ".env" not in encoded
    assert "private-token" not in encoded
    assert "api_key" not in encoded.lower()
