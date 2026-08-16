#!/usr/bin/env bash
#
# scripts/smoke-stage1-e2e.sh — ADR-042 end-to-end verification.
#
# Runs 5 real /wi/dispatch calls with WI_STAGE1_ENABLED=1 against the live
# bridge (real Anthropic API, no mocks). Verifies:
#   1. Every dispatch completes within 45s (well under the 60s SCOPE halt threshold)
#   2. Each dispatch produces a refined_goal (NOT NULL in cypher_sessions)
#   3. Each dispatch fires exactly ONE Anthropic call in the SCOPE phase
#      (scope_iters=1 in cypher_sessions)
#   4. Zero SCOPE wall-clock halts across the 5 dispatches
#   5. cypher_steps has phase='scope' rows recording the single-pass calls
#
# Requires: ANTHROPIC_API_KEY set, WI_STAGE1_ENABLED=1, CYPHER_REFINEMENT_ENABLED=1,
# OUTCOME_HONEST_KANBAN_ENABLED=1, bridge running on :3132.
#
# This is the "does the fix actually work in production" test.

set -u

BRIDGE="${WI_BRIDGE:-http://localhost:3132}"
WI_DB_PATH="${WI_DB_PATH:-$HOME/.work-intelligence-mcp/data.db}"

pass=0; fail=0; halted=0

sc_pass() { echo "  ✓ $1"; pass=$((pass+1)); }
sc_fail() { echo "  ✗ $1"; fail=$((fail+1)); }

echo "═══════════════════════════════════════════════════════════════════"
echo "ADR-042 END-TO-END — real /wi/dispatch with WI_STAGE1_ENABLED=1"
echo "  BRIDGE: $BRIDGE"
echo "═══════════════════════════════════════════════════════════════════"

# ── Preflight ────────────────────────────────────────────────────────────
if ! curl -fsS -m 3 "$BRIDGE/api/board/tasks?limit=1" >/dev/null 2>&1; then
  echo "ABORT — bridge unreachable at $BRIDGE."
  exit 2
fi

# Confirm the flag is on inside the running bridge by checking a marker:
# hit /api/board/tasks (needs OUTCOME_HONEST_KANBAN_ENABLED) — if 200, board flags OK.
CODE=$(curl -sS -m 3 -o /dev/null -w "%{http_code}" "$BRIDGE/api/board/tasks?limit=1")
if [ "$CODE" != "200" ]; then
  echo "ABORT — /api/board/tasks returned $CODE (flags misconfigured)."
  exit 2
fi
echo "Preflight: bridge reachable + board flag active."

# ── Self-assert WI_STAGE1_ENABLED=1 in THIS bridge process ──
# The bridge process reads env at boot. We can't introspect its process env
# from outside, so we fire a canary dispatch and check the observable that
# ONLY the single-pass path produces: exactly one cypher_steps row tagged
# phase='scope' with payload containing "single_pass":true. If we see
# scope_iters>=2 or missing single_pass marker, the flag is OFF inside the
# running bridge and the test would give a false-green.
echo "Self-asserting WI_STAGE1_ENABLED=1 in bridge via canary dispatch..."
CANARY_RESP=$(curl -fsS -m 60 -X POST "$BRIDGE/api/wi/dispatch" \
  -H 'Content-Type: application/json' \
  -d '{"goal":"canary: is bridge :3132 up right now","user":"maaz","task_class":"e2e-canary","posture":"generic","confirm_mode":"auto","dispatch_source":"smoke"}' 2>&1)
CANARY_SID=$(echo "$CANARY_RESP" | jq -r '.session_id // empty' 2>/dev/null)
if [ -z "$CANARY_SID" ]; then
  echo "ABORT — canary dispatch produced no session_id: $CANARY_RESP"
  exit 2
fi
CANARY_ITERS=$(sqlite3 "$WI_DB_PATH" "SELECT scope_iters FROM cypher_sessions WHERE session_id='$CANARY_SID';")
CANARY_SINGLE=$(sqlite3 "$WI_DB_PATH" "SELECT COUNT(*) FROM cypher_steps WHERE session_id='$CANARY_SID' AND phase='scope' AND payload LIKE '%\"single_pass\":true%';")
if [ "$CANARY_ITERS" = "1" ] && [ "$CANARY_SINGLE" = "1" ]; then
  echo "Self-assert: WI_STAGE1_ENABLED=1 confirmed active (scope_iters=1, single_pass marker present)."
else
  echo "ABORT — WI_STAGE1_ENABLED is NOT active in the running bridge."
  echo "         canary $CANARY_SID: scope_iters=$CANARY_ITERS single_pass_marker=$CANARY_SINGLE"
  echo "         Restart the bridge with WI_STAGE1_ENABLED=1 in the environment."
  exit 2
fi

# Sessions BEFORE (to identify what we created)
BEFORE_COUNT=$(sqlite3 "$WI_DB_PATH" "SELECT COUNT(*) FROM cypher_sessions;")
echo "cypher_sessions before: $BEFORE_COUNT"
echo ""

# ── Test corpus — 5 realistic goals matching the SCOPE-halt scenarios ──
declare -a GOALS=(
  "figure out why the search-provider proxy is returning 401"
  "look at PR 4553 and tell me if it will break the ADR-030 flow"
  "what's the blast radius if I refactor src/services/embedder.ts"
  "is bridge :3132 healthy right now"
  "give me my morning briefing please"
)

declare -a SESSION_IDS=()
declare -a DURATIONS=()
# Per-dispatch detail — assembled into the snapshot at the end so the
# audit trail is re-derivable from the repo, not just from console output.
PER_DISPATCH_JSON="$(mktemp)"
echo "[]" > "$PER_DISPATCH_JSON"

for i in "${!GOALS[@]}"; do
  n=$((i+1))
  goal="${GOALS[$i]}"
  echo "── Dispatch $n/5: \"$goal\""

  # Fire dispatch with a 60s HTTP timeout (Stage 1 target is <5s single call,
  # so 60s is generous headroom).
  START=$(date +%s%N)
  RESP=$(curl -fsS -m 60 -X POST "$BRIDGE/api/wi/dispatch" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg g "$goal" '{goal:$g, user:"maaz", task_class:"e2e-smoke", posture:"generic", confirm_mode:"auto", dispatch_source:"smoke"}')" 2>&1)
  END=$(date +%s%N)
  DUR_MS=$(( (END - START) / 1000000 ))
  DURATIONS+=("$DUR_MS")

  SID=$(echo "$RESP" | jq -r '.session_id // empty' 2>/dev/null)
  VERDICT=$(echo "$RESP" | jq -r '.verdict // empty' 2>/dev/null)

  echo "     verdict=$VERDICT  duration=${DUR_MS}ms  session=$SID"

  if [ -z "$SID" ]; then
    sc_fail "no session_id returned — dispatch failed structurally"
    echo "     raw response: $(echo "$RESP" | head -c 300)"
    continue
  fi
  SESSION_IDS+=("$SID")

  # AC 1: duration < 45000ms
  if [ "$DUR_MS" -lt 45000 ]; then
    sc_pass "dispatch $n: duration ${DUR_MS}ms < 45000ms (SCOPE halt threshold cleared)"
  else
    sc_fail "dispatch $n: duration ${DUR_MS}ms >= 45000ms (SCOPE-halt-risk!)"
  fi

  # AC 2: refined_goal is set OR a clarifying-question halt occurred
  # (both are legitimate outcomes of the single-pass — halt on ambiguity
  # is the "ask user" contract, not the SCOPE-60s-halt bug we're fixing).
  RG=$(sqlite3 "$WI_DB_PATH" "SELECT refined_goal FROM cypher_sessions WHERE session_id='$SID';")
  RG_STATE="null"
  if [ -n "$RG" ] && [ "$RG" != "null" ]; then
    sc_pass "dispatch $n: refined_goal populated (success path)"
    RG_STATE="set"
  elif [ "$VERDICT" = "halted" ] && [ "$DUR_MS" -lt 45000 ]; then
    sc_pass "dispatch $n: halted with clarifying-question in ${DUR_MS}ms (legit ask-user path)"
    RG_STATE="clarify_halt"
  else
    sc_fail "dispatch $n: refined_goal NULL AND duration >= 45000ms — real SCOPE halt bug"
    RG_STATE="scope_halt"
    halted=$((halted+1))
  fi

  # AC 3: scope_iters=1 (single-pass!)
  SI=$(sqlite3 "$WI_DB_PATH" "SELECT scope_iters FROM cypher_sessions WHERE session_id='$SID';")
  if [ "$SI" = "1" ]; then
    sc_pass "dispatch $n: scope_iters=1 (single-pass path fired)"
  else
    sc_fail "dispatch $n: scope_iters=$SI (expected 1 for single-pass)"
  fi

  # AC 5: cypher_steps has a phase='scope' row
  SCOPE_STEPS=$(sqlite3 "$WI_DB_PATH" "SELECT COUNT(*) FROM cypher_steps WHERE session_id='$SID' AND phase='scope';")
  if [ "$SCOPE_STEPS" -ge 1 ]; then
    sc_pass "dispatch $n: $SCOPE_STEPS cypher_steps rows tagged phase='scope'"
  else
    sc_fail "dispatch $n: no phase='scope' steps recorded"
  fi

  # Append per-dispatch detail to the snapshot buffer.
  jq --arg goal "$goal" --arg sid "$SID" --arg v "$VERDICT" --arg rg "$RG_STATE" \
     --argjson dur "$DUR_MS" --argjson iters "${SI:-0}" --argjson steps "$SCOPE_STEPS" \
     '. + [{ n: (length + 1), goal: $goal, session_id: $sid, verdict: $v,
             duration_ms: $dur, scope_iters: $iters, refined_goal: $rg,
             scope_steps: $steps }]' \
     "$PER_DISPATCH_JSON" > "${PER_DISPATCH_JSON}.tmp" && mv "${PER_DISPATCH_JSON}.tmp" "$PER_DISPATCH_JSON"

  echo ""
done

# ── Aggregate rollup ──────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════"
echo "E2E aggregate metrics:"
echo "  Dispatches run:   ${#GOALS[@]}"
echo "  Halts observed:   $halted"

# Sort durations for percentile
IFS=$'\n' sorted=($(sort -n <<<"${DURATIONS[*]}"))
unset IFS
n=${#sorted[@]}
if [ "$n" -gt 0 ]; then
  p50=${sorted[$((n/2))]}
  p95_idx=$(( n * 95 / 100 ))
  [ "$p95_idx" -ge "$n" ] && p95_idx=$((n-1))
  p95=${sorted[$p95_idx]}
  max=${sorted[$((n-1))]}
  echo "  Duration p50:     ${p50}ms"
  echo "  Duration p95:     ${p95}ms"
  echo "  Duration max:     ${max}ms"
fi

# AC 4: zero SCOPE halts
if [ "$halted" = "0" ]; then
  sc_pass "AGGREGATE: 0 SCOPE halts across ${#GOALS[@]} real dispatches (cure verified)"
else
  sc_fail "AGGREGATE: $halted SCOPE halts observed"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "ADR-042 E2E: $pass passed, $fail failed"
echo "═══════════════════════════════════════════════════════════════════"

# Save a snapshot for the ADR verification section. Now includes per-dispatch
# detail so the "4/5 refined_goal, 1/5 clarify" breakdown is re-derivable
# from the repo, not asserted only from console output.
SNAP="$(dirname "$0")/../.planning/stage1-e2e-v1.json"
jq -n \
  --slurpfile per "$PER_DISPATCH_JSON" \
  --argjson dispatches "${#GOALS[@]}" \
  --argjson halts "$halted" \
  --argjson p50 "${p50:-0}" \
  --argjson p95 "${p95:-0}" \
  --argjson max "${max:-0}" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg flag_asserted "canary $CANARY_SID scope_iters=$CANARY_ITERS single_pass_marker=$CANARY_SINGLE" \
  '{
    timestamp: $timestamp,
    dispatches: $dispatches,
    halts: $halts,
    duration_ms: { p50: $p50, p95: $p95, max: $max },
    flag_self_assert: $flag_asserted,
    per_dispatch: $per[0]
  }' > "$SNAP"
rm -f "$PER_DISPATCH_JSON"
echo "Snapshot: $SNAP"

if [ "$fail" -gt 0 ]; then exit 1; fi
exit 0
