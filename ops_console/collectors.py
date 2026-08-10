"""Fixed-scope collectors for the OpenClaw + Docker deployment.

The collector surface is intentionally closed: every command, service name,
container path, and URL is defined in this module. Nothing comes from an HTTP
request.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import evidence, unknown, utc_now
from .redaction import public_error


SERVICES = ("openclaw-gateway", "context-recovery", "qwen-vision")
DEFAULT_GATEWAY_PORT = 18789
MAX_LOG_RECORDS = 80
MAX_HISTORY_SAMPLES = 720
CONFIG_PATH = "deploy/openclaw/openclaw.json"
LOG_SOURCE = "docker compose logs --tail 80"
STATE_DB_PATH = "deploy/openclaw/runtime/config/state/openclaw.sqlite"
SESSION_DIR = "deploy/openclaw/runtime/config/agents/main/sessions"
MAX_SESSION_ROWS = 24
MODEL_ROUTE_MAX_AGE_SECONDS = 15 * 60
QUEUE_TABLES = ("channel_ingress_events", "delivery_queue_entries")
ACTIVE_QUEUE_STATUSES = {"queued", "pending", "processing", "claimed", "sending", "in_flight", "retrying", "waiting", "ready"}
TERMINAL_QUEUE_STATUSES = {"completed", "done", "sent", "failed", "cancelled", "expired", "dropped"}
QUEUE_ADAPTER_SCRIPT = (
    "const { DatabaseSync } = require('node:sqlite');"
    "const db = new DatabaseSync('/home/node/.openclaw/state/openclaw.sqlite', { readOnly: true });"
    "const tables = ['channel_ingress_events', 'delivery_queue_entries'];"
    "const result = {};"
    "for (const table of tables) result[table] = db.prepare(`SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`).all();"
    "process.stdout.write(JSON.stringify(result));"
)


@dataclass(frozen=True)
class CommandResult:
    code: int
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False


class CommandRunner:
    """Run only already-constructed argv arrays with bounded timeouts."""

    def run(self, args: list[str], cwd: Path, timeout: float = 3.0) -> CommandResult:
        try:
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            result = subprocess.run(
                args,
                cwd=cwd,
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                creationflags=creationflags,
            )
        except FileNotFoundError:
            return CommandResult(127, stderr="command unavailable")
        except subprocess.TimeoutExpired:
            return CommandResult(124, stderr="command timed out", timed_out=True)
        except OSError as exc:
            return CommandResult(126, stderr=str(exc))
        return CommandResult(result.returncode, result.stdout, result.stderr)


def parse_json_lines(output: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for raw in output.splitlines():
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(value)
        elif isinstance(value, list):
            rows.extend(item for item in value if isinstance(item, dict))
    return rows


def parse_compose_rows(output: str) -> list[dict[str, Any]]:
    """Normalize Compose's JSON output without exposing raw row data."""

    rows: list[dict[str, Any]] = []
    for row in parse_json_lines(output):
        service = row.get("Service") or row.get("service") or row.get("Name")
        if service not in SERVICES:
            continue
        rows.append(
            {
                "service": service,
                "name": str(row.get("Name") or ""),
                "image": str(row.get("Image") or "unknown"),
                "state": str(row.get("State") or row.get("state") or "unknown").lower(),
                "health": str(row.get("Health") or row.get("health") or "unknown").lower(),
                "createdAt": row.get("CreatedAt"),
                "startedAt": row.get("StartedAt"),
            }
        )
    return rows


def parse_percent(value: str) -> float | None:
    match = re.search(r"(-?\d+(?:\.\d+)?)", value or "")
    return round(float(match.group(1)), 1) if match else None


def parse_bytes(value: str) -> int | None:
    match = re.search(r"(-?\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?", value or "", re.IGNORECASE)
    if not match:
        return None
    number = float(match.group(1))
    multiplier = {
        "b": 1,
        "kb": 1000,
        "kib": 1024,
        "mb": 1000**2,
        "mib": 1024**2,
        "gb": 1000**3,
        "gib": 1024**3,
        "tb": 1000**4,
        "tib": 1024**4,
    }.get((match.group(2) or "b").lower(), 1)
    return int(number * multiplier)


def parse_docker_stats(output: str) -> dict[str, dict[str, Any]]:
    stats: dict[str, dict[str, Any]] = {}
    for row in parse_json_lines(output):
        name = str(row.get("Name") or row.get("Container") or "")
        if not name:
            continue
        memory_usage = str(row.get("MemUsage") or row.get("Mem Usage") or "")
        memory_used = parse_bytes(memory_usage.split("/")[0]) if memory_usage else None
        stats[name] = {
            "cpuPercent": parse_percent(str(row.get("CPUPerc") or "")),
            "memoryBytes": memory_used,
            "memoryPercent": parse_percent(str(row.get("MemPerc") or "")),
            "memoryKind": "system_ram",
            "source": "docker stats MEM USAGE; system RAM, not GPU VRAM",
        }
    return stats


def parse_gpu_csv(output: str) -> dict[str, Any] | None:
    for raw in output.splitlines():
        parts = [part.strip() for part in raw.split(",")]
        if len(parts) < 5:
            continue
        utilization = parse_percent(parts[0])
        temperature = parse_percent(parts[1])
        used_mib = parse_bytes(f"{parts[2]} MiB")
        total_mib = parse_bytes(f"{parts[3]} MiB")
        if utilization is None and temperature is None and used_mib is None and total_mib is None:
            continue
        return {
            "utilizationPercent": utilization,
            "temperatureC": temperature,
            "vramUsedBytes": used_mib,
            "vramTotalBytes": total_mib,
            "name": parts[4][:80],
        }
    return None


def parse_ollama_model(output: str) -> str | None:
    match = re.search(r"\b(qwen2\.5vl:7b)\b", output, re.IGNORECASE)
    return match.group(1) if match else None


def service_row(row: dict[str, Any] | None, service: str, stats: dict[str, dict[str, Any]], observed_at: str) -> dict[str, Any]:
    if not row:
        return {
            "service": service,
            "state": "unknown",
            "health": "unknown",
            "observedAt": observed_at,
            "source": "docker compose ps --all",
            "confidence": "not_collected",
            "detail": "未找到服务记录",
        }
    state = row["state"]
    health = row["health"]
    if service == "context-recovery" and state == "running" and health in {"", "unknown"}:
        health = "not_configured"
    container_name = row["name"]
    result: dict[str, Any] = {
        "service": service,
        "container": container_name or "unknown",
        "image": row["image"],
        "state": state,
        "status": "running" if state == "running" else ("stopped" if state in {"exited", "dead"} else state),
        "health": health,
        "createdAt": row.get("createdAt"),
        "startedAt": row.get("startedAt"),
        "observedAt": observed_at,
        "source": "docker compose ps --all",
        "confidence": "direct",
    }
    if container_name in stats:
        result["resources"] = stats[container_name]
    return result


def _public_command_detail(result: CommandResult) -> str:
    if result.timed_out:
        return "采集超时"
    return public_error(result.stderr or result.stdout, fallback="采集失败")


def summarize_log(level: str, lowered: str) -> str:
    """Return a category-only summary; never forward a raw log sentence."""

    if "timeout" in lowered or "timed out" in lowered:
        return "检测到超时日志"
    if "fallback" in lowered:
        return "检测到 fallback 日志"
    if "429" in lowered:
        return "检测到上游 429 日志"
    if "unhealthy" in lowered:
        return "检测到不健康状态日志"
    if "disconnect" in lowered or "closed" in lowered or "reconnect" in lowered:
        return "检测到连接中断日志"
    return "检测到错误日志" if level == "error" else "检测到警告日志"


def _log_timestamp(raw: str, fallback: str) -> str:
    match = re.search(r"\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b", raw)
    if not match:
        return fallback
    try:
        return datetime.fromisoformat(match.group(1).replace("Z", "+00:00")).isoformat(timespec="seconds").replace("+00:00", "Z")
    except ValueError:
        return fallback


def _log_service(raw: str) -> str:
    for service in SERVICES:
        if service in raw:
            return service
    return "openclaw-gateway"


def _safe_event(event_type: str, phase: str, raw: str, service: str, index: int, fallback: str, **values: Any) -> dict[str, Any]:
    event = {
        "id": f"event-{index}",
        "type": event_type,
        "phase": phase,
        "service": service,
        "observedAt": _log_timestamp(raw, fallback),
        "source": LOG_SOURCE,
        "confidence": "inferred",
    }
    event.update(values)
    return event


def parse_runtime_events(output: str, observed_at: str | None = None) -> list[dict[str, Any]]:
    """Extract only allow-listed, content-free lifecycle events from logs."""

    fallback = observed_at or utc_now()
    events: list[dict[str, Any]] = []
    for index, raw in enumerate(output.splitlines()[-MAX_LOG_RECORDS:]):
        lowered = raw.lower()
        service = _log_service(raw)
        if re.search(r"processing message from", lowered):
            channel = "group" if re.search(r"type[\"']?\s*:\s*[\"']?group", lowered) else "direct"
            events.append(_safe_event("qq_inbound", "received", raw, service, index, fallback, channel=channel))
        if re.search(r"skipped group inbound", lowered):
            reason_match = re.search(r"(?:skipreason|reason)[=:]\s*([a-z0-9_-]+)", lowered)
            events.append(_safe_event("qq_inbound", "skipped", raw, service, index, fallback, channel="group", reason=reason_match.group(1) if reason_match else "unknown"))
        if re.search(r"websocket connected|gateway resumed", lowered):
            events.append(_safe_event("qq_connection", "connected", raw, service, index, fallback))
        elif re.search(r"gateway disconnected|websocket closed", lowered):
            events.append(_safe_event("qq_connection", "disconnected", raw, service, index, fallback))
        if "[model-fetch]" in lowered and re.search(r"\bstart\b", lowered):
            model_match = re.search(r"\bmodel=([a-z0-9._:-]+)", lowered)
            events.append(_safe_event("model_request", "started", raw, service, index, fallback, model=model_match.group(1) if model_match else "unknown"))
        if "[model-fetch]" in lowered and re.search(r"\bresponse\b.*\bstatus=200\b", lowered):
            model_match = re.search(r"\bmodel=([a-z0-9._:-]+)", lowered)
            events.append(_safe_event("model_request", "succeeded", raw, service, index, fallback, model=model_match.group(1) if model_match else "unknown"))
        if re.search(r"sent markdown chunk", lowered):
            chunk_match = re.search(r"chunk \((\d+)/(\d+)", lowered)
            events.append(_safe_event(
                "qq_reply",
                "sent",
                raw,
                service,
                index,
                fallback,
                channel="group" if "(group)" in lowered else "direct",
                chunkIndex=int(chunk_match.group(1)) if chunk_match else None,
                chunkTotal=int(chunk_match.group(2)) if chunk_match else None,
            ))
        if re.search(r"context overflow detected|exhausted provider overflow recovery|auto-compaction failed.*context overflow", lowered):
            events.append(_safe_event("context_recovery", "overflow", raw, service, index, fallback))
        elif re.search(r"stalled session:.*(?:stalled_agent_run|state=processing)", lowered):
            events.append(_safe_event("context_recovery", "stalled", raw, service, index, fallback))
        if re.search(r"reset session after recoverable failure", lowered):
            events.append(_safe_event("context_recovery", "reset", raw, service, index, fallback))
    return events[-MAX_LOG_RECORDS:]


class RuntimeConfigCollector:
    """Read allow-listed operational limits from the checked-in OpenClaw config."""

    def __init__(self, path: Path):
        self.path = path

    def collect(self) -> dict[str, Any]:
        observed_at = utc_now()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return unknown(CONFIG_PATH, "OpenClaw 配置不可读取", observed_at)
        if not isinstance(payload, dict):
            return unknown(CONFIG_PATH, "OpenClaw 配置格式不可用", observed_at)

        agents = payload.get("agents") if isinstance(payload.get("agents"), dict) else {}
        defaults = agents.get("defaults") if isinstance(agents.get("defaults"), dict) else {}
        channels = payload.get("channels") if isinstance(payload.get("channels"), dict) else {}
        qqbot = channels.get("qqbot") if isinstance(channels.get("qqbot"), dict) else {}
        groups = qqbot.get("groups") if isinstance(qqbot.get("groups"), dict) else {}
        group_default = groups.get("*") if isinstance(groups.get("*"), dict) else {}
        messages = payload.get("messages") if isinstance(payload.get("messages"), dict) else {}
        queue = messages.get("queue") if isinstance(messages.get("queue"), dict) else {}
        inbound = messages.get("inbound") if isinstance(messages.get("inbound"), dict) else {}
        session = payload.get("session") if isinstance(payload.get("session"), dict) else {}
        reset_by_type = session.get("resetByType") if isinstance(session.get("resetByType"), dict) else {}
        group_session = reset_by_type.get("group") if isinstance(reset_by_type.get("group"), dict) else {}
        compaction = defaults.get("compaction") if isinstance(defaults.get("compaction"), dict) else {}

        def integer(value: Any) -> int | None:
            return value if isinstance(value, int) and not isinstance(value, bool) else None

        return evidence(
            "available",
            CONFIG_PATH,
            "direct",
            observed_at,
            contextTokens=integer(defaults.get("contextTokens")),
            historyLimit=integer(qqbot.get("historyLimit")),
            groupHistoryLimit=integer(group_default.get("historyLimit")),
            queueMode=str(queue.get("mode") or "unknown")[:32],
            queueDebounceMs=integer(queue.get("debounceMs")),
            queueCap=integer(queue.get("cap")),
            queueDrop=str(queue.get("drop") or "unknown")[:32],
            inboundDebounceMs=integer(inbound.get("debounceMs")),
            sessionResetMode=str(group_session.get("mode") or "unknown")[:32],
            sessionIdleMinutes=integer(group_session.get("idleMinutes")),
            compactionMode=str(compaction.get("mode") or "unknown")[:32],
            compactionKeepRecentTokens=integer(compaction.get("keepRecentTokens")),
            compactionRecentTurnsPreserve=integer(compaction.get("recentTurnsPreserve")),
        )


class RuntimeStateCollector:
    """Read only queue/session metadata without returning payloads or identities."""

    _queue_tables = QUEUE_TABLES
    _active_queue_statuses = ACTIVE_QUEUE_STATUSES
    _terminal_queue_statuses = TERMINAL_QUEUE_STATUSES

    def __init__(self, state_db: Path, session_dir: Path):
        self.state_db = state_db
        self.session_dir = session_dir

    @staticmethod
    def _timestamp(value: Any) -> str | None:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            seconds = float(value) / 1000 if value > 100_000_000_000 else float(value)
            try:
                return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            except (OverflowError, OSError, ValueError):
                return None
        if isinstance(value, str):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            except ValueError:
                return None
        return None

    @staticmethod
    def _opaque_id(path: Path) -> str:
        digest = hashlib.sha256(path.stem.encode("utf-8", errors="ignore")).hexdigest()[:10]
        return f"session-{digest}"

    def _queue_from_counts(self, counts: dict[str, int], source: str, observed_at: str) -> dict[str, Any]:
        unknown_statuses = set(counts) - self._active_queue_statuses - self._terminal_queue_statuses
        if unknown_statuses:
            return unknown(source, "队列存在未识别状态，未猜测当前长度", observed_at)
        active = sum(counts.get(status, 0) for status in self._active_queue_statuses)
        return evidence("available", source, "direct", observed_at, value=active, ingressCount=sum(counts.get(status, 0) for status in self._active_queue_statuses), statusCounts=counts)

    def _queue(self, observed_at: str) -> dict[str, Any]:
        source = "OpenClaw state SQLite queue tables"
        try:
            connection = sqlite3.connect(f"file:{self.state_db.resolve().as_posix()}?mode=ro", uri=True, timeout=0.25)
            try:
                table_names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not set(self._queue_tables).issubset(table_names):
                    return unknown(source, "队列表不可读取", observed_at)
                counts: dict[str, int] = {}
                for table in self._queue_tables:
                    for status, count in connection.execute(f"SELECT status, COUNT(*) FROM {table} GROUP BY status"):
                        status_name = str(status or "").lower()
                        counts[status_name] = counts.get(status_name, 0) + int(count)
                return self._queue_from_counts(counts, source, observed_at)
            finally:
                connection.close()
        except (OSError, sqlite3.Error):
            return unknown(source, "状态数据库不可读取", observed_at)

    def _sessions(self, observed_at: str, idle_minutes: int | None) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
        source = f"{SESSION_DIR}/*.jsonl 元数据"
        if not self.session_dir.exists():
            return unknown(source, "会话目录不可读取", observed_at), [], unknown(source, "最近请求 Token 未采集", observed_at)
        rows: list[dict[str, Any]] = []
        recent_usage: tuple[str, int, str | None] | None = None
        pattern = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$", re.IGNORECASE)
        now = datetime.now(timezone.utc)
        for path in self.session_dir.glob("*.jsonl"):
            if not pattern.match(path.name):
                continue
            try:
                with path.open("rb") as handle:
                    handle.seek(0, os.SEEK_END)
                    handle.seek(max(0, handle.tell() - 512 * 1024), os.SEEK_SET)
                    tail = handle.read().decode("utf-8", errors="replace")
            except OSError:
                continue
            latest_at: str | None = None
            latest_input: int | None = None
            latest_model: str | None = None
            for line in tail.splitlines():
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(item, dict):
                    continue
                message = item.get("message") if isinstance(item.get("message"), dict) else {}
                stamp = self._timestamp(message.get("timestamp")) or self._timestamp(item.get("timestamp"))
                if stamp and (latest_at is None or stamp > latest_at):
                    latest_at = stamp
                usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
                input_tokens = usage.get("input")
                if isinstance(input_tokens, int) and not isinstance(input_tokens, bool) and stamp:
                    if latest_at == stamp:
                        latest_input = input_tokens
                        latest_model = str(message.get("model") or "")[:120] or None
                        if recent_usage is None or stamp > recent_usage[0]:
                            recent_usage = (stamp, input_tokens, latest_model)
            if not latest_at:
                continue
            try:
                age_seconds = max(0.0, (now - datetime.fromisoformat(latest_at.replace("Z", "+00:00"))).total_seconds())
            except ValueError:
                age_seconds = float("inf")
            active = idle_minutes is not None and age_seconds <= idle_minutes * 60
            rows.append({
                "id": self._opaque_id(path),
                "status": "active" if active else "idle",
                "lastActivityAt": latest_at,
                "queueLength": None,
                "contextTokens": latest_input,
                "contextTokensKind": "recent_request_input" if latest_input is not None else None,
                "model": latest_model,
                "source": source,
                "confidence": "direct",
            })
        rows.sort(key=lambda row: row["lastActivityAt"], reverse=True)
        total_count = len(rows)
        active_count = sum(row["status"] == "active" for row in rows)
        rows = rows[:MAX_SESSION_ROWS]
        summary = evidence("available", source, "direct", observed_at, totalCount=total_count, returnedCount=len(rows), activeCount=active_count, truncated=total_count > MAX_SESSION_ROWS)
        if recent_usage:
            context = evidence("available", source, "direct", recent_usage[0], value=recent_usage[1], kind="recent_request_input", model=recent_usage[2])
        else:
            context = unknown(source, "最近请求 Token 未采集", observed_at)
        return summary, rows, context

    def collect(self, idle_minutes: int | None = None, queue_override: dict[str, Any] | None = None) -> dict[str, Any]:
        observed_at = utc_now()
        summary, sessions, context = self._sessions(observed_at, idle_minutes)
        queue = queue_override if queue_override and queue_override.get("status") == "available" else self._queue(observed_at)
        return {"queueLength": queue, "summary": summary, "sessions": sessions, "contextTokens": context}


class HostCollector:
    def __init__(self, root: Path):
        self.root = root

    def _cpu_percent_windows(self) -> float | None:
        if os.name != "nt":
            try:
                load = os.getloadavg()[0]
                return round(min(100.0, max(0.0, load / max(1, os.cpu_count() or 1) * 100)), 1)
            except (AttributeError, OSError):
                return None

        class FileTime(ctypes.Structure):
            _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_uint32)]

        kernel_a, user_a, idle_a = FileTime(), FileTime(), FileTime()
        kernel_b, user_b, idle_b = FileTime(), FileTime(), FileTime()
        get_times = ctypes.windll.kernel32.GetSystemTimes
        if not get_times(ctypes.byref(idle_a), ctypes.byref(kernel_a), ctypes.byref(user_a)):
            return None
        time.sleep(0.06)
        if not get_times(ctypes.byref(idle_b), ctypes.byref(kernel_b), ctypes.byref(user_b)):
            return None

        def value(item: FileTime) -> int:
            return (item.high << 32) | item.low

        idle = value(idle_b) - value(idle_a)
        total = value(kernel_b) - value(kernel_a) + value(user_b) - value(user_a)
        return round(max(0.0, min(100.0, (total - idle) / total * 100)), 1) if total > 0 else None

    def collect(self) -> dict[str, Any]:
        observed_at = utc_now()
        cpu = self._cpu_percent_windows()
        try:
            usage = shutil.disk_usage(self.root)
            disk = evidence(
                "available",
                "Python shutil.disk_usage",
                "direct",
                observed_at,
                totalBytes=usage.total,
                usedBytes=usage.used,
                freeBytes=usage.free,
                usedPercent=round(usage.used / usage.total * 100, 1) if usage.total else None,
            )
        except OSError as exc:
            disk = unknown("Python shutil.disk_usage", public_error(str(exc)), observed_at)

        memory: dict[str, Any]
        if os.name == "nt":
            class MemoryStatus(ctypes.Structure):
                _fields_ = [
                    ("length", ctypes.c_uint32),
                    ("memoryLoad", ctypes.c_uint32),
                    ("totalPhys", ctypes.c_uint64),
                    ("availPhys", ctypes.c_uint64),
                    ("totalPage", ctypes.c_uint64),
                    ("availPage", ctypes.c_uint64),
                    ("totalVirtual", ctypes.c_uint64),
                    ("availVirtual", ctypes.c_uint64),
                    ("availExtended", ctypes.c_uint64),
                ]

            status = MemoryStatus()
            status.length = ctypes.sizeof(MemoryStatus)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                memory = evidence(
                    "available",
                    "Windows GlobalMemoryStatusEx",
                    "direct",
                    observed_at,
                    totalBytes=status.totalPhys,
                    availableBytes=status.availPhys,
                    usedBytes=status.totalPhys - status.availPhys,
                    usedPercent=float(status.memoryLoad),
                )
            else:
                memory = unknown("Windows GlobalMemoryStatusEx", "读取失败", observed_at)
        else:
            memory = unknown("host memory", "当前实现优先支持 Windows 主机采集", observed_at)

        cpu_value = evidence("available", "Windows GetSystemTimes" if os.name == "nt" else "os.getloadavg", "direct", observed_at, percent=cpu) if cpu is not None else unknown("host CPU", "读取失败", observed_at)
        return {"cpu": cpu_value, "memory": memory, "disk": disk}


class ModelRouteCollector:
    def __init__(self, path: Path, config_path: Path):
        self.path = path
        self.config_path = config_path

    def _configured_route(self, observed_at: str) -> dict[str, Any]:
        try:
            payload = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return unknown("deploy/openclaw/openclaw.json", "模型路由配置未采集", observed_at)
        defaults = payload.get("agents", {}).get("defaults", {}) if isinstance(payload, dict) else {}
        model = defaults.get("model") if isinstance(defaults, dict) else None
        if not isinstance(model, dict):
            return unknown("deploy/openclaw/openclaw.json", "模型路由配置格式不可用", observed_at)
        primary = model.get("primary")
        fallbacks = model.get("fallbacks")
        if not isinstance(primary, str) or not primary.strip():
            return unknown("deploy/openclaw/openclaw.json", "主模型配置未采集", observed_at)
        fallback = next((item.strip() for item in fallbacks if isinstance(item, str) and item.strip()), "未配置") if isinstance(fallbacks, list) else "未配置"
        return evidence(
            "available",
            "deploy/openclaw/openclaw.json",
            "direct",
            observed_at,
            primary=primary[:120],
            fallback=fallback[:120],
            route="configured",
            primaryAvailable=None,
            statusCode=None,
            lastProbeAt=None,
            detail="配置中的主备模型；当前可用性仍需模型请求或 watcher 证据",
        )

    def collect(self) -> dict[str, Any]:
        observed_at = utc_now()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return self._configured_route(observed_at)
        if not isinstance(payload, dict):
            return self._configured_route(observed_at)
        safe = {
            "primary": str(payload.get("primary") or "unknown")[:120],
            "fallback": str(payload.get("fallback") or "configured-fallback")[:120],
            "route": str(payload.get("route") or "unknown")[:60],
            "primaryAvailable": payload.get("primaryAvailable") if isinstance(payload.get("primaryAvailable"), bool) else None,
            "statusCode": payload.get("statusCode") if isinstance(payload.get("statusCode"), int) else None,
            "lastProbeAt": str(payload.get("lastProbeAt") or "unknown")[:40],
        }
        last_probe = payload.get("lastProbeAt")
        try:
            probe_at = datetime.fromisoformat(str(last_probe).replace("Z", "+00:00"))
            if probe_at.tzinfo is None:
                probe_at = probe_at.replace(tzinfo=timezone.utc)
            age_seconds = (datetime.now(timezone.utc) - probe_at.astimezone(timezone.utc)).total_seconds()
        except (TypeError, ValueError, OverflowError):
            age_seconds = float("inf")
        if age_seconds < 0 or age_seconds > MODEL_ROUTE_MAX_AGE_SECONDS:
            return self._configured_route(observed_at)
        return evidence("available", "deploy/openclaw/runtime/model-route-state.json", "direct", observed_at, **safe)


class DockerCollector:
    def __init__(self, root: Path, runner: CommandRunner | None = None):
        self.root = root.resolve()
        self.compose_dir = self.root / "deploy" / "openclaw"
        self.runner = runner or CommandRunner()
        self.compose = [
            "docker",
            "compose",
            "-f",
            str(self.compose_dir / "docker-compose.yml"),
            "-f",
            str(self.compose_dir / "docker-compose.local.yml"),
        ]

    def _compose_ps(self) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        observed_at = utc_now()
        daemon = self.runner.run(["docker", "info", "--format", "{{.ServerVersion}}"], self.root, timeout=4)
        if daemon.code != 0:
            return (
                evidence("unavailable", "docker info", "not_collected", observed_at, detail=_public_command_detail(daemon)),
                [],
            )
        result = self.runner.run(self.compose + ["ps", "--all", "--format", "json"], self.compose_dir, timeout=4)
        if result.code != 0:
            return (
                evidence("unavailable", "docker compose ps --all", "not_collected", observed_at, detail=_public_command_detail(result)),
                [],
            )
        rows = parse_compose_rows(result.stdout)
        return evidence("available", "docker compose ps --all", "direct", observed_at, count=len(rows)), rows

    def _stats(self, services: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        names = [str(item.get("name")) for item in services if item.get("state") == "running" and item.get("name")]
        if not names:
            return {}
        result = self.runner.run(["docker", "stats", "--no-stream", "--format", "{{json .}}", *names], self.root, timeout=4)
        return parse_docker_stats(result.stdout) if result.code == 0 else {}

    def _queue_state(self, gateway_running: bool) -> dict[str, Any]:
        source = "docker compose exec openclaw-gateway fixed queue adapter"
        if not gateway_running:
            return unknown(source, "Gateway 未运行，队列状态未采集", utc_now())
        result = self.runner.run(
            self.compose + ["exec", "-T", "openclaw-gateway", "node", "-e", QUEUE_ADAPTER_SCRIPT],
            self.compose_dir,
            timeout=4,
        )
        if result.code != 0:
            return unknown(source, "容器内队列适配器不可用", utc_now())
        try:
            payload = json.loads(result.stdout)
            counts: dict[str, int] = {}
            for rows in payload.values():
                if not isinstance(rows, list):
                    return unknown(source, "容器内队列适配器返回格式不可用", utc_now())
                for row in rows:
                    if not isinstance(row, dict):
                        return unknown(source, "容器内队列适配器返回格式不可用", utc_now())
                    status = str(row.get("status") or "").lower()
                    count = row.get("count")
                    if not status or not isinstance(count, int):
                        return unknown(source, "容器内队列适配器返回格式不可用", utc_now())
                    counts[status] = counts.get(status, 0) + count
        except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
            return unknown(source, "容器内队列适配器返回格式不可用", utc_now())
        unknown_statuses = set(counts) - ACTIVE_QUEUE_STATUSES - TERMINAL_QUEUE_STATUSES
        if unknown_statuses:
            return unknown(source, "队列存在未识别状态，未猜测当前长度", utc_now())
        active = sum(counts.get(status, 0) for status in ACTIVE_QUEUE_STATUSES)
        return evidence("available", source, "direct", utc_now(), value=active, ingressCount=active, statusCounts=counts)

    def _gateway_port(self, docker_status: dict[str, Any]) -> int:
        result = self.runner.run(self.compose + ["port", "openclaw-gateway", "18789"], self.compose_dir, timeout=3)
        if result.code == 0:
            match = re.search(r":(\d+)\s*$", result.stdout.strip())
            if match:
                port = int(match.group(1))
                if 1024 <= port <= 65535:
                    return port
        return DEFAULT_GATEWAY_PORT

    def _gpu(self, qwen_running: bool) -> dict[str, Any]:
        query = [
            "nvidia-smi",
            "--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name",
            "--format=csv,noheader,nounits",
        ]
        result = self.runner.run(query, self.root, timeout=3)
        parsed = parse_gpu_csv(result.stdout) if result.code == 0 else None
        if parsed:
            return evidence("available", "nvidia-smi on host", "direct", utc_now(), **parsed, memoryKind="gpu_vram")
        if qwen_running:
            nested = self.runner.run(self.compose + ["exec", "-T", "qwen-vision", *query], self.compose_dir, timeout=4)
            parsed = parse_gpu_csv(nested.stdout) if nested.code == 0 else None
            if parsed:
                return evidence("available", "nvidia-smi via qwen-vision", "direct", utc_now(), **parsed, memoryKind="gpu_vram")
        detail = "nvidia-smi 不可用" if not result.timed_out else "nvidia-smi 采集超时"
        return unknown("nvidia-smi / qwen-vision", detail, utc_now())

    def _ollama(self, qwen_running: bool) -> dict[str, Any]:
        if not qwen_running:
            return unknown("ollama ps via qwen-vision", "qwen-vision 未运行", utc_now())
        result = self.runner.run(self.compose + ["exec", "-T", "qwen-vision", "ollama", "ps"], self.compose_dir, timeout=4)
        if result.code != 0:
            return evidence("degraded", "ollama ps via qwen-vision", "not_collected", utc_now(), detail=_public_command_detail(result), currentModel=None)
        model = parse_ollama_model(result.stdout)
        return evidence("available", "ollama ps via qwen-vision", "direct", utc_now(), currentModel=model, modelLoaded=model is not None)

    def _logs(self) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
        observed_at = utc_now()
        result = self.runner.run(
            self.compose + ["logs", "--no-color", "--timestamps", "--tail", "80", *SERVICES],
            self.compose_dir,
            timeout=4,
        )
        if result.code != 0:
            status = evidence("unknown", "docker compose logs --tail 80", "not_collected", observed_at, detail=_public_command_detail(result))
            return status, [], {"status": "unknown", "observedAt": observed_at, "source": "gateway log pattern", "confidence": "not_collected"}, []
        records: list[dict[str, Any]] = []
        websocket = {"status": "unknown", "observedAt": observed_at, "source": "gateway log pattern", "confidence": "not_collected", "detail": "未发现可确认连接事件"}
        events = parse_runtime_events(result.stdout, observed_at)
        connection_events = [event for event in events if event["type"] == "qq_connection"]
        if connection_events:
            latest = connection_events[-1]
            websocket = {
                "status": "connected" if latest["phase"] == "connected" else "degraded",
                "observedAt": latest["observedAt"],
                "source": LOG_SOURCE,
                "confidence": "inferred",
                "detail": "根据脱敏日志模式推断；不能证明外部消息送达",
            }
        for index, raw in enumerate(result.stdout.splitlines()[-MAX_LOG_RECORDS:]):
            service = _log_service(raw)
            lowered = raw.lower()
            level = "error" if re.search(r"\b(error|fatal|exception|traceback|failed)\b", lowered) else "warn" if re.search(r"\b(warn|timeout|timed out|fallback|429|unhealthy)\b", lowered) else "info"
            if level == "info":
                continue
            records.append({
                "id": f"log-{index}",
                "service": service,
                "level": level,
                "summary": summarize_log(level, lowered),
                "observedAt": _log_timestamp(raw, observed_at),
                "source": LOG_SOURCE,
                "confidence": "inferred",
            })
        return evidence("available", LOG_SOURCE, "inferred", observed_at, count=len(records), eventCount=len(events)), records[-MAX_LOG_RECORDS:], websocket, events

    def collect(self) -> dict[str, Any]:
        observed_at = utc_now()
        docker_status, rows = self._compose_ps()
        stats = self._stats(rows)
        by_service = {row["service"]: row for row in rows}
        services = [service_row(by_service.get(name), name, stats, observed_at) for name in SERVICES]
        gateway_port = self._gateway_port(docker_status)
        qwen_running = by_service.get("qwen-vision", {}).get("state") == "running"
        log_status, logs, websocket, events = self._logs()
        return {
            "status": docker_status,
            "services": services,
            "gatewayPort": gateway_port,
            "stats": stats,
            "systemRam": evidence(
                "available" if stats else "unknown",
                "docker stats MEM USAGE",
                "direct" if stats else "not_collected",
                observed_at,
                bytes=sum(item.get("memoryBytes") or 0 for item in stats.values()) if stats else None,
                memoryKind="system_ram",
                detail="Docker MEM USAGE 是系统 RAM，不是 GPU VRAM" if stats else "Docker 统计未采集",
            ),
            "gpu": self._gpu(qwen_running),
            "ollama": self._ollama(qwen_running),
            "logs": log_status,
            "logRecords": logs,
            "websocket": websocket,
            "events": events,
            "queueState": self._queue_state(by_service.get("openclaw-gateway", {}).get("state") == "running"),
        }


def probe_gateway(port: int, timeout: float = 2.0) -> dict[str, Any]:
    observed_at = utc_now()
    url = f"http://127.0.0.1:{port}/healthz"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            status = "healthy" if 200 <= response.status < 300 else "degraded"
            return evidence(status, "OpenClaw /healthz on loopback", "direct", observed_at, httpStatus=response.status, port=port)
    except urllib.error.HTTPError as exc:
        return evidence("degraded", "OpenClaw /healthz on loopback", "direct", observed_at, httpStatus=exc.code, port=port)
    except (OSError, urllib.error.URLError, TimeoutError):
        return evidence("unknown", "OpenClaw /healthz on loopback", "not_collected", observed_at, httpStatus=None, port=port, detail="healthz 不可达")


class SnapshotBuilder:
    def __init__(self, root: Path, runner: CommandRunner | None = None):
        self.root = root.resolve()
        self.docker = DockerCollector(self.root, runner)
        self.host = HostCollector(self.root)
        self.config = RuntimeConfigCollector(self.root / CONFIG_PATH)
        self.route = ModelRouteCollector(
            self.root / "deploy" / "openclaw" / "runtime" / "model-route-state.json",
            self.root / CONFIG_PATH,
        )
        self.state = RuntimeStateCollector(self.root / STATE_DB_PATH, self.root / SESSION_DIR)

    @staticmethod
    def _event_meta(events: list[dict[str, Any]], event_types: set[str], detail: str) -> dict[str, Any]:
        matches = [event for event in events if event.get("type") in event_types]
        if not matches:
            return unknown(LOG_SOURCE, detail, utc_now())
        latest = matches[-1]
        return evidence("available", LOG_SOURCE, "inferred", str(latest.get("observedAt") or utc_now()), eventCount=len(matches))

    @staticmethod
    def _overall(services: list[dict[str, Any]], gateway: dict[str, Any], docker_status: dict[str, Any]) -> tuple[str, str]:
        if docker_status.get("status") in {"unavailable", "unknown"}:
            return "degraded", "Docker 采集不可用，服务运行态未能确认"
        service_health_ok = all(
            item.get("status") == "running" and item.get("health") in {"healthy", "not_configured"}
            for item in services
        )
        if gateway.get("status") == "healthy" and service_health_ok:
            return "operational", "本机服务与 Gateway healthz 已直接观察"
        if any(
            item.get("status") in {"stopped", "exited", "dead", "unhealthy"}
            or item.get("health") == "unhealthy"
            for item in services
        ) or gateway.get("status") == "degraded":
            return "degraded", "至少一个服务或 healthz 处于异常/停止状态"
        return "unknown", "运行态证据不足"

    def build(self, history: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        observed_at = utc_now()
        runtime = self.docker.collect()
        gateway = probe_gateway(int(runtime.get("gatewayPort") or DEFAULT_GATEWAY_PORT))
        host = self.host.collect()
        route = self.route.collect()
        configuration = self.config.collect()
        runtime_state = self.state.collect(
            configuration.get("sessionIdleMinutes") if configuration.get("status") == "available" else None,
            queue_override=runtime.get("queueState"),
        )
        overall, overall_detail = self._overall(runtime["services"], gateway, runtime["status"])
        errors = [record for record in runtime["logRecords"] if record["level"] in {"error", "warn"}][-12:]
        events = runtime["events"]
        event_meta = self._event_meta(events, {"qq_inbound", "qq_connection", "model_request", "qq_reply"}, "当前日志尾部未发现可识别事件")
        model_request_meta = self._event_meta(events, {"model_request"}, "模型请求时间未采集")
        if model_request_meta.get("status") != "available" and runtime_state["contextTokens"].get("status") == "available":
            model_request_meta = evidence(
                "available",
                str(runtime_state["contextTokens"].get("source") or SESSION_DIR),
                "direct",
                str(runtime_state["contextTokens"].get("observedAt") or observed_at),
                kind="recent_request_input",
            )
        reply_meta = self._event_meta(events, {"qq_reply"}, "成功回复时间未采集；不代表外部未送达")
        recovery_events = [event for event in events if event.get("type") == "context_recovery"]
        recovery_meta = self._event_meta(events, {"context_recovery"}, "当前日志尾部未发现压缩/恢复事件")
        recent_event_at = event_meta.get("observedAt") if event_meta.get("status") == "available" else None
        recent_model_request_at = model_request_meta.get("observedAt") if model_request_meta.get("status") == "available" else None
        recent_reply_at = reply_meta.get("observedAt") if reply_meta.get("status") == "available" else None
        configured_context = (
            evidence("available", CONFIG_PATH, "direct", configuration.get("observedAt"), value=configuration.get("contextTokens"), kind="configured_limit")
            if configuration.get("status") == "available" and configuration.get("contextTokens") is not None
            else unknown(CONFIG_PATH, "上下文配置上限未采集", observed_at)
        )
        queue_detail = "当前队列长度未采集"
        if configuration.get("status") == "available" and configuration.get("queueCap") is not None:
            queue_detail = f"当前队列长度未采集；配置上限 {configuration['queueCap']} 条"
        context_detail = "当前会话 Token 占用未采集，未用消息条数代替"
        if configuration.get("status") == "available" and configuration.get("contextTokens") is not None:
            context_detail = f"当前会话 Token 占用未采集；配置上限 {configuration['contextTokens']} Token"
        session_meta = runtime_state["summary"]
        return {
            "schemaVersion": "qqbot-ops/v1",
            "observedAt": observed_at,
            "console": {
                "status": overall,
                "detail": overall_detail,
                "bind": "127.0.0.1",
                "port": None,
                "source": "local console snapshot",
                "confidence": "direct",
            },
            "dashboard": {
                "status": overall,
                "detail": overall_detail,
                "gateway": gateway,
                "services": runtime["services"],
                "websocket": runtime["websocket"],
                "recentEventAt": recent_event_at,
                "recentModelRequestAt": recent_model_request_at,
                "recentSuccessfulReplyAt": recent_reply_at,
                "modelRoute": route,
                "recentErrors": errors,
                "host": host,
                "gpu": runtime["gpu"],
                "ollama": runtime["ollama"],
                "lastRefreshAt": observed_at,
            },
            "runtime": {
                "services": runtime["services"],
                "docker": {**runtime["status"], "systemRam": runtime["systemRam"]},
                "gpu": runtime["gpu"],
                "ollama": runtime["ollama"],
                "host": host,
                "configuration": configuration,
                "state": runtime_state,
                "history": history or [],
            },
            "activity": {
                "events": events,
                "connection": runtime["websocket"],
                "queueLength": runtime_state["queueLength"] if runtime_state["queueLength"].get("status") == "available" else unknown("OpenClaw runtime queue", queue_detail, observed_at),
                "queueConfiguration": configuration,
                "eventCollection": event_meta,
                "recentEventAt": event_meta,
                "recentModelRequestAt": model_request_meta,
                "recentSuccessfulReplyAt": reply_meta,
                "privacy": "仅展示脱敏元数据；未接入时不保存消息正文、图片或用户标识",
            },
            "sessions": {
                "sessions": runtime_state["sessions"],
                "summary": session_meta,
                "contextTokens": runtime_state["contextTokens"] if runtime_state["contextTokens"].get("status") == "available" else unknown("OpenClaw session adapter", context_detail, observed_at),
                "contextTokenConfiguration": configured_context,
                "compactionConfiguration": configuration,
                "recovery": {**recovery_meta, "eventCount": len(recovery_events)},
                "queueConfiguration": configuration,
                "privacy": "未接入会话适配器；不展示完整群号、OpenID、正文或图片",
            },
            "logs": {
                "status": runtime["logs"],
                "records": runtime["logRecords"],
                "recentErrors": errors,
                "retention": {"tailLines": 80, "maxRecords": MAX_LOG_RECORDS, "rawPayloadsStored": False},
            },
            "operations": {
                "allowed": ["refresh", "open_control_ui", "view_services"],
                "gatewayUrl": f"http://127.0.0.1:{runtime['gatewayPort']}/",
                "services": [item["service"] for item in runtime["services"]],
                "note": "Phase 1 只读；不提供任意命令、Docker socket、清理缓存或高风险重启",
            },
            "evidenceBoundary": [
                "容器运行、healthz、端口监听、本地模型可用和 QQ 真实收发是不同证据层级",
                "QQ WebSocket 状态若来自日志仅为低置信度推断，不能证明外部消息送达",
                "GPU VRAM 仅来自 nvidia-smi；Docker MEM USAGE 单独标记为系统 RAM",
            ],
            "secretsRedacted": True,
        }
