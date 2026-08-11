"""Small shared helpers for the console's evidence-aware data model."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def format_host_for_url(host: str) -> str:
    """Format an IPv6 literal for an HTTP URL without changing hostnames."""

    if ":" in host and not host.startswith("["):
        return f"[{host}]"
    return host


def utc_now() -> str:
    """Return an ISO-8601 UTC timestamp suitable for API responses."""

    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def evidence(
    status: str,
    source: str,
    confidence: str,
    observed_at: str | None = None,
    **values: Any,
) -> dict[str, Any]:
    """Build a value that always carries its evidence boundary."""

    result: dict[str, Any] = {
        "status": status,
        "observedAt": observed_at or utc_now(),
        "source": source,
        "confidence": confidence,
    }
    result.update(values)
    return result


def unknown(source: str, detail: str | None = None, observed_at: str | None = None) -> dict[str, Any]:
    values: dict[str, Any] = {}
    if detail:
        values["detail"] = detail
    return evidence("unknown", source, "not_collected", observed_at, **values)
