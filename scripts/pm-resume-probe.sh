#!/usr/bin/env bash
# scripts/pm-resume-probe.sh — Minimal live-bridge probe for ADR-053 pm-resume
# Requires: ADR_053_ENABLED=1 bridge running on BRIDGE_URL (default http://localhost:3132)
# Seeds a couple of sub_task_events for a dummy sub_task_id, then POSTs /api/wi/resume
# Prints HTTP code and JSON body; exits 0 on 200 with resolved>=1.

set -euo pipefail
BRIDGE_URL="${BRIDGE_URL:-http://localhost:3132}"
WI_DB_PATH="${WI_DB_PATH:-$HOME/.work-intelligence-mcp/data.db}"
SUBTASK_ID="${1:-smk_resume_subtask}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 not found on PATH" >&2
  exit 2
fi

if [ ! -r "$WI_DB_PATH" ]; then
  echo "WI_DB_PATH not readable: $WI_DB_PATH" >&2
  exit 2
fi

# Seed two events: a question and a blocker
sqlite3 "$WI_DB_PATH" <<SQL
INSERT INTO sub_task_events(sub_task_id, kind, payload_json) VALUES ('$SUBTASK_ID', 'question', '{"q":"?"}');
INSERT INTO sub_task_events(sub_task_id, kind, payload_json) VALUES ('$SUBTASK_ID', 'blocker', '{"b":"!"}');
SQL

# Call resume
HTTP_CODE=$(curl -s -o /tmp/pm_resume_probe.json -w '%{http_code}' -X POST "$BRIDGE_URL/api/wi/resume" \
  -H 'Content-Type: application/json' \
  -d "{\"sub_task_id\":\"$SUBTASK_ID\"}")

BODY=$(cat /tmp/pm_resume_probe.json)

echo "HTTP $HTTP_CODE"
printf "%s\n" "$BODY"

if [ "$HTTP_CODE" = "200" ]; then
  RESOLVED=$(printf "%s" "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('resolved',0))" 2>/dev/null || echo 0)
  if [ "$RESOLVED" -ge 1 ]; then
    exit 0
  fi
fi
exit 1
