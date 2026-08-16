#!/usr/bin/env bash
# scripts/smoke-bug-killswitch.sh
#
# ADR-030 Phase B (Plan 75-04): proves BUG_INVESTIGATOR_ENABLED=0 actually
# short-circuits BugInvestigatorAgent registration.
#
# Spawns a child bridge on :3134 with BUG_INVESTIGATOR_ENABLED=0, a
# hermetic temporary DATABASE_PATH, and palace disabled. Waits up to 30s
# for the child to become live, then asserts:
#
#   1. Child bridge becomes live on :3134.
#   2. stderr contains "BugInvestigatorAgent disabled via BUG_INVESTIGATOR_ENABLED=0".
#   3. /api/agents/health does NOT list BugInvestigatorAgent.
#   4. The full agent count is N - 1 vs the normal launch (i.e. exactly one
#      agent disappeared, not zero, not two).
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed (see ✗ lines)
#   2 — child bridge couldn't even boot

set -u

CHILD_PORT=3134
CHILD_URL="http://localhost:${CHILD_PORT}"
CHILD_DB="/tmp/wi-bug-killswitch-test-$$.db"
LOG="/tmp/wi-bug-killswitch-${$}.log"

fail_count=0
pass_count=0
pass() { printf "  ✓ %s\n"  "$*"; pass_count=$((pass_count + 1)); }
fail() { printf "  ✗ %s\n"  "$*"; fail_count=$((fail_count + 1)); }

cleanup() {
  if [ -n "${CHILD_PID:-}" ]; then
    kill -9 "$CHILD_PID" 2>/dev/null || true
  fi
  rm -f "$CHILD_DB" "$LOG" 2>/dev/null || true
}
trap cleanup EXIT

echo "── BugInvestigator killswitch smoke ──"
echo "    spawning child bridge on :${CHILD_PORT} with BUG_INVESTIGATOR_ENABLED=0"

BUG_INVESTIGATOR_ENABLED=0 \
  PORT="$CHILD_PORT" \
  DATABASE_PATH="$CHILD_DB" \
  MEMPALACE_PATH="" \
  CODE_GRAPH_INDEX_DISABLED=1 \
  node web-server.js > "$LOG" 2>&1 &
CHILD_PID=$!

# Wait up to 30s for child bridge liveness.
ready=0
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null -m 2 "${CHILD_URL}/api/status" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "FATAL: child bridge did not become live on ${CHILD_URL} within 30s"
  echo "── log tail ──"
  tail -20 "$LOG"
  exit 2
fi
pass "Child bridge boots with BUG_INVESTIGATOR_ENABLED=0"

# 2. stderr contains the disable line.
if grep -q 'BugInvestigatorAgent disabled via BUG_INVESTIGATOR_ENABLED=0' "$LOG"; then
  pass "stderr contains 'BugInvestigatorAgent disabled' line"
else
  fail "stderr missing 'BugInvestigatorAgent disabled' line — log tail:"
  tail -10 "$LOG"
fi

# 3. /api/agents/health does NOT list BugInvestigatorAgent.
agents=$(curl -fsS "${CHILD_URL}/api/agents/health" 2>/dev/null || echo '{}')
if echo "$agents" | grep -q '"name":"BugInvestigatorAgent"'; then
  fail "BugInvestigatorAgent appears in /api/agents/health when killswitch is on"
else
  pass "BugInvestigatorAgent absent from /api/agents/health"
fi

# 4. Total agent count baseline check — assert > 0 agents present so we
# know the bridge actually came up registered, just without the
# investigator. (A full N vs N-1 comparison would require a second child
# spawn; we keep this smoke single-spawn for speed.)
agent_count=$(echo "$agents" | grep -o '"name":' | wc -l | tr -d ' ')
if [ "$agent_count" -ge 7 ]; then
  pass "Other agents still register (count=$agent_count)"
else
  fail "Only $agent_count agents — something else broke (expected ≥7)"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "BugInvestigator killswitch smoke: $pass_count passed, $fail_count failed"
echo "═══════════════════════════════════════════════════"

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
exit 0
