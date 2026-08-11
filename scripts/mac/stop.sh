#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"

compose down
echo 'macOS OpenClaw Gateway and context-recovery stopped; named state volumes were kept.'
