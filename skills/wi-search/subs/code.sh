#!/usr/bin/env bash
# subcommand: code — run code research question
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
QUESTION="$*"
[ -z "$QUESTION" ] && { echo "Usage: wi-search code <research question>"; exit 1; }
STATUS=$(curl -sf "$BRIDGE/api/status" | head -c 500 2>/dev/null) || { echo '{"error":"bridge unreachable"}'; exit 1; }
curl -sf -X POST "$BRIDGE/api/jira/analyze" -H "Content-Type: application/json" -d "{\"question\":\"$QUESTION\",\"type\":\"code_research\"}" | head -c 8000
