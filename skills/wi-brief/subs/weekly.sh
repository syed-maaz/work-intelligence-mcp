#!/usr/bin/env bash
# subcommand: weekly — weekly engineering report
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
PROJECT=""
WEEK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --week) WEEK="$2"; shift 2 ;;
    *) echo "Usage: wi-brief weekly [--project KEY] [--week YYYY-WNN]"; exit 1 ;;
  esac
done
URL="$BRIDGE/api/weekly-report?project=${PROJECT:-BDS}"
curl -sf "$URL" | head -c 10000
