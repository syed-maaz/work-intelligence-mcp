#!/usr/bin/env bash
# subcommand: analyze — composed analyze-stage audit.
set -uo pipefail
REPO="$(git rev-parse --show-toplevel)"

storage=$(bash "$REPO/skills/wi-audit/subs/storage.sh" 2>/dev/null) || storage='null'
dead=$(bash "$REPO/skills/wi-audit/subs/dead-writes.sh" 2>/dev/null) || dead='null'
kg=$(bash "$REPO/skills/wi-audit/subs/kg-freshness.sh" 2>/dev/null) || kg='null'

printf '{"storage_audit":%s,"dead_writes":%s,"kg_freshness":%s}\n' "$storage" "$dead" "$kg"

[ "$storage" = "null" ] && [ "$dead" = "null" ] && [ "$kg" = "null" ] && exit 1
exit 0
