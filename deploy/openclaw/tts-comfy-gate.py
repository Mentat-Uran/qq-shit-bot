#!/usr/bin/env python3
"""Serialize local TTS, ASR, and ComfyUI GPU use.

The gateway and ComfyUI both talk to this loopback-only service.  It owns the
short-lived GPU lease, starts the TTS or ASR container only when needed, and
asks ComfyUI to release its models before either model starts.  The service
deliberately does not expose Docker or host-control endpoints beyond the two
local lease operations used by the configured applications.
"""

from __future__ import annotations

import http.client
import http.server
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from typing import Any


LOGGER = logging.getLogger("qqbot-tts-gpu-gate")

DEPLOY_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(DEPLOY_DIR, ".env")
COMPOSE_BASE = os.path.join(DEPLOY_DIR, "docker-compose.yml")
COMPOSE_LOCAL = os.path.join(DEPLOY_DIR, "docker-compose.local.yml")
COMPOSE_CODEX = os.path.join(DEPLOY_DIR, "docker-compose.codex.yml")
QWEN_SERVICE = "qwen-tts"
ASR_SERVICE = "qwen-asr"

GATE_HOST = "127.0.0.1"
GATE_PORT = 18102
COMFY_URL = "http://127.0.0.1:8188"
QWEN_URL = "http://127.0.0.1:18101"
ASR_URL = "http://127.0.0.1:18103"

MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_AUDIO_REQUEST_BYTES = 32 * 1024 * 1024
MAX_AUDIO_BYTES = 32 * 1024 * 1024
MAX_TEXT_CHARS = 2000
LEASE_MAX_SECONDS = 6 * 60 * 60
LEASE_WAIT_SECONDS = 15 * 60
COMFY_FREE_TIMEOUT_SECONDS = 60
QWEN_START_TIMEOUT_SECONDS = 10 * 60
COMPOSE_TIMEOUT_SECONDS = 120
DOCKER_STOP_TIMEOUT_SECONDS = 45
# The host has an 8 GiB mobile GPU.  Five GiB free is achievable after
# ComfyUI unloads its models and leaves enough headroom for the selected 1.7B
# Qwen3-TTS service plus the desktop's small resident allocations.
COMFY_FREE_TARGET_BYTES = 5 * 1024**3

TTS_DEFAULT_INSTRUCT = (
    "Use a natural, warm, conversational Mandarin voice with gentle emotional "
    "variation. Preserve the speaker's intent and punctuation."
)
TTS_STYLE_INSTRUCTIONS = {
    "温柔": "Use a warm, gentle, intimate Mandarin voice with soft emotional variation. Preserve the wording and punctuation.",
    "播音": "Use a clear, steady, polished Mandarin broadcast voice with confident pacing and precise pronunciation. Preserve the wording and punctuation.",
    "戏剧": "Use an expressive, vivid Mandarin voice with noticeable but natural dramatic emotion. Preserve the wording and punctuation.",
    "正常": TTS_DEFAULT_INSTRUCT,
}
TTS_STYLE_PREFIX = re.compile(r"^\s*【\s*语气\s*[=:：]\s*(温柔|播音|戏剧|正常)\s*】\s*")

DOCKER = shutil.which("docker") or "/usr/bin/docker"


class GateError(RuntimeError):
    """A local coordination or backend error safe to report as a status."""


class GateBusy(GateError):
    """The other GPU owner did not release the lease before the deadline."""


def _http_request(
    method: str,
    url: str,
    *,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 10,
) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(
        url,
        data=body,
        headers=headers or {},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read(MAX_AUDIO_BYTES)
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read(MAX_AUDIO_BYTES)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise GateError("local endpoint unavailable") from error


def _json_request(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    *,
    timeout: float = 10,
) -> tuple[int, dict[str, Any]]:
    body = None
    headers: dict[str, str] = {}
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    status, _, raw = _http_request(method, url, body=body, headers=headers, timeout=timeout)
    if not raw:
        return status, {}
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GateError("local endpoint returned invalid JSON") from error
    if not isinstance(decoded, dict):
        raise GateError("local endpoint returned an invalid response")
    return status, decoded


def _compose(*arguments: str, timeout: float = COMPOSE_TIMEOUT_SECONDS) -> bool:
    command = [
        DOCKER,
        "compose",
        "--env-file",
        ENV_FILE,
        "-f",
        COMPOSE_BASE,
        "-f",
        COMPOSE_LOCAL,
        "-f",
        COMPOSE_CODEX,
        *arguments,
    ]
    try:
        result = subprocess.run(
            command,
            cwd=DEPLOY_DIR,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        LOGGER.error("compose operation failed: %s", type(error).__name__)
        return False
    if result.returncode != 0:
        LOGGER.error("compose operation returned status %s", result.returncode)
        return False
    return True


def _qwen_reachable() -> bool:
    try:
        status, _, _ = _http_request("GET", f"{QWEN_URL}/health", timeout=2)
    except GateError:
        return False
    return status > 0


def _qwen_ready() -> bool:
    try:
        status, payload = _json_request("GET", f"{QWEN_URL}/health", timeout=3)
    except GateError:
        return False
    return status == 200 and payload.get("model_ready") is True


def _asr_reachable() -> bool:
    try:
        status, _, _ = _http_request("GET", f"{ASR_URL}/health", timeout=2)
    except GateError:
        return False
    return status > 0


def _asr_ready() -> bool:
    try:
        status, payload = _json_request("GET", f"{ASR_URL}/health", timeout=3)
    except GateError:
        return False
    return status == 200 and payload.get("model_ready") is True


def _read_comfy_vram() -> tuple[int, int] | None:
    try:
        status, payload = _json_request("GET", f"{COMFY_URL}/system_stats", timeout=5)
    except GateError:
        return None
    if status != 200:
        return None
    devices = payload.get("devices")
    if not isinstance(devices, list):
        return None
    for device in devices:
        if not isinstance(device, dict):
            continue
        try:
            total = int(device["vram_total"])
            free = int(device["vram_free"])
        except (KeyError, TypeError, ValueError):
            continue
        if total > 0 and free >= 0:
            return free, total
    return None


class GpuGate:
    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.owner: str | None = None
        self.owner_token: str | None = None
        self.owner_since = 0.0
        self.waiting_comfy = 0
        self.qwen_expected = False
        self.asr_expected = False

    def _reap_expired_locked(self) -> None:
        if self.owner is None or self.owner_since <= 0:
            return
        if time.monotonic() - self.owner_since <= LEASE_MAX_SECONDS:
            return
        LOGGER.error("reaping an expired %s GPU lease", self.owner)
        self.owner = None
        self.owner_token = None
        self.owner_since = 0.0
        self.condition.notify_all()

    def _claim_locked(self, owner: str) -> str:
        token = uuid.uuid4().hex
        self.owner = owner
        self.owner_token = token
        self.owner_since = time.monotonic()
        return token

    def acquire_tts(self) -> str:
        deadline = time.monotonic() + LEASE_WAIT_SECONDS
        with self.condition:
            while True:
                self._reap_expired_locked()
                # Give a queued Comfy prompt priority once the current owner
                # finishes, so repeated TTS requests cannot starve image work.
                if self.owner is None and self.waiting_comfy == 0:
                    return self._claim_locked("tts")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise GateBusy("GPU is busy")
                self.condition.wait(timeout=min(remaining, 5.0))

    def acquire_asr(self) -> str:
        deadline = time.monotonic() + LEASE_WAIT_SECONDS
        with self.condition:
            while True:
                self._reap_expired_locked()
                if self.owner is None and self.waiting_comfy == 0:
                    return self._claim_locked("asr")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise GateBusy("GPU is busy")
                self.condition.wait(timeout=min(remaining, 5.0))

    def acquire_comfy(self) -> str:
        deadline = time.monotonic() + LEASE_WAIT_SECONDS
        with self.condition:
            self.waiting_comfy += 1
            try:
                while True:
                    self._reap_expired_locked()
                    if self.owner is None:
                        token = self._claim_locked("comfy")
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise GateBusy("GPU is busy")
                    self.condition.wait(timeout=min(remaining, 5.0))
            finally:
                self.waiting_comfy -= 1

        try:
            self._stop_qwen()
        except Exception:
            self.release(token)
            raise
        return token

    def release(self, token: str) -> None:
        with self.condition:
            if self.owner_token != token:
                LOGGER.warning("ignored release for an unknown GPU lease")
                return
            self.owner = None
            self.owner_token = None
            self.owner_since = 0.0
            self.condition.notify_all()

    def _stop_qwen(self) -> None:
        if not _compose("stop", "--timeout", "30", QWEN_SERVICE, timeout=DOCKER_STOP_TIMEOUT_SECONDS):
            raise GateError("TTS container could not be stopped")
        deadline = time.monotonic() + DOCKER_STOP_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if not _qwen_reachable():
                self.qwen_expected = False
                return
            time.sleep(0.25)
        raise GateError("TTS container did not stop")

    def _stop_asr(self) -> None:
        if not _compose("stop", "--timeout", "30", ASR_SERVICE, timeout=DOCKER_STOP_TIMEOUT_SECONDS):
            raise GateError("ASR container could not be stopped")
        deadline = time.monotonic() + DOCKER_STOP_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if not _asr_reachable():
                self.asr_expected = False
                return
            time.sleep(0.25)
        raise GateError("ASR container did not stop")

    def _free_comfy(self) -> None:
        try:
            status, _ = _json_request(
                "POST",
                f"{COMFY_URL}/free",
                {"unload_models": True, "free_memory": True},
                timeout=10,
            )
        except GateError as error:
            raise GateError("ComfyUI memory release request failed") from error
        if status != 200:
            raise GateError("ComfyUI memory release request failed")

        deadline = time.monotonic() + COMFY_FREE_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            vram = _read_comfy_vram()
            if vram is not None:
                free, total = vram
                target = max(COMFY_FREE_TARGET_BYTES, int(total * 0.68))
                if free >= target:
                    LOGGER.info("ComfyUI released GPU memory: free=%d total=%d", free, total)
                    return
            time.sleep(0.5)
        raise GateError("ComfyUI did not release enough GPU memory")

    def _start_qwen(self) -> None:
        if not _compose("up", "-d", QWEN_SERVICE, timeout=COMPOSE_TIMEOUT_SECONDS):
            raise GateError("TTS container could not be started")
        deadline = time.monotonic() + QWEN_START_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if _qwen_ready():
                self.qwen_expected = True
                LOGGER.info("Qwen TTS is ready")
                return
            time.sleep(1.0)
        raise GateError("TTS model did not become ready")

    def _start_asr(self) -> None:
        if not _compose("up", "-d", ASR_SERVICE, timeout=COMPOSE_TIMEOUT_SECONDS):
            raise GateError("ASR container could not be started")
        deadline = time.monotonic() + QWEN_START_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if _asr_ready():
                self.asr_expected = True
                LOGGER.info("Qwen ASR is ready")
                return
            time.sleep(1.0)
        raise GateError("ASR model did not become ready")

    def prepare_tts(self) -> None:
        # A warm Qwen server was started by this gate only after ComfyUI had
        # released its models, and Comfy acquisition always stops it first.
        # Reuse it for consecutive reads without needlessly reloading weights.
        if self.asr_expected or _asr_reachable():
            self._stop_asr()
        if self.qwen_expected and _qwen_ready():
            return
        if self.qwen_expected or _qwen_reachable():
            self._stop_qwen()
        self._free_comfy()
        self._start_qwen()

    def prepare_asr(self) -> None:
        if self.qwen_expected or _qwen_reachable():
            self._stop_qwen()
        if self.asr_expected and _asr_ready():
            return
        if self.asr_expected or _asr_reachable():
            self._stop_asr()
        self._free_comfy()
        self._start_asr()

    def startup_cleanup(self) -> None:
        # A previous gate process may have died while Qwen was warm.  Clear
        # that state before accepting either kind of lease.
        if _qwen_reachable():
            self._stop_qwen()
        else:
            self.qwen_expected = False
        if _asr_reachable():
            self._stop_asr()
        else:
            self.asr_expected = False

    def shutdown(self) -> None:
        if _qwen_reachable():
            try:
                self._stop_qwen()
            except Exception:
                LOGGER.error("could not stop TTS during gate shutdown")
        if _asr_reachable():
            try:
                self._stop_asr()
            except Exception:
                LOGGER.error("could not stop ASR during gate shutdown")

    def status(self) -> dict[str, Any]:
        with self.condition:
            owner = self.owner
            waiting_comfy = self.waiting_comfy
            qwen_expected = self.qwen_expected
            asr_expected = self.asr_expected
        return {
            "status": "ok",
            "owner": owner,
            "waiting_comfy": waiting_comfy,
            "qwen_expected": qwen_expected,
            "qwen_ready": _qwen_ready(),
            "asr_expected": asr_expected,
            "asr_ready": _asr_ready(),
        }

    def forward_tts(self, body: bytes) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", 18101, timeout=120)
        try:
            connection.request(
                "POST",
                "/v1/audio/speech",
                body=body,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "audio/mpeg, audio/*;q=0.9, application/json",
                    "Connection": "close",
                },
            )
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read(MAX_AUDIO_BYTES)
        except (http.client.HTTPException, OSError, TimeoutError) as error:
            raise GateError("TTS backend request failed") from error
        finally:
            connection.close()

    def forward_asr(self, body: bytes, content_type: str) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", 18103, timeout=600)
        try:
            connection.request(
                "POST",
                "/v1/audio/transcriptions",
                body=body,
                headers={
                    "Content-Type": content_type,
                    "Accept": "application/json",
                    "Connection": "close",
                },
            )
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read(MAX_AUDIO_BYTES)
        except (http.client.HTTPException, OSError, TimeoutError) as error:
            raise GateError("ASR backend request failed") from error
        finally:
            connection.close()


class GateHttpServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class GateHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "qqbot-tts-gpu-gate"

    @property
    def gate(self) -> GpuGate:
        return self.server.gate  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        LOGGER.info("%s %s", self.command, self.path.split("?", 1)[0])

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        self._send(
            status,
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": {"message": message, "type": "gpu_gate_error"}})

    def _read_body(self, max_bytes: int = MAX_REQUEST_BYTES) -> bytes | None:
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            self._error(400, "invalid request body")
            return None
        if length < 0:
            self._error(411, "content length required")
            return None
        if length > max_bytes:
            self._error(413, "request body is too large")
            return None
        return self.rfile.read(length)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in ("/health", "/gpu/status"):
            self._send_json(200, self.gate.status())
            return
        self._error(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/gpu/comfy/acquire":
            try:
                token = self.gate.acquire_comfy()
            except GateBusy:
                self._error(503, "GPU is busy")
            except GateError:
                self._error(503, "GPU coordination is unavailable")
            else:
                self._send_json(200, {"lease_id": token, "owner": "comfy"})
            return

        if path == "/gpu/asr/acquire":
            try:
                token = self.gate.acquire_asr()
            except GateBusy:
                self._error(503, "GPU is busy")
            except GateError:
                self._error(503, "GPU coordination is unavailable")
            else:
                self._send_json(200, {"lease_id": token, "owner": "asr"})
            return

        if path == "/v1/audio/transcriptions":
            content_type = self.headers.get("Content-Type", "")
            if not content_type.lower().startswith("multipart/form-data;"):
                self._error(400, "multipart form data required")
                return
            body = self._read_body(MAX_AUDIO_REQUEST_BYTES)
            if body is None:
                return
            token: str | None = None
            try:
                token = self.gate.acquire_asr()
                self.gate.prepare_asr()
                status, headers, result = self.gate.forward_asr(body, content_type)
                self._send(status, result, headers.get("Content-Type", "application/json"))
            except GateBusy:
                self._error(503, "GPU is busy")
            except GateError as error:
                LOGGER.error("ASR request failed: %s", str(error))
                self._error(503, "ASR is temporarily unavailable")
            finally:
                if token is not None:
                    self.gate.release(token)
            return

        body = self._read_body()
        if body is None:
            return

        if path == "/gpu/comfy/release":
            try:
                payload = json.loads(body.decode("utf-8"))
                token = payload.get("lease_id") if isinstance(payload, dict) else None
            except (UnicodeDecodeError, json.JSONDecodeError):
                token = None
            if not isinstance(token, str) or not token:
                self._error(400, "lease_id required")
                return
            self.gate.release(token)
            self._send_json(200, {"released": True})
            return

        if path == "/gpu/asr/release":
            try:
                payload = json.loads(body.decode("utf-8"))
                token = payload.get("lease_id") if isinstance(payload, dict) else None
            except (UnicodeDecodeError, json.JSONDecodeError):
                token = None
            if not isinstance(token, str) or not token:
                self._error(400, "lease_id required")
                return
            self.gate.release(token)
            self._send_json(200, {"released": True})
            return

        if path != "/v1/audio/speech":
            self._error(404, "not found")
            return

        try:
            payload = json.loads(body.decode("utf-8"))
            text = payload.get("input") if isinstance(payload, dict) else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "invalid request body")
            return
        if not isinstance(text, str) or not text.strip():
            self._error(400, "input text required")
            return
        if len(text) > MAX_TEXT_CHARS:
            self._error(413, "input text is too long")
            return

        style_match = TTS_STYLE_PREFIX.match(text)
        backend_body = body
        if style_match:
            style = style_match.group(1)
            clean_text = text[style_match.end():].strip()
            if not clean_text:
                self._error(400, "input text required")
                return
            payload["input"] = clean_text
            payload["instruct"] = TTS_STYLE_INSTRUCTIONS[style]
            backend_body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

        token: str | None = None
        try:
            token = self.gate.acquire_tts()
            self.gate.prepare_tts()
            status, headers, audio = self.gate.forward_tts(backend_body)
            content_type = headers.get("Content-Type", "audio/mpeg")
            self._send(status, audio, content_type)
        except GateBusy:
            self._error(503, "GPU is busy")
        except GateError as error:
            LOGGER.error("TTS request failed: %s", str(error))
            self._error(503, "TTS is temporarily unavailable")
        finally:
            if token is not None:
                self.gate.release(token)


def main() -> int:
    gate = GpuGate()
    gate.startup_cleanup()
    server = GateHttpServer((GATE_HOST, GATE_PORT), GateHandler)
    server.gate = gate  # type: ignore[attr-defined]

    def stop_server(signum: int, frame: Any) -> None:
        del signum, frame
        # HTTPServer.shutdown() waits for serve_forever() to return and must
        # therefore run outside the signal-handler thread.
        threading.Thread(target=server.shutdown, name="gate-shutdown", daemon=True).start()

    signal.signal(signal.SIGINT, stop_server)
    signal.signal(signal.SIGTERM, stop_server)
    LOGGER.info("GPU gate listening on loopback port %d", GATE_PORT)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        gate.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
