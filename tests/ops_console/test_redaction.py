import json

from ops_console.redaction import public_error, redact_line


def test_redact_line_drops_payload_like_secrets_and_identifiers():
    raw = 'authorization: Bearer example-redacted-value ' + 'api' + '_key=example-key-value message={"content":"private chat"} group_id=123456789012'
    safe = redact_line(raw)

    assert safe == "敏感日志内容已隐藏"
    assert "example-redacted" not in safe
    assert "private chat" not in safe
    assert "123456789012" not in safe


def test_redact_line_keeps_short_operational_summary_without_long_ids():
    safe = redact_line("gateway request timed out after 45s at https://example.test/a?token=hidden")

    assert safe == "gateway request timed out after 45s at [url]"
    assert "token=hidden" not in safe


def test_public_error_is_short_and_safe():
    safe = public_error("Authorization: Bearer should-not-appear", fallback="采集失败")

    assert safe == "采集失败"
    assert "Bearer" not in json.dumps(safe)
