#!/usr/bin/env bash
# scripts/wi-opro-dry-run.sh — ADR-039 AC-13 verification harness.
#
# Prints the closed list of TriggerType values the nightly OPRO sweep
# iterates, asserts `goal_refinement` is in that list, and (with the live
# DB) prints which goal_refinement templates exist + their evolution
# source so you can see whether OPRO has produced revisions yet.
#
# No Anthropic API call — this is a pure introspection script. Use it to
# answer "is the OPRO machinery actually wired to iterate
# goal_refinement?" without waiting for an OPRO cycle or burning tokens.
#
# Usage:
#   npm run wi:opro:dry-run
#
# Exit codes:
#   0 — goal_refinement is in OPRO_SWEEP_TRIGGER_TYPES
#   1 — goal_refinement is NOT in the list (AC-13 regression)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${HOME}/.work-intelligence-mcp/data.db"

# Build dist/ first so the .js imports resolve.
if [ ! -f "${REPO_ROOT}/dist/intelligence/prompt-evolution-jobs.js" ]; then
  echo "dist/ not built yet — running npm run build…"
  (cd "$REPO_ROOT" && npm run build) >/dev/null
fi

echo "═══════════════════════════════════════════════════"
echo "ADR-039 AC-13 OPRO dry-run — $(date '+%Y-%m-%d %H:%M %Z')"
echo "═══════════════════════════════════════════════════"

# Probe the dist module to print the closed list and check membership.
RESULT=$(node --env-file="${REPO_ROOT}/.env" -e "
import('${REPO_ROOT}/dist/intelligence/prompt-evolution-jobs.js').then(({ OPRO_SWEEP_TRIGGER_TYPES }) => {
  console.log('TriggerType values OPRO sweep iterates:');
  for (const t of OPRO_SWEEP_TRIGGER_TYPES) {
    const marker = t === 'goal_refinement' ? ' ← (AC-13 target)' : '';
    console.log('  - ' + t + marker);
  }
  const has = OPRO_SWEEP_TRIGGER_TYPES.includes('goal_refinement');
  console.log('');
  console.log('AC-13 assertion: goal_refinement in sweep list → ' + (has ? 'YES' : 'NO'));
  process.exit(has ? 0 : 1);
}).catch(e => { console.error('THROW:' + e.message); process.exit(2); });
" 2>&1)
NODE_EXIT=$?

echo "$RESULT"
echo ""

# If the live DB exists, also surface the goal_refinement template inventory.
if [ -f "$DB" ]; then
  echo "─── goal_refinement template inventory (live DB) ─────"
  TEMPLATES=$(sqlite3 -separator '|' "$DB" "
    SELECT id, version, evolution_source, invocation_count, is_active
    FROM prompt_templates
    WHERE trigger_type = 'goal_refinement'
    ORDER BY version
  ")
  if [ -z "$TEMPLATES" ]; then
    echo "  (none yet — seedTemplatesIfEmpty has not inserted the v1 seed)"
  else
    echo "$TEMPLATES" | awk -F'|' '{
      printf "  id=%-3s v=%-2s source=%-10s invocations=%-3s active=%s\n", $1, $2, $3, $4, $5
    }'
  fi
fi

echo ""
echo "═══════════════════════════════════════════════════"
if [ "$NODE_EXIT" -eq 0 ]; then
  echo "VERDICT: AC-13 satisfied — goal_refinement IS in OPRO sweep"
else
  echo "VERDICT: AC-13 REGRESSION — goal_refinement missing from sweep"
fi
echo "═══════════════════════════════════════════════════"

exit $NODE_EXIT
