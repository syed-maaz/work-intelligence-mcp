#!/usr/bin/env bash
# skills/wi-storage-audit/run.sh — per-table storage audit via sqlite3 dbstat.
set -uo pipefail

DB="${DATABASE_PATH:-$HOME/.work-intelligence-mcp/data.db}"
[ -f "$DB" ] || { echo '{"error":"db not found","path":"'"$DB"'"}'; exit 1; }

# Get table list
TABLES=$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name;")

REPO="$(git rev-parse --show-toplevel)"

echo '{"tables":['
first=1
while IFS= read -r tbl; do
  [ -z "$tbl" ] && continue
  rows=$(sqlite3 "$DB" "SELECT COUNT(*) FROM \"$tbl\";" 2>/dev/null || echo 0)
  bytes=$(sqlite3 "$DB" "SELECT COALESCE(SUM(payload),0) FROM dbstat WHERE name='$tbl';" 2>/dev/null || echo 0)
  readers=$(grep -rn "FROM $tbl\b\|FROM \"$tbl\"" "$REPO/src" "$REPO/web-server.js" 2>/dev/null | wc -l | tr -d ' ')
  writers=$(grep -rn "INSERT INTO $tbl\b\|INSERT INTO \"$tbl\"\|INSERT OR\|UPDATE $tbl\b\|UPDATE \"$tbl\"" "$REPO/src" "$REPO/web-server.js" 2>/dev/null | grep -i "$tbl" | wc -l | tr -d ' ')
  live=true
  [ "$readers" -eq 0 ] && [ "$rows" -gt 0 ] && live=false
  [ "$first" -eq 0 ] && echo ','
  printf '{"name":"%s","rows":%s,"bytes":%s,"readers":%s,"writers":%s,"live":%s}' \
    "$tbl" "$rows" "$bytes" "$readers" "$writers" "$live"
  first=0
done <<< "$TABLES"
echo ']}'
