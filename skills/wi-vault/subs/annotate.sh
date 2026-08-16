#!/usr/bin/env bash
# subcommand: annotate — open an Obsidian vault note for annotation
set -euo pipefail
VAULT=$(grep -E '^OBSIDIAN_VAULT_PATH=' .env 2>/dev/null | cut -d= -f2- || echo "${OBSIDIAN_VAULT_PATH:-}")
[ -z "$VAULT" ] && { echo "OBSIDIAN_VAULT_PATH not set — cannot annotate."; exit 1; }
[ -d "$VAULT" ] || { echo "Vault dir missing: $VAULT"; exit 1; }
NAME="${1:-}"
[ -z "$NAME" ] && { echo "Usage: wi-vault annotate <topic|person|cluster name> | list"; exit 1; }

if [ "$NAME" = "list" ]; then
  find "$VAULT" -name '*.md' -not -name '_*' | while read -r f; do
    grep -ql 'USER ANNOTATIONS BELOW' "$f" && echo "${f#"$VAULT"/}"
  done | sort
  exit 0
fi

FILE="$VAULT/$NAME.md"
[ ! -f "$FILE" ] && FILE="$VAULT/people/$NAME.md"
[ ! -f "$FILE" ] && FILE=$(find "$VAULT" -name "*$NAME*" -not -name '_*' 2>/dev/null | head -1)
[ -z "$FILE" ] && { echo "No vault note found for: $NAME"; exit 1; }

grep -q 'USER ANNOTATIONS BELOW' "$FILE" || { echo "No annotation zone in $FILE — stopping."; exit 1; }

DATE=$(date +%Y-%m-%d)
grep -q "^### $DATE" "$FILE" || printf '\n### %s — note\n\n' "$DATE" >> "$FILE"

STATUS=$(awk '/^## Current Status/{f=1;next} /^## /{f=0} /USER ANNOTATIONS BELOW/{f=0} f' "$FILE" | head -8)
echo "── machine Current Status ──"
echo "$STATUS"
echo "── Opening: $FILE ──"
${EDITOR:-nano} "$FILE"
