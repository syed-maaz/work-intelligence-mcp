/**
 * Skill discovery scanner — phase 82b (2026-06-14).
 *
 * Scans ~/.claude/skills/ + ~/.claude/plugins/ for SKILL.md files and
 * upserts each into the skill_catalog table. Run at bridge boot
 * (default-on, behind WI_SKILL_DISCOVERY=1 kill-switch).
 *
 * Why a scanner not a registry:
 *   - The user installs/uninstalls plugins via the Claude Code CLI;
 *     there's no event we hook. Scan-on-boot picks up changes.
 *   - The wi-* set is also discovery-friendly: install-skills.sh
 *     symlinks them into ~/.claude/skills, but adding a new wi-*
 *     SKILL.md on disk shouldn't require touching this scanner.
 *   - Idempotent: same skill on repeat scan → UPDATE last_seen_at,
 *     refresh description/task_classes if changed.
 *
 * Hard rules:
 *   - Pure function — takes db + opts, returns a result summary.
 *     No HTTP, no LLM call.
 *   - Errors per-file are caught + reported; one bad SKILL.md doesn't
 *     stop the scan.
 *   - No symlink loops: realpath each candidate, dedupe by realpath.
 *   - Hard cap at 5000 SKILL.md files. Anything past that is suspicious
 *     and we refuse rather than burn boot time.
 */

import type Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

export type SkillSource = 'wi' | 'global' | 'plugin' | 'builtin';

export interface DiscoveredSkill {
  skill_name: string;
  source: SkillSource;
  source_path: string;
  description: string | null;
  trigger_phrases: string[];
  task_classes: string[];
}

export interface ScanResult {
  scanned: number;
  inserted: number;
  updated: number;
  /**
   * Rows deleted because they were in the catalog but no longer on disk.
   * See prune step in `discoverSkills`. Zero when `WI_SKILL_DISCOVERY_PRUNE=0`
   * or when the scan found nothing (empty-scan guard — never prune from empty).
   */
  pruned: number;
  pruned_names: string[];
  errors: Array<{ path: string; error: string }>;
  duration_ms: number;
}

const DEFAULT_ROOTS = [
  path.join(homedir(), '.claude/skills'),
  path.join(homedir(), '.claude/plugins/marketplaces'),
  path.join(homedir(), '.claude/plugins/cache'),
];

const HARD_CAP = 5000;
const DESCRIPTION_TRUNCATE = 500;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
  'have', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'was', 'with', 'when', 'who', 'will', 'would', 'use', 'used', 'using',
  'this', 'that', 'these', 'those', 'about', 'into', 'their', 'them',
  'they', 'than', 'then', 'thus', 'such', 'also', 'after', 'before',
  'between', 'across', 'over', 'under', 'any', 'each', 'every', 'all',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'how', 'what', 'why', 'where', 'which', 'while', 'whose', 'whom',
]);

/**
 * Walk a tree finding SKILL.md files. Hard-capped + symlink-safe.
 * Yields paths relative to the original walk root (not realpath) so
 * that wi-* SKILL.md files (symlinks pointing out of the .claude
 * tree into the repo) keep their original ~/.claude/skills/wi-*
 * path — which is what classifySource matches on.
 *
 * Symlink-loop protection: dedupe by realpath of every directory
 * before recursing into it.
 */
function* walkForSkills(root: string, seen: Set<string>): Generator<string> {
  if (!fs.existsSync(root)) return;

  const stack: string[] = [root];
  const visitedDirs = new Set<string>();
  while (stack.length > 0) {
    if (seen.size >= HARD_CAP) return;

    const dir = stack.pop()!;
    let real: string;
    try { real = fs.realpathSync(dir); } catch { continue; }
    if (visitedDirs.has(real)) continue;
    visitedDirs.add(real);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);

      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }

      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile() && ent.name === 'SKILL.md') {
        if (seen.has(full)) continue;
        seen.add(full);
        yield full;
      }
    }
  }
}

/**
 * Parse YAML frontmatter from a SKILL.md file. Tiny hand-rolled
 * parser — we only need name + description + optional triggers.
 * Avoids pulling in a full YAML dep for one specific use.
 */
function parseFrontmatter(content: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!content.startsWith('---')) return out;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return out;
  const fm = content.slice(3, end);

  let currentList: string[] | null = null;

  for (const rawLine of fm.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;

    // List item under current key.
    if (line.startsWith('- ') && currentList) {
      currentList.push(line.slice(2).trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();

    // Skip indented (nested) keys we don't need.
    if (line[0] === ' ' || line[0] === '\t') continue;

    if (val === '' || val === '|' || val === '>') {
      currentList = [];
      out[key] = currentList;
    } else {
      val = val.replace(/^["']|["']$/g, '');
      out[key] = val;
      currentList = null;
    }
  }

  // Drop empty list keys (overrode by single-line values).
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (Array.isArray(v) && v.length === 0) delete out[k];
  }

  return out;
}

/**
 * Classify a SKILL.md path into one of the four source buckets.
 * Order matters: a path under ~/.claude/skills/work-intelligence/
 * counts as wi even though it's nominally "in the skills dir".
 */
function classifySource(skillPath: string): SkillSource {
  const norm = skillPath.replace(/\\/g, '/');
  // wi-* live under ~/.claude/skills/work-intelligence/ (subtree) AND
  // are also exposed as top-level symlinks at ~/.claude/skills/wi-*/.
  // Match either path pattern.
  if (norm.includes('/.claude/skills/work-intelligence/')) return 'wi';
  if (/\/\.claude\/skills\/wi-[a-z][a-z0-9-]*\/SKILL\.md$/.test(norm)) return 'wi';
  if (norm.includes('/plugins/')) return 'plugin';
  // Anything still in ~/.claude/skills/ but NOT wi-* → global.
  if (norm.includes('/.claude/skills/')) return 'global';
  return 'builtin';
}

/**
 * Extract task-class keywords from a description. Cheap deterministic
 * NLP: lowercase, strip punctuation, drop stopwords, take unigrams + a
 * few hand-mapped synonyms (so 'frontend' description gets 'ui' too).
 */
function extractTaskClasses(description: string | null): string[] {
  if (!description) return [];
  const tokens = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));

  const unique = new Set(tokens);

  // Hand-mapped synonyms — keep tiny + obvious. The goal is to make
  // `task_class=ui-review` find 'frontend-design' even though the
  // SKILL.md description doesn't say "ui-review" verbatim.
  const SYNONYMS: Record<string, string[]> = {
    frontend: ['ui', 'ui-review', 'design', 'build-feature'],
    ui: ['frontend', 'design', 'ui-review'],
    design: ['ui', 'frontend', 'ui-review'],
    review: ['ui-review', 'pr-review', 'code-review'],
    code: ['code-review', 'refactor', 'build-feature'],
    pr: ['pr-review', 'review'],
    bug: ['investigate', 'debug'],
    debug: ['investigate', 'debug-issue'],
    research: ['research', 'deep-research'],
    test: ['testing', 'qa'],
    build: ['build-feature', 'wiring'],
    implement: ['build-feature'],
    scaffold: ['build-feature'],
    create: ['build-feature'],
    generate: ['build-feature'],
    engineer: ['build-feature', 'senior-backend', 'senior-frontend'],
    backend: ['build-feature', 'senior-backend'],
    api: ['build-feature', 'senior-backend'],
    component: ['build-feature', 'ui-review', 'frontend'],
    refactor: ['refactor', 'code-review'],
    architecture: ['senior-architect', 'build-feature'],
    security: ['senior-secops', 'investigate'],
    cloud: ['aws', 'azure', 'gcp'],
    aws: ['cloud', 'senior-backend'],
    azure: ['cloud', 'senior-backend'],
    gcp: ['cloud', 'senior-backend'],
    playwright: ['testing', 'qa'],
    stripe: ['build-feature', 'senior-backend'],
    ml: ['senior-ml-engineer', 'build-feature'],
    llm: ['senior-prompt-engineer', 'build-feature'],
    prompt: ['senior-prompt-engineer'],
    agent: ['build-feature', 'senior-backend'],
  };

  for (const tok of [...unique]) {
    const syns = SYNONYMS[tok];
    if (syns) syns.forEach(s => unique.add(s));
  }

  return [...unique].sort();
}

/**
 * Read + parse one SKILL.md. Returns null on unreadable / bad
 * frontmatter — those land in the errors array of ScanResult.
 *
 * Non-dispatchable skills return null too (silently, no error row):
 *   - directory name starts with `_` (e.g. `_TEMPLATE`, `_archive`) — matches
 *     the existing meta-directory convention on disk.
 *   - frontmatter `dispatchable: false` — escape hatch for skills that live
 *     in a normal-named dir but should not be model-dispatchable (docs-only
 *     helpers, in-progress scaffolds, etc.).
 */
function parseSkillFile(filePath: string): DiscoveredSkill | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  // Structural skip: any SKILL.md under a dir starting with '_' is a
  // meta/scaffold/archive dir. Never register as dispatchable.
  const dirName = path.basename(path.dirname(filePath));
  if (dirName.startsWith('_')) return null;

  const fm = parseFrontmatter(content);
  const fmName = typeof fm.name === 'string' ? fm.name.trim() : '';
  const skill_name = fmName || dirName;
  if (!skill_name) return null;

  // Frontmatter opt-out: `dispatchable: false` in the top-level frontmatter
  // block. Parsed as a plain string here (parseFrontmatter is stringly-typed);
  // accept 'false', 'False', 'FALSE', 'no', '0' — the same shape the human
  // is likely to type. Anything else, including missing, defaults to true.
  const dispatchable = fm.dispatchable;
  if (typeof dispatchable === 'string') {
    const flag = dispatchable.trim().toLowerCase();
    if (flag === 'false' || flag === 'no' || flag === '0') return null;
  }

  const fmDesc = typeof fm.description === 'string' ? fm.description.trim() : null;
  const description = fmDesc ? fmDesc.slice(0, DESCRIPTION_TRUNCATE) : null;
  const triggers = Array.isArray(fm.triggers) ? fm.triggers : [];

  return {
    skill_name,
    source: classifySource(filePath),
    source_path: filePath,
    description,
    trigger_phrases: triggers,
    task_classes: extractTaskClasses(description),
  };
}

/**
 * Run the scan. Default roots are the three Claude Code skill paths;
 * tests can override via opts.roots.
 */
export function discoverSkills(
  db: Database.Database,
  opts: { roots?: string[] } = {},
): ScanResult {
  const startMs = Date.now();
  const result: ScanResult = {
    scanned: 0, inserted: 0, updated: 0, pruned: 0, pruned_names: [], errors: [], duration_ms: 0,
  };

  const roots = opts.roots ?? DEFAULT_ROOTS;
  const seen = new Set<string>();
  const skills: DiscoveredSkill[] = [];

  for (const root of roots) {
    for (const skillPath of walkForSkills(root, seen)) {
      result.scanned += 1;
      try {
        const sk = parseSkillFile(skillPath);
        if (sk) skills.push(sk);
      } catch (err) {
        result.errors.push({ path: skillPath, error: (err as Error).message });
      }
    }
  }

  // Upsert in one transaction so the catalog is never half-written.
  const upsert = db.prepare(`
    INSERT INTO skill_catalog (skill_name, source, source_path, description, trigger_phrases, task_classes, registered_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(skill_name) DO UPDATE SET
      source = excluded.source,
      source_path = excluded.source_path,
      description = excluded.description,
      trigger_phrases = excluded.trigger_phrases,
      task_classes = excluded.task_classes,
      last_seen_at = datetime('now')
  `);

  // Detect insert-vs-update by counting existing rows with each name.
  const existing = db.prepare(`SELECT skill_name FROM skill_catalog`).all() as Array<{ skill_name: string }>;
  const existingNames = new Set(existing.map(r => r.skill_name));

  const tx = db.transaction((): void => {
    for (const sk of skills) {
      const isUpdate = existingNames.has(sk.skill_name);
      try {
        upsert.run(
          sk.skill_name,
          sk.source,
          sk.source_path,
          sk.description,
          JSON.stringify(sk.trigger_phrases),
          JSON.stringify(sk.task_classes),
        );
        if (isUpdate) result.updated += 1;
        else result.inserted += 1;
      } catch (err) {
        result.errors.push({ path: sk.source_path, error: (err as Error).message });
      }
    }

    // ─── Prune ──────────────────────────────────────────────────────────
    // Delete catalog rows whose skills are no longer on disk. Bounded to
    // rows whose `source_path` sits under one of the scanned roots — that
    // way a test that inserts a hand-crafted row with `/tmp/foo/SKILL.md`
    // as source_path is never pruned by a scan of ~/.claude.
    //
    // Guards:
    //   - `WI_SKILL_DISCOVERY_PRUNE=0` — kill switch, default is prune-on.
    //   - Empty-scan guard: if the scan found ZERO skills (permission
    //     error, missing roots, etc.) we skip prune. Never nuke the
    //     whole catalog on the strength of an empty scan.
    if (process.env.WI_SKILL_DISCOVERY_PRUNE === '0') return;
    if (skills.length === 0) return;

    const scannedNames = new Set(skills.map(s => s.skill_name));
    const selectStale = db.prepare<[], { skill_name: string; source_path: string }>(
      `SELECT skill_name, source_path FROM skill_catalog`,
    );
    const deleteRow = db.prepare(
      `DELETE FROM skill_catalog WHERE skill_name = ?`,
    );
    for (const row of selectStale.all()) {
      if (scannedNames.has(row.skill_name)) continue;
      // Only prune rows that CLAIM to live under a scanned root. Rows with
      // unrelated source_paths (test fixtures, future sources) are left
      // alone — this scanner has no authority over them.
      const isUnderScannedRoot = roots.some(
        r => row.source_path === r || row.source_path.startsWith(r + path.sep),
      );
      if (!isUnderScannedRoot) continue;
      try {
        deleteRow.run(row.skill_name);
        result.pruned += 1;
        result.pruned_names.push(row.skill_name);
      } catch (err) {
        result.errors.push({ path: row.source_path, error: (err as Error).message });
      }
    }
  });
  tx();

  result.duration_ms = Date.now() - startMs;
  return result;
}

// ─── Read API ─────────────────────────────────────────────────────────────────

export interface CatalogRow {
  skill_name: string;
  source: SkillSource;
  source_path: string;
  description: string | null;
  trigger_phrases: string[];
  task_classes: string[];
  registered_at: string;
  last_seen_at: string;
  in_priors: boolean;
}

export interface CatalogResponse {
  total: number;
  by_source: Record<SkillSource, number>;
  in_priors_count: number;
  skills: CatalogRow[];
  generated_at: string;
}

interface RawCatalogRow {
  skill_name: string;
  source: SkillSource;
  source_path: string;
  description: string | null;
  trigger_phrases: string | null;
  task_classes: string | null;
  registered_at: string;
  last_seen_at: string;
  in_priors: number;
}

function safeJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function getCatalog(db: Database.Database): CatalogResponse {
  const rows = db.prepare<[], RawCatalogRow>(`
    SELECT
      c.skill_name, c.source, c.source_path, c.description, c.trigger_phrases,
      c.task_classes, c.registered_at, c.last_seen_at,
      EXISTS(SELECT 1 FROM skill_priors p WHERE p.skill_name = c.skill_name) AS in_priors
    FROM skill_catalog c
    ORDER BY c.source, c.skill_name
  `).all();

  const by_source: Record<SkillSource, number> = { wi: 0, global: 0, plugin: 0, builtin: 0 };
  let in_priors_count = 0;
  const skills: CatalogRow[] = rows.map(r => {
    by_source[r.source] += 1;
    if (r.in_priors) in_priors_count += 1;
    return {
      skill_name: r.skill_name,
      source: r.source,
      source_path: r.source_path,
      description: r.description,
      trigger_phrases: safeJsonArray(r.trigger_phrases),
      task_classes: safeJsonArray(r.task_classes),
      registered_at: r.registered_at,
      last_seen_at: r.last_seen_at,
      in_priors: !!r.in_priors,
    };
  });

  return {
    total: skills.length,
    by_source,
    in_priors_count,
    skills,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Helper for resolveCandidates — returns skill_names whose task_classes
 * JSON contains the requested taskClass keyword. wi-* skills are
 * deprioritised here because the seeded DEFAULT_CANDIDATES list is the
 * source of truth for wi routing; this function is for surfacing the
 * non-wi catalog into the candidate pool.
 */
export function discoveredCandidatesForClass(
  db: Database.Database,
  taskClass: string,
): string[] {
  const tcLower = taskClass.toLowerCase();
  // task_classes is stored as a JSON array; we use LIKE for cheap match.
  // Format is e.g. ["frontend","ui","design"] so '"<class>"' is the
  // unambiguous needle.
  const needle = `%"${tcLower.replace(/"/g, '\\"')}"%`;
  const rows = db.prepare<[string], { skill_name: string }>(`
    SELECT skill_name FROM skill_catalog
     WHERE task_classes LIKE ?
     ORDER BY source = 'wi' DESC, source = 'global' DESC, source = 'plugin' DESC, registered_at ASC
  `).all(needle);
  return rows.map(r => r.skill_name);
}
