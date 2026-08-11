#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
PLIST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/qqshitbot"
LABEL="com.mentat.qqshitbot.ops-console"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
UID_VALUE=$(id -u)

mkdir -p "$PLIST_DIR" "$LOG_DIR"
chmod 700 "$LOG_DIR"

launchctl bootout "gui/$UID_VALUE/$LABEL" >/dev/null 2>&1 || true

TMP_PLIST=$(mktemp "${TMPDIR:-/tmp}/qqshitbot-console.XXXXXX")
cleanup() {
    rm -f "$TMP_PLIST"
}
trap cleanup EXIT INT TERM

cat >"$TMP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$REPO_ROOT/scripts/mac/console.sh</string>
    <string>--no-browser</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/ops-console.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/ops-console.err.log</string>
</dict>
</plist>
EOF

plutil -lint "$TMP_PLIST" >/dev/null
mv "$TMP_PLIST" "$PLIST_PATH"
chmod 600 "$PLIST_PATH"
launchctl bootstrap "gui/$UID_VALUE" "$PLIST_PATH"
launchctl kickstart -k "gui/$UID_VALUE/$LABEL"
printf 'Operations Console LaunchAgent installed: %s\n' "$LABEL"
printf 'Logs: %s\n' "$LOG_DIR"
