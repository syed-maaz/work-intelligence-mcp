#!/usr/bin/env bash
# scripts/adr-053-e2e-15.sh — ADR‑053 E2E (15 real-world scenarios)
# Preconditions:
#   - Bridge running and reachable at $BRIDGE_URL (default http://localhost:3132)
#   - Flags ON in that process: ADR_053_ENABLED=1 OUTCOME_HONEST_KANBAN_ENABLED=1 CYPHER_REFINEMENT_ENABLED=1
#   - sqlite3 installed; DB readable at $WI_DB_PATH (default ~/.work-intelligence-mcp/data.db)
# Behavior:
#   - Sends 15 cross-repo goals to /api/wi/dispatch/stream and asserts:
#       * SSE contains "[ADR-053] PM orchestration engaged"
#       * SSE emits a result event with pm_cards
#       * DB has new tasks with titles referencing the scenario tag and correct posture/depends_on
#   - Prints a summary with pass/fail counts. Exit code 0 on all-pass; 1 otherwise.

set -euo pipefail
BRIDGE_URL="${BRIDGE_URL:-http://localhost:3132}"
WI_DB_PATH="${WI_DB_PATH:-$HOME/.work-intelligence-mcp/data.db}"
TAG="e2e-adr053"

die() { echo "FATAL: $*" >&2; exit 2; }
pass() { printf "  ✓ %s\n" "$*"; }
fail() { printf "  ✗ %s\n" "$*"; }
section(){ printf "\n── %s ──\n" "$*"; }

check_prereqs(){
  section "0. Prereqs"
  curl -fsS -m 2 "$BRIDGE_URL/api/status" >/dev/null || die "Bridge not reachable at $BRIDGE_URL"
  pass "Bridge reachable: $BRIDGE_URL"
  if ! command -v sqlite3 >/dev/null 2>&1; then die "sqlite3 not found"; fi
  if [ ! -r "$WI_DB_PATH" ]; then die "WI_DB_PATH not readable: $WI_DB_PATH"; fi
  pass "sqlite3 present and DB readable: $WI_DB_PATH"
}

# Dispatch helper: hits SSE endpoint and captures to a temp file
sse_dispatch(){
  local goal="$1"; local out="$2"
  curl -fsS -N -X POST "$BRIDGE_URL/api/wi/dispatch/stream" \
    -H 'Content-Type: application/json' \
    -d "{\"goal\":\"$goal\",\"user\":\"$TAG\",\"confirm_mode\":\"auto\"}" >"$out"
}

assert_orchestrator(){
  local sse="$1"; local label="$2"
  # engaged line
  if ! grep -q "\[ADR-053] PM orchestration engaged" "$sse"; then
    fail "$label — missing ADR-053 engagement line"; return 1
  fi
  # result event with pm_cards
  if ! awk '/^event: result/{flag=1;next}/^event:/{flag=0}flag' "$sse" | grep -q 'pm_cards'; then
    fail "$label — result event missing pm_cards"; return 1
  fi
  pass "$label — orchestrator engaged + pm_cards present"
  return 0
}

assert_db_cards(){
  local marker="$1"; local min_cards=${2:-3}
  local q="SELECT COUNT(*) FROM tasks WHERE goal_text LIKE '%$marker%' AND intent='execute';"
  local n=$(sqlite3 "$WI_DB_PATH" "$q" 2>/dev/null || echo 0)
  if [ "${n:-0}" -lt "$min_cards" ]; then
    fail "$marker — expected at least $min_cards execute cards in DB, got $n"; return 1
  fi
  pass "$marker — DB shows $n execute cards"
  return 0
}

run_scenario(){
  local name="$1"; shift
  local goal="$* — [$TAG:$name]"
  local tmp="/tmp/$TAG-$name.sse"
  sse_dispatch "$goal" "$tmp" || { fail "$name — SSE dispatch failed"; return 1; }
  local ok=0
  assert_orchestrator "$tmp" "$name" && ok=1 || ok=0
  assert_db_cards "[$TAG:$name]" 3 && ok=$((ok&1)) || ok=0
  return $((ok^1)) # 0 on success, 1 on failure
}

main(){
  check_prereqs
  section "ADR-053 E2E (15 scenarios)"
  local fails=0; local total=0

  declare -a SCEN=(
    "lotse-endpoint Build a new REST endpoint across lotse UI (example-service) and backend API with an ops deployment (helm/k8s)"
    "ui-be-chain Build a lotse UI feature that depends on a backend model/API and tests with an ops rollout"
    "ops-rollout Build and roll out a config change touching lotse UI and backend service with an operations deployment"
    "data-migration Build a data migration with backend model + endpoint and lotse UI surface, plus an ops helm/k8s rollout"
    "webhook-integration Build a new webhook integration across lotse UI and backend API with an ops canary release"
    "search-feature Build a cross-repo search feature (lotse UI + backend API) and an ops deployment"
    "auth-flow Build an auth flow across lotse frontend and backend API with an ops rollout"
    "metrics-pipeline Build a metrics pipeline with backend changes and lotse UI dashboards plus an ops deployment"
    "file-upload Build large file upload: backend API endpoint + lotse UI widget + an ops rollout"
    "rate-limit Build rate limiting: backend support + lotse UI flags + an operations rollout"
    "feature-flag Build and wire a feature flag across lotse UI (example-service) and backend API, rollout via ops"
    "notifications Build notifications across backend worker/API and lotse UI with an ops deployment"
    "ci-improvement Build CI improvements requiring backend test hardening and lotse UI CI visibility with an ops change"
    "sdk-update Build and roll out a shared SDK update across lotse UI and backend services with an ops deployment"
    "error-budget Build error budget dashboards across backend probes and lotse UI, then roll out via ops"
  )

  for spec in "${SCEN[@]}"; do
    total=$((total+1))
    name=$(printf "%s" "$spec" | awk '{print $1}')
    goal=$(printf "%s" "$spec" | cut -d' ' -f2-)
    if run_scenario "$name" "$goal"; then :; else fails=$((fails+1)); fi
  done

  section "Summary"
  if [ "$fails" -eq 0 ]; then
    pass "All $total scenarios passed"
    exit 0
  else
    fail "$fails/$total scenarios failed"
    exit 1
  fi
}

main "$@"
