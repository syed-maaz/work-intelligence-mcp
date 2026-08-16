#!/usr/bin/env bash
# subcommand: all — cross-source FTS search
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
QUERY=""
SINCE=""
SOURCES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --sources) SOURCES="$2"; shift 2 ;;
    *) QUERY="$QUERY $1"; shift ;;
  esac
done
QUERY=$(echo "$QUERY" | sed 's/^ //')
[ -z "$QUERY" ] && { echo "Usage: wi-search all <query> [--since YYYY-MM-DD] [--sources jira,teams,email,github]"; exit 1; }
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$QUERY" 2>/dev/null || echo "$QUERY")
URL="$BRIDGE/api/search-all?query=$ENCODED"
[ -n "$SINCE" ] && URL="$URL&since=$SINCE"
[ -n "$SOURCES" ] && URL="$URL&sources=$SOURCES"
curl -sf "$URL" | head -c 10000
