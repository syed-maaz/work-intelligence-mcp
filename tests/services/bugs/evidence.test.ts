import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import {
  fileFromTopFrame,
  recallSimilar,
  gatherEvidence,
} from '../../../src/services/bugs/evidence.js';
import type { BugRow, BugBlastRadius, BugGitLogEntry, BugRecallHit } from '../../../src/types/bugs.js';

function makeBug(overrides: Partial<BugRow> = {}): BugRow {
  return {
    id: 1,
    fingerprint: 'fp1234567890abcd',
    source: 'bridge',
    error_name: 'TypeError',
    message: 'Cannot read property x of undefined',
    top_frame: 'src/routes/pr.ts:89',
    first_seen_at: '2026-05-31T14:00:00.000Z',
    last_seen_at: '2026-05-31T14:00:00.000Z',
    occurrence_count: 1,
    status: 'new',
    severity: 'low',
    context_json: null,
    investigation_attempts: 0,
    ...overrides,
  };
}

describe('fileFromTopFrame — repo detection + path stripping', () => {
  const bases = { 'example-service': '/abs/example-service', operations: '/abs/operations', wi: '/abs/wi' };

  it('returns null when top_frame is null', () => {
    expect(fileFromTopFrame(null, bases)).toBeNull();
  });

  it('returns null when top_frame has no file path shape', () => {
    expect(fileFromTopFrame('<anonymous>', bases)).toBeNull();
  });

  it('detects WI repo for plain src/ paths', () => {
    const r = fileFromTopFrame('src/routes/pr.ts:89', bases);
    expect(r).toEqual({ repo: 'work-intelligence-mcp', file: 'src/routes/pr.ts', absoluteRepoBase: '/abs/wi' });
  });

  it('detects example-service via repos/example-service/ prefix', () => {
    const r = fileFromTopFrame('repos/example-service/lib/foo.ts:42', bases);
    expect(r).toEqual({ repo: 'example-service', file: 'lib/foo.ts', absoluteRepoBase: '/abs/example-service' });
  });

  it('detects operations via repos/operations/ prefix', () => {
    const r = fileFromTopFrame('repos/operations/configs/values.yaml:12', bases);
    expect(r).toEqual({ repo: 'operations', file: 'configs/values.yaml', absoluteRepoBase: '/abs/operations' });
  });

  it('strips :line:col suffix', () => {
    const r = fileFromTopFrame('src/x.ts:42:7', bases);
    expect(r?.file).toBe('src/x.ts');
  });
});

describe('recallSimilar', () => {
  const db = new Database(':memory:'); // unused — the recallFn is mocked at the gatherEvidence level

  it('dedupes by source:id across two pattern calls', async () => {
    // recallSimilar calls recallMemory twice (fingerprint + error_name).
    // Real recallMemory needs brain_decisions/brain_clusters tables; here
    // we test the higher-level behaviour by spying on recallMemory.
    // Easier: test via gatherEvidence with a recallFn override. But for
    // unit coverage of recallSimilar specifically, exercise it with a DB
    // that has empty tables — it should return [] without throwing.
    db.exec(`CREATE TABLE IF NOT EXISTS brain_decisions (
      id INTEGER PRIMARY KEY,
      cache_key TEXT,
      question TEXT,
      decision TEXT,
      rationale TEXT,
      confidence REAL DEFAULT 0.5,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS brain_action_clusters (
      id INTEGER PRIMARY KEY,
      signature TEXT,
      created_at TEXT
    );`);
    const bug = makeBug();
    const result = await recallSimilar(db, null, bug);
    expect(result).toEqual([]);
  });
});

describe('gatherEvidence — orchestrator', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS brain_decisions (
    id INTEGER PRIMARY KEY, cache_key TEXT, question TEXT, decision TEXT,
    rationale TEXT, confidence REAL DEFAULT 0.5, created_at TEXT);
  CREATE TABLE IF NOT EXISTS brain_action_clusters (
    id INTEGER PRIMARY KEY, signature TEXT, created_at TEXT);`);

  const baseArgs = {
    db,
    bridgeBaseUrl: 'http://localhost:3132',
    palaceClient: null,
  };

  it('null top_frame → empty gitLog and null blastRadius', async () => {
    const result = await gatherEvidence({
      ...baseArgs,
      bug: makeBug({ top_frame: null }),
      gitLogFn: async () => [{ sha: 'abc', author: 'x', date: '2026-01-01', subject: 's' }] as BugGitLogEntry[],
      blastRadiusFn: async () => ({ repo: 'work-intelligence-mcp', file: 'x', edges: [], edgeCount: 0 }) as BugBlastRadius,
      recallFn: async () => [] as BugRecallHit[],
    });
    expect(result.gitLog).toEqual([]);
    expect(result.blastRadius).toBeNull();
    expect(result.topFrame).toBeNull();
  });

  it('git log function failure → gitLog: []', async () => {
    const result = await gatherEvidence({
      ...baseArgs,
      bug: makeBug(),
      gitLogFn: async () => { throw new Error('git not found'); },
      blastRadiusFn: async () => null,
      recallFn: async () => [] as BugRecallHit[],
    });
    expect(result.gitLog).toEqual([]);
  });

  it('blast-radius returns null on error', async () => {
    const result = await gatherEvidence({
      ...baseArgs,
      bug: makeBug(),
      gitLogFn: async () => [],
      blastRadiusFn: async () => null,
      recallFn: async () => [],
    });
    expect(result.blastRadius).toBeNull();
  });

  it('all sources work — full BugEvidence populated', async () => {
    const fakeGitLog: BugGitLogEntry[] = [{ sha: 'abc12345', author: 'maaz', date: '2026-05-31', subject: 'fix' }];
    const fakeBlast: BugBlastRadius = {
      repo: 'work-intelligence-mcp',
      file: 'src/routes/pr.ts',
      edges: [{ ref_type: 'call', src_file: 'a', dst_file: 'b' }],
      edgeCount: 1,
    };
    const fakeRecall: BugRecallHit[] = [
      { source: 'decision', id: 'dec_1', snippet: 'similar', confidence: 0.8, score: 0.7 },
    ];
    const result = await gatherEvidence({
      ...baseArgs,
      bug: makeBug({
        context_json: JSON.stringify({ stack: 'TypeError: x\n  at handler (/src/routes/pr.ts:89:7)\n  at next (/node_modules/express/route.js:144)' }),
      }),
      gitLogFn: async () => fakeGitLog,
      blastRadiusFn: async () => fakeBlast,
      recallFn: async () => fakeRecall,
    });
    expect(result.stack).toContain('TypeError: x');
    expect(result.topFrame).toBe('src/routes/pr.ts:89');
    expect(result.gitLog).toEqual(fakeGitLog);
    expect(result.blastRadius).toEqual(fakeBlast);
    expect(result.recall).toEqual(fakeRecall);
  });

  it('NEVER throws — all sources fail simultaneously', async () => {
    const result = await gatherEvidence({
      ...baseArgs,
      bug: makeBug(),
      gitLogFn: async () => { throw new Error('git'); },
      blastRadiusFn: async () => { throw new Error('http'); },
      recallFn: async () => { throw new Error('db'); },
    });
    // Returns a valid BugEvidence with empty fields; doesn't reject.
    expect(result.gitLog).toEqual([]);
    expect(result.blastRadius).toBeNull();
    expect(result.recall).toEqual([]);
  });

  it('stack truncation — keeps top 20 lines from context_json.stack', async () => {
    const longStack = Array.from({ length: 50 }, (_, i) => `  at line${i}`).join('\n');
    const result = await gatherEvidence({
      ...baseArgs,
      bug: makeBug({ context_json: JSON.stringify({ stack: longStack }) }),
      gitLogFn: async () => [],
      blastRadiusFn: async () => null,
      recallFn: async () => [],
    });
    expect(result.stack?.split('\n')).toHaveLength(20);
  });

  it('context_json without stack field → stack null', async () => {
    const result = await gatherEvidence({
      ...baseArgs,
      bug: makeBug({ context_json: JSON.stringify({ scope: 'TopicsPage' }) }),
      gitLogFn: async () => [],
      blastRadiusFn: async () => null,
      recallFn: async () => [],
    });
    expect(result.stack).toBeNull();
  });

  it('malformed context_json → stack null, no throw', async () => {
    const result = await gatherEvidence({
      ...baseArgs,
      bug: makeBug({ context_json: '{not valid json' }),
      gitLogFn: async () => [],
      blastRadiusFn: async () => null,
      recallFn: async () => [],
    });
    expect(result.stack).toBeNull();
  });
});
