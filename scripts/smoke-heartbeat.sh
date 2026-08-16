#!/usr/bin/env bash
# scripts/smoke-heartbeat.sh
#
# Canary watch script: polls /api/status and checks heartbeat.healthy.
# Exits 1 if stale, 2 if bridge unreachable, 0 after N loops all green.
#
# Usage:
#   npm run canary:heartbeat
#   BRIDGE_URL=http://localhost:3132 bash scripts/smoke-heartbeat.sh
#
# Env:
#   BRIDGE_URL  — default http://localhost:3132
#   MAX_LOOPS   — number of poll cycles (default 3, 0 = run forever)

set -u
BRIDGE_URL="${BRIDGE_URL:-http://localhost:3132}"
MAX_LOOPS="${MAX_LOOPS:-3}"
SLEEP_SEC="${SLEEP_SEC:-30}"
loop=0

trap 'echo "heartbeat canary terminated"; exit 0' SIGTERM SIGINT

while true; do
  loop=$((loop + 1))

  body=$(curl -fsS --max-time 5 "${BRIDGE_URL}/api/status" 2>/dev/null) || {
    echo "HEARTBEAT FAIL at $(date): bridge unreachable"
    exit 2
  }

  healthy=$(echo "$body" | python3 -c "
import sys,json
try:
    d=json.loads(sys.stdin.read())
    hb=d.get('heartbeat',{})
    print('true' if hb.get('healthy') else 'false')
except Exception:
    print('false')
" 2>/dev/null)

  if [ "$healthy" != "true" ]; then
    echo "HEARTBEAT FAIL at $(date): heartbeat.healthy != true — body: $(echo "$body" | head -c 200)"
    exit 1
  fi

  echo "[$(date -u +%H:%M:%SZ)] heartbeat healthy — loop ${loop}/${MAX_LOOPS:-∞}"

  if [ "${MAX_LOOPS:-0}" -gt 0 ] && [ "$loop" -ge "$MAX_LOOPS" ]; then
    echo "All ${loop} loops green."
    exit 0
  fi

  sleep "${SLEEP_SEC}"
done
