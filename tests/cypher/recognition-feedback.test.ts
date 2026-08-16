/**
 * Recognition-feedback loop (2026-07-17) — recordRecognitionFeedback tests.
 *
 * Verifies the wrong-suggestion → Beta priors wiring (S3):
 *   - 'wrong_scope' / 'wrong_question' down-weight the SUGGESTED skill (β+)
 *   - 'useful' up-weights the suggested skill (α+)
 *   - a NAMED right skill is credited (α+) AND written to skill_actually_invoked
 *   - 'unrated' moves nothing
 *   - no double-credit when named skill == chosen skill
 *   - missing session → SESSION_NOT_FOUND; bad verdict → INVALID_VERDICT
 *   - a missing prompt_outcomes row is a SOFT miss (priors still move)
 *
 * Priors are updated at the 'user_observed' tier (weight 1.0) — a human
 * explicitly rated the recognition. Pure DB; no LLM, no network.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { recordRecognitionFeedback } from '../../src/services/cypher/recognition-feedback.js';
import { getSkillPrior } from '../../src/services/cypher/learn.js';
import migrateV59 from '../../src/db/migrations/v59_cypher_tables.js';
import migrateV62 from '../../src/db/migrations/v62_skill_actually_invoked.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV59(db); // cypher_sessions + skill_priors
  migrateV62(db); // cypher_sessions.skill_actually_invoked
  return db;
}

function seedSession(
  db: Database.Database,
  sessionId: string,
  opts: { goal?: string; chosen_skill?: string | null; task_class?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO cypher_sessions (session_id, goal, chosen_skill, task_class)
     VALUES (?, ?, ?, ?)`,
  ).run(
    sessionId,
    opts.goal ?? 'some goal',
    opts.chosen_skill ?? null,
    opts.task_class ?? 'build-feature',
  );
}

/** Mean = α / (α+β). Seed Beta(1,1) implicitly; new skills start at 0.5. */
function meanOf(db: Database.Database, skill: string, tc = 'build-feature'): number {
  const p = getSkillPrior(db, skill, tc);
  return p ? p.mean : 0.5;
}

describe('recognition-feedback — recordRecognitionFeedback', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('wrong_scope down-weights the suggested skill (β increment)', () => {
    seedSession(db, 's1', { chosen_skill: 'wi-investigate' });
    const before = meanOf(db, 'wi-investigate'); // 0.5 (unseen)
    const r = recordRecognitionFeedback(db, { sessionId: 's1', verdict: 'wrong_scope' });
    expect(r.ok).toBe(true);
    const after = meanOf(db, 'wi-investigate');
    // β += 1.0 (user_observed weight) → mean drops below 0.5.
    expect(after).toBeLessThan(before);
    if (r.ok) {
      expect(r.prior_updates).toEqual([{ skill: 'wi-investigate', outcome: 'failed' }]);
      expect(r.chosen_skill).toBe('wi-investigate');
    }
  });

  it('wrong_question also down-weights the suggested skill', () => {
    seedSession(db, 's2', { chosen_skill: 'wi-search' });
    recordRecognitionFeedback(db, { sessionId: 's2', verdict: 'wrong_question' });
    expect(meanOf(db, 'wi-search')).toBeLessThan(0.5);
  });

  it('useful up-weights the suggested skill (α increment)', () => {
    seedSession(db, 's3', { chosen_skill: 'wi-blast-radius' });
    recordRecognitionFeedback(db, { sessionId: 's3', verdict: 'useful' });
    expect(meanOf(db, 'wi-blast-radius')).toBeGreaterThan(0.5);
  });

  it('names a right skill on a wrong verdict → wrong down-weighted AND right credited', () => {
    seedSession(db, 's4', { chosen_skill: 'wi-investigate' });
    const r = recordRecognitionFeedback(db, {
      sessionId: 's4',
      verdict: 'wrong_scope',
      skill: 'wi-blast-radius',
    });
    expect(r.ok).toBe(true);
    // The wrong one drops, the named right one rises.
    expect(meanOf(db, 'wi-investigate')).toBeLessThan(0.5);
    expect(meanOf(db, 'wi-blast-radius')).toBeGreaterThan(0.5);
    if (r.ok) {
      expect(r.prior_updates).toEqual([
        { skill: 'wi-investigate', outcome: 'failed' },
        { skill: 'wi-blast-radius', outcome: 'success' },
      ]);
      expect(r.named_skill).toBe('wi-blast-radius');
    }
    // Credit reassignment recorded.
    const invoked = db
      .prepare(`SELECT skill_actually_invoked FROM cypher_sessions WHERE session_id = 's4'`)
      .get() as { skill_actually_invoked: string | null };
    expect(invoked.skill_actually_invoked).toBe('wi-blast-radius');
  });

  it('no double-credit when the named skill equals the chosen skill on useful', () => {
    seedSession(db, 's5', { chosen_skill: 'wi-pr-review' });
    const r = recordRecognitionFeedback(db, {
      sessionId: 's5',
      verdict: 'useful',
      skill: 'wi-pr-review',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Exactly ONE update — the verdict-mapped success on the chosen skill.
      expect(r.prior_updates).toEqual([{ skill: 'wi-pr-review', outcome: 'success' }]);
    }
  });

  it('unrated moves no prior', () => {
    seedSession(db, 's6', { chosen_skill: 'wi-investigate' });
    const r = recordRecognitionFeedback(db, { sessionId: 's6', verdict: 'unrated' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prior_updates).toEqual([]);
    expect(meanOf(db, 'wi-investigate')).toBe(0.5); // untouched
  });

  it('missing session → SESSION_NOT_FOUND', () => {
    const r = recordRecognitionFeedback(db, { sessionId: 'nope', verdict: 'useful' });
    expect(r).toEqual({ ok: false, reason: 'SESSION_NOT_FOUND' });
  });

  it('invalid verdict → INVALID_VERDICT', () => {
    seedSession(db, 's7', { chosen_skill: 'wi-x' });
    // @ts-expect-error deliberately invalid verdict
    const r = recordRecognitionFeedback(db, { sessionId: 's7', verdict: 'thumbs_up' });
    expect(r).toEqual({ ok: false, reason: 'INVALID_VERDICT' });
  });

  it('missing prompt_outcomes row is a SOFT miss — priors still move', () => {
    // freshDb has NO prompt_outcomes table at all → updateUserVerdict throws
    // internally, but recordRecognitionFeedback must still move the prior and
    // report verdict_row_updated=false without throwing.
    seedSession(db, 's8', { chosen_skill: 'wi-investigate' });
    const r = recordRecognitionFeedback(db, { sessionId: 's8', verdict: 'wrong_scope' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict_row_updated).toBe(false);
    expect(meanOf(db, 'wi-investigate')).toBeLessThan(0.5); // prior moved regardless
  });

  it('uses the session task_class as the priors partition key', () => {
    seedSession(db, 's9', { chosen_skill: 'wi-investigate', task_class: 'pr-review' });
    recordRecognitionFeedback(db, { sessionId: 's9', verdict: 'wrong_scope' });
    // Prior moved under 'pr-review', NOT the default '*'.
    expect(meanOf(db, 'wi-investigate', 'pr-review')).toBeLessThan(0.5);
    expect(meanOf(db, 'wi-investigate', '*')).toBe(0.5); // untouched partition
  });

  it('null chosen_skill → no crash, no prior move, still ok', () => {
    seedSession(db, 's10', { chosen_skill: null });
    const r = recordRecognitionFeedback(db, { sessionId: 's10', verdict: 'wrong_scope' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.chosen_skill).toBeNull();
      expect(r.prior_updates).toEqual([]);
    }
  });
});
