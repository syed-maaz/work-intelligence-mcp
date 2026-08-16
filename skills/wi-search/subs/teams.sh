#!/usr/bin/env bash
# subcommand: teams — search Teams messages and transcripts
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
QUERY=""
SINCE=""
MEETINGS_ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --meetings-only) MEETINGS_ONLY="true"; shift ;;
    *) QUERY="$QUERY $1"; shift ;;
  esac
done
QUERY=$(echo "$QUERY" | sed 's/^ //')
[ -z "$QUERY" ] && { echo "Usage: wi-search teams <query> [--since YYYY-MM-DD] [--meetings-only]"; exit 1; }
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$QUERY" 2>/dev/null || echo "$QUERY")
URL="$BRIDGE/api/teams-updates?query=$ENCODED"
[ -n "$SINCE" ] && URL="$URL&since=$SINCE"
curl -sf "$URL" | head -c 10000
