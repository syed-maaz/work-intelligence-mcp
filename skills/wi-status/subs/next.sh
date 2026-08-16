#!/usr/bin/env bash
# subcommand: next — list pending work items
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
LIMIT="${1:-5}"
case "$LIMIT" in
  ''|*[!0-9]*) LIMIT=5 ;;
esac
[ "$LIMIT" -lt 1 ] 2>/dev/null && LIMIT=1
[ "$LIMIT" -gt 50 ] 2>/dev/null && LIMIT=50
RESP=$(curl -fsS "$BRIDGE/api/cypher/pm/next?limit=$LIMIT" 2>/dev/null) || { echo "error: bridge unreachable at $BRIDGE/api/cypher/pm/next"; exit 0; }
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
items = d.get('items', [])
total = d.get('total', len(items))
if not items:
  print('  (queue empty — no pending unblocked items)')
else:
  print(f'Top {len(items)} of {total} pending unblocked work items (priority asc):')
  print()
  for i in items:
    wave = i.get('wave') or '-'
    smoke = i.get('smoke_section') or '-'
    print(f\"  p{i['priority']}  {i['phase']:25}  {wave:18}  {i['id']:25}  {smoke}\")
    title = i.get('title','')[:80]
    print(f'       └─ {title}')
"
