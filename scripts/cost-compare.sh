#!/usr/bin/env bash
# scripts/cost-compare.sh — instant cost-comparison chart
#
# Runs against the live ~/.work-intelligence-mcp/data.db. Prints:
#   1. Top 15 methods by total spend (last 30 days)
#   2. Daily cost trend with ASCII bar chart (last 14 days)
#   3. Loop vs pipeline dispatch counts by day (last 14 days)
#
# Usage:
#   bash scripts/cost-compare.sh
#
# No deps beyond sqlite3 + awk + standard shell — runs anywhere.

set -u
DB="${WI_DB:-${HOME}/.work-intelligence-mcp/data.db}"
if [ ! -f "$DB" ]; then
  echo "FATAL: DB not found at $DB" >&2
  exit 1
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  COST COMPARISON — last 30 days"
echo "  Source: ${DB}"
echo "═══════════════════════════════════════════════════════════════"
echo

echo "── 1. Cost by Anthropic METHOD (top 15 by total spend) ────────"
sqlite3 "$DB" <<'SQL'
.headers on
.mode column
SELECT
  method,
  COUNT(*) AS calls,
  printf('$%.4f', SUM(cost_usd)) AS total_cost,
  printf('$%.5f', AVG(cost_usd)) AS avg_call,
  printf('%dk', SUM(input_tokens) / 1000) AS in_tokens,
  printf('%dk', SUM(output_tokens) / 1000) AS out_tokens
FROM token_usage
WHERE recorded_at > datetime('now', '-30 days')
GROUP BY method
ORDER BY SUM(cost_usd) DESC
LIMIT 15;
SQL

echo
echo "── 2. Daily cost trend (last 14 days, ASCII bar chart) ─────────"
echo "       (each block = ~2.5% of the largest day)"
sqlite3 "$DB" -separator '|' <<'SQL' | awk -F'|' '
  NR==1 { next }
  { v[NR] = $2 + 0; day[NR] = $1; if (v[NR] > max) max = v[NR] }
  END {
    for (i = 2; i <= NR; i++) {
      bar = ""
      width = (max > 0) ? int(v[i] / max * 40) : 0
      for (j = 0; j < width; j++) bar = bar "█"
      printf "  %s  $%7.4f  %s\n", day[i], v[i], bar
    }
  }
'
SELECT
  date(recorded_at) AS day,
  SUM(cost_usd) AS cost
FROM token_usage
WHERE recorded_at > datetime('now', '-14 days')
GROUP BY date(recorded_at)
ORDER BY day;
SQL

echo
echo "── 3. Dispatch counts by day (cypher_sessions, last 14 days) ───"
sqlite3 "$DB" <<'SQL'
.headers on
.mode column
SELECT
  date(started_at) AS day,
  COUNT(*) AS total,
  SUM(CASE WHEN engine = 'loop'     THEN 1 ELSE 0 END) AS loop_n,
  SUM(CASE WHEN engine != 'loop' OR engine IS NULL THEN 1 ELSE 0 END) AS legacy_n
FROM cypher_sessions
WHERE started_at > datetime('now', '-14 days')
GROUP BY date(started_at)
ORDER BY day DESC
LIMIT 14;
SQL

echo
echo "── 4. ADR-037 LOOP dispatches — outcome distribution ───────────"
sqlite3 "$DB" <<'SQL'
.headers on
.mode column
SELECT
  COALESCE(outcome, '(open)') AS outcome,
  COUNT(*) AS dispatches,
  printf('%.1fs', AVG(duration_ms) / 1000.0) AS avg_duration,
  printf('%.0fk', AVG(total_tokens) / 1000.0) AS avg_tokens
FROM cypher_sessions
WHERE engine = 'loop'
GROUP BY outcome
ORDER BY dispatches DESC;
SQL

echo
echo "── 5. v1.4 BASELINE (anchor) vs PHASE 5 SOAK (since 2026-06-23) "
sqlite3 "$DB" <<'SQL'
.headers on
.mode column
SELECT
  'v1.4 baseline (pre-2026-06-23)' AS window,
  COUNT(*) AS dispatches,
  printf('$%.4f', SUM(cost_usd)) AS total_cost,
  printf('$%.5f', AVG(cost_usd)) AS avg_per_call
FROM token_usage
WHERE recorded_at BETWEEN datetime('now', '-30 days') AND '2026-06-23'

UNION ALL

SELECT
  'Phase 5 soak (2026-06-23+)' AS window,
  COUNT(*) AS dispatches,
  printf('$%.4f', SUM(cost_usd)) AS total_cost,
  printf('$%.5f', AVG(cost_usd)) AS avg_per_call
FROM token_usage
WHERE recorded_at >= '2026-06-23';
SQL

echo
echo "═══════════════════════════════════════════════════════════════"
echo "Run this script any time during Phase 5 to track soak progress."
echo "Save snapshots: bash scripts/cost-compare.sh > snapshots/day-N.txt"
echo "═══════════════════════════════════════════════════════════════"
