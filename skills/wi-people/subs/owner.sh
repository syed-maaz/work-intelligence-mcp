#!/usr/bin/env bash
# subcommand: owner — look up code ownership for a path
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
PATH_ARG="${*:-}"
if [ -z "$PATH_ARG" ]; then
  echo "Usage: wi-people owner <file-path-or-glob>"
  exit 1
fi
curl -sf "$BRIDGE/api/code-graph/owners?path=$PATH_ARG" | head -c 4000
echo "---"
curl -sf "$BRIDGE/api/code-graph/blast-radius?file=$PATH_ARG" | head -c 4000
