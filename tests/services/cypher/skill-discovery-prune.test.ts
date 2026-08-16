/**
 * skill-discovery prune step — post-merge ghost cleanup (2026-07-24).
 *
 * Context: 44 pre-merge flat skill names (e.g. wi-jira-analyze, wi-blast-radius)
 * were registered in skill_catalog before the 2026-07-24 merge factored them
 * into 11 thick parents. The old scanner UPSERTed forever, never DELETEd.
 * These stale "ghost" rows still get picked by the model as tool candidates
 * and misroute (e.g. chosen_skill='example-skill' for a wi-storage-audit goal).
 *
 * These tests pin the new prune behavior:
 *   - Row on disk stays.
 *   - Row NOT on disk AND under a scanned root  →  deleted.
 *   - Row NOT on disk AND OUTSIDE scanned roots →  kept (test fixtures, other sources).
 *   - Empty scan (no SKILL.md found)            →  NO prune (safety guard).
 *   - WI_SKILL_DISCOVERY_PRUNE=0                →  NO prune (kill switch).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { discoverSkills } from '../../../src/services/cypher/skill-discovery.js';
import migrateV63 from '../../../src/db/migrations/v63_skill_catalog.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV63(db);
  return db;
}

function seedGhost(db: Database.Database, name: string, sourcePath: string): void {
  db.prepare(
    `INSERT INTO skill_catalog (skill_name, source, source_path, description, trigger_phrases, task_classes, registered_at, last_seen_at)
     VALUES (?, 'wi', ?, ?, '[]', '[]', datetime('now','-30 days'), datetime('now','-30 days'))`,
  ).run(name, sourcePath, `Pre-merge ghost skill ${name}`);
}

function writeSkill(root: string, dir: string, name: string): string {
  const skillDir = path.join(root, dir);
  fs.mkdirSync(skillDir, { recursive: true });
  const p = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(p, `---\nname: ${name}\ndescription: Real skill on disk.\n---\n\nBody.\n`);
  return p;
}

describe('discoverSkills — prune step (ghost cleanup)', () => {
  let db: Database.Database;
  let tmpRoot: string;

  beforeEach(() => {
    db = freshDb();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-prune-'));
    delete process.env.WI_SKILL_DISCOVERY_PRUNE;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.WI_SKILL_DISCOVERY_PRUNE;
  });

  it('prunes a ghost row whose source_path is under the scanned root but the file is gone', () => {
    // Real skill: exists on disk AND will be discovered.
    writeSkill(tmpRoot, 'wi-jira', 'wi-jira');

    // Ghost skill: DB row claims to live under tmpRoot, file is NOT there.
    seedGhost(db, 'wi-jira-analyze', path.join(tmpRoot, 'wi-jira-analyze', 'SKILL.md'));

    const result = discoverSkills(db, { roots: [tmpRoot] });

    expect(result.scanned).toBeGreaterThan(0);
    expect(result.pruned).toBe(1);
    expect(result.pruned_names).toEqual(['wi-jira-analyze']);

    const remaining = db.prepare(`SELECT skill_name FROM skill_catalog ORDER BY skill_name`).all() as Array<{ skill_name: string }>;
    expect(remaining.map(r => r.skill_name)).toEqual(['wi-jira']);
  });

  it('does NOT prune a row whose source_path is OUTSIDE the scanned roots (test fixture, other source)', () => {
    writeSkill(tmpRoot, 'wi-jira', 'wi-jira');

    // Row lives under /tmp/OTHER, not under tmpRoot. Scanner has no authority.
    seedGhost(db, 'test-fixture-skill', '/tmp/OTHER/test-fixture-skill/SKILL.md');

    const result = discoverSkills(db, { roots: [tmpRoot] });

    expect(result.pruned).toBe(0);
    expect(result.pruned_names).toEqual([]);
    const rows = db.prepare(`SELECT skill_name FROM skill_catalog ORDER BY skill_name`).all() as Array<{ skill_name: string }>;
    expect(rows.map(r => r.skill_name).sort()).toEqual(['test-fixture-skill', 'wi-jira']);
  });

  it('does NOT prune when the scan finds zero skills (empty-scan safety guard)', () => {
    // Empty tmpRoot — no SKILL.md files at all.
    seedGhost(db, 'wi-jira-analyze', path.join(tmpRoot, 'wi-jira-analyze', 'SKILL.md'));

    const result = discoverSkills(db, { roots: [tmpRoot] });

    expect(result.scanned).toBe(0);
    expect(result.pruned).toBe(0);
    const rows = db.prepare(`SELECT skill_name FROM skill_catalog`).all() as Array<{ skill_name: string }>;
    expect(rows.length).toBe(1);
  });

  it('does NOT prune when WI_SKILL_DISCOVERY_PRUNE=0 kill switch is set', () => {
    writeSkill(tmpRoot, 'wi-jira', 'wi-jira');
    seedGhost(db, 'wi-jira-analyze', path.join(tmpRoot, 'wi-jira-analyze', 'SKILL.md'));

    process.env.WI_SKILL_DISCOVERY_PRUNE = '0';
    const result = discoverSkills(db, { roots: [tmpRoot] });

    expect(result.pruned).toBe(0);
    const rows = db.prepare(`SELECT skill_name FROM skill_catalog ORDER BY skill_name`).all() as Array<{ skill_name: string }>;
    expect(rows.map(r => r.skill_name).sort()).toEqual(['wi-jira', 'wi-jira-analyze']);
  });

  it('prunes multiple ghosts in one scan (the real 44-name migration case)', () => {
    writeSkill(tmpRoot, 'wi-jira',  'wi-jira');
    writeSkill(tmpRoot, 'wi-audit', 'wi-audit');

    for (const g of ['wi-jira-analyze', 'wi-jira-report', 'wi-storage-audit', 'wi-kg-freshness']) {
      seedGhost(db, g, path.join(tmpRoot, g, 'SKILL.md'));
    }

    const result = discoverSkills(db, { roots: [tmpRoot] });

    expect(result.pruned).toBe(4);
    expect(result.pruned_names.sort()).toEqual(
      ['wi-jira-analyze', 'wi-jira-report', 'wi-kg-freshness', 'wi-storage-audit'],
    );
    const remaining = db.prepare(`SELECT skill_name FROM skill_catalog ORDER BY skill_name`).all() as Array<{ skill_name: string }>;
    expect(remaining.map(r => r.skill_name).sort()).toEqual(['wi-audit', 'wi-jira']);
  });

  it('skips SKILL.md under a directory starting with underscore (_TEMPLATE, _archive)', () => {
    writeSkill(tmpRoot, 'wi-jira', 'wi-jira');
    writeSkill(tmpRoot, '_TEMPLATE', 'wi-EXAMPLE');
    writeSkill(tmpRoot, '_archive', 'wi-old');

    const result = discoverSkills(db, { roots: [tmpRoot] });

    // Scanner walked all three SKILL.md files (they're on disk)
    expect(result.scanned).toBe(3);
    // But only wi-jira landed in the catalog — the underscored dirs skipped
    const rows = db.prepare(`SELECT skill_name FROM skill_catalog ORDER BY skill_name`).all() as Array<{ skill_name: string }>;
    expect(rows.map(r => r.skill_name)).toEqual(['wi-jira']);
  });

  it('skips SKILL.md with frontmatter dispatchable: false', () => {
    // Normal skill — dispatchable
    writeSkill(tmpRoot, 'wi-jira', 'wi-jira');

    // Explicit opt-out — should be skipped even though dir name is normal
    const optOutDir = path.join(tmpRoot, 'wi-experimental');
    fs.mkdirSync(optOutDir, { recursive: true });
    fs.writeFileSync(
      path.join(optOutDir, 'SKILL.md'),
      `---\nname: wi-experimental\ndescription: Not ready.\ndispatchable: false\n---\n\nBody.\n`,
    );

    // Case-insensitive: FALSE / False / No / 0 all count
    for (const [dir, flag] of [['wi-a', 'False'], ['wi-b', 'FALSE'], ['wi-c', 'no'], ['wi-d', '0']]) {
      const d = path.join(tmpRoot, dir);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(
        path.join(d, 'SKILL.md'),
        `---\nname: ${dir}\ndescription: skipme.\ndispatchable: ${flag}\n---\n\nBody.\n`,
      );
    }

    const result = discoverSkills(db, { roots: [tmpRoot] });

    // 6 SKILL.md scanned, only wi-jira landed
    expect(result.scanned).toBe(6);
    const rows = db.prepare(`SELECT skill_name FROM skill_catalog ORDER BY skill_name`).all() as Array<{ skill_name: string }>;
    expect(rows.map(r => r.skill_name)).toEqual(['wi-jira']);
  });
});
