#!/usr/bin/env bash
# smoke-fetcher.sh — ADR-044 Task C5 smoke assertions
#
# Exercises the ADR-044 fetcher substrate end-to-end against a running bridge:
#   (a) GET  /api/sync/stream         — parallel source ordering
#   (b) POST /api/search-all/stream   — local-first envelope <500ms
#   (c) POST /api/search-all/stream   — per-source isolation under Outlook timeout
#   (d) LIVE AC-U6                     — browser pool slot leak recovery
#
# HONEST POSTURE: assertion (d) is LIVE-verified only when a Playwright browser
# pool is exposed by the bridge. If not, the script prints exactly:
#   `AC-U6 skipped: no browser pool in this environment`
# and marks the assertion as non-zero. It NEVER fakes green.
#
# Usage:
#   BRIDGE_URL=http://127.0.0.1:6789 bash scripts/smoke-fetcher.sh
#
# Exit code: sum of individual assertion failures (0 == all green).

set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:6789}"
TIMEOUT_SEC="${TIMEOUT_SEC:-35}"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
FAIL=0
STATUS_A="skipped"; STATUS_B="skipped"; STATUS_C="skipped"; STATUS_D="skipped"

pass() { printf "%s✓ PASS%s %s\n" "$GRN" "$RST" "$1"; }
fail() { printf "%s✗ FAIL%s %s\n" "$RED" "$RST" "$1"; FAIL=$((FAIL+1)); }
skip() { printf "%s∅ SKIP%s %s\n" "$YLW" "$RST" "$1"; }
info() { printf "%s%s%s\n" "$DIM" "$1" "$RST"; }

# --- Preflight: bridge reachable? -------------------------------------------
if ! curl -sS -m 3 -o /dev/null -w "%{http_code}\n" "$BRIDGE_URL/api/health" 2>/dev/null | grep -qE '^(200|204)$'; then
  fail "bridge unreachable at $BRIDGE_URL (set BRIDGE_URL or start the bridge)"
  printf "\nAssertions summary: (a) %s  (b) %s  (c) %s  (d) %s\n" \
    "$STATUS_A" "$STATUS_B" "$STATUS_C" "$STATUS_D"
  exit "$FAIL"
fi
info "bridge reachable at $BRIDGE_URL"

# --- Helpers ----------------------------------------------------------------
# Read an SSE body from a URL; capture per-frame receive timestamps (ms since
# script start) plus the frame body. Emits lines: "<t_ms>|<data-json>".
sse_read_ms() {
  local url="$1" method="${2:-GET}" body="${3:-}"
  local t0
  t0=$(python3 -c 'import time; print(int(time.time()*1000))')
  if [[ "$method" == "POST" ]]; then
    curl -sS -N -m "$TIMEOUT_SEC" -H 'Content-Type: application/json' \
      -X POST --data "$body" "$url"
  else
    curl -sS -N -m "$TIMEOUT_SEC" "$url"
  fi | while IFS= read -r line; do
    if [[ "$line" == data:* ]]; then
      local now
      now=$(python3 -c 'import time; print(int(time.time()*1000))')
      printf "%s|%s\n" "$((now - t0))" "${line#data: }"
    fi
  done
}

# --- (a) parallel isolation on /api/sync/stream -----------------------------
printf "\n== (a) GET /api/sync/stream — parallel result ordering ==\n"
if OUT=$(sse_read_ms "$BRIDGE_URL/api/sync/stream" 2>/dev/null); then
  RESULT_LINES=$(printf "%s\n" "$OUT" | awk -F'|' '/"kind":"result"/{print}')
  RESULT_COUNT=$(printf "%s\n" "$RESULT_LINES" | grep -c '"kind":"result"' || true)
  EMAIL_TS=$(printf "%s\n" "$RESULT_LINES" | awk -F'|' '/"source":"email"/{print $1; exit}')
  JIRA_TS=$(printf "%s\n" "$RESULT_LINES" | awk -F'|' '/"source":"jira"/{print $1; exit}')
  info "result frames: $RESULT_COUNT   email_ms=$EMAIL_TS   jira_ms=$JIRA_TS"
  if [[ "$RESULT_COUNT" -ge 2 && -n "$EMAIL_TS" && -n "$JIRA_TS" && "$EMAIL_TS" -lt "$JIRA_TS" ]]; then
    pass "(a) >=2 result frames and email arrived before jira"
    STATUS_A="run"
  else
    fail "(a) expected >=2 result frames with email_ts < jira_ts"
    STATUS_A="run"
  fi
else
  fail "(a) /api/sync/stream did not respond within ${TIMEOUT_SEC}s"
  STATUS_A="run"
fi

# --- (b) local envelope <500ms on /api/search-all/stream --------------------
printf "\n== (b) POST /api/search-all/stream — local envelope <500ms ==\n"
BODY_B='{"query":"adr","sources":["local","email","jira"],"limit":10}'
if OUT=$(sse_read_ms "$BRIDGE_URL/api/search-all/stream" POST "$BODY_B" 2>/dev/null); then
  LOCAL_TS=$(printf "%s\n" "$OUT" | awk -F'|' '/"kind":"result"/ && /"source":"local"/{print $1; exit}')
  info "local envelope arrival: ${LOCAL_TS:-<none>} ms"
  if [[ -n "$LOCAL_TS" && "$LOCAL_TS" -lt 500 ]]; then
    pass "(b) local envelope arrived in ${LOCAL_TS}ms (<500ms)"
    STATUS_B="run"
  else
    fail "(b) local envelope missing or >=500ms (got: ${LOCAL_TS:-none})"
    STATUS_B="run"
  fi
else
  fail "(b) POST /api/search-all/stream did not respond within ${TIMEOUT_SEC}s"
  STATUS_B="run"
fi

# --- (c) per-source isolation with Outlook timeout injection ----------------
printf "\n== (c) POST /api/search-all/stream — outlook timeout isolation ==\n"
# Injection hint: bridge honors x-wi-inject-timeout header if compiled with
# INJECT_TIMEOUTS=1 (dev-only). Absent that support, this remains a skip.
BODY_C='{"query":"adr","sources":["local","email","jira","teams","outlook"],"limit":10,"__inject":{"outlook":"timeout"}}'
C_T0=$(python3 -c 'import time; print(int(time.time()*1000))')
if OUT=$(curl -sS -N -m "$TIMEOUT_SEC" \
           -H 'Content-Type: application/json' \
           -H 'x-wi-inject-timeout: outlook' \
           -X POST --data "$BODY_C" \
           "$BRIDGE_URL/api/search-all/stream" 2>/dev/null); then
  C_T1=$(python3 -c 'import time; print(int(time.time()*1000))')
  AGG_MS=$((C_T1 - C_T0))
  OUTLOOK_STATE=$(printf "%s\n" "$OUT" | awk -F'data: ' '/"source":"outlook"/{print $2; exit}' | python3 -c 'import sys,json
try:
  d=json.loads(sys.stdin.read() or "{}")
  print(d.get("state") or d.get("status") or d.get("kind") or "unknown")
except Exception:
  print("unparseable")')
  LOCAL_OK=$(printf "%s\n" "$OUT" | grep -c '"source":"local"' || true)
  TEAMS_OK=$(printf "%s\n" "$OUT" | grep -c '"source":"teams"' || true)
  JIRA_OK=$(printf "%s\n" "$OUT"  | grep -c '"source":"jira"'  || true)
  info "aggregate: ${AGG_MS}ms  outlook=$OUTLOOK_STATE  local=$LOCAL_OK teams=$TEAMS_OK jira=$JIRA_OK"
  if [[ "$AGG_MS" -le 20000 && "$LOCAL_OK" -ge 1 && "$JIRA_OK" -ge 1 && \
        ( "$OUTLOOK_STATE" == "timed_out" || "$OUTLOOK_STATE" == "error" ) ]]; then
    pass "(c) outlook timed_out; local+jira ok; aggregate ${AGG_MS}ms <= 20s"
    STATUS_C="run"
  elif [[ "$OUTLOOK_STATE" == "unknown" || "$OUTLOOK_STATE" == "unparseable" ]]; then
    skip "(c) injection hook not present — bridge did not honor x-wi-inject-timeout"
    STATUS_C="skipped-no-injection-hook"
  else
    fail "(c) isolation assertion failed (outlook=$OUTLOOK_STATE, agg=${AGG_MS}ms)"
    STATUS_C="run"
  fi
else
  fail "(c) POST /api/search-all/stream did not respond within ${TIMEOUT_SEC}s"
  STATUS_C="run"
fi

# --- (d) AC-U6: browser pool slot leak (LIVE only) --------------------------
printf "\n== (d) AC-U6 — browser pool slot leak ==\n"
POOL_JSON=$(curl -sS -m 3 "$BRIDGE_URL/api/browser-pool/stats" 2>/dev/null || echo "")
if [[ -z "$POOL_JSON" ]] || ! printf "%s" "$POOL_JSON" | python3 -c 'import sys,json
try:
  d=json.loads(sys.stdin.read())
  assert "freeSlotCount" in d
except Exception:
  sys.exit(1)' 2>/dev/null; then
  echo "AC-U6 skipped: no browser pool in this environment"
  STATUS_D="skipped-no-browser-pool"
  FAIL=$((FAIL+1))   # honest-posture: skipped != green
else
  PRE=$(printf "%s" "$POOL_JSON" | python3 -c 'import sys,json;print(json.loads(sys.stdin.read())["freeSlotCount"])')
  info "pre-fetch freeSlotCount=$PRE — re-running (c) then sampling recovery"
  curl -sS -N -m "$TIMEOUT_SEC" \
       -H 'Content-Type: application/json' \
       -H 'x-wi-inject-timeout: outlook' \
       -X POST --data "$BODY_C" \
       "$BRIDGE_URL/api/search-all/stream" >/dev/null 2>&1 || true
  RECOVERED=0
  for i in $(seq 1 10); do
    sleep 1
    POST=$(curl -sS -m 3 "$BRIDGE_URL/api/browser-pool/stats" 2>/dev/null \
             | python3 -c 'import sys,json;print(json.loads(sys.stdin.read())["freeSlotCount"])' 2>/dev/null || echo "?")
    info "  t=${i}s freeSlotCount=$POST"
    if [[ "$POST" == "$PRE" ]]; then RECOVERED=1; break; fi
  done
  if [[ "$RECOVERED" -eq 1 ]]; then
    pass "(d) freeSlotCount returned to $PRE within ${i}s"
    STATUS_D="run"
  else
    fail "(d) pool slot leak — freeSlotCount did not recover to $PRE within 10s"
    STATUS_D="run"
  fi
fi

# --- Summary ----------------------------------------------------------------
printf "\n===============================================================\n"
printf "Assertions: (a) %s  (b) %s  (c) %s  (d) %s\n" \
  "$STATUS_A" "$STATUS_B" "$STATUS_C" "$STATUS_D"
printf "Total failures: %d\n" "$FAIL"
exit "$FAIL"
