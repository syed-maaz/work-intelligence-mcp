#!/usr/bin/env bash
# skills/wi-merge-discipline/run.sh — pre-merge readiness checklist.
set -uo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo ".")"
cd "$REPO"

pass=0
fail=0
items=()

check() {
  local label="$1" ok="$2" detail="$3"
  if [ "$ok" = "1" ]; then
    items+=("✓ $label: $detail")
    pass=$((pass+1))
  else
    items+=("✗ $label: $detail")
    fail=$((fail+1))
  fi
}

# 1. Working tree clean
dirty=$(git status --porcelain | wc -l | tr -d ' ')
check "clean tree" "$([ "$dirty" -eq 0 ] && echo 1 || echo 0)" "$dirty uncommitted file(s)"

# 2. Stash list
stashes=$(git stash list 2>/dev/null | wc -l | tr -d ' ')
check "no stashes" "$([ "$stashes" -eq 0 ] && echo 1 || echo 0)" "$stashes stash(es) pending"

# 3. Commits ahead of master
base="master"
git rev-parse "$base" &>/dev/null || base="main"
ahead=$(git log "$base"..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')
check "commits staged" "$([ "$ahead" -gt 0 ] && echo 1 || echo 0)" "$ahead commit(s) ahead of $base"

# 4. Build (300s timeout)
if timeout 300 npm run build &>/dev/null 2>&1; then
  check "build" "1" "ok"
else
  check "build" "0" "failed or timed out"
fi

# 5. Typecheck
if timeout 120 npm run typecheck &>/dev/null 2>&1; then
  check "typecheck" "1" "ok"
else
  check "typecheck" "0" "errors found"
fi

# 6. Tests (vitest)
if timeout 120 npx vitest run --reporter=verbose &>/dev/null 2>&1; then
  check "vitest" "1" "ok"
else
  check "vitest" "0" "failures or timeout"
fi

echo "# wi-merge-discipline checklist"
for item in "${items[@]}"; do echo "  $item"; done
echo ""
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ] && exit 0 || exit 1
