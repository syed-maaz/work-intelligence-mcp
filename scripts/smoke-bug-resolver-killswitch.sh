#!/usr/bin/env bash
# scripts/smoke-bug-resolver-killswitch.sh
#
# ADR-030 Phase C (Plan 76-03): proves BUG_RESOLVER_ENABLED=0 (the default)
# actually short-circuits BugResolverAgent registration AND that the
# resolve-attempt route returns 400 'resolver_disabled' in that state.
#
# Spawns a child bridge on :3135 with BUG_RESOLVER_ENABLED unset (defaults
# to disabled), a hermetic temporary DATABASE_PATH, and palace disabled.
# Asserts:
#
#   1. Child bridge becomes live on :3135.
#   2. stderr contains "BugResolverAgent disabled (BUG_RESOLVER_ENABLED!=1)".
#   3. /api/agents/health does NOT list BugResolverAgent.
#   4. POST /api/bugs/:id/resolve-attempt returns 400 with
#      code='resolver_disabled'.
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed (see ✗ lines)
#   2 — child bridge couldn't even boot

set -u

CHILD_PORT=3135
CHILD_URL="http://localhost:${CHILD_PORT}"
CHILD_DB="/tmp/wi-bug-resolver-killswitch-test-$$.db"
LOG="/tmp/wi-bug-resolver-killswitch-${$}.log"

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

echo "── BugResolver killswitch smoke ──"
echo "    spawning child bridge on :${CHILD_PORT} with BUG_RESOLVER_ENABLED unset (defaults to disabled)"

# Explicitly unset BUG_RESOLVER_ENABLED so an inherited value from the
# parent shell can't leak in and turn this assertion green by accident.
unset BUG_RESOLVER_ENABLED

# BUG_INVESTIGATOR_ENABLED=0 too — keeps the child boot fast and isolates
# this smoke to the resolver path only.
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
pass "Child bridge boots with BUG_RESOLVER_ENABLED unset"

# The resolver registration happens inside a 5s-deferred setTimeout in the
# bridge's agent boot block, so we need to wait past that delay before
# asserting on stderr or /api/agents/health. 8s gives the boot block time
# to log the disable line and finish registering all other agents.
sleep 8

# 2. stderr contains the disable line.
if grep -q 'BugResolverAgent disabled' "$LOG"; then
  pass "stderr contains 'BugResolverAgent disabled' line"
else
  fail "stderr missing 'BugResolverAgent disabled' line — log tail:"
  tail -10 "$LOG"
fi

# 3. /api/agents/health does NOT list BugResolverAgent.
agents=$(curl -fsS "${CHILD_URL}/api/agents/health" 2>/dev/null || echo '{}')
if echo "$agents" | grep -q '"name":"BugResolverAgent"'; then
  fail "BugResolverAgent appears in /api/agents/health when killswitch is on"
else
  pass "BugResolverAgent absent from /api/agents/health"
fi

# 4. POST /api/bugs/:id/resolve-attempt returns 400 with resolver_disabled.
status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${CHILD_URL}/api/bugs/1/resolve-attempt" -H 'Content-Type: application/json' -d '{}' 2>/dev/null)
body=$(curl -s -X POST "${CHILD_URL}/api/bugs/1/resolve-attempt" -H 'Content-Type: application/json' -d '{}' 2>/dev/null)
if [ "$status" = "400" ] && echo "$body" | grep -q 'resolver_disabled'; then
  pass "/api/bugs/:id/resolve-attempt → 400 resolver_disabled"
else
  fail "expected 400 resolver_disabled, got status=$status body=$body"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "BugResolver killswitch smoke: $pass_count passed, $fail_count failed"
echo "═══════════════════════════════════════════════════"

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
exit 0
