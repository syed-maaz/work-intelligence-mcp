#!/usr/bin/env bash
# subcommand: ask — topic expert question
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
QUESTION=""
PROJECT=""
SINCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    *) QUESTION="$QUESTION $1"; shift ;;
  esac
done
QUESTION=$(echo "$QUESTION" | sed 's/^ //')
[ -z "$QUESTION" ] && { echo "Usage: wi-search ask <question> [--project KEY] [--since YYYY-MM-DD]"; exit 1; }
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$QUESTION" 2>/dev/null || echo "$QUESTION")
URL="$BRIDGE/api/topic-expert?question=$ENCODED"
[ -n "$PROJECT" ] && URL="$URL&projectKey=$PROJECT"
[ -n "$SINCE" ] && URL="$URL&since=$SINCE"
curl -sf "$URL" | head -c 10000
