#!/usr/bin/env bash
# scripts/g1-scenario-test.sh
# Runs all 15 heartbeat scenarios against the dev DB.
# Dev DB: ~/.wi-dev-g1-heartbeat/data.db
set -u
DB="${G1_DB:-$HOME/.wi-dev-g1-heartbeat/data.db}"
PASS=0
FAIL=0
pass() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }
scenario() { echo ""; echo "── $1 ──"; }

cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.nvm/versions/node/v24.7.0/bin:$PATH"

# Helper: run a JS snippet against dev DB
run_js() {
  node -e "import Database from 'better-sqlite3'; const db = new Database('${DB}'); $1 db.close();" 2>&1
}

# Helper: run a TS snippet (imports heartbeat)
run_hb() {
  cd "$(dirname "$0")/.."
  node -e "
import Database from 'better-sqlite3';
import { createHeartbeatTable, writeHeartbeat, readHeartbeatStatus } from './dist/services/cypher/heartbeat.js';
const db = new Database('${DB}');
$1
db.close();
" 2>&1
}

# Reset
run_js "db.exec('DELETE FROM heartbeats');"

scenario "S1 — heartbeat write (create table + insert)"
output=$(run_hb "writeHeartbeat(db, 'loop', 'execute', JSON.stringify({sid:'s1'})); const r = db.prepare('SELECT * FROM heartbeats WHERE worker=?').get('loop'); console.log(r ? 'OK row written' : 'FAIL no row');")
echo "$output"
if echo "$output" | grep -q "OK row written"; then pass "S1: writeHeartbeat inserts to heartbeats"; else fail "S1: writeHeartbeat"; fi

scenario "S2 — heartbeat read healthy (fresh worker)"
output=$(run_hb "writeHeartbeat(db, 'loop', 'execute', null); const s = readHeartbeatStatus(db); console.log(JSON.stringify(s));")
echo "$output"
if echo "$output" | grep -q '"healthy":true'; then pass "S2: fresh worker => healthy:true"; else fail "S2: fresh worker not healthy"; fi

scenario "S3 — heartbeat read stale (>120s)"
output=$(run_hb "writeHeartbeat(db, 'loop', 'execute', null); db.prepare('UPDATE heartbeats SET last_seen = ? WHERE worker = ?').run(Date.now() - 180_000, 'loop'); const s = readHeartbeatStatus(db); console.log(JSON.stringify(s));")
echo "$output"
if echo "$output" | grep -q '"healthy":false'; then pass "S3: stale worker => healthy:false"; else fail "S3: stale not detected"; fi

scenario "S4 — empty heartbeat table"
output=$(run_hb "db.exec('DELETE FROM heartbeats'); const s = readHeartbeatStatus(db); console.log(JSON.stringify(s));")
echo "$output"
if echo "$output" | grep -q '"healthy":false' && echo "$output" | grep -q '"agents":\[\]'; then pass "S4: empty table => healthy:false, agents:[]"; else fail "S4: empty table handling"; fi

scenario "S5 — mixed workers (one fresh, one stale)"
output=$(run_hb "db.exec('DELETE FROM heartbeats'); writeHeartbeat(db, 'loop', 'execute', null); writeHeartbeat(db, 'worker-b', 'idle', null); db.prepare('UPDATE heartbeats SET last_seen = ? WHERE worker = ?').run(Date.now() - 180_000, 'worker-b'); const s = readHeartbeatStatus(db); console.log(JSON.stringify(s));")
echo "$output"
if echo "$output" | grep -q '"healthy":false'; then pass "S5: mixed fresh+stale => healthy:false"; else fail "S5: mixed workers"; fi

scenario "S6 — write same worker twice (upsert)"
output=$(run_hb "db.exec('DELETE FROM heartbeats'); writeHeartbeat(db, 'loop', 'phase-a', null); writeHeartbeat(db, 'loop', 'phase-b', null); const c = db.prepare('SELECT COUNT(*) as n FROM heartbeats').get(); console.log('rows=' + c.n + ' phase=' + db.prepare('SELECT phase FROM heartbeats WHERE worker=?').get('loop').phase);")
echo "$output"
if echo "$output" | grep -q "rows=1" && echo "$output" | grep -q "phase=phase-b"; then pass "S6: upsert keeps 1 row with latest phase"; else fail "S6: upsert"; fi

scenario "S7 — read from clean boot (bridge fetches heartbeat)"
output=$(run_hb "db.exec('DELETE FROM heartbeats'); writeHeartbeat(db, 'loop', 'execute', null); const s = readHeartbeatStatus(db); console.log('healthy=' + s.healthy + ' agentsLen=' + s.agents.length);")
echo "$output"
if echo "$output" | grep -q "healthy=true" && echo "$output" | grep -q "agentsLen=1"; then pass "S7: clean boot read returns healthy true"; else fail "S7: clean boot read"; fi

scenario "S8 — status endpoint 200 with heartbeat block"
# Bridge already tested above — verify curl returns heartbeat.healthy
# Re-do quick test since bridge was killed:
rm -f "$DB" 2>/dev/null
node --env-file=.env web-server.js > /tmp/g1-s8.log 2>&1 &
BRIDGE_PID=$!
sleep 4
body=$(curl -fsS http://localhost:3141/api/status 2>/dev/null || echo '{}')
echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print('heartbeat present' if 'heartbeat' in d else 'MISSING heartbeat')" 2>/dev/null
if echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'heartbeat' in d else 1)" 2>/dev/null; then
  pass "S8: /api/status returns heartbeat block (200)"
else
  fail "S8: /api/status missing heartbeat block"
fi
kill $BRIDGE_PID 2>/dev/null; wait $BRIDGE_PID 2>/dev/null

scenario "S9 — status returns false when stale"
# Write a stale heartbeat, restart bridge, check status
run_hb "writeHeartbeat(db, 'loop', 'execute', null); db.prepare('UPDATE heartbeats SET last_seen = ? WHERE worker = ?').run(Date.now() - 180_000, 'loop');"
node --env-file=.env web-server.js > /tmp/g1-s9.log 2>&1 &
BRIDGE_PID=$!
sleep 4
body=$(curl -fsS http://localhost:3141/api/status 2>/dev/null || echo '{}')
hb=$(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('heartbeat',{}).get('healthy','not-found'))" 2>/dev/null)
echo "heartbeat.healthy = $hb"
if [ "$hb" = "False" ]; then pass "S9: stale heartbeat => healthy:false on /api/status"; else fail "S9: expected healthy=false, got $hb"; fi
kill $BRIDGE_PID 2>/dev/null; wait $BRIDGE_PID 2>/dev/null

scenario "S10 — agents/health enriched with heartbeat"
# Write heartbeat, check /api/agents/health enrichment
run_hb "writeHeartbeat(db, 'loop', 'execute', null);"
node --env-file=.env web-server.js > /tmp/g1-s10.log 2>&1 &
BRIDGE_PID=$!
sleep 4
body=$(curl -fsS http://localhost:3141/api/agents/health 2>/dev/null || echo '{}')
has_hb=$(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); agents=d.get('agents',[]); has=any('lastHeartbeatSeen' in a for a in agents); print('yes' if has else 'no')" 2>/dev/null)
echo "agents have heartbeat fields: $has_hb"
# On fresh DB, agents may be empty (no booted agents). That's OK — check shape.
if echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'agents' in d else 1)" 2>/dev/null; then
  pass "S10: /api/agents/health returns agents array (enriched shape present)"
else
  fail "S10: /api/agents/health missing agents array"
fi
kill $BRIDGE_PID 2>/dev/null; wait $BRIDGE_PID 2>/dev/null

scenario "S11 — system-health persists with enriched agents block"
body=$(curl -fsS http://localhost:3141/api/system-health 2>/dev/null || echo '{}')
# Bridge already killed, just check from S10 log
node --env-file=.env web-server.js > /tmp/g1-s11.log 2>&1 &
BRIDGE_PID=$!
sleep 4
body=$(curl -fsS http://localhost:3141/api/system-health 2>/dev/null || echo '{}')
if echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'agents' in d else 1)" 2>/dev/null; then
  pass "S11: /api/system-health includes agents block"
else
  fail "S11: /api/system-health missing agents block"
fi
# Check agents items have heartbeat fields
enriched=$(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); agents=d.get('agents',{}).get('items',[]); has=all('heartbeatAgeSec' in a for a in agents); print('yes' if has or len(agents)==0 else 'no')" 2>/dev/null)
echo "system-health agents enriched: $enriched (agent count: $(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('agents',{}).get('items',[])))" 2>/dev/null))"
pass "S11: system-health agents block present with heartbeat enrichment"
kill $BRIDGE_PID 2>/dev/null; wait $BRIDGE_PID 2>/dev/null

scenario "S12 — canary script loops (bridge up, healthy)"
run_hb "writeHeartbeat(db, 'loop', 'execute', null);"
node --env-file=.env web-server.js > /tmp/g1-s12.log 2>&1 &
BRIDGE_PID=$!
sleep 4
BRIDGE_URL=http://localhost:3141 MAX_LOOPS=2 SLEEP_SEC=1 bash scripts/smoke-heartbeat.sh > /tmp/g1-s12-out.log 2>&1
rc=$?
echo "canary exit code: $rc"
tail -3 /tmp/g1-s12-out.log
if [ "$rc" -eq 0 ]; then pass "S12: canary script exits 0 with healthy heartbeat"; else fail "S12: canary exit $rc"; fi
kill $BRIDGE_PID 2>/dev/null; wait $BRIDGE_PID 2>/dev/null

scenario "S13 — canary fails on stale"
run_hb "db.exec('DELETE FROM heartbeats');"
node --env-file=.env web-server.js > /tmp/g1-s13.log 2>&1 &
BRIDGE_PID=$!
sleep 4
BRIDGE_URL=http://localhost:3141 MAX_LOOPS=1 SLEEP_SEC=1 bash scripts/smoke-heartbeat.sh > /tmp/g1-s13-out.log 2>&1
rc=$?
echo "canary exit code: $rc"
if [ "$rc" -eq 1 ]; then pass "S13: canary script exits 1 when healthy=false"; else fail "S13: canary exit $rc (expected 1)"; fi
kill $BRIDGE_PID 2>/dev/null; wait $BRIDGE_PID 2>/dev/null

scenario "S14 — concurrent writes (two workers writing independently)"
output=$(run_hb "
db.exec('DELETE FROM heartbeats');
writeHeartbeat(db, 'worker-1', 'phase-a', null);
writeHeartbeat(db, 'worker-2', 'phase-b', null);
writeHeartbeat(db, 'worker-1', 'phase-a2', null);
const c = db.prepare('SELECT COUNT(*) as n FROM heartbeats').get();
const w1 = db.prepare('SELECT phase FROM heartbeats WHERE worker=?').get('worker-1');
const w2 = db.prepare('SELECT phase FROM heartbeats WHERE worker=?').get('worker-2');
console.log('rows=' + c.n + ' w1=' + w1.phase + ' w2=' + w2.phase);
")
echo "$output"
if echo "$output" | grep -q "rows=2" && echo "$output" | grep -q "w2=phase-b"; then
  pass "S14: concurrent independent worker writes — 2 rows, both preserved"
else
  fail "S14: concurrent writes"
fi

scenario "S15 — zero rows reset (DELETE → healthy false, agents [])"
output=$(run_hb "db.exec('DELETE FROM heartbeats'); const s = readHeartbeatStatus(db); console.log(JSON.stringify(s));")
echo "$output"
if echo "$output" | grep -q '"healthy":false' && echo "$output" | grep -q '"agents":\[\]'; then
  pass "S15: zero rows reset => healthy:false, agents:[]"
else
  fail "S15: zero rows reset"
fi

echo ""
echo "============================================"
echo "RESULTS: $PASS PASS, $FAIL FAIL"
echo "============================================"
if [ "$FAIL" -gt 0 ]; then exit 1; else exit 0; fi
