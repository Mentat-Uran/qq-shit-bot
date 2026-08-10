from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_console_contract_has_no_socket_or_retired_visual_dependency():
    files = [
        ROOT / "ops_console" / "server.py",
        ROOT / "ops_console" / "collectors.py",
        ROOT / "ops_console" / "static" / "index.html",
        ROOT / "ops_console" / "static" / "app.js",
        ROOT / "ops_console" / "static" / "styles.css",
    ]
    text = "\n".join(path.read_text(encoding="utf-8") for path in files)

    assert "docker.sock" not in text
    assert "video-bridge" not in text
    assert "image-fusion" not in text
    assert "Mage-VL" not in text
    assert "LocateAnything" not in text
    assert "arbitrary" not in text.lower()


def test_windows_console_launcher_is_separate_from_formal_bot_launcher():
    launcher = (ROOT / "scripts" / "windows" / "Start-QQBotConsole.bat").read_text(encoding="utf-8")
    powershell = (ROOT / "scripts" / "windows" / "Start-QQBotConsole.ps1").read_text(encoding="utf-8")

    assert "ops_console.server" in powershell
    assert "127.0.0.1" in launcher
    assert "Start-OpenClawDocker.ps1" not in launcher
    assert "OPENCLAW_GATEWAY_TOKEN" not in powershell
    assert ".env" not in powershell
    assert "POWERSHELL_EXE" in launcher
    assert "System32\\WindowsPowerShell\\v1.0\\powershell.exe" in launcher
    assert "Test-PythonCandidate" in powershell
    assert "Python 3.11 or newer" in powershell


def test_frontend_theme_and_chinese_localization_contract():
    html = (ROOT / "ops_console" / "static" / "index.html").read_text(encoding="utf-8")
    javascript = (ROOT / "ops_console" / "static" / "app.js").read_text(encoding="utf-8")
    styles = (ROOT / "ops_console" / "static" / "styles.css").read_text(encoding="utf-8")

    assert 'meta name="color-scheme" content="dark light"' in html
    assert 'id="theme-toggle"' in html
    assert 'aria-pressed="false"' in html
    assert 'id="main-content"' in html
    assert "运行与资源" in html
    assert "日志与诊断" in html
    assert "tail 80 / max 80 records" not in html

    assert 'const THEME_STORAGE_KEY = "qqbot-ops-theme"' in javascript
    assert "localStorage.getItem(THEME_STORAGE_KEY)" in javascript
    assert "localStorage.setItem(THEME_STORAGE_KEY, state.theme)" in javascript
    assert 'document.documentElement.dataset.theme = state.theme' in javascript
    assert "confidenceLabels" in javascript
    assert "sourceLabels" in javascript
    assert "eventTypeLabels" in javascript
    assert "activity-event-source" in html
    assert "queueConfiguration" in javascript
    assert "contextTokenConfiguration" in javascript
    assert "meter-unknown" in javascript

    assert 'html[data-theme="light"]' in styles
    assert "--panel-gradient-start" in styles
    assert "--meter-track" in styles
    assert ".meter.meter-unknown span" in styles


def test_runtime_collection_contract_is_allow_listed_and_evidence_aware():
    collectors = (ROOT / "ops_console" / "collectors.py").read_text(encoding="utf-8")

    assert "class RuntimeConfigCollector" in collectors
    assert "def parse_runtime_events" in collectors
    assert '"events": events' in collectors
    assert '"configuration": configuration' in collectors
    assert "docker compose logs --tail 80" in collectors
    assert "messageId" not in collectors
    assert "groupOpenid" not in collectors
