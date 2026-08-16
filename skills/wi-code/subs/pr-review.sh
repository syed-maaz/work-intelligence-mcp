#!/usr/bin/env bash
# subcommand: pr-review — AI-assisted PR review with work context
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
PR_URL="${1:-}"
[ -z "$PR_URL" ] && { echo "Usage: wi-code pr-review <PR-URL>"; exit 1; }
curl -sf -X POST "$BRIDGE/api/pr/enrich" -H "Content-Type: application/json" -d "{\"prUrl\":\"$PR_URL\"}" | head -c 6000
