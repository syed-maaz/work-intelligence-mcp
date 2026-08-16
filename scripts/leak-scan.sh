#!/usr/bin/env bash
# Scan ALL files (ignore .git + node_modules + release scratch only). Case-insensitive.
# Exit 1 on any hit not on the path-allowlist.
set -uo pipefail
command -v rg >/dev/null 2>&1 || { echo "SCANNER ERROR: rg not found (brew install ripgrep)"; exit 2; }
[ -f scripts/leak-allow.txt ] || { echo "MISSING scripts/leak-allow.txt"; exit 2; }
scan() { rg -n -i --no-ignore --hidden \
     --glob '!.git' --glob '!node_modules' --glob '!.wi-release' --glob '!.claude/worktrees' \
     --glob '!.planning' --glob '!.codex' --glob '!.hermes' --glob '!.env' \
     --glob '!ARCHITECTURE.md' --glob '!CYPHER.md' \
     --glob '!scripts/leak-*.txt' \
     -f "$1" .; }
hits=$( { scan scripts/leak-patterns.txt; scan scripts/leak-names.txt; } 2> >(grep -v '^$' >&2) | rg -v -f scripts/leak-allow.txt || true)
# v6: never swallow scan errors — a malformed pattern or rg failure must NOT read as CLEAN
if rg --no-messages -f scripts/leak-patterns.txt /dev/null 2>/dev/null; then [ ${PIPESTATUS[0]:-0} -ne 0 ] && { echo "SCANNER ERROR (see stderr)"; exit 2; }; fi
if [ -n "$hits" ]; then echo "LEAK SCAN FAILED:"; echo "$hits"; exit 1; fi
echo "LEAK SCAN CLEAN"; exit 0