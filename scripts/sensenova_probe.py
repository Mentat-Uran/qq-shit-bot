#!/usr/bin/env python3
"""Opt-in redacted probe for the Mac SenseNova -> DeepSeek media route.

The script reads the ignored deployment .env in-process and never prints keys,
request bodies, image bytes, model responses, or QQ content. It is a provider
probe only; it cannot prove that a real QQ attachment reached the gateway.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


SENSENOVA_URL = "https://token.sensenova.cn/v1/chat/completions"
DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"
VISION_MODEL = "sensenova-6.7-flash-lite"
TEXT_MODEL = "deepseek-v4-flash"
FALLBACK_TEXT_MODEL = "deepseek-chat"
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


def content_from_response(value: dict[str, Any] | None) -> str | None:
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
    # SenseNova 6.7 Flash-Lite may return its usable multimodal description in
    # the provider-specific reasoning field while omitting message.content.
    for field in ("reasoning", "reasoning_content"):
        reasoning = message.get(field)
        if isinstance(reasoning, str) and reasoning.strip():
            return reasoning.strip()
    return None


def image_message(image_path: Path) -> list[dict[str, Any]]:
    media_type = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return [
        {"type": "text", "text": "用一句很短的中文描述这张图片，供另一个文本模型生成最终回复。"},
        {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{encoded}"}},
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path("deploy/openclaw/.env"))
    parser.add_argument("--image", type=Path, help="local image file; bytes are sent as a data URL and never printed")
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument(
        "--probe-official-fallback",
        action="store_true",
        help="explicitly probe the paid official DeepSeek fallback after the SenseNova route",
    )
    args = parser.parse_args(argv)
    if args.timeout < 5 or args.timeout > 180:
        print("timeout must be between 5 and 180 seconds", file=sys.stderr)
        return 2

    values = parse_env(args.env_file.resolve())
    vision_key = values.get("SENSENOVA_API_KEY")
    if not configured(vision_key):
        print("provider probe not run: SENSENOVA_API_KEY is missing or a placeholder (value redacted)")
        return 2
    if args.image and not args.image.is_file():
        print("provider probe not run: image file is missing")
        return 2

    vision_payload: dict[str, Any] = {
        "model": VISION_MODEL,
        "messages": [{"role": "user", "content": image_message(args.image)}] if args.image else [{"role": "user", "content": "返回：视觉探针文本路径可用。"}],
        "max_tokens": 120,
    }
    vision_status, vision_response = request_json(SENSENOVA_URL, vision_key, vision_payload, args.timeout)
    vision_text = content_from_response(vision_response)
    print(f"sensenova_vision model={VISION_MODEL} requested={'yes' if args.image else 'no'} status={vision_status or 'unreachable'} content={'yes' if vision_text else 'no'}")
    if not vision_text:
        return 1

    final_payload = {
        "model": TEXT_MODEL,
        "messages": [{"role": "user", "content": f"视觉识别结果：{vision_text}\n请生成一句很短的中文 QQ 回复。"}],
        "max_tokens": 80,
    }
    text_status, text_response = request_json(SENSENOVA_URL, vision_key, final_payload, args.timeout)
    final_text = content_from_response(text_response)
    print(f"sensenova_text model={TEXT_MODEL} status={text_status or 'unreachable'} content={'yes' if final_text else 'no'}")
    if final_text or not args.probe_official_fallback:
        return 0 if final_text else 1

    deepseek_key = values.get("DEEPSEEK_API_KEY")
    if not configured(deepseek_key):
        print("official_deepseek_fallback not run: key is missing or a placeholder (value redacted)")
        return 1
    fallback_payload = {**final_payload, "model": FALLBACK_TEXT_MODEL}
    fallback_status, fallback_response = request_json(DEEPSEEK_URL, deepseek_key, fallback_payload, args.timeout)
    fallback_text = content_from_response(fallback_response)
    print(
        f"official_deepseek_fallback model={FALLBACK_TEXT_MODEL} "
        f"status={fallback_status or 'unreachable'} content={'yes' if fallback_text else 'no'}"
    )
    return 0 if fallback_text else 1


if __name__ == "__main__":
    raise SystemExit(main())
