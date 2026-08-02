"""Telegram-specific gateway filtering for noisy status/error output."""

from gateway.config import Platform
from gateway.run import (
    _prepare_gateway_status_message,
    _sanitize_gateway_final_response,
    _trim_gateway_history_to_recent_completed_turns,
)


def test_telegram_status_suppresses_auxiliary_and_retry_noise():
    """Auxiliary failures and retry backoff chatter should not hit Telegram."""
    noisy_messages = [
        "⚠ Auxiliary title generation failed: HTTP 400: Operation contains cybersecurity risk",
        "⚠ Compression summary failed: upstream error. Inserted a fallback context marker.",
        "🗜️ Compacting context — summarizing earlier conversation so I can continue...",
        "ℹ Configured compression model 'small-model' failed (timeout). Recovered using main model — check auxiliary.compression.model in config.yaml.",
        "⏳ Retrying in 4.2s (attempt 1/3)...",
        "⏱️ Rate limited. Waiting 30.0s (attempt 2/3)...",
        "⚠️ Max retries (3) exhausted — trying fallback...",
    ]

    for message in noisy_messages:
        assert _prepare_gateway_status_message(Platform.TELEGRAM, "warn", message) is None


def test_non_telegram_status_is_unchanged():
    """The Telegram quieting policy must not hide CLI/Discord diagnostics."""
    message = "⏳ Retrying in 4.2s (attempt 1/3)..."

    assert _prepare_gateway_status_message(Platform.DISCORD, "lifecycle", message) == message
    assert _prepare_gateway_status_message("local", "lifecycle", message) == message


def test_qq_status_is_always_silent():
    assert _prepare_gateway_status_message(Platform.QQBOT, "lifecycle", "Retrying in 4s") is None
    assert _prepare_gateway_status_message(Platform.QQBOT, "tool", "Searching the web") is None


def test_telegram_status_sanitizes_raw_provider_security_errors():
    """Provider policy/security bodies should be replaced before chat delivery."""
    raw = (
        "❌ API failed after 3 retries — HTTP 400: request blocked because "
        "Operation contains cybersecurity risk. request_id=req_123"
    )

    sanitized = _prepare_gateway_status_message(Platform.TELEGRAM, "lifecycle", raw)

    assert sanitized is not None
    assert "provider rejected" in sanitized.lower()
    assert "cybersecurity risk" not in sanitized.lower()
    assert "HTTP 400" not in sanitized
    assert "req_123" not in sanitized


def test_telegram_final_response_sanitizes_raw_provider_errors():
    """Final Telegram replies should not expose raw provider/security details."""
    raw = (
        "API call failed after 3 retries: HTTP 400: This request was blocked "
        "under the provider cybersecurity risk policy. request_id=req_abc"
    )

    sanitized = _sanitize_gateway_final_response(Platform.TELEGRAM, raw)

    assert "provider rejected" in sanitized.lower()
    assert "cybersecurity risk" not in sanitized.lower()
    assert "HTTP 400" not in sanitized
    assert "req_abc" not in sanitized


def test_telegram_final_response_redacts_auth_secrets():
    """Authentication errors should be useful without leaking key material."""
    raw = (
        "⚠️ Provider authentication failed: Incorrect API key provided: "
        "sk-live_abcdefghijklmnopqrstuvwxyz1234567890"
    )

    sanitized = _sanitize_gateway_final_response(Platform.TELEGRAM, raw)

    assert "authentication failed" in sanitized.lower()
    assert "check the configured credentials" in sanitized.lower()
    assert "sk-live" not in sanitized


def test_telegram_final_response_keeps_normal_answers():
    """Normal assistant content should not be rewritten."""
    answer = "Here is the clean summary you asked for."

    assert _sanitize_gateway_final_response(Platform.TELEGRAM, answer) == answer


def test_qq_final_response_drops_provider_error_but_keeps_normal_answer():
    error = "API call failed after 3 retries: HTTP 429 rate limit exceeded"
    answer = "这事真绷不住了"

    assert _sanitize_gateway_final_response(Platform.QQBOT, error) == ""
    assert _sanitize_gateway_final_response(Platform.QQBOT, answer) == answer


def test_qq_final_response_drops_safety_refusal_diagnostic():
    refusal = (
        "⚠️  The model declined to respond to this request "
        "(safety refusal — not a Hermes/gateway failure).\n\n"
        "Model's explanation: 你好，我无法给到相关内容。\n\n"
        "Try rephrasing the request."
    )

    assert _sanitize_gateway_final_response(Platform.QQBOT, refusal) == ""


def test_qq_history_keeps_only_latest_completed_normal_turn():
    history = [
        {"role": "user", "content": "旧话题"},
        {"role": "assistant", "content": "旧回复"},
        {"role": "user", "content": "最近话题"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1"}]},
        {"role": "tool", "tool_call_id": "c1", "content": "结果"},
        {"role": "assistant", "content": "最近回复"},
        {"role": "user", "content": "失败话题"},
        {"role": "assistant", "content": "API call failed after 3 retries: HTTP 429"},
        {"role": "user", "content": "未完成话题"},
    ]

    assert _trim_gateway_history_to_recent_completed_turns(history) == [
        {"role": "user", "content": "最近话题"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1"}]},
        {"role": "tool", "tool_call_id": "c1", "content": "结果"},
        {"role": "assistant", "content": "最近回复"},
    ]
