#!/usr/bin/env bash
# Subcommand dispatcher for wi-govern.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
SUBS="$REPO/skills/wi-govern/subs"

SUB="${1:-}"
if [ -z "$SUB" ]; then
  echo "usage: bash skills/wi-govern/run.sh <subcommand> [args]" >&2
  echo "subcommands: $(ls "$SUBS" 2>/dev/null | sed 's/\.\(sh\|mjs\)$//' | tr '\n' ' ')" >&2
  exit 1
fi
shift
SUB_MJS="$SUBS/$SUB.mjs"
SUB_SH="$SUBS/$SUB.sh"
if [ -f "$SUB_MJS" ]; then
  node "$SUB_MJS" "$@"
elif [ -f "$SUB_SH" ]; then
  bash "$SUB_SH" "$@"
else
  echo "unknown subcommand: $SUB" >&2
  echo "subcommands: $(ls "$SUBS" 2>/dev/null | sed 's/\.\(sh\|mjs\)$//' | tr '\n' ' ')" >&2
  exit 1
fi
