#!/usr/bin/env bash
# subcommand: resolve-all — trigger BugResolverAgent on proposed bugs
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
SEVERITY=""
SOURCE_FILTER=""
CAP=10
while [ $# -gt 0 ]; do
  case "$1" in
    --severity) SEVERITY="$2"; shift 2 ;;
    --source) SOURCE_FILTER="$2"; shift 2 ;;
    --cap) CAP="$2"; shift 2 ;;
    --help) echo "Usage: wi-bug resolve-all [--severity low|medium|high] [--source <val>] [--cap N]"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done
PROPOSED=$(curl -sf "$BRIDGE/api/bugs?status=proposed" 2>/dev/null || echo "[]")
echo "{\"subcommand\":\"resolve-all\",\"proposed_bugs\":$PROPOSED,\"note\":\"Run via wi-bug resolve-all on bridge at $BRIDGE\"}"
