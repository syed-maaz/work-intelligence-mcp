#!/usr/bin/env bash
# scripts/smoke-killswitch.sh
#
# Closes ADR-027 v2 follow-up #3: prove the CODE_GRAPH_INDEX_DISABLED=1
# kill-switch actually short-circuits CodeGraphIndexer agent registration.
#
# Why: the code at web-server.js:6446-6448 short-circuits the agent before
# `registerAgent('CodeGraphIndexer')` runs. A refactor that flattens the
# if/else would ship silently — the kill-switch exists *because* the indexer
# can wedge, and losing it during a wedge is exactly the moment we need it.
#
# What this checks:
#   1. Spawn a child bridge on PORT=3133 with CODE_GRAPH_INDEX_DISABLED=1
#      and a hermetic DATABASE_PATH (no clobber of the real DB) and
#      MEMPALACE_PATH= (palace disabled, no Python child needed).
#   2. Wait for liveness on :3133.
#   3. GET /api/agents/health → assert CodeGraphIndexer is NOT in the list,
#      and the agent count is exactly 8 (not 9).
#   4. Tear down the child bridge.
#
# Exit codes:
#   0 — kill-switch works as documented
#   1 — assertion failed (kill-switch regressed)
#   2 — could not boot child bridge
#
# Standalone usage:
#   bash scripts/smoke-killswitch.sh
#
# Wired in via:
#   npm run smoke:killswitch
#   npm run smoke:bridge   (does NOT call this — child bridge spawn is heavy
#                          and would slow the inner-loop. Run together with
#                          smoke:all or in CI.)

set -u

PORT="${SMOKE_KILLSWITCH_PORT:-3133}"
CHILD_URL="http://localhost:${PORT}"
TEST_DB="${SMOKE_KILLSWITCH_DB:-/tmp/wi-killswitch-test-$$.db}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

fail_count=0
pass_count=0

pass() { printf "  ✓ %s\n" "$*"; pass_count=$((pass_count + 1)); }
fail() { printf "  ✗ %s\n" "$*"; fail_count=$((fail_count + 1)); }

cleanup() {
  if [ -n "${CHILD_PID:-}" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill "$CHILD_PID" 2>/dev/null || true
    # Give it a beat to exit cleanly, then force.
    for _ in 1 2 3 4 5; do
      kill -0 "$CHILD_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$CHILD_PID" 2>/dev/null || true
  fi
  # Also reap anything else that grabbed the port (rare).
  lsof -ti ":${PORT}" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  rm -f "$TEST_DB" "${TEST_DB}-shm" "${TEST_DB}-wal" 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo "── Kill-switch smoke (CODE_GRAPH_INDEX_DISABLED=1, port :${PORT}) ──"

# This smoke spawns `node web-server.js`, which needs the project's
# node_modules. In the main checkout that's already there. In a fresh
# worktree it isn't — bail with an actionable message rather than a
# noisy ERR_MODULE_NOT_FOUND.
if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
  echo "  ! node_modules missing at $PROJECT_ROOT — skipping kill-switch smoke" >&2
  echo "    fix: run \`npm install\` in this checkout, OR symlink node_modules" >&2
  echo "         from your main checkout: ln -s <main>/node_modules $PROJECT_ROOT/node_modules" >&2
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "Kill-switch smoke: SKIPPED (node_modules missing)"
  echo "═══════════════════════════════════════════════════"
  exit 0
fi

# Make sure nothing else is on the port.
existing=$(lsof -ti ":${PORT}" 2>/dev/null || true)
if [ -n "$existing" ]; then
  echo "  port :${PORT} already in use by PID(s) $existing — killing first" >&2
  echo "$existing" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# Boot the child bridge. Inherit .env for ANTHROPIC_API_KEY and friends, but
# override port, DB, and palace via shell env (shell wins over --env-file).
# .env may be absent in a worktree — fall back to no env file in that case.
LOG_FILE="/tmp/wi-killswitch-child-$$.log"
ENV_FILE_ARG=""
if [ -f "$PROJECT_ROOT/.env" ]; then
  ENV_FILE_ARG="--env-file=.env"
fi
(
  cd "$PROJECT_ROOT" && \
  PORT="$PORT" \
  CODE_GRAPH_INDEX_DISABLED=1 \
  DATABASE_PATH="$TEST_DB" \
  MEMPALACE_PATH="" \
  SKIP_STALE_DIST_CHECK=1 \
  node $ENV_FILE_ARG web-server.js \
    >"$LOG_FILE" 2>&1
) &
CHILD_PID=$!

# Wait up to 60s for full agent boot. The bridge prints
# `[Agents] Boot complete: N agents — {...}` to stderr only after every
# registerAgent() call has run. /api/status answers earlier than that, so
# polling /api/agents/health between server.listen and Boot complete returns
# an under-counted (or empty) list — that's the bug we hit on the first try.
#
# We use the log file as the readiness signal because it's the same line
# scripts/smoke-bridge.sh check #2 already depends on, so any future change
# that drops it would be caught there too.
ready=0
for i in $(seq 1 60); do
  if grep -q "\[Agents\] Boot complete:" "$LOG_FILE" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$CHILD_PID" 2>/dev/null; then
    echo "  ✗ child bridge exited before becoming ready — log tail:" >&2
    tail -30 "$LOG_FILE" >&2
    rm -f "$LOG_FILE"
    exit 2
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "  ✗ child bridge did not finish agent boot in 60s — log tail:" >&2
  tail -30 "$LOG_FILE" >&2
  rm -f "$LOG_FILE"
  exit 2
fi

# Belt-and-braces: confirm /api/status also answers.
if ! curl -fsS -o /dev/null -m 2 "${CHILD_URL}/api/status" 2>/dev/null; then
  echo "  ✗ child bridge agent boot done but /api/status not reachable" >&2
  exit 2
fi

pass "child bridge live on :${PORT} with full agent boot"

# Confirm via stderr that the kill-switch fired. This is belt-and-braces —
# the agent-list assertion is the load-bearing check.
if grep -q "CODE_GRAPH_INDEX_DISABLED=1" "$LOG_FILE"; then
  pass "stderr confirms kill-switch fired ('disabled via CODE_GRAPH_INDEX_DISABLED=1')"
else
  fail "stderr missing kill-switch confirmation message — fragile but expected"
fi

# Pull agents list and check.
agents_resp=$(curl -fsS "${CHILD_URL}/api/agents/health" 2>/dev/null || echo '')
if [ -z "$agents_resp" ]; then
  fail "could not reach /api/agents/health on child bridge"
else
  has_cgi=$(printf "%s" "$agents_resp" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    agents = d.get('agents') or []
    names = [a.get('name') for a in agents]
    print('YES' if 'CodeGraphIndexer' in names else 'NO')
except Exception:
    print('PARSE_ERR')
" 2>/dev/null)

  agent_count=$(printf "%s" "$agents_resp" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    agents = d.get('agents') or []
    print(len(agents))
except Exception:
    print('-1')
" 2>/dev/null)

  if [ "$has_cgi" = "NO" ]; then
    pass "CodeGraphIndexer is NOT registered (kill-switch honored)"
  else
    fail "CodeGraphIndexer IS registered with CODE_GRAPH_INDEX_DISABLED=1 set (kill-switch broken: $has_cgi)"
  fi

  # ADR-027 v2 documents 8 agents when CodeGraphIndexer is suppressed.
  # If a new agent ships, update this number alongside the new registerAgent
  # call — the failure message tells you exactly what the count was so the
  # update is mechanical.
  if [ "$agent_count" = "8" ]; then
    pass "agent count is 8 (1 less than the normal 9 — kill-switch honored)"
  else
    fail "expected 8 agents with kill-switch on, got $agent_count — either kill-switch broke or a new agent shipped without updating this assertion"
  fi
fi

rm -f "$LOG_FILE"

echo ""
echo "═══════════════════════════════════════════════════"
echo "Kill-switch smoke: $pass_count passed, $fail_count failed"
echo "═══════════════════════════════════════════════════"

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
exit 0
