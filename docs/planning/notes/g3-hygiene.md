# G3 — Repo & DB Hygiene Report (T4) — 2026-08-06

Agent G3-REAP. Measured 2026-08-06. All paths OUTSIDE this repo (no deletion performed — recommendations only; orchestrator approves).

## 1. Backup bloat — `~/.work-intelligence-mcp/` (4.1 GB in 8 stale baks)

| File | Size | Date | Verdict |
|---|---|---|---|
| `data.db.adr039-bak` | 458M | 2026-06-26 | DELETE — superseded (39 days old, pre-ADR-039) |
| `data.db.adr039-pre-rollout` | 458M | 2026-06-27 | DELETE — superseded (pre-rollout snapshot of same change) |
| `data.db.pre-c1.bak` | 464M | 2026-07-06 | DELETE — superseded |
| `data.db.pre-c2.bak` | 464M | 2026-07-06 | DELETE — superseded |
| `data.db.pre-c3.bak` | 465M | 2026-07-06 | DELETE — superseded |
| `data.db.pre-b5-unstick.bak` | 522M | 2026-07-13 | DELETE — superseded |
| `data.db.pre-ac-a1-1784275897.bak` | 530M | 2026-07-17 | DELETE — superseded |
| `data.db.bak-20260725-130844` | 798M | 2026-07-25 | **KEEP** — newest pre-change snapshot (12 days old) |

**Savings: ~3.3 GB** by removing 7 of 8.

Note: mission brief said "adr039 baks 479MB x2" — actual: 458M each, and there are 6 more baks (4.1 GB total). Live DB is 1.1 GB + 51 MB WAL.

## 2. Retention policy (recommended, mirrors standard DB-backup practice)

1. **Keep last 2 baks max** (rolling). Current state: keep `data.db.bak-20260725-130844`; keep the next one created after the reap-2026-08-06 run; delete everything older.
2. **Age prune**: any bak older than 14 days → delete automatically. 2026-07-25 bak stays until 2026-08-08, then eligible.
3. **Same-day baks collapse**: multiple baks created for one logical change (e.g. `adr039-bak` + `adr039-pre-rollout`, `pre-c1/c2/c3`) — keep only the final pre-state.
4. **Name scheme**: `data.db.bak-<YYYYMMDD>-<HHMMSS>` only (current scheme); delete legacy `data.db.adr039-*` / `data.db.pre-*` naming families after 2026-08-31.
5. Enforce via weekly cron (`find ~/.work-intelligence-mcp -name 'data.db.*bak*' -mtime +14 -delete` style, orchestrator-approved) or a `scripts/` housekeeping entry (out of G3 scope).

## 3. Worktree bloat — `~/Desktop/projects/work-intelligence-mcp/.claude/worktrees` (1.2 GB, 28 dirs)

Mission brief expected ~19 GB; actual measured **1.2 GB total / 28 dirs**. Single offender:

| Path | Size | Verdict |
|---|---|---|
| `cypher-full-toolbox` | **678M** | DELETE — 57% of total; stale phase worktree |
| remaining 27 dirs | ~25-28M each | PRUNE — `git worktree remove` after their branches merge; keep `master` only |

**Savings: ~1.2 GB.** Recommendation: `git worktree list --porcelain` → for each branch already merged to master → `git worktree remove <dir>`. Never `rm -rf` a worktree while its branch is checked out; use `git worktree remove`.

## 4. WAL hygiene

`data.db-wal` 51 MB and `data.db-shm` 128K are normal (WAL mode, live bridge). No action. They are NOT backups — never delete while bridge runs.

## 5. .gitignore additions (this repo — applied, commit in stage 4)

`*.bak`, `data.db-wal`, `data.db-shm` added under the Database section. Prevents accidental staging of backup/WAL artifacts in any future repo-local db work.

## 6. What G3 did NOT delete (per discipline)

All bak removal + worktree pruning are outside repo + require orchestrator sign-off. G3 read-only measured. Commands above are the approved runbook.
