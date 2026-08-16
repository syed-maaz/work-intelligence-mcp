/**
 * Tests for ADR-051 Option A § Follow-up item 3 — skill-registry drift check.
 *
 * Verifies:
 *   1. A "clean" state (only known carve-outs) reports total_unknown_drift=0
 *      and formats as a single green line.
 *   2. A newly-added wi-* skill with no route AND not in EXPECTED_CATALOG_ONLY
 *      is flagged as unknown_catalog_only drift.
 *   3. Format output stays bounded (top-5 examples + count suffix) so a burst
 *      of drift doesn't spew unbounded stderr at boot.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  checkSkillRegistryDrift,
  formatDriftSummary,
} from '../../../src/services/cypher/skill-registry-drift.js';
import { _internal } from '../../../src/services/cypher/skill-dispatch.js';

/**
 * Build an in-memory DB with just the skill_catalog schema and seed it with a
 * given list of wi-* skill names. Bypasses migrations — the drift check only
 * reads {skill_name}, so a minimal schema is enough for unit-test isolation.
 */
function makeCatalogDb(skillNames: string[]): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE skill_catalog (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name      TEXT    NOT NULL UNIQUE,
      source          TEXT    NOT NULL,
      source_path     TEXT    NOT NULL,
      description     TEXT,
      trigger_phrases TEXT,
      task_classes    TEXT,
      registered_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      last_seen_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const stmt = db.prepare(
    `INSERT INTO skill_catalog (skill_name, source, source_path) VALUES (?, 'wi', ?)`,
  );
  for (const name of skillNames) {
    stmt.run(name, `/tmp/skills/${name}/SKILL.md`);
  }
  return db;
}

describe('skill-registry-drift', () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  it('reports zero unknown drift when catalog matches routes + known carve-outs', () => {
    // Simulate a "clean" install: catalog contains every route that ISN'T in
    // EXPECTED_ROUTE_ONLY (the legit intersection of the two inventories) plus
    // the wrapper skills that ARE in EXPECTED_CATALOG_ONLY. In that state the
    // drift check should find zero unknown drift.
    const EXPECTED_ROUTE_ONLY = new Set([
      'wi-blast-radius',
      'wi-pr-review',
      'wi-code-research',
      'wi-find-expert',
      'wi-teammate',
      'wi-morning-brief',
      'wi-daily-digest',
      'wi-jira-analyze',
      'wi-jira-report',
      'wi-ticket-links',
      'wi-save-to-ticket',
      'wi-bug-report',
      'wi-search-all',
      'wi-teams-search',
      'wi-palace-query',
      'wi-check-links',
      'wi-frontmatter',
      'wi-sync',
      'wi-health',
    ]);
    const EXPECTED_CATALOG_ONLY = [
      'wi-code',
      'wi-people',
      'wi-brief',
      'wi-jira',
      'wi-bug',
      'wi-audit',
      'wi-git-audit',
      'wi-govern',
      'wi-vault',
      'wi-pm',
      'wi-router',
      'wi-record-outcome',
      'wi-review-adr',
      'wi-pre-meeting',
      'wi-add-bucket',
    ];
    const routesInBothInventories = Object.keys(_internal.SKILL_ROUTES).filter(
      (r) => !EXPECTED_ROUTE_ONLY.has(r),
    );
    db = makeCatalogDb([...routesInBothInventories, ...EXPECTED_CATALOG_ONLY]);
    const report = checkSkillRegistryDrift(db);

    expect(report.total_unknown_drift).toBe(0);
    expect(report.unknown_catalog_only).toEqual([]);
    expect(report.unknown_route_only).toEqual([]);
    expect(formatDriftSummary(report)).toContain('no drift beyond ADR-051');
  });

  it('flags an unwhitelisted catalog-only skill as unknown drift', () => {
    // wi-fake-experimental-skill: not in any inventory, not in whitelist.
    // Should surface as unknown_catalog_only drift.
    db = makeCatalogDb(['wi-fake-experimental-skill']);
    const report = checkSkillRegistryDrift(db);

    expect(report.unknown_catalog_only).toContain('wi-fake-experimental-skill');
    expect(report.total_unknown_drift).toBeGreaterThanOrEqual(1);
    const summary = formatDriftSummary(report);
    expect(summary).toContain('unknown-drift=');
    expect(summary).toContain('wi-fake-experimental-skill');
    expect(summary).toContain('investigate');
  });

  it('bounds the output to top-5 examples with a "+N more" count suffix', () => {
    // Seed 10 fake unwhitelisted skills. Format output should show 5 + "(+5 more)".
    const fakes = Array.from({ length: 10 }, (_, i) => `wi-fake-drift-${i}`);
    db = makeCatalogDb(fakes);
    const report = checkSkillRegistryDrift(db);

    expect(report.unknown_catalog_only.length).toBe(10);
    const summary = formatDriftSummary(report);
    // Only 5 should be inlined; suffix should announce the remainder.
    expect(summary).toMatch(/wi-fake-drift-0/);
    expect(summary).toMatch(/\(\+5 more\)/);
    // wi-fake-drift-9 is beyond the top 5 — must NOT appear inline.
    // (Sort is lexicographic, so wi-fake-drift-{0..4} are the "top 5"; 5..9 in the tail.)
    expect(summary).not.toMatch(/wi-fake-drift-9/);
  });
});
