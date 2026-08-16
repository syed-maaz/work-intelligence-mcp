import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import migrateV52 from '../../src/db/migrations/v52_model_config.js';
import migrateV53 from '../../src/db/migrations/v53_bug_capture_tables.js';
import migrateV54 from '../../src/db/migrations/v54_bug_last_investigation.js';
import migrateV55 from '../../src/db/migrations/v55_bug_severity_override.js';
import {
  BugInvestigatorAgent,
  validateDecision,
} from '../../src/intelligence/bug-investigator-agent.js';
import type {
  InvestigationDecision,
  DecideFn,
} from '../../src/intelligence/bug-investigator-agent.js';
import { captureBug } from '../../src/routes/bugs.js';
import type { BugEvidence, BugRow } from '../../src/types/bugs.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS brain_decisions (id INTEGER PRIMARY KEY)`);
  db.pragma('foreign_keys = ON');
  migrateV52(db);
  migrateV53(db);
  migrateV54(db);
  migrateV55(db);
  return db;
}

const baseEvidence: BugEvidence = {
  stack: null,
  topFrame: null,
  gitLog: [],
  blastRadius: null,
  recall: [],
};

const validDecision: InvestigationDecision = {
  root_cause: 'Null pointer dereference in handler',
  files_to_change: ['src/routes/pr.ts'],
  lines_changed: 3,
  confidence: 0.78,
  suggested_patch: '--- a/src/routes/pr.ts\n+++ b/src/routes/pr.ts\n@@ -89 +89 @@\n-bad\n+good\n',
};

function makeAgent(db: Database.Database, decideFn: DecideFn) {
  return new BugInvestigatorAgent({
    db,
    palaceClient: null,
    bridgeBaseUrl: 'http://localhost:3132',
    decideFn,
    evidenceFn: async () => baseEvidence,
  });
}

describe('BugInvestigatorAgent.tick — happy + skip paths', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('1. no candidates → skipped: no_candidate', async () => {
    const agent = makeAgent(db, async () => validDecision);
    const result = await agent.tick();
    expect(result.investigated).toBe(0);
    expect(result.skipped).toBe('no_candidate');
  });

  it('2. one valid candidate → investigated, status=proposed', async () => {
    captureBug(db, { source: 'bridge', errorName: 'TypeError', message: 'm' });
    const agent = makeAgent(db, async () => validDecision);
    const result = await agent.tick();
    expect(result.investigated).toBe(1);
    expect(result.skipped).toBeNull();
    expect(result.bugId).toBeDefined();
    expect(result.investigationId).toBeDefined();

    const row = db.prepare(`SELECT status, last_investigation_id, investigation_attempts FROM bugs WHERE id=?`).get(result.bugId!) as
      | { status: string; last_investigation_id: number; investigation_attempts: number }
      | undefined;
    expect(row?.status).toBe('proposed');
    expect(row?.last_investigation_id).toBe(result.investigationId);
    expect(row?.investigation_attempts).toBe(1);
  });

  it("3. recursion guard — source='bug-investigator' rows skipped", async () => {
    captureBug(db, { source: 'bug-investigator', errorName: 'AgentError', message: 'self' });
    const agent = makeAgent(db, async () => validDecision);
    const result = await agent.tick();
    expect(result.skipped).toBe('no_candidate');
  });

  it('4. attempt cap — investigation_attempts=3 row skipped', async () => {
    captureBug(db, { source: 'bridge', errorName: 'E', message: 'cap' });
    db.prepare(`UPDATE bugs SET investigation_attempts=3`).run();
    const agent = makeAgent(db, async () => validDecision);
    const result = await agent.tick();
    expect(result.skipped).toBe('no_candidate');
  });

  it('5. severity ordering — high outranks low', async () => {
    const lo = captureBug(db, { source: 'bridge', errorName: 'L', message: 'low' });
    const hi = captureBug(db, { source: 'bridge', errorName: 'H', message: 'high' });
    db.prepare(`UPDATE bugs SET severity='high' WHERE id=?`).run(hi.id);
    const agent = makeAgent(db, async () => validDecision);
    const result = await agent.tick();
    expect(result.bugId).toBe(hi.id);
    expect(result.bugId).not.toBe(lo.id);
  });

  it('6. budget exceeded → skipped: budget_exceeded', async () => {
    captureBug(db, { source: 'bridge', errorName: 'E', message: 'budget' });
    const agent = new BugInvestigatorAgent({
      db,
      palaceClient: null,
      bridgeBaseUrl: 'http://localhost:3132',
      decideFn: async () => validDecision,
      evidenceFn: async () => baseEvidence,
      maxPerHour: 0,        // immediate budget exhaustion
    });
    const result = await agent.tick();
    expect(result.skipped).toBe('budget_exceeded');
    // status should NOT have changed.
    const row = db.prepare(`SELECT status FROM bugs LIMIT 1`).get() as { status: string };
    expect(row.status).toBe('new');
  });
});

describe('BugInvestigatorAgent.tick — failure paths', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('7. evidenceFn throws → status rolled back to new (attempts < 3)', async () => {
    captureBug(db, { source: 'bridge', errorName: 'E', message: 'evfail' });
    const agent = new BugInvestigatorAgent({
      db,
      palaceClient: null,
      bridgeBaseUrl: 'http://localhost:3132',
      decideFn: async () => validDecision,
      evidenceFn: async () => { throw new Error('evidence broke'); },
    });
    const result = await agent.tick();
    expect(result.investigated).toBe(0);
    expect(result.error).toBeDefined();
    const row = db.prepare(`SELECT status, investigation_attempts FROM bugs WHERE id=?`).get(result.bugId!) as
      | { status: string; investigation_attempts: number }
      | undefined;
    expect(row?.status).toBe('new');
    expect(row?.investigation_attempts).toBe(1);
  });

  it('8. decideFn throws → status rolled back to new', async () => {
    captureBug(db, { source: 'bridge', errorName: 'E', message: 'decfail' });
    const agent = makeAgent(db, async () => { throw new Error('brain offline'); });
    const result = await agent.tick();
    expect(result.investigated).toBe(0);
    expect(result.error).toContain('brain offline');
    const row = db.prepare(`SELECT status FROM bugs WHERE id=?`).get(result.bugId!) as { status: string };
    expect(row.status).toBe('new');
  });

  it('9. failure on attempt 3 flips to wont-fix', async () => {
    captureBug(db, { source: 'bridge', errorName: 'E', message: 'cap-fail' });
    db.prepare(`UPDATE bugs SET investigation_attempts=2`).run();   // next bump puts it at 3
    const agent = makeAgent(db, async () => { throw new Error('still broken'); });
    const result = await agent.tick();
    expect(result.investigated).toBe(0);
    const row = db.prepare(`SELECT status, investigation_attempts FROM bugs LIMIT 1`).get() as
      | { status: string; investigation_attempts: number };
    expect(row.investigation_attempts).toBe(3);
    expect(row.status).toBe('wont-fix');
  });

  it('10. invalid decision shape → treated as failure (rollback)', async () => {
    captureBug(db, { source: 'bridge', errorName: 'E', message: 'bad' });
    const agent = makeAgent(db, async () => ({
      // Missing files_to_change array; missing confidence.
      root_cause: 'r',
    }) as unknown as InvestigationDecision);
    const result = await agent.tick();
    expect(result.investigated).toBe(0);
    expect(result.error).toBeDefined();
    const row = db.prepare(`SELECT status FROM bugs LIMIT 1`).get() as { status: string };
    expect(row.status).toBe('new');
  });

  it('11. null suggested_patch is allowed', async () => {
    captureBug(db, { source: 'bridge', errorName: 'E', message: 'no-patch' });
    const agent = makeAgent(db, async () => ({
      ...validDecision,
      suggested_patch: null,
    }));
    const result = await agent.tick();
    expect(result.investigated).toBe(1);
    const inv = db.prepare(`SELECT suggested_patch FROM bug_investigations WHERE id=?`).get(result.investigationId!) as
      | { suggested_patch: string | null }
      | undefined;
    expect(inv?.suggested_patch).toBeNull();
  });

  it('12. concurrent ticks — re-entrancy guard', async () => {
    captureBug(db, { source: 'bridge', errorName: 'E', message: 'concur' });
    let resolveSlow: ((d: InvestigationDecision) => void) | null = null;
    const slowDecide: DecideFn = () => new Promise((res) => { resolveSlow = res; });
    const agent = new BugInvestigatorAgent({
      db,
      palaceClient: null,
      bridgeBaseUrl: 'http://localhost:3132',
      decideFn: slowDecide,
      evidenceFn: async () => baseEvidence,
    });
    const first = agent.tick();
    // Second call while first is in-flight returns no_candidate (re-entrancy guard).
    const second = await agent.tick();
    expect(second.skipped).toBe('no_candidate');
    expect(second.investigated).toBe(0);
    // Now release the first.
    resolveSlow!(validDecision);
    const firstResult = await first;
    expect(firstResult.investigated).toBe(1);
    // attempts should have been bumped exactly once.
    const row = db.prepare(`SELECT investigation_attempts FROM bugs LIMIT 1`).get() as { investigation_attempts: number };
    expect(row.investigation_attempts).toBe(1);
  });
});

describe('validateDecision', () => {
  it('accepts a complete valid decision', () => {
    expect(() => validateDecision(validDecision)).not.toThrow();
  });

  it('rejects missing root_cause', () => {
    expect(() => validateDecision({ ...validDecision, root_cause: '' })).toThrow(/root_cause/);
  });

  it('rejects non-array files_to_change', () => {
    expect(() => validateDecision({ ...validDecision, files_to_change: 'a' })).toThrow(/files_to_change/);
  });

  it('rejects confidence out of [0,1]', () => {
    expect(() => validateDecision({ ...validDecision, confidence: 1.5 })).toThrow(/confidence/);
  });

  it('treats missing lines_changed as 0', () => {
    const r = validateDecision({ ...validDecision, lines_changed: undefined });
    expect(r.lines_changed).toBe(0);
  });
});
