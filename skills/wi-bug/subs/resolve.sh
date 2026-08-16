#!/usr/bin/env bash
# subcommand: resolve — mark a bug as resolved/wont-fix
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
BUG_ID="${1:-}"
RESOLUTION="resolved"
NOTE=""
shift 2>/dev/null || true
while [ $# -gt 0 ]; do
  case "$1" in
    --note) NOTE="$2"; shift 2 ;;
    resolved|wont-fix) RESOLUTION="$1"; shift ;;
    --help) echo "Usage: wi-bug resolve <bug_id> [resolved|wont-fix] [--note \"reason\"]"; exit 0 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
if [ -z "$BUG_ID" ]; then
  echo '{"error":"missing required argument: bug_id"}'
  exit 1
fi
BODY="{\"resolution\":\"$RESOLUTION\"}"
[ -n "$NOTE" ] && BODY="{\"resolution\":\"$RESOLUTION\",\"note\":\"$NOTE\"}"
curl -s -X POST "$BRIDGE/api/bugs/$BUG_ID/resolve" \
  -H "Content-Type: application/json" \
  -d "$BODY"
