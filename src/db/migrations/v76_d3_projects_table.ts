/**
 * v76 — ADR-038 v2.5 D3 slice 1: Projects table + seed (2026-06-26).
 *
 * Promotes `tasks.project` from a free-text default to a first-class
 * scope dimension. D3 (Gap 7 in the ADR-038 portfolio) makes project a
 * peer of task / dispatch / global in the scope hierarchy:
 *
 *   global         — Cypher's self-model
 *   project        — configured repos
 *   task           — task_id within a project (D2)
 *   dispatch       — single Cypher session
 *
 * **Scope of this slice (slice 1/N):**
 *   - Introduce a `projects` table with id (slug) as PK.
 *   - Seed the configured project(s) from wi.config.json repos,
 *     plus 'wi' as the default self-project. Falls back to env
 *     (REPO_PATH) if no repos configured.
 *   - Backfill any other project values currently in `tasks.project`
 *     so slice 2's FK constraint can land without orphan rows.
 *   - **No FK constraint added in this slice.** `tasks.project` stays
 *     TEXT NOT NULL DEFAULT 'wi'. Existing writers are unaffected.
 *
 * Slice 2 (next migration) adds `FOREIGN KEY(project) REFERENCES
 * projects(id)` via a table-rebuild migration. By then this slice's
 * backfill guarantees no orphan rows.
 *
 * Slice 3+ wires the `cypher_task_create` tool to validate project
 * exists, adds `cypher_project_create`, and extends scope-aware reads
 * across other tables (brain_decisions, palace, skill_priors).
 *
 * Schema decisions:
 *   - id is the slug (e.g. 'wi'), matches existing `tasks.project` values
 *     so slice 2's FK constraint trivially holds. Rename-friendlier
 *     `prj_*` ids were considered but rejected — migrating PK shape later
 *     is much worse than picking it now.
 *   - description, default_branch, repo_path are nullable now — D4
 *     (worktrees, Q-2.3) needs repo_path to be set for projects that
 *     have backing repos; for now we seed it from CLAUDE.md conventions
 *     where known and leave NULL otherwise.
 *
 * See:
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D3
 *   - src/services/cypher/projects.ts (runtime accessor — slice 1)
 *   - .planning/cypher/02-PROJECT-PORTFOLIO.md (multi-project ratio data)
 */

import type Database from 'better-sqlite3';

interface ProjectRow { project: string }

export default function migrateV76(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      description     TEXT NULL,
      default_branch  TEXT NULL,
      repo_path       TEXT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS projects_name_idx ON projects(name);
  `);

  const now = Date.now();

  // Seed the configured project(s). INSERT OR IGNORE is safe across
  // re-runs. 'wi' is always seeded as the default self-project.
  const seedStmt = db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, description, default_branch, repo_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  seedStmt.run(
    'wi',
    'Work Intelligence MCP',
    "Cypher's own source repo (this project)",
    'master',
    null, // current cwd — left NULL; D4 fills it in from BRIDGE_PROJECT_ROOT
    now,
  );

  if (process.env.REPO_PATH) {
    seedStmt.run(
      'workspace',
      'Primary Application',
      'Main application codebase',
      'main',
      process.env.REPO_PATH,
      now,
    );
  }

  // Backfill: any other project slug currently in tasks.project that
  // isn't in the seed list gets a placeholder row so slice 2's FK
  // constraint lands cleanly. Guarded so it only runs if `tasks`
  // exists (v75 created it — this migration runs after, but defensive
  // anyway in case a future migration reorders).
  const tablesRow = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`)
    .get() as { name: string } | undefined;

  if (tablesRow) {
    const existingProjects = db
      .prepare(`SELECT DISTINCT project FROM tasks WHERE project IS NOT NULL`)
      .all() as ProjectRow[];

    for (const row of existingProjects) {
      const slug = row.project;
      if (!slug) continue;
      seedStmt.run(
        slug,
        slug,
        `Backfilled from tasks.project during v76 migration`,
        null,
        null,
        now,
      );
    }
  }
}
