#!/usr/bin/env bash
# subcommand: teammate — look up a teammate's profile
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
QUERY="${*:-}"
if [ -z "$QUERY" ]; then
  echo "Usage: wi-people teammate <name or email>"
  exit 1
fi
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$QUERY" 2>/dev/null || echo "$QUERY")
curl -sf "$BRIDGE/api/teammates?q=$ENCODED" | head -c 4000
