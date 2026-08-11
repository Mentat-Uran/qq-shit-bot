#!/bin/sh
set -eu

LABEL="com.mentat.qqshitbot.ops-console"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_VALUE=$(id -u)

launchctl bootout "gui/$UID_VALUE/$LABEL" >/dev/null 2>&1 || true
if [ -f "$PLIST_PATH" ]; then
    rm -f "$PLIST_PATH"
fi
printf 'Operations Console LaunchAgent removed: %s\n' "$LABEL"
