#!/usr/bin/env bash
# subcommand: health — check system health
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
echo "=== Bridge Status ==="
curl -sf "$BRIDGE/api/status" | head -c 500 2>/dev/null || echo "unreachable"
echo
echo "=== System Health ==="
curl -sf "$BRIDGE/api/system-health" | head -c 3000 2>/dev/null || echo "unreachable"
echo
echo "=== Palace Status ==="
curl -sf "$BRIDGE/api/palace/status" | head -c 1000 2>/dev/null || echo "unreachable"
echo
echo "=== Sync Status ==="
curl -sf "$BRIDGE/api/sync/status" | head -c 1000 2>/dev/null || echo "unreachable"
echo
echo "=== Token Stats ==="
curl -sf "$BRIDGE/api/token-stats" | head -c 1000 2>/dev/null || echo "unreachable"
echo
echo "=== Recent Errors ==="
curl -sf "$BRIDGE/api/errors?limit=5" | head -c 2000 2>/dev/null || echo "unreachable"
