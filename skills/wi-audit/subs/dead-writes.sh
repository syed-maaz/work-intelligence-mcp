#!/usr/bin/env bash
# skills/wi-dead-writes/run.sh — tables with writers but no readers (dead-write candidates).
set -uo pipefail

DB="${DATABASE_PATH:-$HOME/.work-intelligence-mcp/data.db}"
[ -f "$DB" ] || { echo '[]'; exit 1; }

REPO="$(git rev-parse --show-toplevel)"

TABLES=$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name;")

dead=()
while IFS= read -r tbl; do
  [ -z "$tbl" ] && continue
  rows=$(sqlite3 "$DB" "SELECT COUNT(*) FROM \"$tbl\";" 2>/dev/null || echo 0)
  [ "$rows" -eq 0 ] && continue
  readers=$(grep -rn "FROM $tbl\b\|FROM \"$tbl\"" "$REPO/src" "$REPO/web-server.js" 2>/dev/null | wc -l | tr -d ' ')
  writers=$(grep -rn "INSERT INTO $tbl\b\|INSERT INTO \"$tbl\"\|INSERT OR.*$tbl\|UPDATE $tbl\b\|UPDATE \"$tbl\"" "$REPO/src" "$REPO/web-server.js" 2>/dev/null | grep -i "$tbl" | wc -l | tr -d ' ')
  [ "$writers" -gt 0 ] && [ "$readers" -eq 0 ] && dead+=("$tbl")
done <<< "$TABLES"

echo '['
first=1
for t in "${dead[@]}"; do
  [ "$first" -eq 0 ] && echo ','
  printf '"%s"' "$t"
  first=0
done
echo ']'
