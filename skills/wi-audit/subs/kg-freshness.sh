#!/usr/bin/env bash
# skills/wi-kg-freshness/run.sh — KG and brain outcome freshness report.
set -uo pipefail

DB="${DATABASE_PATH:-$HOME/.work-intelligence-mcp/data.db}"
[ -f "$DB" ] || { echo '{"kg_last_write":null,"correlation_dispatch_count":0,"cypher_outcomes_by_verdict":{}}'; exit 1; }

# KG last write — palace lives in ChromaDB; use fetch_runs as proxy for last sync activity.
# Fallback to cypher_sessions MAX(started_at) if fetch_runs has no rows.
kg_last=$(sqlite3 "$DB" "SELECT MAX(completed_at) FROM fetch_runs;" 2>/dev/null || echo "")
if [ -z "$kg_last" ] || [ "$kg_last" = "null" ]; then
  kg_last=$(sqlite3 "$DB" "SELECT MAX(started_at) FROM cypher_sessions;" 2>/dev/null || echo "")
fi

# Cypher dispatch count (correlation proxy)
dispatch_count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM cypher_sessions;" 2>/dev/null || echo 0)
[ -z "$dispatch_count" ] && dispatch_count=0

# Brain outcomes by verdict (W-1: renamed from brain_outcomes_by_status)
outcomes_json=$(sqlite3 "$DB" \
  "SELECT json_group_object(COALESCE(outcome,'unknown'), cnt) FROM (SELECT outcome, COUNT(*) as cnt FROM cypher_outcomes GROUP BY outcome);" \
  2>/dev/null || echo "")
[ -z "$outcomes_json" ] && outcomes_json="{}"

# W-2: safe quoting for kg_last
if [ "$kg_last" = "" ] || [ "$kg_last" = "null" ]; then
  kg_last_json="null"
else
  kg_last_json="\"$kg_last\""
fi
printf '{"kg_last_write":%s,"correlation_dispatch_count":%s,"cypher_outcomes_by_verdict":%s}\n' "$kg_last_json" "$dispatch_count" "$outcomes_json"
