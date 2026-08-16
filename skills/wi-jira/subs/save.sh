#!/usr/bin/env bash
# subcommand: save — save notes to a Jira ticket
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
KEY="${1:-}"
NOTES=""
shift 2>/dev/null || true
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES="$2"; shift 2 ;;
    *) KEY="$1"; shift ;;
  esac
done
[ -z "$KEY" ] && { echo "Usage: wi-jira save <TICKET-KEY> [--notes \"text\"]"; exit 1; }
[ -z "$NOTES" ] && NOTES="Investigation findings recorded by Claude Code on $(date)."
curl -sf -X PUT "$BRIDGE/api/jira/analysis/$KEY/notes" -H "Content-Type: application/json" -d "{\"notes\":\"$NOTES\"}"
