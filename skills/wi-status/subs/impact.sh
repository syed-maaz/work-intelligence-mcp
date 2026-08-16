#!/usr/bin/env bash
# subcommand: impact — list work items touching a file
set -euo pipefail
BRIDGE="${WI_BRIDGE_URL:-http://localhost:3132}"
FILE_PATH="${1:-}"
[ -z "$FILE_PATH" ] && { echo "Usage: wi-status impact <file-path>"; exit 1; }
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")
RESP=$(curl -fsS "$BRIDGE/api/cypher/pm/impact?kind=file_path&value=$ENCODED" 2>/dev/null) || { echo "error: bridge unreachable at $BRIDGE/api/cypher/pm/impact"; exit 0; }
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
items = d.get('items', [])
if not items:
  print(f'  (no work items reference \"$FILE_PATH\")')
else:
  print(f'{len(items)} work item(s) reference $FILE_PATH:')
  print()
  for i in items:
    print(f\"  [{i['status']:11}]  {i['id']:25}  {i.get('title','')[:60]}\")
"
