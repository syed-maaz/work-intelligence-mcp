import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import migrateV52 from '../../src/db/migrations/v52_model_config.js';
import migrateV53 from '../../src/db/migrations/v53_bug_capture_tables.js';
import migrateV54 from '../../src/db/migrations/v54_bug_last_investigation.js';
import migrateV55 from '../../src/db/migrations/v55_bug_severity_override.js';
import migrateV56 from '../../src/db/migrations/v56_bug_resolver.js';
import { BugResolverAgent } from '../../src/intelligence/bug-resolver-agent.js';

// ── Test setup ───────────────────────────────────────────────────────────

function createDb() {
  const db = new Database(':memory:');
  // brain_decisions stub for FKs.
  db.exec(`CREATE TABLE IF NOT EXISTS brain_decisions (id INTEGER PRIMARY KEY)`);
  db.pragma('foreign_keys = ON');
  migrateV52(db);
  migrateV53(db);
  migrateV54(db);
  migrateV55(db);
  migrateV56(db);
  return db;
}

interface SeedOptions {
  status?: string;
  filesToChange?: string[];
  suggestedPatch?: string | null;
  rootCause?: string;
}

function seedProposedBug(db: Database.Database, opts: SeedOptions = {}): { bugId: number; investigationId: number } {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`fp-${Math.random().toString(36).slice(2, 10)}`, 'bridge', 'TypeError', 'cannot read x', now, now, opts.status ?? 'resolving');
  const bugId = (db.prepare(`SELECT MAX(id) AS id FROM bugs`).get() as { id: number }).id;

  const result = db.prepare(
    `INSERT INTO bug_investigations
       (bug_id, root_cause, files_to_change, lines_changed, confidence, suggested_patch, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    bugId,
    opts.rootCause ?? 'race in startup queue',
    JSON.stringify(opts.filesToChange ?? ['src/routes/bugs.ts']),
    5,
    0.85,
    opts.suggestedPatch === undefined
      ? '--- a/src/routes/bugs.ts\n+++ b/src/routes/bugs.ts\n@@ -1 +1 @@\n-old\n+new\n'
      : opts.suggestedPatch,
    now,
  );
  const investigationId = Number(result.lastInsertRowid);
  db.prepare(`UPDATE bugs SET last_investigation_id=? WHERE id=?`).run(investigationId, bugId);
  return { bugId, investigationId };
}

function makeStubAgent(db: Database.Database, overrides: Partial<{
  applyCheck: boolean;
  applyThrows: boolean;
  typecheckError: string | null;
  commitSha: string;
  commitThrows: boolean;
}> = {}) {
  const calls = {
    gitApply: 0,
    runTypecheck: 0,
    gitCheckoutHead: 0,
    gitCommit: 0,
    typecheckTouchedWeb: false,
  };
  const agent = new BugResolverAgent({
    db,
    cwd: '/tmp/wi-resolver-test',
    gitApplyCheck: () => overrides.applyCheck !== false,
    gitApply: () => {
      calls.gitApply += 1;
      if (overrides.applyThrows) throw new Error('apply failed');
    },
    runTypecheck: (touchedWeb) => {
      calls.runTypecheck += 1;
      calls.typecheckTouchedWeb = touchedWeb;
      return overrides.typecheckError ?? null;
    },
    gitCheckoutHead: () => { calls.gitCheckoutHead += 1; },
    gitCommit: () => {
      calls.gitCommit += 1;
      if (overrides.commitThrows) throw new Error('commit failed');
      return overrides.commitSha ?? 'deadbeef1234';
    },
  });
  return { agent, calls };
}

// ── Suites ───────────────────────────────────────────────────────────────

describe('BugResolverAgent — happy path', () => {
  it('flips bug to auto-resolved + writes audit row + records commit SHA', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db);
    const { agent } = makeStubAgent(db, { commitSha: 'abc123' });

    const result = await agent.resolveOne(bugId);
    expect(result.outcome).toBe('auto-resolved');
    expect(result.commitSha).toBe('abc123');

    const row = db.prepare(`SELECT status FROM bugs WHERE id=?`).get(bugId) as { status: string };
    expect(row.status).toBe('auto-resolved');

    const audit = db.prepare(
      `SELECT outcome, commit_sha, failure_reason FROM bug_resolutions WHERE bug_id=?`,
    ).get(bugId) as { outcome: string; commit_sha: string; failure_reason: string | null };
    expect(audit.outcome).toBe('auto-resolved');
    expect(audit.commit_sha).toBe('abc123');
    expect(audit.failure_reason).toBeNull();
  });

  it('runs each apply step exactly once on success', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db);
    const { agent, calls } = makeStubAgent(db);

    await agent.resolveOne(bugId);
    expect(calls.gitApply).toBe(1);
    expect(calls.runTypecheck).toBe(1);
    expect(calls.gitCommit).toBe(1);
    expect(calls.gitCheckoutHead).toBe(0); // never reverts on success
  });

  it('passes touchedWeb=true when files include a web/ path', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db, { filesToChange: ['src/foo.ts', 'web/src/pages/Bar.tsx'] });
    const { agent, calls } = makeStubAgent(db);

    await agent.resolveOne(bugId);
    expect(calls.typecheckTouchedWeb).toBe(true);
  });

  it('passes touchedWeb=false when only root files', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db, { filesToChange: ['src/foo.ts', 'src/bar.ts'] });
    const { agent, calls } = makeStubAgent(db);

    await agent.resolveOne(bugId);
    expect(calls.typecheckTouchedWeb).toBe(false);
  });
});

describe('BugResolverAgent — pre-flight failures', () => {
  it('unable-to-resolve when bug not found', async () => {
    const db = createDb();
    const { agent } = makeStubAgent(db);
    const result = await agent.resolveOne(99999);
    expect(result.outcome).toBe('unable-to-resolve');
    expect(result.reason).toMatch(/not found/);
  });

  it('unable-to-resolve when no investigation row exists', async () => {
    const db = createDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('fp-nochild', 'bridge', 'E', 'm', now, now, 'resolving');
    const bugId = (db.prepare(`SELECT MAX(id) AS id FROM bugs`).get() as { id: number }).id;
    const { agent, calls } = makeStubAgent(db);

    const result = await agent.resolveOne(bugId);
    expect(result.outcome).toBe('unable-to-resolve');
    expect(result.reason).toMatch(/no investigation/);
    expect(calls.gitApply).toBe(0);

    const status = (db.prepare(`SELECT status FROM bugs WHERE id=?`).get(bugId) as { status: string }).status;
    expect(status).toBe('unable-to-resolve');
  });

  it('unable-to-resolve when suggested_patch is null', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db, { suggestedPatch: null });
    const { agent, calls } = makeStubAgent(db);

    const result = await agent.resolveOne(bugId);
    expect(result.outcome).toBe('unable-to-resolve');
    expect(result.reason).toMatch(/no suggested_patch/);
    expect(calls.gitApply).toBe(0);
  });

  it('unable-to-resolve when suggested_patch is empty string', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db, { suggestedPatch: '   \n  ' });
    const { agent, calls } = makeStubAgent(db);

    const result = await agent.resolveOne(bugId);
    expect(result.outcome).toBe('unable-to-resolve');
    expect(calls.gitApply).toBe(0);
  });

  it('unable-to-resolve when files_to_change includes a sibling repo (BLOCKED)', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db, { filesToChange: ['repos/app/src/foo.ts'] });
    const { agent, calls } = makeStubAgent(db);

    const result = await agent.resolveOne(bugId);
    expect(result.outcome).toBe('unable-to-resolve');
    expect(result.reason).toMatch(/blocked path.*repos\/app/);
    expect(calls.gitApply).toBe(0);
    expect(calls.gitCommit).toBe(0);
  });

  it('unable-to-resolve when files_to_change includes a path outside the repo', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db, { filesToChange: ['/home/testuser/.claude/skills/foo/SKILL.md'] });
    const { agent, calls } = makeStubAgent(db);

    const result = await agent.resolveOne(bugId);
    expect(result.outcome).toBe('unable-to-resolve');
    expect(result.reason).toMatch(/blocked path/);
    expect(calls.gitApply).toBe(0);
  });

  it('unable-to-resolve when git apply --check fails', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db);
    const { agent, calls } = makeStubAgent(db, { applyCheck: false });

    const result = await agent.resolveOne(bugId);
    expect(result.outcome).toBe('unable-to-resolve');
    expect(result.reason).toMatch(/git apply --check failed/);
    expect(calls.gitApply).toBe(0);
    expect(calls.gitCommit).toBe(0);
  });
});

describe('BugResolverAgent — apply-stage failures', () => {
  it('reverts via gitCheckoutHead and reports unable-to-resolve when typecheck fails', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db);
    const { agent, calls } = makeStubAgent(db, { typecheckError: "TS2304: Cannot find name 'Foo'" });

    const result = await agent.resolveOne(bugId);
    expect(result.outcome).toBe('unable-to-resolve');
    expect(result.reason).toMatch(/typecheck failed.*TS2304/);
    expect(calls.gitApply).toBe(1);
    expect(calls.gitCheckoutHead).toBe(1); // revert called
    expect(calls.gitCommit).toBe(0);       // never reaches commit
  });

  it('reports unable-to-resolve when git apply throws', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db);
    const { agent, calls } = makeStubAgent(db, { applyThrows: true });

    const result = await agent.resolveOne(bugId);
    expect(result.outcome).toBe('unable-to-resolve');
    expect(result.reason).toMatch(/git apply failed/);
    expect(calls.runTypecheck).toBe(0);
    expect(calls.gitCommit).toBe(0);
  });

  it('reports unable-to-resolve when git commit throws', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db);
    const { agent, calls } = makeStubAgent(db, { commitThrows: true });

    const result = await agent.resolveOne(bugId);
    expect(result.outcome).toBe('unable-to-resolve');
    expect(result.reason).toMatch(/git commit failed/);
    // typecheck succeeded, commit blew up → DO NOT auto-revert (working tree
    // is clean per the agent contract, user inspects with `git status`).
    expect(calls.gitCheckoutHead).toBe(0);
  });
});

describe('BugResolverAgent — audit row contents', () => {
  it('records files_changed JSON exactly when files are present', async () => {
    const db = createDb();
    const files = ['src/routes/bugs.ts', 'src/types/bugs.ts'];
    const { bugId } = seedProposedBug(db, { filesToChange: files });
    const { agent } = makeStubAgent(db);

    await agent.resolveOne(bugId);
    const row = db.prepare(`SELECT files_changed FROM bug_resolutions WHERE bug_id=?`).get(bugId) as { files_changed: string };
    expect(JSON.parse(row.files_changed)).toEqual(files);
  });

  it('records cwd field always (even on failure)', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db, { suggestedPatch: null });
    const { agent } = makeStubAgent(db);
    await agent.resolveOne(bugId);
    const row = db.prepare(`SELECT cwd FROM bug_resolutions WHERE bug_id=?`).get(bugId) as { cwd: string };
    expect(row.cwd).toBe('/tmp/wi-resolver-test');
  });

  it('records failure_reason on failure (and null on success)', async () => {
    const db = createDb();
    const { bugId: bugBad } = seedProposedBug(db, { suggestedPatch: null });
    const { bugId: bugGood } = seedProposedBug(db);

    const { agent } = makeStubAgent(db);
    await agent.resolveOne(bugBad);
    await agent.resolveOne(bugGood);

    const bad = db.prepare(`SELECT failure_reason FROM bug_resolutions WHERE bug_id=?`).get(bugBad) as { failure_reason: string | null };
    const good = db.prepare(`SELECT failure_reason FROM bug_resolutions WHERE bug_id=?`).get(bugGood) as { failure_reason: string | null };
    expect(bad.failure_reason).toMatch(/no suggested_patch/);
    expect(good.failure_reason).toBeNull();
  });

  it('brain_decision_id is always NULL in Phase 76', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db);
    const { agent } = makeStubAgent(db);
    await agent.resolveOne(bugId);
    const row = db.prepare(`SELECT brain_decision_id FROM bug_resolutions WHERE bug_id=?`).get(bugId) as { brain_decision_id: number | null };
    expect(row.brain_decision_id).toBeNull();
  });
});

describe('BugResolverAgent — queue + tick', () => {
  it('enqueue + tick processes one item per tick', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db);
    const { agent } = makeStubAgent(db);

    agent.enqueue(bugId);
    const r1 = await agent.tick();
    expect(r1.processed).toBe(1);
    const r2 = await agent.tick();
    expect(r2.processed).toBe(0); // queue drained
  });

  it('tick is a no-op when BUG_RESOLVER_ENABLED=0', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db);
    const { agent, calls } = makeStubAgent(db);

    agent.enqueue(bugId);
    const prev = process.env.BUG_RESOLVER_ENABLED;
    process.env.BUG_RESOLVER_ENABLED = '0';
    try {
      const r = await agent.tick();
      expect(r.processed).toBe(0);
      expect(calls.gitApply).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.BUG_RESOLVER_ENABLED; else process.env.BUG_RESOLVER_ENABLED = prev;
    }
  });

  it('enqueue dedupes the same bugId', async () => {
    const db = createDb();
    const { bugId } = seedProposedBug(db);
    const { agent } = makeStubAgent(db);
    agent.enqueue(bugId);
    agent.enqueue(bugId);
    agent.enqueue(bugId);
    const r1 = await agent.tick();
    expect(r1.processed).toBe(1);
    const r2 = await agent.tick();
    expect(r2.processed).toBe(0);
  });
});

describe('BugResolverAgent — investigation lookup fallback', () => {
  it('falls back to ORDER BY decided_at when last_investigation_id is NULL', async () => {
    const db = createDb();
    const { bugId, investigationId } = seedProposedBug(db);
    // Simulate a pre-v54 row by clearing last_investigation_id.
    db.prepare(`UPDATE bugs SET last_investigation_id=NULL WHERE id=?`).run(bugId);

    const { agent } = makeStubAgent(db);
    const result = await agent.resolveOne(bugId);
    expect(result.outcome).toBe('auto-resolved');
    // Audit row written (proves the fallback found the investigation).
    const row = db.prepare(`SELECT outcome FROM bug_resolutions WHERE bug_id=?`).get(bugId) as { outcome: string };
    expect(row.outcome).toBe('auto-resolved');
    void investigationId; // referenced for clarity
  });
});
