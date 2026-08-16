#!/usr/bin/env bash
# subcommand: todo — list vault notes needing annotation
set -euo pipefail
VAULT=$(grep -E '^OBSIDIAN_VAULT_PATH=' .env 2>/dev/null | cut -d= -f2- || echo "${OBSIDIAN_VAULT_PATH:-}")
[ -z "$VAULT" ] && { echo "OBSIDIAN_VAULT_PATH not set."; exit 1; }
[ -d "$VAULT" ] || { echo "Vault dir missing: $VAULT"; exit 1; }
DAYS="${1:-7}"

find "$VAULT" -name '*.md' -not -name '_*' -mtime -"$DAYS" 2>/dev/null | while read -r f; do
  grep -ql 'USER ANNOTATIONS BELOW' "$f" || continue
  below=$(awk '/USER ANNOTATIONS BELOW/{flag=1;next} flag' "$f" | grep -cv '^[[:space:]]*$')
  [ "$below" -eq 0 ] || continue
  mt=$(stat -f '%m' "$f" 2>/dev/null || stat -c '%Y' "$f" 2>/dev/null)
  [ -n "$mt" ] && printf '%s\t%s\n' "$mt" "${f#"$VAULT"/}"
done | sort -rn | cut -f2- | head -8