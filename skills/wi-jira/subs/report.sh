#!/usr/bin/env bash
# subcommand: report — fetch sprint board report
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
KEY="${1:-BDS}"
BOARD=""
shift 2>/dev/null || true
while [ $# -gt 0 ]; do
  case "$1" in
    --board) BOARD="$2"; shift 2 ;;
    *) KEY="$1"; shift ;;
  esac
done
URL="${BOARD:-https://your-domain.atlassian.net/secure/RapidBoard.jspa?projectKey=$KEY}"
curl -sf "$BRIDGE/api/jira-report?projectKey=$KEY&boardUrl=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$URL'))")" | head -c 12000
