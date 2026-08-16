#!/usr/bin/env bash
# subcommand: blast-radius — calculate blast radius of a file change or PR
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
TARGET="${1:-}"
[ -z "$TARGET" ] && { echo "Usage: wi-code blast-radius <file-path> | <PR-URL>"; exit 1; }
curl -sf "$BRIDGE/api/code-graph/blast-radius?file=$TARGET" | head -c 3000
