#!/usr/bin/env bash
# subcommand: palace — query MemPalace knowledge graph
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
QUESTION="$*"
[ -z "$QUESTION" ] && { echo "Usage: wi-search palace <question>"; exit 1; }
HEALTH=$(curl -sf "$BRIDGE/api/palace/status" | head -c 1000 2>/dev/null) || HEALTH='{"error":"unreachable"}'
echo "$HEALTH" | grep -q '"healthy":true' && curl -sf -X POST "$BRIDGE/api/notebooks/default/chat" -H "Content-Type: application/json" -d "{\"message\":\"$QUESTION\",\"usePalace\":true}" | head -c 8000 || echo '{"error":"palace not healthy","status":'"$HEALTH"'}'
