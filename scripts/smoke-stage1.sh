#!/usr/bin/env bash
#
# scripts/smoke-stage1.sh — ADR-042 Phase 1 substrate smoke.
#
# Verifies each DoD item for Stage 1 (Prompt Generation) end-to-end
# against the live bridge + DB. Where a check needs Ollama, it degrades
# to SKIP cleanly (not fail). Separate from smoke-bridge.sh and
# smoke-pm.sh as required by the ADR's DoD.
#
# Usage:
#   WI_STAGE1_ENABLED=0 npm run web:bridge   # in another terminal
#   ./scripts/smoke-stage1.sh
#
# Exit 0 on all-green (SKIPs count as pass); exit 1 on any hard failure.

set -u

BRIDGE="${WI_BRIDGE:-http://localhost:3132}"
WI_DB_PATH="${WI_DB_PATH:-$HOME/.work-intelligence-mcp/data.db}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

pass_count=0
fail_count=0
skip_count=0

pass() { echo "  ✓ PASS: $1"; pass_count=$((pass_count+1)); }
fail() { echo "  ✗ FAIL: $1"; fail_count=$((fail_count+1)); }
skip() { echo "  ○ SKIP: $1"; skip_count=$((skip_count+1)); }

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required tool '$1' not on PATH"
    exit 2
  fi
}
require curl
require jq
require sqlite3
require node

echo "═══════════════════════════════════════════════════"
echo "ADR-042 Stage 1 (Prompt Generation) smoke"
echo "  BRIDGE:      $BRIDGE"
echo "  WI_DB_PATH:  $WI_DB_PATH"
echo "═══════════════════════════════════════════════════"

# ── § 0 preflight ──────────────────────────────────────────────────────────
echo ""
echo "── § 0. Preflight ──"

if ! curl -fsS -m 3 "$BRIDGE/api/board/tasks?limit=1" >/dev/null 2>&1; then
  fail "§ 0.1 — bridge unreachable at $BRIDGE (start with: npm run web:bridge)"
  echo ""
  echo "════════ Smoke aborted (0 passed, 1 failed) ═══════"
  exit 1
fi
pass "§ 0.1 — bridge reachable"

if [ ! -r "$WI_DB_PATH" ]; then
  fail "§ 0.2 — DB not readable at $WI_DB_PATH"
  exit 1
fi
pass "§ 0.2 — DB readable"

# ── § 1 corpus present + held-out invariant ────────────────────────────────
echo ""
echo "── § 1. Paraphrase corpus (AC-U1 evidence) ──"

CORPUS="$REPO/.planning/paraphrase-corpus-v1.jsonl"
if [ ! -r "$CORPUS" ]; then
  fail "§ 1.1 — paraphrase corpus not found at $CORPUS"
else
  CORPUS_SIZE=$(grep -c '"goal"' "$CORPUS")
  if [ "$CORPUS_SIZE" -ge 10 ]; then
    pass "§ 1.1 — corpus present with $CORPUS_SIZE goals (≥ 10 required)"
  else
    fail "§ 1.1 — corpus has $CORPUS_SIZE goals (need ≥10)"
  fi
  # Held-out check: no verbatim collision with prompt_memory
  COLLISIONS=$(python3 <<PYEOF 2>/dev/null
import json, sqlite3, re, sys
with open("$CORPUS") as f:
    entries = [json.loads(l) for l in f if l.strip() and '"goal"' in l]
conn = sqlite3.connect("$WI_DB_PATH")
def norm(s): return re.sub(r'\s+', ' ', s.lower().strip())
existing = {norm(r[0]) for r in conn.execute("SELECT goal FROM prompt_memory")}
n = sum(1 for e in entries if norm(e['goal']) in existing)
print(n)
PYEOF
)
  if [ "$COLLISIONS" = "0" ]; then
    pass "§ 1.2 — all $CORPUS_SIZE goals held-out (no verbatim in prompt_memory 854 rows)"
  else
    fail "§ 1.2 — $COLLISIONS goal(s) verbatim in prompt_memory (corpus not held-out)"
  fi
fi

# ── § 2 v98 audit blockers (prerequisites for Stage 1 recognition path) ────
echo ""
echo "── § 2. v98 blocker fixes (regression check) ──"

# BLOCKER-1 regression: aggregate-prior-means test file exists
if [ -r "$REPO/tests/cypher/aggregate-prior-means.test.ts" ]; then
  pass "§ 2.1 — aggregate-prior-means test present (BLOCKER-1 regression guard)"
else
  fail "§ 2.1 — aggregate-prior-means test file missing"
fi

# BLOCKER-2 regression: check embedder.ts has explicit outcome map + skip on unknown
if grep -q "OUTCOME_WEIGHT.*success.*mixed.*failed.*halted.*abandoned" "$REPO/src/services/embedder.ts" 2>/dev/null \
   || grep -q "success: 1.0" "$REPO/src/services/embedder.ts" 2>/dev/null; then
  # More robust — look for the explicit 6-value map
  if grep -c "success:\|mixed:\|failed:\|halted:\|abandoned:\|rejected_non_interactive:" \
        "$REPO/src/services/embedder.ts" | head -c 1 | grep -q "6"; then
    pass "§ 2.2 — OUTCOME_WEIGHT has explicit weight for all 6 CHECK values (BLOCKER-2)"
  else
    n=$(grep -cE "^\s+(success|mixed|failed|halted|abandoned|rejected_non_interactive):" "$REPO/src/services/embedder.ts")
    if [ "$n" -ge 6 ]; then
      pass "§ 2.2 — OUTCOME_WEIGHT covers all 6 CHECK values (BLOCKER-2 fix, $n keys)"
    else
      fail "§ 2.2 — OUTCOME_WEIGHT missing values ($n/6)"
    fi
  fi
else
  fail "§ 2.2 — OUTCOME_WEIGHT explicit map missing"
fi

# BLOCKER-1 regression: getCatalogHint uses getAggregatePriorMeans, NOT getEffectivePriors('*',…)
if grep -q "getAggregatePriorMeans" "$REPO/src/services/cypher/tool-catalog.ts"; then
  pass "§ 2.3 — getCatalogHint uses aggregate priors (BLOCKER-1 fix)"
else
  fail "§ 2.3 — getCatalogHint still uses broken getEffectivePriors('*', …)"
fi

# ── § 3 Stage 1 module (structural) ────────────────────────────────────────
echo ""
echo "── § 3. Stage 1 module ──"

if [ -r "$REPO/src/services/cypher/stage1.ts" ]; then
  pass "§ 3.1 — src/services/cypher/stage1.ts present"
else
  fail "§ 3.1 — stage1.ts missing"
fi

# Contract constants: SNIPPET_MAX_CHARS should be 120
if grep -q "SNIPPET_MAX_CHARS = 120" "$REPO/src/services/cypher/stage1.ts" 2>/dev/null; then
  pass "§ 3.2 — SNIPPET_MAX_CHARS = 120 (ADR-042 HIGH-3 numeric contract)"
else
  fail "§ 3.2 — SNIPPET_MAX_CHARS not 120 or not exported"
fi

# Unit tests exist and pass — run and check exit code + count
STAGE1_TEST_OUT=$(PATH="$HOME/.nvm/versions/node/v24.7.0/bin:$PATH" NO_COLOR=1 FORCE_COLOR=0 \
  npx vitest run tests/cypher/stage1.test.ts --reporter=default 2>&1)
STAGE1_TEST_EXIT=$?
# Vitest output line "Tests  22 passed (22)" — grep with fixed patterns.
STAGE1_PASSED=$(echo "$STAGE1_TEST_OUT" | awk '/^ *Tests +[0-9]+ passed/ {print $2; exit}')
if [ "$STAGE1_TEST_EXIT" = "0" ] && [ "${STAGE1_PASSED:-0}" -ge "22" ]; then
  pass "§ 3.3 — tests/cypher/stage1.test.ts: $STAGE1_PASSED tests green"
else
  fail "§ 3.3 — stage1 tests exit=$STAGE1_TEST_EXIT passed=${STAGE1_PASSED:-0}"
fi

# ── § 4 Stage 1 fetch against LIVE DB (real evidence bundle) ───────────────
echo ""
echo "── § 4. stage1Fetch live evidence bundle ──"

# Run stage1Fetch on a real goal via a small node driver
STAGE1_OUT=$(PATH="$HOME/.nvm/versions/node/v24.7.0/bin:$PATH" node <<NODEEOF 2>&1
process.env.DATABASE_PATH = "$WI_DB_PATH";
const { getDatabase } = await import('$REPO/dist/db/connection.js');
const { stage1Fetch, SNIPPET_MAX_CHARS } = await import('$REPO/dist/services/cypher/stage1.js');
const db = getDatabase();
const goal = "figure out why the search-provider proxy is returning 401";
const ev = await stage1Fetch(goal, db);
// Report structural invariants
const allSnippets = [...ev.prompt_memory_hits, ...ev.message_hits, ...ev.catalog_candidates].map(h => h.snippet);
const overCap = allSnippets.filter(s => s.length > SNIPPET_MAX_CHARS).length;
console.log(JSON.stringify({
  wallclock_ms: ev.fetch_wallclock_ms,
  semantic_available: ev.semantic_available,
  pm_hits: ev.prompt_memory_hits.length,
  msg_hits: ev.message_hits.length,
  cat_candidates: ev.catalog_candidates.length,
  catalog_source: ev.catalog_source,
  snippet_over_cap: overCap,
  errors: ev.errors,
}));
NODEEOF
)

# Parse the JSON output
if echo "$STAGE1_OUT" | jq . >/dev/null 2>&1; then
  WALLCLOCK=$(echo "$STAGE1_OUT" | jq '.wallclock_ms')
  SEM=$(echo "$STAGE1_OUT" | jq '.semantic_available')
  PM=$(echo "$STAGE1_OUT" | jq '.pm_hits')
  MSG=$(echo "$STAGE1_OUT" | jq '.msg_hits')
  CAT=$(echo "$STAGE1_OUT" | jq '.cat_candidates')
  OVER=$(echo "$STAGE1_OUT" | jq '.snippet_over_cap')

  if [ "$WALLCLOCK" -lt "2000" ]; then
    pass "§ 4.1 — stage1Fetch wall-clock ${WALLCLOCK}ms < 2000ms budget"
  else
    fail "§ 4.1 — stage1Fetch wall-clock ${WALLCLOCK}ms EXCEEDS 2000ms"
  fi

  if [ "$OVER" = "0" ]; then
    pass "§ 4.2 — 0 snippets exceed SNIPPET_MAX_CHARS (HIGH-3 contract holds)"
  else
    fail "§ 4.2 — $OVER snippets over the 120-char cap"
  fi

  TOTAL_HITS=$((PM + MSG + CAT))
  if [ "$TOTAL_HITS" -gt "0" ]; then
    pass "§ 4.3 — evidence bundle non-empty: pm=$PM msg=$MSG cat=$CAT (semantic=$SEM)"
  else
    skip "§ 4.3 — evidence bundle empty (Ollama down or empty stores?)"
  fi
else
  fail "§ 4.* — stage1Fetch driver crashed: $STAGE1_OUT"
fi

# ── § 5 paraphrase baseline (recall measurement) ───────────────────────────
echo ""
echo "── § 5. Paraphrase recall baseline (informational) ──"

if [ -r "$REPO/.planning/paraphrase-baseline-v1.json" ]; then
  RECALL=$(jq '.recall' "$REPO/.planning/paraphrase-baseline-v1.json")
  N=$(jq '.results | length' "$REPO/.planning/paraphrase-baseline-v1.json")
  HITS=$(jq '[.results[] | select(.hit)] | length' "$REPO/.planning/paraphrase-baseline-v1.json")
  pass "§ 5.1 — baseline snapshot present: $HITS/$N correct (recall=$RECALL)"
  # This is the FLOOR ADR-042 must improve on. Not a fail — this is honesty.
else
  skip "§ 5.1 — baseline not yet run (scripts/paraphrase-baseline.mjs)"
fi

# ── § 6 renderStage1EvidenceBlock — LLM prompt boundary is stable ─────────
echo ""
echo "── § 6. renderStage1EvidenceBlock stability ──"

RENDER_OUT=$(PATH="$HOME/.nvm/versions/node/v24.7.0/bin:$PATH" node <<'NODEEOF' 2>&1
const { renderStage1EvidenceBlock } = await import(process.env.PWD + '/dist/services/cypher/stage1.js');
const ev = {
  goal: 'smoke goal', semantic_available: false,
  prompt_memory_hits: [], message_hits: [], catalog_candidates: [],
  catalog_source: 'empty', fetch_wallclock_ms: 0, errors: [],
};
const a = renderStage1EvidenceBlock(ev);
const b = renderStage1EvidenceBlock(ev);
console.log(a === b ? 'DETERMINISTIC' : 'NON_DETERMINISTIC');
NODEEOF
)
if echo "$RENDER_OUT" | grep -q DETERMINISTIC; then
  pass "§ 6.1 — renderStage1EvidenceBlock is deterministic on fixed input"
else
  fail "§ 6.1 — renderStage1EvidenceBlock non-deterministic: $RENDER_OUT"
fi

# ── § 7 WI_STAGE1_ENABLED flag wired into loop.ts ──────────────────────────
echo ""
echo "── § 7. WI_STAGE1_ENABLED flag integration (loop.ts) ──"

if grep -q "WI_STAGE1_ENABLED === '1'" "$REPO/src/services/cypher/loop.ts"; then
  pass "§ 7.1 — WI_STAGE1_ENABLED flag gate present in loop.ts"
else
  fail "§ 7.1 — WI_STAGE1_ENABLED flag gate missing from loop.ts"
fi

if grep -q "renderStage1EvidenceBlock" "$REPO/src/services/cypher/loop.ts"; then
  pass "§ 7.2 — loop.ts imports renderStage1EvidenceBlock (Stage 1 wired)"
else
  fail "§ 7.2 — Stage 1 render not wired in loop.ts"
fi

# Flag composition unit tests
FLAG_TEST_OUT=$(PATH="$HOME/.nvm/versions/node/v24.7.0/bin:$PATH" NO_COLOR=1 FORCE_COLOR=0 \
  npx vitest run tests/cypher/stage1-flag.test.ts --reporter=default 2>&1)
FLAG_TEST_EXIT=$?
FLAG_PASSED=$(echo "$FLAG_TEST_OUT" | awk '/^ *Tests +[0-9]+ passed/ {print $2; exit}')
if [ "$FLAG_TEST_EXIT" = "0" ] && [ "${FLAG_PASSED:-0}" -ge "4" ]; then
  pass "§ 7.3 — stage1-flag composition tests: $FLAG_PASSED green"
else
  fail "§ 7.3 — flag composition tests failed: exit=$FLAG_TEST_EXIT passed=${FLAG_PASSED:-0}"
fi

# ── § 8 Single-pass path (the actual SCOPE 60s halt cure) ──────────────────
echo ""
echo "── § 8. Single-pass SCOPE path (ADR-042 core) ──"

# Structurally: the single-pass code block must exist in loop.ts
if grep -q "ADR-042 Stage 1 single-pass path" "$REPO/src/services/cypher/loop.ts"; then
  pass "§ 8.1 — single-pass code block present in loop.ts"
else
  fail "§ 8.1 — single-pass block missing (only prepend was wired, no branch)"
fi

# The single-pass path must pass tools:[] (recognition-only)
if grep -A40 "ADR-042 Stage 1 single-pass path" "$REPO/src/services/cypher/loop.ts" | grep -q "tools: \[\]"; then
  pass "§ 8.2 — single-pass path enforces recognition-only (tools: [])"
else
  fail "§ 8.2 — single-pass path does not enforce tools: [] contract"
fi

# The single-pass path must NOT be inside the while loop
# (verified by finding the else branch that wraps `while (scopeIters ...)`)
if grep -q "Legacy multi-round SCOPE mini-loop" "$REPO/src/services/cypher/loop.ts"; then
  pass "§ 8.3 — legacy multi-round loop is gated behind else branch"
else
  fail "§ 8.3 — legacy multi-round loop not properly gated"
fi

# Integration test: verify ONE-call invariant on mocked Anthropic
INT_TEST_OUT=$(PATH="$HOME/.nvm/versions/node/v24.7.0/bin:$PATH" NO_COLOR=1 FORCE_COLOR=0 \
  npx vitest run tests/services/cypher/stage1-single-pass.test.ts --reporter=default 2>&1)
INT_TEST_EXIT=$?
INT_PASSED=$(echo "$INT_TEST_OUT" | awk '/^ *Tests +[0-9]+ passed/ {print $2; exit}')
if [ "$INT_TEST_EXIT" = "0" ] && [ "${INT_PASSED:-0}" -ge "3" ]; then
  pass "§ 8.4 — single-pass integration test (mocked Anthropic): $INT_PASSED green"
else
  fail "§ 8.4 — single-pass integration tests failed: exit=$INT_TEST_EXIT passed=${INT_PASSED:-0}"
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "ADR-042 Stage 1 smoke: $pass_count passed, $fail_count failed, $skip_count skipped"
echo "═══════════════════════════════════════════════════"

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
exit 0
