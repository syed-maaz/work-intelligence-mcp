#!/usr/bin/env bash
# subcommand: correlate — find cross-domain relationships
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
TOPIC=""
ENTITY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --topic) TOPIC="$2"; shift 2 ;;
    --entity) ENTITY="$2"; shift 2 ;;
    *) echo "Usage: wi-code correlate [--topic <name>] [--entity <name>]"; exit 1 ;;
  esac
done
curl -sf -X POST "$BRIDGE/api/palace/health/refresh" -H "Content-Type: application/json" -d "{\"trigger\":\"correlation\",\"topic\":\"$TOPIC\",\"entity\":\"$ENTITY\"}" 2>/dev/null
[ -n "$TOPIC" ] && curl -sf "$BRIDGE/api/relationships?topic=$TOPIC" | head -c 6000
