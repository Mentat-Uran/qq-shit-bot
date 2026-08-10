"""Defensive redaction for anything that can cross the local API boundary."""

from __future__ import annotations

import re


SENSITIVE_LINE = re.compile(
    r"(?:authorization|bearer\s+|api[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|"
    r"password|cookie|private[_ -]?key|openid|\bopenid\b|\"(?:content|message|prompt|token|secret)\")",
    re.IGNORECASE,
)
URL_WITH_QUERY = re.compile(r"https?://[^\s\"']+", re.IGNORECASE)
LONG_SECRET = re.compile(r"(?<![A-Za-z0-9])[A-Za-z0-9_\-]{24,}(?![A-Za-z0-9])")
LONG_NUMBER = re.compile(r"(?<![0-9])\d{6,}(?![0-9])")
QQ_ID_FIELD = re.compile(r"(group(?:_id|Id)?|user(?:_id|Id)?|member(?:_id|Id)?)\s*[:=]\s*([^,\s}]+)", re.IGNORECASE)
LOCAL_PATH = re.compile(r"(?:[A-Za-z]:\\|\\\\)[^\s\"']+")


def redact_line(value: str, *, max_length: int = 280) -> str | None:
    """Return a short safe log summary, or None for payload-like lines."""

    text = re.sub(r"[\x00-\x1f\x7f]", " ", str(value)).strip()
    if not text:
        return None
    if SENSITIVE_LINE.search(text):
        return "敏感日志内容已隐藏"
    text = URL_WITH_QUERY.sub("[url]", text)
    text = LOCAL_PATH.sub("[path]", text)
    text = QQ_ID_FIELD.sub(lambda match: f"{match.group(1)}=[脱敏标识]", text)
    text = LONG_SECRET.sub("[脱敏值]", text)
    text = LONG_NUMBER.sub("[脱敏数字]", text)
    text = re.sub(r"\s+", " ", text)
    return text[:max_length].rstrip() if text else None


def public_error(value: str | None, *, fallback: str = "采集失败") -> str:
    """Keep command errors useful without returning paths, headers, or secrets."""

    if not value:
        return fallback
    safe = redact_line(value, max_length=160)
    if not safe or safe == "敏感日志内容已隐藏":
        return fallback
    return safe
