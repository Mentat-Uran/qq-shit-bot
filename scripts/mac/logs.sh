#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"
tail_lines=${1:-80}
case "$tail_lines" in
    *[!0-9]*|"") echo 'Usage: logs.sh [tail-lines]' >&2; exit 2 ;;
esac
compose logs --no-color --timestamps --tail "$tail_lines" -f openclaw-gateway context-recovery
