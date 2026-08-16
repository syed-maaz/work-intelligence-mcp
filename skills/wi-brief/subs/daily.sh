#!/usr/bin/env bash
# subcommand: daily — daily digest for a topic
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
TOPIC=""
DATE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --date) DATE="$2"; shift 2 ;;
    *) TOPIC="$1"; shift ;;
  esac
done
[ -z "$TOPIC" ] && { echo "Usage: wi-brief daily <topic-name> [--date YYYY-MM-DD]"; exit 1; }
URL="$BRIDGE/api/digest?topic=$TOPIC"
[ -n "$DATE" ] && URL="$URL&date=$DATE"
DATA=$(curl -sf "$URL" | head -c 8000) || DATA="{}"
echo "$DATA"
