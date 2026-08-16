#!/usr/bin/env bash
# scripts/adr-039-dogfood-check.sh — ADR-039 AC-19 measurement runner.
#
# Runs the four AC-19 threshold queries against ~/.work-intelligence-mcp/data.db
# and prints PASS / FAIL per threshold plus the raw numbers behind each call.
#
# Usage:
#   bash scripts/adr-039-dogfood-check.sh                   # default 14d window ending today
#   bash scripts/adr-039-dogfood-check.sh 2026-06-29        # 14d window starting from given date
#   bash scripts/adr-039-dogfood-check.sh 2026-06-29 7      # 7d window from given date
#
# Exit codes:
#   0 — all four thresholds met (verdict: green-merge)
#   1 — at least one threshold below target (verdict: mixed-extend or red-rollback)
#
# Append the output to .planning/cypher/adr-039-dogfood-rolling.md on every
# run during the dogfood window. The final read on day 14 informs the
# decision artifact .planning/cypher/adr-039-dogfood-result.md.

set -euo pipefail

DB="${HOME}/.work-intelligence-mcp/data.db"
if [ ! -f "$DB" ]; then
  echo "ERROR: WI database not found at $DB" >&2
  exit 2
fi

START_DATE="${1:-}"
WINDOW_DAYS="${2:-14}"

# Default: window ends today, starts (WINDOW_DAYS - 1) days ago.
if [ -z "$START_DATE" ]; then
  START_DATE=$(date -v-"$((WINDOW_DAYS - 1))"d +%Y-%m-%d 2>/dev/null || date -d "${WINDOW_DAYS} days ago" +%Y-%m-%d)
fi
END_DATE=$(date -v+"$WINDOW_DAYS"d -j -f %Y-%m-%d "$START_DATE" +%Y-%m-%d 2>/dev/null \
  || date -d "$START_DATE + $WINDOW_DAYS days" +%Y-%m-%d)

# Convert YYYY-MM-DD to ISO datetime string for sqlite text-compare.
START_TS="${START_DATE}T00:00:00"
END_TS="${END_DATE}T00:00:00"

echo "═══════════════════════════════════════════════════"
echo "ADR-039 AC-19 dogfood check — $(date '+%Y-%m-%d %H:%M %Z')"
echo "Window: $START_DATE → $END_DATE  (${WINDOW_DAYS} days)"
echo "═══════════════════════════════════════════════════"

# AC-19 thresholds.
THRESH_DISPATCHES=20
THRESH_BRIEFS=15
THRESH_VERDICTS=10
THRESH_OPRO_REVISIONS=1

fails=0

run_q() {
  sqlite3 -separator '|' "$DB" "$1"
}

# ── Threshold 1: ≥20 /wi dispatches with CYPHER_REFINEMENT_ENABLED on ─────
# Approximation: count cypher_sessions rows in the window with scope_iters > 0
# (only refinement-enabled dispatches enter the SCOPE phase, which is the
# only path that increments scope_iters above NULL/0). The handful of
# explicit phase='scope' tests that fire scope_iters in test DBs don't
# touch the live DB.
DISPATCHES=$(run_q "
  SELECT COUNT(*) FROM cypher_sessions
  WHERE scope_iters > 0
    AND started_at >= '$START_TS'
    AND started_at <  '$END_TS'
")
echo ""
echo "1. Refinement-enabled dispatches in window: $DISPATCHES (threshold ≥${THRESH_DISPATCHES})"
if [ "$DISPATCHES" -ge "$THRESH_DISPATCHES" ]; then
  echo "   ✓ PASS"
else
  echo "   ✗ FAIL — need $((THRESH_DISPATCHES - DISPATCHES)) more"
  fails=$((fails + 1))
fi

# ── Threshold 2: ≥15 of those emit a refined_goal row ────────────────────
BRIEFS=$(run_q "
  SELECT COUNT(*) FROM cypher_sessions
  WHERE refined_goal IS NOT NULL
    AND started_at >= '$START_TS'
    AND started_at <  '$END_TS'
")
echo ""
echo "2. Dispatches with a refined_goal brief: $BRIEFS (threshold ≥${THRESH_BRIEFS})"
if [ "$BRIEFS" -ge "$THRESH_BRIEFS" ]; then
  echo "   ✓ PASS"
else
  echo "   ✗ FAIL — need $((THRESH_BRIEFS - BRIEFS)) more"
  fails=$((fails + 1))
fi

# Coverage rate (for context — not a hard threshold).
if [ "$DISPATCHES" -gt 0 ]; then
  PCT=$(( (BRIEFS * 100) / DISPATCHES ))
  echo "   (coverage: ${PCT}% of dispatches produced a brief)"
fi

# ── Threshold 3: user_verdict captured on ≥10 refinement dispatches ──────
# Joins prompt_outcomes back to cypher_sessions via the v88 session_id FK.
# Only counts rows where user_verdict is not the default 'unrated'.
VERDICTS=$(run_q "
  SELECT COUNT(DISTINCT po.session_id) FROM prompt_outcomes po
  JOIN cypher_sessions cs ON cs.session_id = po.session_id
  WHERE po.session_id IS NOT NULL
    AND po.user_verdict IS NOT NULL
    AND po.user_verdict != 'unrated'
    AND cs.started_at >= '$START_TS'
    AND cs.started_at <  '$END_TS'
")
echo ""
echo "3. User verdicts on refinement dispatches: $VERDICTS (threshold ≥${THRESH_VERDICTS})"
if [ "$VERDICTS" -ge "$THRESH_VERDICTS" ]; then
  echo "   ✓ PASS"
else
  echo "   ✗ FAIL — need $((THRESH_VERDICTS - VERDICTS)) more"
  fails=$((fails + 1))
fi

# Verdict breakdown (for context).
if [ "$VERDICTS" -gt 0 ]; then
  echo "   Breakdown:"
  run_q "
    SELECT '   - ' || user_verdict || ': ' || COUNT(*)
    FROM prompt_outcomes po
    JOIN cypher_sessions cs ON cs.session_id = po.session_id
    WHERE po.user_verdict IS NOT NULL
      AND po.user_verdict != 'unrated'
      AND cs.started_at >= '$START_TS'
      AND cs.started_at <  '$END_TS'
    GROUP BY user_verdict
    ORDER BY COUNT(*) DESC
  "
fi

# ── Threshold 4: ≥1 OPRO-mutated goal_refinement template revision ──────
OPRO_REVS=$(run_q "
  SELECT COUNT(*) FROM prompt_templates
  WHERE trigger_type = 'goal_refinement'
    AND evolution_source != 'manual'
")
echo ""
echo "4. OPRO-evolved goal_refinement templates: $OPRO_REVS (threshold ≥${THRESH_OPRO_REVISIONS})"
if [ "$OPRO_REVS" -ge "$THRESH_OPRO_REVISIONS" ]; then
  echo "   ✓ PASS"
else
  echo "   ✗ FAIL — need $((THRESH_OPRO_REVISIONS - OPRO_REVS)) more"
  fails=$((fails + 1))
fi

# Show goal_refinement template inventory (for context).
TEMPLATE_COUNT=$(run_q "SELECT COUNT(*) FROM prompt_templates WHERE trigger_type = 'goal_refinement'")
echo "   (goal_refinement template inventory: $TEMPLATE_COUNT total rows)"
if [ "$TEMPLATE_COUNT" -gt 0 ]; then
  run_q "
    SELECT '   - v' || version || ' (' || evolution_source || ', invoked ' || invocation_count || 'x, eff=' || ROUND(effectiveness_score, 2) || ', active=' || is_active || ')'
    FROM prompt_templates
    WHERE trigger_type = 'goal_refinement'
    ORDER BY version
  "
fi

# ── AC-19a context: per-phase token telemetry (v89) ─────────────────────
# Informational — not a hard threshold. Surfaces the median + p90 of
# scope_phase_tokens / total_dispatch_tokens across refinement-enabled
# dispatches in the window. Below ~25% says SCOPE is cheap (good);
# above ~50% says SCOPE is dominating dispatch cost (worth reviewing
# the refiner prompt for chattiness).
echo ""
echo "5. (AC-19a info) Per-phase token spend ratio:"
PHASE_STATS=$(run_q "
  SELECT
    COUNT(DISTINCT cs.session_id) AS dispatches_with_phase_data,
    SUM(CASE WHEN cs.phase='scope' THEN cs.tokens_used ELSE 0 END) AS total_scope,
    SUM(CASE WHEN cs.phase='execute' THEN cs.tokens_used ELSE 0 END) AS total_execute,
    SUM(cs.tokens_used) AS total_tagged
  FROM cypher_steps cs
  JOIN cypher_sessions sess ON sess.session_id = cs.session_id
  WHERE cs.phase IS NOT NULL
    AND sess.started_at >= '$START_TS'
    AND sess.started_at <  '$END_TS'
")
if [ -n "$PHASE_STATS" ]; then
  DISPATCHES_PHASED=$(printf "%s" "$PHASE_STATS" | cut -d'|' -f1)
  TOTAL_SCOPE=$(printf "%s" "$PHASE_STATS" | cut -d'|' -f2)
  TOTAL_EXECUTE=$(printf "%s" "$PHASE_STATS" | cut -d'|' -f3)
  TOTAL_TAGGED=$(printf "%s" "$PHASE_STATS" | cut -d'|' -f4)
  echo "   Dispatches with phase-tagged steps: $DISPATCHES_PHASED"
  echo "   Total scope-phase tokens:   ${TOTAL_SCOPE:-0}"
  echo "   Total execute-phase tokens: ${TOTAL_EXECUTE:-0}"
  if [ -n "$TOTAL_TAGGED" ] && [ "$TOTAL_TAGGED" -gt 0 ]; then
    SCOPE_PCT=$(( (TOTAL_SCOPE * 100) / TOTAL_TAGGED ))
    echo "   Aggregate scope share: ${SCOPE_PCT}% of phase-tagged tokens"
  fi
fi

echo ""
echo "═══════════════════════════════════════════════════"
if [ "$fails" -eq 0 ]; then
  echo "VERDICT: green-merge (all 4 thresholds met)"
  exit 0
else
  echo "VERDICT: in-progress ($fails of 4 thresholds short)"
  echo "  Final-window decision per dogfood doc:"
  echo "    - 0 fails  → green-merge"
  echo "    - 1-2 fails → mixed-extend (run another week)"
  echo "    - 3-4 fails → red-rollback (CYPHER_REFINEMENT_ENABLED=0)"
  echo "═══════════════════════════════════════════════════"
  exit 1
fi
