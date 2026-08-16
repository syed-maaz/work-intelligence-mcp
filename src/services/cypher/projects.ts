/**
 * Cypher v2.5 D3 slice 1 — projects accessor module (2026-06-26).
 *
 * Read/write helpers for the `projects` table introduced by v76.
 *
 * Scope of slice 1:
 *   - Read accessors: getProject, listProjects
 *   - Write accessor: createProject (idempotent — INSERT OR IGNORE)
 *
 * Slice 2+ adds:
 *   - FK constraint on `tasks.project` (via v77 table-rebuild migration)
 *   - `cypher_task_create` validates project exists (rejects unknown slugs)
 *   - `cypher_project_create` tool
 *
 * Design decisions (see v76 migration header for full context):
 *   - id is the slug (e.g. 'wi', 'app'), matches existing tasks.project values
 *   - description, default_branch, repo_path nullable (D4 fills repo_path)
 *
 * See:
 *   - src/db/migrations/v76_d3_projects_table.ts
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D3
 */

import type Database from 'better-sqlite3';
import { getWiConfig } from '../wi-config.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  description: string | null;
  default_branch: string | null;
  repo_path: string | null;
  created_at: number;
}

export interface CreateProjectOpts {
  id: string;
  name: string;
  description?: string;
  default_branch?: string;
  repo_path?: string;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function getProject(db: Database.Database, id: string): Project | null {
  return (db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Project) ?? null;
}

export function listProjects(db: Database.Database): Project[] {
  return db.prepare(`SELECT * FROM projects ORDER BY id ASC`).all() as Project[];
}

/**
 * Insert a new project. Idempotent — INSERT OR IGNORE means a second
 * call with the same `id` is a no-op (returns the existing row's
 * project ID without modifying it).
 *
 * Returns the project as it now exists in the DB (either freshly
 * inserted or the pre-existing row).
 */
export function createProject(
  db: Database.Database,
  opts: CreateProjectOpts
): Project {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, description, default_branch, repo_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.name,
    opts.description ?? null,
    opts.default_branch ?? null,
    opts.repo_path ?? null,
    now,
  );
  const inserted = getProject(db, opts.id);
  if (!inserted) {
    // Should be unreachable — INSERT OR IGNORE doesn't fail; if it
    // didn't insert, the row already existed and getProject finds it.
    throw new Error(`projects: createProject failed for id=${opts.id}`);
  }
  return inserted;
}

/**
 * Returns true if the given project id exists. Slice 2 will use this
 * in `cypher_task_create` to validate project before creating a task.
 */
export function projectExists(db: Database.Database, id: string): boolean {
  const row = db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(id) as { 1?: number } | undefined;
  return !!row;
}

// ── ADR-040 F-UI (2026-07-09): goal → project classification ─────────────
//
// ADR-038 D3 made `projects` a first-class scope dimension but never
// wired an *inference* step — cards created from `/wi <goal>` all landed
// under a hard-coded 'wi'. That collapsed the board's project buckets
// (everything read `wi`). This classifier reads the goal text and routes
// the card to the right project so the board's swimlanes are meaningful.
//
// Signal patterns are derived from the real task corpus:
//   - first configured repo: Jira ticket keys, PR references, repo name mentions
//   - second configured repo: deployment, helm, k8s, infra patterns
//   - wi (default): adr-*, cypher, smoke, schema v*, /board, /api/,
//     work-intelligence, self-referential tooling
//
// Order matters: secondary repos checked before primary because a goal
// mentioning both repos ("ops PR for ticket X") should land under the
// secondary repo classification. Default is 'wi' — the safest fallback
// (WI is the repo Cypher runs in).

function firstConfigRepoName(): string {
  try {
    const repos = getWiConfig().repos ?? [];
    if (repos.length > 0) return repos[0].name;
  } catch { /* fall through */ }
  return 'app';
}

function secondConfigRepoName(): string | null {
  try {
    const repos = getWiConfig().repos ?? [];
    if (repos.length > 1) return repos[1].name;
  } catch { /* fall through */ }
  return null;
}

const FIRST_REPO = firstConfigRepoName();
const SECOND_REPO = secondConfigRepoName();

const PRIMARY_REPO_SIGNALS: RegExp[] = [
  /[A-Z]{2,5}-\d{3,6}/,
  /\bPR[\s#-]*\d{2,6}\b/i,
];

const SECONDARY_REPO_SIGNALS: RegExp[] = [
  /\b(helm|kustomize|canary|ingress|portieris)\b/i,
  /\b(deploy|rollout|infra|k8s|kubernetes)\b/i,
];

const WI_SIGNALS: RegExp[] = [
  /\badr-?0\d{2}\b/i,
  /\bcypher\b/i,
  /\bsmoke\b/i,
  /\bschema\s+v\d+/i,
  /\/board\b/,
  /\/api\//,
  /\bwork-intelligence\b/i,
  /\bBoardWorker|runSkillSubagent|outcome-honest\b/i,
];

/**
 * Classify a free-text goal into a project slug. Returns one of the
 * known project ids (derived from config or fallback). Falls back to
 * 'wi' when no signal matches. Pure — no DB access, safe to unit test.
 *
 * If `knownProjects` is provided (from listProjects), the result is
 * validated against it; an inferred project not in the set falls back
 * to 'wi' so we never write a dangling FK.
 */
export function resolveProjectFromGoal(
  goal: string | null | undefined,
  knownProjects?: string[],
): string {
  const text = (goal ?? '').trim();
  let inferred = 'wi';
  if (text) {
    if (SECOND_REPO && SECONDARY_REPO_SIGNALS.some((re) => re.test(text))) {
      inferred = SECOND_REPO;
    } else if (PRIMARY_REPO_SIGNALS.some((re) => re.test(text)) || new RegExp(`\\b${FIRST_REPO}\\b`, 'i').test(text)) {
      inferred = FIRST_REPO;
    } else if (WI_SIGNALS.some((re) => re.test(text))) {
      inferred = 'wi';
    }
  }
  if (knownProjects && knownProjects.length > 0 && !knownProjects.includes(inferred)) {
    return 'wi';
  }
  return inferred;
}

/**
 * Seed projects from config-driven repos, with env-gated fallback.
 * Called at bridge boot. Safe to call repeatedly (createProject is
 * INSERT OR IGNORE).
 */
export function seedCanonicalProjects(db: Database.Database): void {
  createProject(db, {
    id: 'wi',
    name: 'Work Intelligence',
    description: "Cypher's own source repo (this project)",
    default_branch: 'master',
  });

  let repoConfigs: Array<{ name: string; localPath: string; defaultBranch?: string }> = [];
  try {
    repoConfigs = (getWiConfig().repos ?? []).map(r => ({
      name: r.name,
      localPath: r.localPath,
      defaultBranch: r.defaultBranch,
    }));
  } catch { /* config missing — fall through to env */ }

  if (repoConfigs.length === 0) {
    if (process.env.REPO_PATH) {
      repoConfigs.push({ name: 'workspace', localPath: './repos/workspace', defaultBranch: 'main' });
    }
    if (process.env.OPERATIONS_PATH) {
      repoConfigs.push({ name: 'operations', localPath: './repos/operations', defaultBranch: 'main' });
    }
  }

  for (const rc of repoConfigs) {
    createProject(db, {
      id: rc.name,
      name: rc.name,
      description: `Configured repo (${rc.localPath})`,
      default_branch: rc.defaultBranch ?? 'main',
      repo_path: rc.localPath,
    });
  }
}
