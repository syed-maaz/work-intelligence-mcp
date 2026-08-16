import type Database from 'better-sqlite3';

/**
 * v98→v99 — ADR-043 PM Orchestration Layer, Phase 1 (Shape C substrate).
 *
 * Adds three columns to `tasks` + one composite covering index. All existing
 * rows (~48 live cards at ship time) keep column defaults; no table rebuild.
 *
 * Columns:
 *   - priority       INTEGER 0-100, default 50. User- or LLM-set business rank.
 *                    Distinct from `kanban_order` (v90) which is manual UI
 *                    within-column drag position. `priority` drives the
 *                    cross-column backlog rank consumed by
 *                    `computeBacklogRank()` and by `BoardWorkerAgent`.
 *   - effort_points  Nullable Fibonacci story-points (1/2/3/5/8/13). Nullable
 *                    because unestimated cards are legal — the ranker uses 0
 *                    when NULL so it doesn't penalise unknowns.
 *   - intent         Enum {brainstorm, plan, execute, decide}. Default
 *                    'execute' so pre-existing rows stay picked up by
 *                    BoardWorkerAgent unchanged. Only 'execute' cards
 *                    advance; the other three sit in `ready` until user
 *                    promotes via `/pm bump` or PATCH.
 *
 * Index:
 *   - tasks_backlog_rank_idx(intent, kanban_column, priority DESC, created_at)
 *     covers the two hot reads: BoardWorkerAgent's ready-pick query
 *     (`intent='execute' AND kanban_column='ready' AND blocked=0 …`) and
 *     `computeBacklogRank`'s full-backlog scan.
 *
 * Cross-refs:
 *   - docs/docs/adr/adr-043-pm-orchestration-layer.md § Decision
 *   - src/services/board/ranker.ts (consumer)
 *   - src/intelligence/board-worker-agent.ts (consumer)
 */
export default function migrateV99(db: Database.Database): void {
  db.exec(`
    ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 50
      CHECK (priority BETWEEN 0 AND 100);
    ALTER TABLE tasks ADD COLUMN effort_points INTEGER NULL
      CHECK (effort_points IS NULL OR effort_points IN (1,2,3,5,8,13));
    ALTER TABLE tasks ADD COLUMN intent TEXT NOT NULL DEFAULT 'execute'
      CHECK (intent IN ('brainstorm','plan','execute','decide'));

    CREATE INDEX IF NOT EXISTS tasks_backlog_rank_idx
      ON tasks(intent, kanban_column, priority DESC, created_at);
  `);
}
