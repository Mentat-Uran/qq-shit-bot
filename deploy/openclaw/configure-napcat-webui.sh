#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONFIG_PATH=${NAPCAT_WEBUI_CONFIG:-"$SCRIPT_DIR/runtime/napcat/config/webui.json"}
BIND_ADDRESS=${NAPCAT_WEBUI_BIND_ADDRESS:-127.0.0.1}

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required to update NapCat WebUI binding safely." >&2
    exit 1
fi

if [ ! -f "$CONFIG_PATH" ]; then
    # NapCat creates this file on first start. The launcher retries after the
    # container has initialized, without creating a partial config here.
    exit 3
fi

python3 - "$CONFIG_PATH" "$BIND_ADDRESS" <<'PY'
import ipaddress
import json
import os
import stat
import sys
import tempfile

config_path, bind_address = sys.argv[1:]

try:
    address = ipaddress.ip_address(bind_address)
except ValueError:
    raise SystemExit("NAPCAT_WEBUI_BIND_ADDRESS must be a concrete IPv4 address")

if not isinstance(address, ipaddress.IPv4Address) or address.is_unspecified or address.is_multicast:
    raise SystemExit("NAPCAT_WEBUI_BIND_ADDRESS must be a concrete IPv4 address")

with open(config_path, "r", encoding="utf-8") as stream:
    config = json.load(stream)

if not isinstance(config, dict):
    raise SystemExit("NapCat WebUI config must be a JSON object")

if config.get("host") == bind_address:
    raise SystemExit(4)

config["host"] = bind_address
file_stat = os.stat(config_path)
directory = os.path.dirname(config_path) or "."
temporary_path = None

try:
    descriptor, temporary_path = tempfile.mkstemp(
        prefix=".webui.json.",
        dir=directory,
        text=True,
    )
    os.fchmod(descriptor, stat.S_IMODE(file_stat.st_mode))
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(config, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary_path, config_path)
    temporary_path = None
except Exception:
    if temporary_path:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
    raise
PY
