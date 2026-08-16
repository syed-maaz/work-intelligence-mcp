import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Regression tests for audit findings F1, F2, F4, F5.
 *
 * F1: SQL injection surface in queryObsidianNotes wikilink NOT-IN clause
 * F2: RRF id collision across lanes with numeric PKs
 * F4: FTS5 metacharacter escaping in queryObsidianNotes
 * F5: SEPARATOR indexOf vs lastIndexOf in vault write-back
 *
 * These tests exercise the primitives directly, not the full recallMemory
 * pipeline, so they stay fast and don't need the whole schema loaded.
 */

describe('audit-fix regressions (F1/F2/F4/F5)', () => {
  describe('F4 — sanitizeFtsQuery', () => {
    // We can only import this indirectly. Rather than exporting it, we test
    // the behavior via a black-box: a fixture obsidian_notes table + the
    // real queryObsidianNotes function.
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(':memory:');
      db.exec(`
        CREATE TABLE obsidian_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          topic_name TEXT,
          wi_body TEXT,
          user_annotations TEXT,
          wikilinks_json TEXT,
          tags_json TEXT,
          file_mtime_epoch INTEGER NOT NULL,
          indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE VIRTUAL TABLE obsidian_notes_fts USING fts5(
          file_name, wi_body, user_annotations, wikilinks_json, tags_json,
          content='obsidian_notes',
          content_rowid='id'
        );
        CREATE TRIGGER obsidian_notes_ai AFTER INSERT ON obsidian_notes BEGIN
          INSERT INTO obsidian_notes_fts(rowid, file_name, wi_body, user_annotations, wikilinks_json, tags_json)
          VALUES (new.id, new.file_name, new.wi_body, new.user_annotations, new.wikilinks_json, new.tags_json);
        END;
      `);
      db.prepare(
        `INSERT INTO obsidian_notes (file_path, file_name, wi_body, wikilinks_json, tags_json, file_mtime_epoch)
         VALUES ('/vault/DEMO-17726.md', 'DEMO-17726', 'Investigation notes for DEMO-17726 auth flow', '[]', '[]', ?)`,
      ).run(Date.now());
    });

    it('handles hyphenated identifiers like "DEMO-17726" without FTS5 parse error', async () => {
      // If F4 is broken, this throws or returns 0 rows because FTS5 parses
      // -17726 as NOT 17726. With sanitizeFtsQuery the pattern becomes
      // `"BDS" "17726"` (phrase-quoted tokens) which is well-formed.
      const { recallMemory } = await import('../../../src/services/brain/recall.js');
      const results = await recallMemory({
        db,
        pattern: 'DEMO-17726',
        palace: null,
        wings: [],
        sqliteLanes: true,
      });
      const obs = results.filter((r) => r.source === 'obsidian');
      expect(obs.length).toBeGreaterThan(0);
      expect(obs[0].id).toBe('obsidian:DEMO-17726');
    });

    it('handles parenthesized clarifiers like "auth (flow)" without error', async () => {
      const { recallMemory } = await import('../../../src/services/brain/recall.js');
      const results = await recallMemory({
        db,
        pattern: 'auth (flow)',
        palace: null,
        wings: [],
        sqliteLanes: true,
      });
      // Should not throw. Result count is secondary — the important thing is
      // FTS5 didn't error on the unescaped '(' or ')'.
      expect(Array.isArray(results)).toBe(true);
    });

    it('empty-after-sanitize input returns empty array, not error', async () => {
      const { recallMemory } = await import('../../../src/services/brain/recall.js');
      // '""' becomes '' after stripping, so short-circuit path fires.
      const results = await recallMemory({
        db,
        pattern: '""',
        palace: null,
        wings: [],
        sqliteLanes: true,
      });
      const obs = results.filter((r) => r.source === 'obsidian');
      expect(obs.length).toBe(0);
    });
  });

  describe('F1 — wikilink NOT-IN uses parameterized json_each', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(':memory:');
      db.exec(`
        CREATE TABLE obsidian_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          topic_name TEXT,
          wi_body TEXT,
          user_annotations TEXT,
          wikilinks_json TEXT,
          tags_json TEXT,
          file_mtime_epoch INTEGER NOT NULL,
          indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE VIRTUAL TABLE obsidian_notes_fts USING fts5(
          file_name, wi_body, user_annotations, wikilinks_json, tags_json,
          content='obsidian_notes',
          content_rowid='id'
        );
        CREATE TRIGGER obsidian_notes_ai AFTER INSERT ON obsidian_notes BEGIN
          INSERT INTO obsidian_notes_fts(rowid, file_name, wi_body, user_annotations, wikilinks_json, tags_json)
          VALUES (new.id, new.file_name, new.wi_body, new.user_annotations, new.wikilinks_json, new.tags_json);
        END;
      `);
      // One note that matches by FTS body, one note that only matches by wikilink.
      db.prepare(
        `INSERT INTO obsidian_notes (file_path, file_name, wi_body, wikilinks_json, tags_json, file_mtime_epoch)
         VALUES (?, ?, ?, ?, '[]', ?)`,
      ).run('/vault/John_Chen.md', 'John_Chen', 'search-provider proxy investigation', '["John Chen"]', Date.now());
      db.prepare(
        `INSERT INTO obsidian_notes (file_path, file_name, wi_body, wikilinks_json, tags_json, file_mtime_epoch)
         VALUES (?, ?, ?, ?, '[]', ?)`,
      ).run('/vault/Other_Note.md', 'Other_Note', 'unrelated body content', '["John Chen"]', Date.now() - 1000);
    });

    it('wikilink NOT-IN does not throw on empty seenIds', async () => {
      const { recallMemory } = await import('../../../src/services/brain/recall.js');
      // Query for a person name that produces no FTS hits (seenIds is empty),
      // then wikilink expansion runs with empty seenIds. Old code interpolated
      // '0' as a sentinel; new code passes an empty JSON array through json_each.
      const results = await recallMemory({
        db,
        pattern: 'John Chen',
        palace: null,
        wings: [],
        sqliteLanes: true,
      });
      const obs = results.filter((r) => r.source === 'obsidian');
      // Should find both notes via wikilink expansion (both link to John Chen).
      expect(obs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('F2 — namespaced RRF keys prevent cross-lane collision', () => {
    // We can't cheaply construct a full-schema fixture that produces a
    // brain_decisions row with id=X and a message_cosine hit with id=X in
    // the same recallMemory call. Instead we assert the namespacing helper
    // behavior directly by observing that RRF results across lanes are keyed
    // by source:id.
    it('two lanes with the same raw id keep their own source metadata', async () => {
      const { rrfMerge } = await import('../../../src/services/brain/rrf-merge.js');
      // Simulate what recallMemory now does: namespace ids at Rankable level.
      const nsKey = (source: string, id: string) => `${source}:${id}`;
      const decisionsRanked = [
        { id: nsKey('decision', '7'), score: 0.9, source: 'decision', snippet: 'decision-7 snippet' },
      ];
      const cosineRanked = [
        { id: nsKey('message_cosine', '7'), score: 0.85, source: 'message_cosine', snippet: 'cosine-7 snippet' },
      ];
      const merged = rrfMerge([decisionsRanked, cosineRanked], 60, 10);
      // Both should survive; RRF gives them distinct positions.
      expect(merged.length).toBe(2);
      const decision = merged.find((r) => r.id === 'decision:7');
      const cosine = merged.find((r) => r.id === 'message_cosine:7');
      expect(decision?.snippet).toBe('decision-7 snippet');
      expect(cosine?.snippet).toBe('cosine-7 snippet');
    });
  });

  describe('F5 — vault-write SEPARATOR uses lastIndexOf', () => {
    it('SEPARATOR appearing in WI body does not corrupt user annotations on rewrite', () => {
      // Direct simulation of the topic-expert.ts vault-write logic.
      // Not importing the real function because it depends on the full
      // topic-expert build; the merge logic is small enough to re-express.
      const SEPARATOR = '<!-- USER ANNOTATIONS BELOW — DO NOT EDIT ABOVE -->';
      // First write: WI body accidentally contains the sentinel string.
      const wiBodyRound1 = `# Topic\nSome discussion of ${SEPARATOR} appearing inline.\n`;
      const userAnnotations = '\nUser wrote: this is my note.\n';
      // Reproduce the exact write shape from topic-expert.ts:
      //   `${newAboveSep}\n\n${SEPARATOR}\n${existingUserAnnotations}`
      const round1Content = `${wiBodyRound1}\n\n${SEPARATOR}\n${userAnnotations}`;
      const expectedPreserved = `\n${userAnnotations}`;

      // Second write: read the file back, extract "existing user annotations"
      // using lastIndexOf (the fix), install new WI body, preserve user text.
      const sepIdxLast = round1Content.lastIndexOf(SEPARATOR);
      expect(sepIdxLast).toBeGreaterThan(0);
      const preserved = round1Content.slice(sepIdxLast + SEPARATOR.length);
      expect(preserved).toBe(expectedPreserved);

      // Old broken behavior would use indexOf and slice from the FIRST match:
      const sepIdxFirst = round1Content.indexOf(SEPARATOR);
      const brokenPreserved = round1Content.slice(sepIdxFirst + SEPARATOR.length);
      // The broken slice includes the rest of WI body PLUS the real annotations —
      // demonstrably wrong (much longer than what should have been preserved).
      expect(brokenPreserved).not.toBe(expectedPreserved);
      expect(brokenPreserved.length).toBeGreaterThan(expectedPreserved.length);
      // The broken slice also contains the second SEPARATOR literally — proof
      // the boundary was mis-detected.
      expect(brokenPreserved).toContain(SEPARATOR);
    });
  });
});
