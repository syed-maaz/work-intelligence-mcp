#!/usr/bin/env bash
# subcommand: ticket-links — extract and summarize linked content
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
KEY="${1:-}"
[ -z "$KEY" ] && { echo "Usage: wi-jira ticket-links <TICKET-KEY>"; exit 1; }
curl -sf -X POST "$BRIDGE/api/jira/analyze" -H "Content-Type: application/json" -d "{\"key\":\"$KEY\",\"linksOnly\":true}" 2>/dev/null || curl -sf "$BRIDGE/api/jira/analyses?key=$KEY" | head -c 8000
