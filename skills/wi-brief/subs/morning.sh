#!/usr/bin/env bash
# subcommand: morning — generate morning briefing
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
curl -sf "$BRIDGE/api/morning-brief" | head -c 6000
echo "---"
curl -sf "$BRIDGE/api/calendar/upcoming" | head -c 4000
echo "---"
curl -sf "$BRIDGE/api/jira/my-issues" | head -c 4000
