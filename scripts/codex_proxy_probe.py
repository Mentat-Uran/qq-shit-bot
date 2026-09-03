#!/usr/bin/env python3
"""Opt-in redacted probe for the shared Codex reverse-proxy route.

The script reads the ignored deployment .env in-process and never prints the
proxy token, request body, image bytes, model response, or QQ content. It is a
provider probe only; it cannot prove that a real QQ attachment reached the
Gateway or that a reply was delivered to a client.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


CODEX_PROXY_MODEL = "gpt-5.6-luna"
CODEX_PROXY_REASONING_EFFORT = "max"
PLACEHOLDER = "replace-with-"


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if match:
            values[match.group(1)] = match.group(2).strip('"\'')
    return values


def configured(value: str | None) -> bool:
    return bool(value and not value.startswith(PLACEHOLDER))


def request_json(url: str, api_key: str, payload: dict[str, Any], timeout: int) -> tuple[int, dict[str, Any] | None]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(2 * 1024 * 1024)
            value = json.loads(raw.decode("utf-8"))
            return response.status, value if isinstance(value, dict) else None
    except urllib.error.HTTPError as error:
        return error.code, None
    except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return 0, None


def content_from_response(value: dict[str, Any] | None, *, allow_reasoning: bool = True) -> str | None:
    choices = value.get("choices") if isinstance(value, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return None
    message = choices[0].get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    if isinstance(content, list):
        parts = [part.get("text", "").strip() for part in content if isinstance(part, dict)]
        combined = "\n".join(part for part in parts if part)
        if combined:
            return combined
    if allow_reasoning:
        for field in ("reasoning", "reasoning_content"):
            reasoning = message.get(field)
            if isinstance(reasoning, str) and reasoning.strip():
                return reasoning.strip()
    return None


def image_message(image_path: Path) -> list[dict[str, Any]]:
    media_type = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return [
        {"type": "text", "text": "请用一句很短的中文描述这张图片，并直接给出自然的 QQ 回复。"},
        {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{encoded}"}},
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path("deploy/openclaw/.env"))
    parser.add_argument("--image", type=Path, help="local image file; bytes are sent as a data URL and never printed")
    parser.add_argument("--timeout", type=int, default=45)
    args = parser.parse_args(argv)
    if args.timeout < 5 or args.timeout > 180:
        print("timeout must be between 5 and 180 seconds", file=sys.stderr)
        return 2

    values = parse_env(args.env_file.resolve())
    base_url = values.get("CODEX_PROXY_BASE_URL", "").rstrip("/")
    proxy_token = values.get("CODEX_PROXY_TOKEN")
    if not configured(base_url) or not configured(proxy_token):
        print("provider probe not run: CODEX_PROXY_BASE_URL or CODEX_PROXY_TOKEN is missing or a placeholder (value redacted)")
        return 2
    if args.image and not args.image.is_file():
        print("provider probe not run: image file is missing")
        return 2

    content: str | list[dict[str, Any]] = image_message(args.image) if args.image else "返回：Codex 反代文本路径可用。"
    payload: dict[str, Any] = {
        "model": CODEX_PROXY_MODEL,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": 120,
        "reasoning_effort": CODEX_PROXY_REASONING_EFFORT,
    }
    status, response = request_json(f"{base_url}/chat/completions", proxy_token, payload, args.timeout)
    result = content_from_response(response)
    print(
        f"codex_proxy model={CODEX_PROXY_MODEL} requested_image={'yes' if args.image else 'no'} "
        f"status={status or 'unreachable'} content={'yes' if result else 'no'}"
    )
    return 0 if result else 1


if __name__ == "__main__":
    raise SystemExit(main())
