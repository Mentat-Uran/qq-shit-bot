from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "windows" / "Bind-OpenClawQQBot.ps1"
BAT_SCRIPT = ROOT / "scripts" / "windows" / "Bind-OpenClawQQBot.bat"


def test_qr_binding_uses_the_official_plugin_only_as_a_temporary_helper():
    text = SCRIPT.read_text(encoding="utf-8")

    assert "@tencent-connect/openclaw-qqbot@2.0.0" in text
    assert "'qq-diagnostic-filter-init'" in text
    assert "'channels', 'login', '--channel', 'qqbot'" in text
    assert "'plugins', 'uninstall', 'openclaw-qqbot'" in text
    assert "Copy-Item -LiteralPath $sourceConfig -Destination $runtimeConfigPath -Force" in text
    assert "QQBOT_ALLOWED_USER_OPENID" in text
    assert "$ForceQr" in text


def test_qr_binding_does_not_print_secret_values():
    text = SCRIPT.read_text(encoding="utf-8")

    assert "Write-Host $qrCredentials.ClientSecret" not in text
    assert "Write-Output $qrCredentials.ClientSecret" not in text
    assert "Write-Host $secret" not in text


def test_windows_binding_entrypoint_is_pure_batch():
    text = BAT_SCRIPT.read_text(encoding="utf-8")

    assert "Start-OpenClawQQBot.bat" in text
    assert "powershell" not in text.lower()
    assert "QQBOT_CLIENT_SECRET=." in text
