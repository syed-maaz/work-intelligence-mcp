# Wave A merge record — 2026-08-06

## Merged branches (5-agent reviewed)
| Branch | Final commit | Files added | Reviewer APPROVE |
|---|---|---|---|
| worktree/g0-rca | 1329cf0 | docs/incident/2026-08-05-loop-death.md, docs/planning/notes/g0-scenarios.md | R1(APPROVE after must-fix), R3, R5 |
| worktree/g3-reap | 65581fd | src/reap/reap.mjs, scripts/reap-2026-08.mjs, docs/planning/notes/g3-{scenarios,doclaws,hygiene,notes}.md, .gitignore, docs/docs/architecture/index.md (ratified unowned touch) | R1, R2, R4, R5 |
| worktree/g4-metrics | 76c83b3 | scripts/weekly-metrics.js, package.json (metrics:weekly), docs/planning/notes/g4-{scenarios,veto-rule}.md | R1, R4, R5 (after must-fix) |

## 5-reviewer verdict (full)
- R1 data-integrity: APPROVE (must-fix #1/#2/#3 all PASS after re-review; H1 root cause holds)
- R2 ops: APPROVE (idempotent, UPDATE-only, DATABASE_PATH required; pre-reap backup gates prod --apply)
- R3 architecture: APPROVE (ownership clean; index.md touch ratified; Wave B order sound)
- R4 QA: APPROVE (15/15 scenarios; sha256 read-only proven; typecheck/lint 0/0/0; metrics:weekly works)
- R5 security: APPROVE (0 CRIT; 1 MAJ reaped-as-failed mitigated via §5.1 accepted-risk + script breakout; 2 MIN handled)

## Merge into master
Master worktree: ~/Desktop/projects/work-intelligence-mcp/.claude/worktrees/master
Merges: 7e30d37 (g0-rca) ← a64d60e (g3-reap) ← 5f7ad3d (g4-metrics)
Master head: 5f7ad3d

## Post-merge verification on master
- typecheck: 0 errors
- lint: 20 warnings / 0 errors (pre-existing baseline)
- smoke (master bridge on port 3149, fresh dev DB):
  - GET /api/status → 200 (13ms) ✓
  - GET /api/agents/health → 200, 11 agents (9 ready, 1 healthy, 1 disabled) ✓
  - GET /api/system-health → 200 ✓
  - OPTIONS /api/status preflight → 204 + Access-Control-Allow-Origin echo on allow-listed origin ✓
  - bridge boot: clean, 9 ready agents, all smoke-gated feature flags off (BOARD/PM/BUG_RESOLVER — no DB writes during smoke)
- SKIP_BRAIN_LIVE_CALL=1 (no LLM cost). The full smoke script hung ~60s on the post-CORS steps (mid-script timer behavior under bridge); subset above proves boot + core endpoints healthy.

## Hygiene debt surfaced (NOT blockers; recommended cleanup items)
1. **Dangling import** — web-server.js:85 imports `cypherSessionsRoutes` from `./dist/routes/cypher-sessions.js`, but `src/routes/cypher-sessions.ts` does not exist anywhere in src/ (renamed/removed, dist artifact left from Jun 26 build). Production boots only because prod's dist/ retains the stale file; a fresh `npm run build` (as on master) drops it and the bridge fails to boot. **Carryover copied manually for this smoke run.** RECOMMENDED: either restore src/routes/cypher-sessions.ts OR remove the web-server.js import + the dist artifact. Owner: orchestrator-routed (avoids all Wave agents).
2. **Dev-DB schema bootstrap must run from EMPTY** — seeding a `.schema`-copy DB then booting produces `duplicate column name` migrations; the canonical path is `rm dev.db && boot` (initializeDatabase builders migrations from scratch). Documented here for next agents.
3. **Prod --apply of reap** is gated on pre-reap backup + checkpoint (per R2 runbook). Not run in Wave A.
4. **Pre-reap backup of prod pending** — still owes the prod run; not blocking master merge.

## Skipped from master smoke (rationale)
- Full smoke-bridge.sh hung mid-script (timing on post-CORS stages); Wave A added NO bridge code (only reap + metrics scripts + docs), so core-endpoint smoke is the right green signal here. Wave B (G1/G2 change bridge routes) MUST run the full smoke script.
- Smoke:bridge:record (record-smoke-green.mjs updates `schema_metadata.smoke_bridge_last_green`) NOT invoked (it would mark smoke green vs master's dev DB, not prod). Smoke-green is recorded here in this file as the durable evidence. (A bounded canary post-Wave B should update `smoke_bridge_last_green` against prod to unwind the stale Jul 14 value.)