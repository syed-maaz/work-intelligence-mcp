#!/usr/bin/env bash
# subcommand: analyze — run AI analysis on a Jira ticket
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
KEY="${1:-}"
[ -z "$KEY" ] && { echo "Usage: wi-jira analyze <TICKET-KEY>"; exit 1; }
curl -sf -X POST "$BRIDGE/api/jira/analyze" -H "Content-Type: application/json" -d "{\"key\":\"$KEY\"}" 2>/dev/null || curl -sf "$BRIDGE/api/jira/analyses?key=$KEY" | head -c 8000
