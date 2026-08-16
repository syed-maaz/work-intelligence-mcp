#!/usr/bin/env bash
# subcommand: sync — trigger and monitor data sync
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
TOPIC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --topic) TOPIC="$2"; shift 2 ;;
    *) echo "Usage: wi-status sync [--topic <name>]"; exit 1 ;;
  esac
done
STATUS=$(curl -sf "$BRIDGE/api/sync/status" | head -c 2000 2>/dev/null || echo "{}")
echo "Current sync state: $(echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null || echo "unknown")"
RESP=$(curl -sf -X POST "$BRIDGE/api/sync/all" -H "Content-Type: application/json" -d "{\"topic\":${TOPIC:+\"$TOPIC\"}}" 2>/dev/null || echo "{}")
echo "Sync triggered. Check status with: wi-status health"
echo "$RESP" | head -c 500
