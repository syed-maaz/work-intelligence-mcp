# G1 Heartbeat — 15 Real-World Scenarios

Dev DB: `~/.wi-dev-g1-heartbeat/data.db`  
Scenario runner: `scripts/g1-scenario-test.sh`

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| S1 | Write heartbeat (create table + insert) | Row written to heartbeats table | PASS |
| S2 | Read healthy (fresh worker, <2s) | healthy:true, 1 agent with ageSec~0 | PASS |
| S3 | Read stale (worker >120s) | healthy:false, agent shows ageSec=180 | PASS |
| S4 | Empty heartbeat table | healthy:false, agents:[] | PASS |
| S5 | Mixed workers (one fresh, one stale) | healthy:false, both agents listed | PASS |
| S6 | Write same worker twice (upsert) | 1 row, latest phase preserved | PASS |
| S7 | Read from clean boot (bridge starts, heartbeat present) | healthy:true, agentsLen=1 | PASS |
| S8 | /api/status returns heartbeat block (200) | Response includes `heartbeat` key | PASS |
| S9 | /api/status returns healthy:false when stale | heartbeat.healthy = False | PASS |
| S10 | /api/agents/health enriched with heartbeat fields | `lastHeartbeatSeen`, `heartbeatAgeSec`, `heartbeatPhase` present | PASS |
| S11 | /api/system-health agents block enriched | All agents get heartbeatAgeSec/heartbeatPhase fields | PASS |
| S12 | Canary script loops green | Exits 0 after N healthy loops | PASS |
| S13 | Canary script exits on stale | Exits 1 when healthy=false | PASS |
| S14 | Concurrent independent worker writes | 2 rows, both preserved | PASS |
| S15 | Zero rows reset (DELETE all → read) | healthy:false, agents:[] | PASS |

All 15 scenarios PASS (16 assertions total, 0 failures).

## Files changed

| File | Change |
|------|--------|
| `src/services/cypher/heartbeat.ts` | NEW — heartbeat table, writeHeartbeat, readHeartbeatStatus, createHeartbeatTable |
| `src/services/cypher/loop.ts` | ADD — writeHeartbeat call at runLoop entry + import |
| `web-server.js` | MODIFY — /api/status, /api/agents/health, /api/system-health derive from heartbeat |
| `scripts/smoke-heartbeat.sh` | NEW — canary watch script |
| `package.json` | ADD — canary:heartbeat script |

## Verification

- `npm run typecheck` — 0 errors
- `npm run lint` — 0 errors (20 pre-existing warnings)
- Dev bridge boot: `/api/status` returns 200 with heartbeat block
- `curl /api/status | jq .heartbeat.healthy` → derives from actual heartbeat freshness
