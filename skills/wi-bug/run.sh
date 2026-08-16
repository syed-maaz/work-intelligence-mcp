#!/usr/bin/env bash
# Subcommand dispatcher for wi-bug.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
SUBS="$REPO/skills/wi-bug/subs"

SUB="${1:-}"
if [ -z "$SUB" ]; then
  echo "usage: bash skills/wi-bug/run.sh <subcommand> [args]" >&2
  echo "subcommands: $(ls "$SUBS" 2>/dev/null | sed 's/\.sh$//' | tr '\n' ' ')" >&2
  exit 1
fi
shift
SUB_PATH="$SUBS/$SUB.sh"
if [ ! -f "$SUB_PATH" ]; then
  echo "unknown subcommand: $SUB" >&2
  echo "subcommands: $(ls "$SUBS" 2>/dev/null | sed 's/\.sh$//' | tr '\n' ' ')" >&2
  exit 1
fi
bash "$SUB_PATH" "$@"
