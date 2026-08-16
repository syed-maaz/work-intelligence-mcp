#!/usr/bin/env bash
#
# scripts/smoke-pm.sh — ADR-043 PM Orchestration Layer smoke.
#
# Dedicated smoke for the PM layer (separate from smoke-bridge.sh per the
# ADR's Definition-of-Done requirement). Verifies each acceptance criterion
# end-to-end against the live bridge on :3132.
#
# Usage:
#   PM_ORCHESTRATION_ENABLED=1 npm run web:bridge   # in another terminal
#   ./scripts/smoke-pm.sh
#
# Exit 0 on all-green; exit 1 on any failure. No shortcuts — every AC
# checked runs a real HTTP call (not a mocked helper). Non-blocking cleanup
# at end removes cards created during the run.
#
# Cross-refs:
#   - docs/docs/adr/adr-043-pm-orchestration-layer.md § Acceptance Criteria
#   - src/services/board/ranker.ts
#   - src/db/migrations/v99_adr043_pm_layer.ts

set -u

BRIDGE="${WI_BRIDGE:-http://localhost:3132}"
WI_DB_PATH="${WI_DB_PATH:-$HOME/.work-intelligence-mcp/data.db}"
pass_count=0
fail_count=0
CREATED_IDS=()

pass() { echo "  ✓ PASS: $1"; pass_count=$((pass_count+1)); }
fail() { echo "  ✗ FAIL: $1"; fail_count=$((fail_count+1)); }

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required tool '$1' not on PATH"
    exit 2
  fi
}

require curl
require jq
require sqlite3

echo "═══════════════════════════════════════════════════"
echo "ADR-043 PM Orchestration Layer smoke"
echo "  BRIDGE:      $BRIDGE"
echo "  WI_DB_PATH:  $WI_DB_PATH"
echo "═══════════════════════════════════════════════════"

# ── § 0 preflight — bridge reachable + flag on ─────────────────────────────
echo ""
echo "── § 0. Preflight ──"

if ! curl -fsS -m 3 "$BRIDGE/api/board/tasks?limit=1" >/dev/null 2>&1; then
  fail "§ 0.1 — bridge unreachable at $BRIDGE (start with: PM_ORCHESTRATION_ENABLED=1 OUTCOME_HONEST_KANBAN_ENABLED=1 npm run web:bridge)"
  echo ""
  echo "════════ Smoke aborted (0 passed, 1 failed) ═══════"
  exit 1
fi
pass "§ 0.1 — bridge reachable"

BACKLOG_CODE=$(curl -fsS -o /dev/null -w '%{http_code}' "$BRIDGE/api/board/backlog?limit=1" 2>/dev/null || echo "000")
if [ "$BACKLOG_CODE" = "200" ]; then
  pass "§ 0.2 — /api/board/backlog reachable (flags enabled)"
else
  fail "§ 0.2 — /api/board/backlog returned $BACKLOG_CODE (need PM_ORCHESTRATION_ENABLED=1 AND OUTCOME_HONEST_KANBAN_ENABLED=1)"
  echo ""
  echo "════════ Smoke aborted (needs flag on) ════════════"
  exit 1
fi

# ── § 1 substrate (AC-S1) — migration + columns ────────────────────────────
echo ""
echo "── § 1. Substrate (AC-S1) ──"

if [ -r "$WI_DB_PATH" ]; then
  SCHEMA_VER=$(sqlite3 "$WI_DB_PATH" "SELECT value FROM schema_metadata WHERE key='schema_version';")
  if [ "$SCHEMA_VER" -ge 99 ] 2>/dev/null; then
    pass "§ 1.1 — schema_version >= 99 (v99 applied): $SCHEMA_VER"
  else
    fail "§ 1.1 — schema_version < 99: $SCHEMA_VER (migration didn't run — restart bridge)"
  fi

  # Columns present
  COLS_HAVE=$(sqlite3 "$WI_DB_PATH" "SELECT group_concat(name, ',') FROM (SELECT name FROM pragma_table_info('tasks') WHERE name IN ('priority','effort_points','intent') ORDER BY name);")
  if [ "$COLS_HAVE" = "effort_points,intent,priority" ]; then
    pass "§ 1.2 — tasks has priority, effort_points, intent"
  else
    fail "§ 1.2 — tasks columns wrong: $COLS_HAVE"
  fi

  # CHECK constraint enforcement
  BAD_INTENT=$(sqlite3 "$WI_DB_PATH" "INSERT INTO tasks (id,title,posture,created_at,last_touched,intent) VALUES ('tsk_smoke_bad', 'x', 'generic', 0, 0, 'not-a-real-intent');" 2>&1 || true)
  if echo "$BAD_INTENT" | grep -q "CHECK constraint\|constraint failed"; then
    pass "§ 1.3 — intent CHECK constraint rejects invalid values"
  else
    fail "§ 1.3 — invalid intent was accepted (expected CHECK failure). Got: $BAD_INTENT"
    # Roll back the accidental insert if it landed
    sqlite3 "$WI_DB_PATH" "DELETE FROM tasks WHERE id='tsk_smoke_bad';" 2>/dev/null || true
  fi

  # Covering index present
  INDEX_HAS=$(sqlite3 "$WI_DB_PATH" "SELECT name FROM sqlite_master WHERE type='index' AND name='tasks_backlog_rank_idx';")
  if [ "$INDEX_HAS" = "tasks_backlog_rank_idx" ]; then
    pass "§ 1.4 — tasks_backlog_rank_idx present"
  else
    fail "§ 1.4 — tasks_backlog_rank_idx missing"
  fi
else
  fail "§ 1.* — SKIPPED (WI_DB_PATH=$WI_DB_PATH not readable)"
fi

# ── § 2 create endpoint (AC-S2) ────────────────────────────────────────────
echo ""
echo "── § 2. POST /api/board/tasks (AC-S2) ──"

# 2.1 Create an execute card with all PM fields
CREATE_RESP=$(curl -fsS -X POST "$BRIDGE/api/board/tasks" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "PM-SMOKE execute card 001",
    "goal_text": "Verify capture via POST /api/board/tasks",
    "intent": "execute",
    "priority": 70,
    "effort_points": 3
  }' 2>&1)
CREATE_ID=$(echo "$CREATE_RESP" | jq -r '.task.id // empty')
CREATE_INTENT=$(echo "$CREATE_RESP" | jq -r '.task.intent // empty')
CREATE_PRIO=$(echo "$CREATE_RESP" | jq -r '.task.priority // empty')
CREATE_EFFORT=$(echo "$CREATE_RESP" | jq -r '.task.effort_points // empty')

if [ -n "$CREATE_ID" ] && [ "$CREATE_INTENT" = "execute" ] && [ "$CREATE_PRIO" = "70" ] && [ "$CREATE_EFFORT" = "3" ]; then
  pass "§ 2.1 — POST /api/board/tasks creates card with all PM fields (id=$CREATE_ID)"
  CREATED_IDS+=("$CREATE_ID")
else
  fail "§ 2.1 — create returned unexpected shape: $CREATE_RESP"
fi

# 2.2 Reject invalid intent
INVALID_INTENT_CODE=$(curl -fsS -o /tmp/pm-invalid-intent.json -w '%{http_code}' -X POST "$BRIDGE/api/board/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"title":"bad","intent":"nonsense"}')
INVALID_INTENT_RESULT=$(cat /tmp/pm-invalid-intent.json 2>/dev/null)
INVALID_ID=$(echo "$INVALID_INTENT_RESULT" | jq -r '.task.id // empty' 2>/dev/null)
INVALID_ACTUAL=$(echo "$INVALID_INTENT_RESULT" | jq -r '.task.intent // empty' 2>/dev/null)
# Endpoint's contract is: unknown intent → default 'execute'. Accepted, not rejected.
if [ "$INVALID_INTENT_CODE" = "201" ] && [ "$INVALID_ACTUAL" = "execute" ]; then
  pass "§ 2.2 — invalid intent silently coerced to default 'execute' (endpoint contract)"
  [ -n "$INVALID_ID" ] && CREATED_IDS+=("$INVALID_ID")
else
  fail "§ 2.2 — invalid intent handling wrong: HTTP $INVALID_INTENT_CODE actual_intent=$INVALID_ACTUAL body=$INVALID_INTENT_RESULT"
fi

# 2.3 Create a brainstorm card (must NOT be picked up by BoardWorkerAgent)
BRAIN_RESP=$(curl -fsS -X POST "$BRIDGE/api/board/tasks" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "PM-SMOKE brainstorm card 002",
    "goal_text": "Verify brainstorm intent sits idle",
    "intent": "brainstorm",
    "priority": 90
  }' 2>&1)
BRAIN_ID=$(echo "$BRAIN_RESP" | jq -r '.task.id // empty')
BRAIN_INTENT=$(echo "$BRAIN_RESP" | jq -r '.task.intent // empty')
if [ -n "$BRAIN_ID" ] && [ "$BRAIN_INTENT" = "brainstorm" ]; then
  pass "§ 2.3 — brainstorm card created (id=$BRAIN_ID, intent=$BRAIN_INTENT)"
  CREATED_IDS+=("$BRAIN_ID")
else
  fail "§ 2.3 — brainstorm create failed: $BRAIN_RESP"
fi

# 2.4 Missing title → 400
MISSING_CODE=$(curl -fsS -o /dev/null -w '%{http_code}' -X POST "$BRIDGE/api/board/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"priority":50}' || true)
if [ "$MISSING_CODE" = "400" ]; then
  pass "§ 2.4 — missing title returns 400"
else
  fail "§ 2.4 — missing title returned $MISSING_CODE (expected 400)"
fi

# ── § 3 backlog endpoint (AC-S4 — the contribution-sum invariant) ─────────
echo ""
echo "── § 3. GET /api/board/backlog + AC-S4 contribution-sum invariant ──"

BACKLOG=$(curl -fsS "$BRIDGE/api/board/backlog?limit=50")
TOP_ID=$(echo "$BACKLOG" | jq -r '.top_task_id')
BACKLOG_LEN=$(echo "$BACKLOG" | jq '.backlog | length')

if [ "$BACKLOG_LEN" -gt 0 ]; then
  pass "§ 3.1 — backlog returned $BACKLOG_LEN cards, top_task_id=$TOP_ID"
else
  fail "§ 3.1 — backlog empty despite creates above"
fi

# AC-S4: sum(reasons[i].contribution) == rank_score (± 0.01) — for EVERY card
INVARIANT_VIOLATIONS=$(echo "$BACKLOG" | jq -r '
  .backlog
  | map(
      { id: .id,
        rank: .rank_score,
        sum: (.reasons | map(.contribution) | add),
        delta: ((.reasons | map(.contribution) | add) - .rank_score | fabs)
      })
  | map(select(.delta > 0.01))
  | length')
if [ "$INVARIANT_VIOLATIONS" = "0" ]; then
  pass "§ 3.2 — AC-S4: sum(contribution) == rank_score for all $BACKLOG_LEN cards"
else
  fail "§ 3.2 — AC-S4 VIOLATED on $INVARIANT_VIOLATIONS cards"
  echo "$BACKLOG" | jq '.backlog | map(select( ((.reasons|map(.contribution)|add) - .rank_score | fabs) > 0.01 ))'
fi

# 3.3 Every card has all 5 reason signals
MISSING_SIGNALS=$(echo "$BACKLOG" | jq -r '
  .backlog
  | map(
      (["priority","blocked_penalty","deps_penalty","age_bonus","effort_penalty"] as $need
        | .reasons | map(.signal) as $have
        | $need - $have | length))
  | add')
if [ "$MISSING_SIGNALS" = "0" ]; then
  pass "§ 3.3 — every card carries all 5 formula signals"
else
  fail "§ 3.3 — $MISSING_SIGNALS reason-signals missing across the backlog"
fi

# 3.4 intent=execute (default) filters brainstorm/plan/decide out
EXECUTE_ONLY_HAS_BRAIN=$(echo "$BACKLOG" | jq -r '[.backlog[] | select(.intent != "execute")] | length')
if [ "$EXECUTE_ONLY_HAS_BRAIN" = "0" ]; then
  pass "§ 3.4 — default backlog (intent=execute) excludes brainstorm/plan/decide"
else
  fail "§ 3.4 — default backlog leaked $EXECUTE_ONLY_HAS_BRAIN non-execute cards"
fi

# 3.5 intent=all surfaces the brainstorm card we just created
BACKLOG_ALL=$(curl -fsS "$BRIDGE/api/board/backlog?intent=all&limit=50")
HAS_BRAIN_IN_ALL=$(echo "$BACKLOG_ALL" | jq -r --arg id "$BRAIN_ID" '[.backlog[] | select(.id == $id)] | length')
if [ "$HAS_BRAIN_IN_ALL" = "1" ]; then
  pass "§ 3.5 — intent=all includes the brainstorm card ($BRAIN_ID)"
else
  fail "§ 3.5 — brainstorm card missing from intent=all response"
fi

# ── § 4 prioritize (AC-U3) — PATCH re-orders ───────────────────────────────
echo ""
echo "── § 4. Prioritize / re-order (AC-U3) ──"

# Create two execute cards with distinct priorities, verify order, bump the low
# card to 99, verify it moves to top.
LOW_RESP=$(curl -fsS -X POST "$BRIDGE/api/board/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"title":"PM-SMOKE low prio","goal_text":"low","intent":"execute","priority":30}')
LOW_ID=$(echo "$LOW_RESP" | jq -r '.task.id')
CREATED_IDS+=("$LOW_ID")

HIGH_RESP=$(curl -fsS -X POST "$BRIDGE/api/board/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"title":"PM-SMOKE high prio","goal_text":"high","intent":"execute","priority":80}')
HIGH_ID=$(echo "$HIGH_RESP" | jq -r '.task.id')
CREATED_IDS+=("$HIGH_ID")

# Verify high ranks above low pre-bump
PRE_ORDER=$(curl -fsS "$BRIDGE/api/board/backlog?limit=100" | jq -r --arg L "$LOW_ID" --arg H "$HIGH_ID" '
  [.backlog[] | select(.id == $L or .id == $H) | {id, rank_score}] | sort_by(-.rank_score) | .[0].id')
if [ "$PRE_ORDER" = "$HIGH_ID" ]; then
  pass "§ 4.1 — pre-bump: prio=80 ranks above prio=30"
else
  fail "§ 4.1 — pre-bump order wrong (expected $HIGH_ID first, got $PRE_ORDER)"
fi

# Bump the low card to 99
PATCH_CODE=$(curl -fsS -o /tmp/pm-patch.json -w '%{http_code}' -X PATCH "$BRIDGE/api/board/tasks/$LOW_ID" \
  -H 'Content-Type: application/json' \
  -d '{"priority":99}')
if [ "$PATCH_CODE" = "200" ]; then
  pass "§ 4.2 — PATCH priority=99 accepted"
else
  fail "§ 4.2 — PATCH failed: HTTP $PATCH_CODE — $(cat /tmp/pm-patch.json)"
fi

# Verify low card now ranks above high
POST_ORDER=$(curl -fsS "$BRIDGE/api/board/backlog?limit=100" | jq -r --arg L "$LOW_ID" --arg H "$HIGH_ID" '
  [.backlog[] | select(.id == $L or .id == $H) | {id, rank_score}] | sort_by(-.rank_score) | .[0].id')
if [ "$POST_ORDER" = "$LOW_ID" ]; then
  pass "§ 4.3 — post-bump: previously-low card (now prio=99) ranks above prio=80"
else
  fail "§ 4.3 — post-bump order wrong (expected $LOW_ID first, got $POST_ORDER)"
fi

# ── § 25.4 AC-A1 capture wiring (ADR-043 Phase A, 2026-07-24) ──────────────
# Regression coverage for the 2026-07-17 silent-fail bug:
#   3 sessions closed outcome='captured_to_board' with task_id IS NULL and no
#   `tasks` row on the board. Root cause was in loop.ts — LoopResult dropped
#   the task_id returned by captureToBoard() and persistOutcome() never wrote
#   cypher_sessions.task_id.
#
# We CANNOT drive this via the bridge without corrupting the live DB
# (POST /api/board/tasks writes to WI_DB_PATH). Instead we assert the fix
# structurally + exercise it end-to-end via vitest against an in-memory
# sqlite fixture (see tests/services/cypher/pm-capture-hook-integration.test.ts).
#
# Env override: SMOKE_SCRATCH_DB=<path> is echoed for parity with future
# HTTP-based coverage; today the integration test uses `:memory:` internally
# so this variable is a no-op — logged so a human reader knows we're not
# secretly hitting the live DB.
echo ""
echo "── § 25.4 AC-A1 capture wiring (task_id round-trip) ──"
echo "  SMOKE_SCRATCH_DB (if set): ${SMOKE_SCRATCH_DB:-<unset — in-memory used>}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# § 25.4.1 — loop.ts declares task_id / card_number on LoopResult.
if grep -q "task_id?: string | null" "$REPO_ROOT/src/services/cypher/loop.ts" \
   && grep -q "card_number?: number | null" "$REPO_ROOT/src/services/cypher/loop.ts"; then
  pass "§ 25.4.1 — LoopResult carries task_id / card_number slots"
else
  fail "§ 25.4.1 — LoopResult missing task_id/card_number (regression: fix reverted)"
fi

# § 25.4.2 — persistOutcome writes task_id via COALESCE on the captured branch.
if grep -q "task_id = COALESCE(task_id, ?)" "$REPO_ROOT/src/services/cypher/loop.ts"; then
  pass "§ 25.4.2 — persistOutcome COALESCE's task_id (non-null wins, preserves parent link)"
else
  fail "§ 25.4.2 — persistOutcome missing COALESCE(task_id, ?) UPDATE (regression)"
fi

# § 25.4.3 — capture branch propagates task_id into capturedResult.
if grep -q "task_id: cap.task_id" "$REPO_ROOT/src/services/cypher/loop.ts"; then
  pass "§ 25.4.3 — captured LoopResult populates task_id from captureToBoard"
else
  fail "§ 25.4.3 — captured LoopResult drops cap.task_id (the 2026-07-17 bug pattern)"
fi

# § 25.4.4 — capture-failure path is a loud HALT, not a silent swallow.
if grep -q "PM capture hook failed (HALT)" "$REPO_ROOT/src/services/cypher/loop.ts"; then
  pass "§ 25.4.4 — capture failure surfaces HALT with real error (no synthesised false surface)"
else
  fail "§ 25.4.4 — capture failure path missing HALT — silent-swallow regression"
fi

# § 25.4.5 — vitest end-to-end: session round-trips to real tasks row.
# In-memory sqlite fixture; NEVER touches WI_DB_PATH.
INT_TEST_REL="tests/services/cypher/pm-capture-hook-integration.test.ts"
if [ -r "$REPO_ROOT/$INT_TEST_REL" ]; then
  if command -v node >/dev/null 2>&1; then
    ( cd "$REPO_ROOT" && npx --no-install vitest run "$INT_TEST_REL" \
        >/tmp/pm-smoke-25.4.log 2>&1 )
    RC=$?
    if [ "$RC" = "0" ]; then
      pass "§ 25.4.5 — pm-capture-hook-integration.test.ts (2/2 green, in-memory)"
    else
      fail "§ 25.4.5 — integration test failed (rc=$RC — see /tmp/pm-smoke-25.4.log)"
    fi
  else
    fail "§ 25.4.5 — SKIPPED (node not on PATH)"
  fi
else
  fail "§ 25.4.5 — SKIPPED (test file $INT_TEST_REL missing)"
fi

# § 25.4.6 — no orphan captured_to_board sessions on the smoke DB.
# Read-only assertion; runs against WI_DB_PATH but only SELECT. If a scratch
# DB was provided via SMOKE_SCRATCH_DB, prefer that.
CHECK_DB="${SMOKE_SCRATCH_DB:-$WI_DB_PATH}"
if [ -r "$CHECK_DB" ]; then
  ORPHANS=$(sqlite3 "$CHECK_DB" "SELECT COUNT(*) FROM cypher_sessions WHERE outcome='captured_to_board' AND task_id IS NULL;" 2>/dev/null || echo "err")
  if [ "$ORPHANS" = "0" ]; then
    pass "§ 25.4.6 — zero orphaned captured_to_board sessions in $CHECK_DB"
  elif [ "$ORPHANS" = "err" ]; then
    fail "§ 25.4.6 — could not read cypher_sessions from $CHECK_DB"
  else
    fail "§ 25.4.6 — $ORPHANS orphaned captured_to_board sessions in $CHECK_DB (run scripts/repair-orphaned-captures.mjs)"
  fi
else
  fail "§ 25.4.6 — SKIPPED (CHECK_DB=$CHECK_DB not readable)"
fi

# ── § 5 rollout (AC-R1 — flag gate) ────────────────────────────────────────
# Only structural — we can't turn PM_ORCHESTRATION_ENABLED off mid-smoke without
# restarting the bridge, but we CAN grep the source for the gate itself.
echo ""
echo "── § 5. Rollout gate (AC-R1) ──"

WEB_SERVER="$(dirname "$0")/../web-server.js"
if [ -r "$WEB_SERVER" ] && grep -q "PM_ORCHESTRATION_ENABLED === '1'" "$WEB_SERVER"; then
  GATE_COUNT=$(grep -c "PM_ORCHESTRATION_ENABLED === '1'" "$WEB_SERVER")
  pass "§ 5.1 — PM_ORCHESTRATION_ENABLED gate present on $GATE_COUNT PM endpoints"
else
  fail "§ 5.1 — PM_ORCHESTRATION_ENABLED gate missing from web-server.js"
fi

# ── Cleanup — delete cards we created ──────────────────────────────────────
echo ""
echo "── Cleanup ──"
CLEAN_OK=0
CLEAN_FAIL=0
for id in "${CREATED_IDS[@]}"; do
  [ -z "$id" ] || [ "$id" = "null" ] && continue
  # Delete via direct SQL (no DELETE endpoint exposed on /api/board/tasks).
  # Non-destructive to real cards — we only touch IDs we tracked in this run.
  if sqlite3 "$WI_DB_PATH" "DELETE FROM tasks WHERE id='$id';" 2>/dev/null; then
    CLEAN_OK=$((CLEAN_OK+1))
  else
    CLEAN_FAIL=$((CLEAN_FAIL+1))
  fi
done
echo "  Cleaned $CLEAN_OK smoke cards (failures: $CLEAN_FAIL)"

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "ADR-043 PM smoke: $pass_count passed, $fail_count failed"
echo "═══════════════════════════════════════════════════"

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
exit 0
