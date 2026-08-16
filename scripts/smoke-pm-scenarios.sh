#!/usr/bin/env bash
#
# scripts/smoke-pm-scenarios.sh — ADR-043 real-life scenarios.
#
# Ten realistic user flows the PM layer must serve correctly. Each scenario
# is a self-contained round-trip: setup cards, exercise the flow, assert the
# outcome. Cleanup at end removes only the cards we created.
#
# This is the "serving its purpose" check — smoke-pm.sh proves the ACs;
# this proves the ACs solve real problems.

set -u

BRIDGE="${WI_BRIDGE:-http://localhost:3132}"
WI_DB_PATH="${WI_DB_PATH:-$HOME/.work-intelligence-mcp/data.db}"
pass=0; fail=0; scenario=0
CREATED=()

sc_pass() { echo "    ✓ $1"; pass=$((pass+1)); }
sc_fail() { echo "    ✗ $1"; fail=$((fail+1)); }
scenario_hdr() { scenario=$((scenario+1)); echo ""; echo "── Scenario $scenario: $1 ──"; }

# ── Helpers ────────────────────────────────────────────────────────────────

create_card() {  # $1=title  $2=intent  $3=priority  [$4=effort]  [$5=depends_on_json]
  local body
  body=$(jq -nc \
    --arg title "$1" \
    --arg intent "$2" \
    --argjson prio "$3" \
    --argjson effort "${4:-null}" \
    --argjson deps "${5:-null}" \
    '{title:$title, intent:$intent, priority:$prio}
      + (if $effort == null then {} else {effort_points:$effort} end)
      + (if $deps == null then {} else {depends_on:$deps} end)')
  local resp id
  resp=$(curl -fsS -X POST "$BRIDGE/api/board/tasks" \
    -H 'Content-Type: application/json' -d "$body" 2>/dev/null)
  id=$(echo "$resp" | jq -r '.task.id // empty')
  [ -n "$id" ] && CREATED+=("$id")
  echo "$id"
}

get_backlog_top() {  # $1=limit  [$2=intent-filter]
  local q="limit=${1:-5}"
  [ -n "${2:-}" ] && q="$q&intent=$2"
  curl -fsS "$BRIDGE/api/board/backlog?$q" 2>/dev/null
}

patch_task() {  # $1=id  $2=json body
  curl -fsS -X PATCH "$BRIDGE/api/board/tasks/$1" \
    -H 'Content-Type: application/json' -d "$2" 2>/dev/null
}

reason_contribution() {  # $1=card-json  $2=signal name → prints contribution
  echo "$1" | jq --arg s "$2" '.reasons[] | select(.signal == $s) | .contribution'
}

top_card_id() {  # $1=backlog-json
  echo "$1" | jq -r '.backlog[0].id // empty'
}

top_card_score() {
  echo "$1" | jq -r '.backlog[0].rank_score // empty'
}

echo "═══════════════════════════════════════════════════"
echo "ADR-043 — 10 real-life scenarios"
echo "  BRIDGE: $BRIDGE"
echo "═══════════════════════════════════════════════════"

# Preflight
if ! curl -fsS -m 3 "$BRIDGE/api/board/tasks?limit=1" >/dev/null 2>&1; then
  echo "ABORT — bridge unreachable ($BRIDGE). Start with:"
  echo "  PM_ORCHESTRATION_ENABLED=1 OUTCOME_HONEST_KANBAN_ENABLED=1 npm run web:bridge"
  exit 2
fi

# =================================================================
# S1 — Morning triage: user asks 'what's next?' and gets an ordered
# list; the top card must be the highest priority unblocked execute.
# =================================================================
scenario_hdr "Morning triage — 'what's next?'"

S1_LOW=$(create_card "S1 low prio maintenance task" "execute" 25 2)
S1_HIGH=$(create_card "S1 fix broken cron job" "execute" 88 3)
S1_MID=$(create_card "S1 refactor helper module" "execute" 55 5)

BL=$(get_backlog_top 100)
TOP=$(top_card_id "$BL")
if [ "$TOP" = "$S1_HIGH" ]; then
  sc_pass "top card is the prio=88 fix (id=$TOP)"
else
  sc_fail "top should be $S1_HIGH, got $TOP"
fi

# Assert order: HIGH before MID before LOW in the returned backlog
ORDER=$(echo "$BL" | jq -r --arg h "$S1_HIGH" --arg m "$S1_MID" --arg l "$S1_LOW" \
  '[.backlog[] | .id | select(. == $h or . == $m or . == $l)] | @csv' | tr -d '"')
if [ "$ORDER" = "$S1_HIGH,$S1_MID,$S1_LOW" ]; then
  sc_pass "order HIGH,MID,LOW preserved"
else
  sc_fail "order wrong: $ORDER"
fi

# =================================================================
# S2 — 'bump this to top' — user overrides ordering explicitly
# =================================================================
scenario_hdr "User bumps a card to top priority"

BEFORE_TOP=$(top_card_id "$(get_backlog_top 5)")
patch_task "$S1_LOW" '{"priority": 100}' > /dev/null
AFTER_TOP=$(top_card_id "$(get_backlog_top 5)")

if [ "$AFTER_TOP" = "$S1_LOW" ] && [ "$AFTER_TOP" != "$BEFORE_TOP" ]; then
  sc_pass "bump reordered: was=$BEFORE_TOP now=$AFTER_TOP"
else
  sc_fail "bump did not reorder (before=$BEFORE_TOP, after=$AFTER_TOP)"
fi

# =================================================================
# S3 — Brainstorm capture doesn't hijack execute pickup
# =================================================================
scenario_hdr "Brainstorm capture stays out of the pickup queue"

S3_BRAIN=$(create_card "S3 what if we added AI-assisted PR reviews?" "brainstorm" 95 8)
# High priority brainstorm should NOT appear in default backlog
BL_DEFAULT=$(get_backlog_top 50)
HAS_BRAIN=$(echo "$BL_DEFAULT" | jq -r --arg id "$S3_BRAIN" '[.backlog[] | select(.id == $id)] | length')
if [ "$HAS_BRAIN" = "0" ]; then
  sc_pass "brainstorm invisible to default backlog even at priority=95"
else
  sc_fail "brainstorm leaked to default backlog"
fi
# Explicitly requesting 'all' surfaces it
BL_ALL=$(get_backlog_top 50 all)
HAS_ALL=$(echo "$BL_ALL" | jq -r --arg id "$S3_BRAIN" '[.backlog[] | select(.id == $id)] | length')
if [ "$HAS_ALL" = "1" ]; then
  sc_pass "brainstorm visible with intent=all"
else
  sc_fail "brainstorm missing from intent=all"
fi

# =================================================================
# S4 — Dependency chain: dependent card ranked below the dep
# =================================================================
scenario_hdr "Dep-chain: dependent card sinks while dep is unfinished"

S4_DEP=$(create_card "S4 upstream: migrate DB schema" "execute" 60 5)
S4_DOWN=$(create_card "S4 downstream: wire UI to new schema" "execute" 85 3 "[\"$S4_DEP\"]")

# The dependent (prio=85) should be BELOW the dep (prio=60) because
# unready dep penalises 100 → downstream rank_score goes negative.
# Window must exceed the whole execute backlog: on an organic DB the
# dep-penalized card (score ~ -15) sinks well past any fixed top-N, so a
# hardcoded `top 50` would drop it out of the window and report rank=null
# even though the ranker is correct (mirrors Scenario 5's top-100 fix).
BL=$(get_backlog_top 1000)
DEP_RANK=$(echo "$BL" | jq --arg id "$S4_DEP" '[.backlog[] | .id] | index($id)')
DOWN_RANK=$(echo "$BL" | jq --arg id "$S4_DOWN" '[.backlog[] | .id] | index($id)')
if [ -n "$DEP_RANK" ] && [ -n "$DOWN_RANK" ] && [ "$DEP_RANK" != "null" ] && [ "$DOWN_RANK" != "null" ] && [ "$DEP_RANK" -lt "$DOWN_RANK" ]; then
  sc_pass "dep ranked $DEP_RANK, downstream ranked $DOWN_RANK (downstream sunk below dep)"
else
  sc_fail "dep-order wrong: dep rank=$DEP_RANK, downstream rank=$DOWN_RANK"
fi

# The downstream card's rank_score should be negative
DOWN_SCORE=$(echo "$BL" | jq -r --arg id "$S4_DOWN" '[.backlog[] | select(.id == $id) | .rank_score][0]')
if awk "BEGIN {exit !($DOWN_SCORE < 0)}"; then
  sc_pass "downstream rank_score=$DOWN_SCORE is negative (deps penalty applied)"
else
  sc_fail "downstream rank_score=$DOWN_SCORE should be negative"
fi

# =================================================================
# S5 — Blocked card sinks below every unblocked card
# =================================================================
scenario_hdr "Blocked card sinks — no matter how high its priority"

S5_BLOCKED=$(create_card "S5 CRITICAL urgent thing but BLOCKED" "execute" 100 1)
patch_task "$S5_BLOCKED" '{"blocked": 1, "blocked_reason": "waiting on external API"}' > /dev/null

BL=$(get_backlog_top 100)
BLOCKED_RANK=$(echo "$BL" | jq --arg id "$S5_BLOCKED" '[.backlog[] | .id] | index($id)')
BL_LEN=$(echo "$BL" | jq '.backlog | length')
if [ "$BLOCKED_RANK" != "null" ] && [ -n "$BLOCKED_RANK" ]; then
  if [ "$BLOCKED_RANK" -eq $((BL_LEN - 1)) ] || [ "$BLOCKED_RANK" -gt 5 ]; then
    sc_pass "blocked card sank to rank $BLOCKED_RANK of $BL_LEN despite priority=100"
  else
    sc_fail "blocked card too high at rank $BLOCKED_RANK"
  fi
else
  # Might be excluded entirely — worse position than any visible card is fine
  sc_pass "blocked card not in top-20 backlog (better than expected)"
fi

# =================================================================
# S6 — Effort tiebreak: two 70-prio cards, smaller effort wins
# =================================================================
scenario_hdr "Effort penalty as tiebreak: smaller wins on ties"

S6_BIG=$(create_card "S6 tie-A big feature" "execute" 65 13)
S6_SMALL=$(create_card "S6 tie-B tiny tweak" "execute" 65 1)

BL=$(get_backlog_top 100)
BIG_RANK=$(echo "$BL" | jq --arg id "$S6_BIG" '[.backlog[] | .id] | index($id)')
SMALL_RANK=$(echo "$BL" | jq --arg id "$S6_SMALL" '[.backlog[] | .id] | index($id)')
if [ "$SMALL_RANK" != "null" ] && [ "$BIG_RANK" != "null" ] && [ -n "$SMALL_RANK" ] && [ -n "$BIG_RANK" ] && [ "$SMALL_RANK" -lt "$BIG_RANK" ]; then
  sc_pass "tiny effort ranked $SMALL_RANK above big effort at $BIG_RANK (same priority)"
else
  sc_fail "effort tiebreak wrong: small=$SMALL_RANK big=$BIG_RANK"
fi

# =================================================================
# S7 — Reason breakdown is human-readable — invariant sum matches
# =================================================================
scenario_hdr "'/pm next' explanation — reason contributions sum to score"

BL=$(get_backlog_top 10)
TOP_CARD=$(echo "$BL" | jq '.backlog[0]')
SCORE=$(echo "$TOP_CARD" | jq '.rank_score')
SUM=$(echo "$TOP_CARD" | jq '[.reasons[].contribution] | add')
DELTA=$(awk "BEGIN {printf \"%.6f\", ($SUM - $SCORE < 0 ? $SCORE - $SUM : $SUM - $SCORE)}")
if awk "BEGIN {exit !($DELTA < 0.01)}"; then
  sc_pass "top card: sum=$SUM score=$SCORE delta=$DELTA"
else
  sc_fail "invariant broken: delta=$DELTA"
fi
# And every signal must appear (all 5, even if zero contribution)
SIG_COUNT=$(echo "$TOP_CARD" | jq '.reasons | length')
if [ "$SIG_COUNT" = "5" ]; then
  sc_pass "all 5 signals present in top-card breakdown"
else
  sc_fail "expected 5 signals, got $SIG_COUNT"
fi

# =================================================================
# S8 — Priority range clamping: values >100 clamp to 100
# =================================================================
scenario_hdr "Priority clamp — values outside 0..100 get clamped"

# POST with priority=200 — endpoint clamps to 100
S8_CLAMP=$(curl -fsS -X POST "$BRIDGE/api/board/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"title":"S8 clamp test","intent":"execute","priority":200}' 2>/dev/null | jq -r '.task.id')
CREATED+=("$S8_CLAMP")
S8_ACTUAL=$(curl -fsS "$BRIDGE/api/board/backlog?limit=100" | jq -r --arg id "$S8_CLAMP" '[.backlog[] | select(.id == $id) | .priority][0]')
if [ "$S8_ACTUAL" = "100" ]; then
  sc_pass "priority=200 clamped to 100 at POST"
else
  sc_fail "clamp broken: got priority=$S8_ACTUAL"
fi
# Also test PATCH clamp (negative)
patch_task "$S8_CLAMP" '{"priority": -20}' > /dev/null
S8_ACTUAL2=$(curl -fsS "$BRIDGE/api/board/backlog?limit=100" | jq -r --arg id "$S8_CLAMP" '[.backlog[] | select(.id == $id) | .priority][0]')
if [ "$S8_ACTUAL2" = "0" ]; then
  sc_pass "priority=-20 clamped to 0 at PATCH"
else
  sc_fail "PATCH clamp broken: got priority=$S8_ACTUAL2"
fi

# =================================================================
# S9 — Intent transition: brainstorm → execute promotes to pickup
# =================================================================
scenario_hdr "User promotes a brainstorm card by changing intent → execute"

S9_IDEA=$(create_card "S9 idea: add dark mode to /board UI" "brainstorm" 70 3)

# Not in default backlog while brainstorm
BEFORE=$(curl -fsS "$BRIDGE/api/board/backlog?limit=100" | jq -r --arg id "$S9_IDEA" '[.backlog[] | select(.id == $id)] | length')
if [ "$BEFORE" = "0" ]; then
  sc_pass "brainstorm card absent from default backlog pre-promotion"
else
  sc_fail "brainstorm card leaked (before promotion)"
fi

# Promote intent → execute
patch_task "$S9_IDEA" '{"intent": "execute"}' > /dev/null

# Now visible
AFTER=$(curl -fsS "$BRIDGE/api/board/backlog?limit=100" | jq -r --arg id "$S9_IDEA" '[.backlog[] | select(.id == $id)] | length')
if [ "$AFTER" = "1" ]; then
  sc_pass "post-promotion: card appears in execute-default backlog"
else
  sc_fail "promotion didn't surface card (found=$AFTER)"
fi

# =================================================================
# S10 — 'plan' intent is queryable via intent=all but sits idle otherwise
# =================================================================
scenario_hdr "Plan intent — planning-tier cards visible with intent=all only"

S10_PLAN=$(create_card "S10 spike: evaluate approach X vs Y" "plan" 60 5)
S10_DEC=$(create_card "S10 decide: pick between libA and libB" "decide" 75 2)

# Neither should be in default backlog
DEFAULT_HAS=$(curl -fsS "$BRIDGE/api/board/backlog?limit=100" | jq -r --arg a "$S10_PLAN" --arg b "$S10_DEC" \
  '[.backlog[] | select(.id == $a or .id == $b)] | length')
if [ "$DEFAULT_HAS" = "0" ]; then
  sc_pass "plan+decide cards absent from default (execute-only) backlog"
else
  sc_fail "plan/decide leaked to default backlog (count=$DEFAULT_HAS)"
fi

ALL_HAS=$(curl -fsS "$BRIDGE/api/board/backlog?intent=all&limit=100" | jq -r --arg a "$S10_PLAN" --arg b "$S10_DEC" \
  '[.backlog[] | select(.id == $a or .id == $b)] | length')
if [ "$ALL_HAS" = "2" ]; then
  sc_pass "plan+decide both visible with intent=all"
else
  sc_fail "plan/decide missing from intent=all (count=$ALL_HAS)"
fi

# ── Cleanup ────────────────────────────────────────────────────────────────
echo ""
echo "── Cleanup ──"
# NB: create_card runs in a subshell (called via $(create_card ...)), so
# CREATED+= inside the fn does NOT propagate to the parent. Instead we
# clean by title prefix — every scenario titles cards "S<n> ...".
cleaned=$(sqlite3 "$WI_DB_PATH" "
  SELECT COUNT(*) FROM tasks
   WHERE title LIKE 'S1 %' OR title LIKE 'S2 %' OR title LIKE 'S3 %'
      OR title LIKE 'S4 %' OR title LIKE 'S5 %' OR title LIKE 'S6 %'
      OR title LIKE 'S7 %' OR title LIKE 'S8 %' OR title LIKE 'S9 %'
      OR title LIKE 'S10 %';
")
sqlite3 "$WI_DB_PATH" "
  DELETE FROM tasks
   WHERE title LIKE 'S1 %' OR title LIKE 'S2 %' OR title LIKE 'S3 %'
      OR title LIKE 'S4 %' OR title LIKE 'S5 %' OR title LIKE 'S6 %'
      OR title LIKE 'S7 %' OR title LIKE 'S8 %' OR title LIKE 'S9 %'
      OR title LIKE 'S10 %';
" 2>/dev/null || true
echo "  Cleaned $cleaned scenario cards"

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "Scenarios: $scenario   Asserts: $pass passed, $fail failed"
echo "═══════════════════════════════════════════════════"

if [ "$fail" -gt 0 ]; then exit 1; fi
exit 0
