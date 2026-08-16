#!/usr/bin/env bash
# subcommand: report — capture a bug via bridge API
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
SOURCE="agent"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --help) echo "Usage: wi-bug report [--source <val>] <error_name> <message>"; exit 0 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
ERROR_NAME="${ARGS[0]:-}"
MESSAGE="${ARGS[*]:1}"
if [ -z "$ERROR_NAME" ]; then
  echo '{"error":"missing required argument: error_name"}'
  exit 1
fi
curl -s -X POST "$BRIDGE/api/bugs/report" \
  -H "Content-Type: application/json" \
  -d "{\"source\":\"$SOURCE\",\"errorName\":\"$ERROR_NAME\",\"message\":\"$MESSAGE\"}"
