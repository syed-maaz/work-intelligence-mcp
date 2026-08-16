# Multi-Agent Execution Contract — 2026-08-06

Council roadmap G0→G7 executed by 8 parallel agents, one per git worktree.

## Layout

| Agent | Branch | Worktree | Port | Scope |
|---|---|---|---|---|
| G0 RCA | `worktree/g0-rca` | `~/Desktop/projects/wi-mcp-g0-rca` | — (read-only) | Diagnose Aug 5 loop death → `docs/incident/2026-08-05-loop-death.md` |
| G1 Heartbeat | `worktree/g1-heartbeat` | `~/Desktop/projects/wi-mcp-g1-heartbeat` | 3141 | heartbeat/vitality table, status derives green, canary + pager |
| G2 Dispatch | `worktree/g2-dispatch` | `~/Desktop/projects/wi-mcp-g2-dispatch` | 3142 | in-bridge tool invoke (kill `claude -p` subprocess), retry x2, per-skill timeouts, DLQ |
| G3 Reap | `worktree/g3-reap` | `~/Desktop/projects/wi-mcp-g3-reap` | — (data/docs) | hung children, 269 queue, doc lies, repo hygiene |
| G4 Metrics | `worktree/g4-metrics` | `~/Desktop/projects/wi-mcp-g4-metrics` | 3144 | weekly 3-number report script + veto rule |
| G5 Fallback | `worktree/g5-fallback` | `~/Desktop/projects/wi-mcp-g5-fallback` | 3145 | CAP-11 preamble, per-bucket fallback chains in model-config |
| G6 Reaper | `worktree/g6-reaper` | `~/Desktop/projects/wi-mcp-g6-reaper` | 3146 | BugReaper propose-only worker (waits for G2 merge) |
| G7 ADR | `worktree/g7-adr` | `~/Desktop/projects/wi-mcp-g7-adr` | — (docs) | ADR-053 §9 revision, ADR-054 publication |

## Isolation rules (MANDATORY)

1. Work ONLY inside your worktree dir. Never touch master worktree, prod checkout, or other agents' worktrees.
2. Prod DB `~/.work-intelligence-mcp/data.db` is READ-ONLY — only G0 queries it with sqlite3/read-only node. All other agents use dev DB `~/.wi-dev-<task>/data.db` (schema copy).
3. `node_modules` is a symlink to repo root — never install/modify deps.
4. Never push. Commit to your branch with `worktree/<task>` prefix in message.
5. Run `npm run typecheck && npm run lint` before every commit.

## File ownership (kill merge conflicts)

| File | Owner |
|---|---|
| `docs/incident/2026-08-05-loop-death.md` | G0 only |
| `src/services/cypher/heartbeat.ts` (new), loop.ts heartbeat seam, web-server.js status routes | G1 only |
| `src/services/cypher/skill-dispatch.ts` | G2 only |
| `src/services/cypher/dispatch-timeouts.ts` (new) | G2 only |
| `scripts/weekly-metrics.js` (new) | G4 only |
| `src/services/model-config.ts` | G5 only |
| `src/services/bug-reaper/` (new) | G6 only |
| `docs/docs/adr/ADR-053` revision, `ADR-054` (new) | G7 only |
| `web-server.js` line 10682 (bridgeBaseUrl) | ALREADY on master (env-overridable) |
| Everything else | nobody — if needed, ask orchestrator before touching |

## Merge protocol

- **Wave A** (parallel): G0 + G3 + G4 — disjoint files, merge in any order.
- **Wave B** (parallel): G1 + G2 — disjoint files. Must wait Wave A merged.
- **Wave C**: G5 — after Wave B.
- **Wave D**: G6 — after Wave B + C (needs fixed transport + fallback).
- **Wave E**: G7 — after all.
- Orchestrator (lead agent) merges each branch into master worktree with `git merge --no-ff`, runs `typecheck + lint + smoke:bridge` on master, records smoke green, then tags `wave-<letter>-<date>`.
- Production checkout fast-forwards to master at the end; prod stays on port 3132.

## Dev env (per worktree `.env` — gitignored)

```bash
PORT=<assigned>
BRIDGE_BASE_URL=http://localhost:<assigned>
DATABASE_PATH=~/.wi-dev-<task>/data.db
```
Loop flags OFF by default in dev unless the agent's scope needs them.

## Communication

- Every agent commits a progress note to `docs/planning/notes/<task>-<date>.md` in its own branch (merge conflict-free, owns path).
- Blockers → commit `BLOCKED: <reason>` note, stop, orchestrator resolves.

## Universal discipline — EVERY agent, EVERY session (MANDATORY)

Read `docs/planning/DISCIPLINE.md` before starting ANY task. It is the contract for every model and every session touching this repo.

**Definition of Done — NO agent declares a task done without all three:**

1. **E2E test passes** — run the full E2E suite relevant to your scope (existing suites: `npm run smoke:*`, `npm run test:run`; for new features write and run an E2E test of the complete user flow, not just unit tests).
2. **15 real-world scenarios pass** — exercise your feature against 15 realistic scenarios (real table names, real data shapes, real failure modes: timeouts, empty results, missing tables, duplicate rows, long-running inputs, partial failures, stale data, permission errors, malformed payloads, concurrent writes). Document all 15 with PASS/FAIL in `docs/planning/notes/<task>-scenarios.md`.
3. **5-agent review** — your work is reviewed by ≥5 independent agents (different roles/models) before merge eligibility. Orchestrator dispatches reviewers per wave. Reviewer verdicts recorded in `docs/planning/reviews/<task>-<wave>.md`. Any FAIL → fix + re-review before merge.

**Streaming retry discipline** — if an agent call fails, times out, or returns empty (streaming issue), wait 10 seconds and retry. Keep retrying up to 5 attempts before declaring BLOCKED and committing a `BLOCKED: <reason>` note.
