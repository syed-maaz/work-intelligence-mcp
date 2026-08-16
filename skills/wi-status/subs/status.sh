#!/usr/bin/env bash
# subcommand: status — show work item status by ID
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
AC_ID="${1:-}"
[ -z "$AC_ID" ] && { echo "Usage: wi-status status <work-item-id>"; exit 1; }
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$AC_ID" 2>/dev/null || echo "$AC_ID")
RESP_CODE=$(curl -s -o /tmp/wi-status-resp.json -w '%{http_code}' "$BRIDGE/api/cypher/pm/status?id=$ENCODED" 2>/dev/null) || { echo "error: bridge unreachable"; exit 0; }
if [ "$RESP_CODE" = "404" ]; then echo "  no work item with id '$AC_ID' (404)"; exit 0; fi
if [ "$RESP_CODE" != "200" ]; then echo "error: bridge returned HTTP $RESP_CODE"; cat /tmp/wi-status-resp.json 2>/dev/null; echo; exit 0; fi
cat /tmp/wi-status-resp.json | python3 -c "
import json, sys
d = json.load(sys.stdin)
it = d.get('item', {})
ev = d.get('evidence', [])
print(f\"{it.get('id'):25}  status={it.get('status')}  priority={it.get('priority')}\")
print(f\"  phase: {it.get('phase')}    wave: {it.get('wave') or '-'}\")
print(f\"  title: {it.get('title','')}\")
if it.get('smoke_section'): print(f\"  smoke: {it['smoke_section']}\")
if it.get('depends_on') and it['depends_on'] != []: print(f\"  depends_on: {it['depends_on']}\")
if it.get('blocker_reason'): print(f\"  blocked: {it['blocker_reason']}\")
if it.get('shipped_at'): print(f\"  shipped_at: {it['shipped_at']}\")
if ev:
  print(); print(f\"  Evidence ({len(ev)} rows):\")
  for e in ev:
    note = f\" — {e.get('note')}\" if e.get('note') else ''
    print(f\"    [{e['evidence_kind']:18}]  {e['evidence_value']}{note}\")
else:
  print(); print('  (no evidence linked yet)')
"
