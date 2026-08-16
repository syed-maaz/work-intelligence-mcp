/**
 * ADR-042 Phase 1 — Stage 1 fetch + evidence contract tests.
 *
 * Verifies:
 *   - snippet truncation contract (≤120 chars — the HIGH-3 fix)
 *   - catalog-hint parser recognises semantic AND word-overlap paths
 *   - stage1Fetch never throws even when DB has no tables
 *   - stage1Fetch aggregates from independent sources safely
 *   - fetch_wallclock_ms is bounded by the timeout
 *   - renderStage1EvidenceBlock produces stable prompt boundary text
 *
 * No LLM calls, no Ollama — pure evidence-shape tests. Real semantic
 * hits are exercised in scripts/smoke-stage1.sh against the live DB.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  stage1Fetch,
  truncateSnippet,
  parseCatalogHintOutput,
  renderStage1EvidenceBlock,
  computeRecognitionConfidence,
  RECOGNITION_CONFIDENCE_GATE_DEFAULT,
  RECOGNITION_CONFIDENCE_MARGIN_DEFAULT,
  SNIPPET_MAX_CHARS,
  STAGE1_FETCH_TIMEOUT_MS,
  MAX_HITS_PER_SOURCE,
} from '../../src/services/cypher/stage1.js';
import migrateV101 from '../../src/db/migrations/v101_doc_embeddings.js';
import { embedDocs, checkOllamaAvailable } from '../../src/services/embedder.js';

function bareDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  return db;
}

describe('ADR-042 Stage 1 — truncateSnippet contract', () => {
  it('leaves short strings unchanged', () => {
    expect(truncateSnippet('hello')).toBe('hello');
  });

  it('trims to SNIPPET_MAX_CHARS with a ellipsis marker', () => {
    const big = 'a'.repeat(300);
    const cut = truncateSnippet(big);
    expect(cut.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('normalises whitespace onto one line', () => {
    expect(truncateSnippet('a\n  b\n\tc')).toBe('a b c');
  });

  it('accepts custom max param', () => {
    expect(truncateSnippet('abcdef', 3)).toBe('ab…');
  });

  it('handles null/undefined without throwing', () => {
    expect(truncateSnippet(undefined as unknown as string)).toBe('');
    expect(truncateSnippet(null as unknown as string)).toBe('');
  });
});

describe('ADR-042 Stage 1 — parseCatalogHintOutput', () => {
  it('recognises the semantic-path header', () => {
    const hint = [
      'Candidate skills (learned from similar past prompts + success-rate — advisory, not binding):',
      '  - wi-investigate (sim=0.83, success=0.72, matches=12)',
      '  - wi-search (sim=0.75, success=0.87, matches=5)',
    ].join('\n');
    const parsed = parseCatalogHintOutput(hint);
    expect(parsed.source).toBe('semantic');
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0]!.id).toBe('wi-investigate');
    expect(parsed.candidates[0]!.score).toBeCloseTo(0.83, 4);
  });

  it('recognises the word-overlap-path header', () => {
    const hint = [
      'Candidate skills (description-overlap with raw goal — advisory, not binding):',
      '  - code-reviewer (score=3) [task_classes: code-review, pr]',
      '  - wi-pr-review (score=2)',
    ].join('\n');
    const parsed = parseCatalogHintOutput(hint);
    expect(parsed.source).toBe('word-overlap');
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0]!.id).toBe('code-reviewer');
    expect(parsed.candidates[0]!.score).toBe(3);
  });

  it('empty/whitespace input → empty candidates', () => {
    expect(parseCatalogHintOutput('').source).toBe('empty');
    expect(parseCatalogHintOutput('   \n\n').source).toBe('empty');
    expect(parseCatalogHintOutput('').candidates).toEqual([]);
  });

  it('unknown header → empty (safer than misclassifying)', () => {
    const hint = 'Some future format we do not recognise\n  - foo (sim=0.9)';
    const parsed = parseCatalogHintOutput(hint);
    expect(parsed.source).toBe('empty');
    expect(parsed.candidates).toEqual([]);
  });

  it('every parsed candidate snippet fits SNIPPET_MAX_CHARS', () => {
    const hint = [
      'Candidate skills (learned from similar past prompts + success-rate — advisory, not binding):',
      `  - ${'x'.repeat(200)} (sim=0.8)`,
    ].join('\n');
    const parsed = parseCatalogHintOutput(hint);
    // The line is skipped rather than truncated (skill name doesn't match the regex).
    // That's fine — we only ingest valid entries.
    // But when a valid line is parsed, its snippet must fit.
    const hintValid = [
      'Candidate skills (learned from similar past prompts + success-rate — advisory, not binding):',
      `  - wi-x (sim=0.8) ${'y'.repeat(300)}`,
    ].join('\n');
    const parsedValid = parseCatalogHintOutput(hintValid);
    for (const c of parsedValid.candidates) {
      expect(c.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    }
    void parsed; // reference to satisfy noUnusedLocals
  });
});

describe('ADR-042 Stage 1 — stage1Fetch resilience', () => {
  let db: Database.Database;
  beforeEach(() => { db = bareDb(); });
  afterEach(() => db.close());

  it('empty goal returns empty evidence, does not throw', async () => {
    const ev = await stage1Fetch('', db);
    expect(ev.goal).toBe('');
    expect(ev.prompt_memory_hits).toEqual([]);
    expect(ev.message_hits).toEqual([]);
    expect(ev.doc_hits).toEqual([]);
    expect(ev.catalog_candidates).toEqual([]);
    expect(ev.catalog_source).toBe('empty');
    expect(ev.semantic_available).toBe(false);
    expect(ev.errors).toEqual([]);
  });

  it('DB with no relevant tables → empty hits, non-empty errors possibly, never throws', async () => {
    const ev = await stage1Fetch('any goal', db);
    // No throw is the primary invariant. Some hits *may* be non-empty
    // depending on which branch failed hard vs quietly — assert only
    // structural invariants.
    expect(ev.goal).toBe('any goal');
    expect(Array.isArray(ev.prompt_memory_hits)).toBe(true);
    expect(Array.isArray(ev.message_hits)).toBe(true);
    expect(Array.isArray(ev.doc_hits)).toBe(true);
    expect(Array.isArray(ev.catalog_candidates)).toBe(true);
    expect(ev.fetch_wallclock_ms).toBeGreaterThanOrEqual(0);
  });

  it('respects overall timeout — wall-clock stays under budget', async () => {
    const ev = await stage1Fetch('some goal', db, { timeoutMs: 200 });
    // Bounded: 200ms budget + some slack. Ollama probes race-cap at 200
    // so total ≤ 400 in the worst case.
    expect(ev.fetch_wallclock_ms).toBeLessThan(1500);
  });

  it('respects maxHitsPerSource cap on catalog_candidates', async () => {
    const ev = await stage1Fetch('anything', db, { maxHitsPerSource: 2 });
    expect(ev.catalog_candidates.length).toBeLessThanOrEqual(2);
  });

  it('all hit snippets satisfy the ≤120-char contract', async () => {
    const ev = await stage1Fetch('test the contract', db);
    for (const bucket of [ev.prompt_memory_hits, ev.message_hits, ev.catalog_candidates]) {
      for (const h of bucket) {
        expect(h.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
      }
    }
  });
});

describe('ADR-042 Stage 1 — renderStage1EvidenceBlock', () => {
  it('renders header, goal, and 1-pass instruction for empty evidence', () => {
    const block = renderStage1EvidenceBlock({
      goal: 'test goal',
      semantic_available: false,
      prompt_memory_hits: [],
      message_hits: [],
      catalog_candidates: [],
      catalog_source: 'empty',
      fetch_wallclock_ms: 42,
      errors: [],
    });
    expect(block).toContain('Stage 1a evidence');
    expect(block).toContain('test goal');
    expect(block).toContain('No local recognition');
    expect(block).toContain('one pass'); // 1b instruction
    expect(block).toContain('recognition-only');
  });

  it('renders candidate skills section when present', () => {
    const block = renderStage1EvidenceBlock({
      goal: 'g',
      semantic_available: true,
      prompt_memory_hits: [],
      message_hits: [],
      catalog_candidates: [
        { source: 'catalog_hint', id: 'wi-x', score: 0.8, snippet: 'wi-x (sim=0.8)' },
      ],
      catalog_source: 'semantic',
      fetch_wallclock_ms: 10,
      errors: [],
    });
    expect(block).toContain('Candidate skills (semantic path)');
    expect(block).toContain('wi-x');
  });

  it('renders message hits with source label and sim score', () => {
    const block = renderStage1EvidenceBlock({
      goal: 'g',
      semantic_available: true,
      prompt_memory_hits: [],
      message_hits: [
        { source: 'messages', id: '42', score: 0.71, snippet: 'jira DEMO-15702 search-provider proxy fix' },
      ],
      catalog_candidates: [],
      catalog_source: 'empty',
      fetch_wallclock_ms: 15,
      errors: [],
    });
    expect(block).toContain('Related messages');
    expect(block).toContain('msg#42 sim=0.71');
    expect(block).toContain('search-provider');
  });

  it('block is deterministic for a fixed evidence input (snapshot-friendly)', () => {
    const ev = {
      goal: 'stable',
      semantic_available: true,
      prompt_memory_hits: [] as never[],
      message_hits: [] as never[],
      catalog_candidates: [] as never[],
      catalog_source: 'empty' as const,
      fetch_wallclock_ms: 0,
      errors: [],
    };
    const a = renderStage1EvidenceBlock(ev);
    const b = renderStage1EvidenceBlock(ev);
    expect(a).toBe(b);
  });
});

describe('ADR-042 Stage 1 — exported constants match ADR contract', () => {
  it('SNIPPET_MAX_CHARS is 120 (matches ADR-042 HIGH-3 fix)', () => {
    expect(SNIPPET_MAX_CHARS).toBe(120);
  });
  it('STAGE1_FETCH_TIMEOUT_MS is positive and reasonable (≤2000)', () => {
    expect(STAGE1_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(STAGE1_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });
  it('MAX_HITS_PER_SOURCE is bounded (2..15)', () => {
    expect(MAX_HITS_PER_SOURCE).toBeGreaterThanOrEqual(2);
    expect(MAX_HITS_PER_SOURCE).toBeLessThanOrEqual(15);
  });
});

describe('ADR-042 Stage 1 — two-tier merge invariants (audit HIGH-1)', () => {
  it('anti-domination: skill in prompt_memory does NOT also appear in catalog_candidates', async () => {
    // Structural invariant on the returned evidence bundle — enforced by
    // the anti-domination pass in stage1Fetch. When wi-investigate is
    // in prompt_memory_hits, it must NOT also be in catalog_candidates.
    // This test uses a bare DB (no data), so both arrays will be empty
    // and the invariant holds vacuously — the real check runs live in
    // scripts/stage1-realwork.mjs against the 854-row prompt_memory.
    const db = bareDb();
    try {
      const ev = await stage1Fetch('any test goal', db);
      const pmIds = new Set(ev.prompt_memory_hits.map((h) => h.id));
      const catIds = ev.catalog_candidates.map((c) => c.id);
      const overlap = catIds.filter((id) => pmIds.has(id));
      expect(overlap).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ── ADR-042 Gap 2: Branch-D doc_embeddings integration ─────────────────────

describe('ADR-042 Stage 1 — doc_embeddings Branch-D', () => {
  let db: Database.Database;
  let repo: { root: string; cleanup: () => void };
  let ollamaUp = false;

  function docDb(): Database.Database {
    const d = new Database(':memory:');
    d.exec(`CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    migrateV101(d);
    return d;
  }
  function fakeDocs(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'wi-stage1-docs-'));
    const adrDir = join(root, 'docs/docs/adr');
    mkdirSync(adrDir, { recursive: true });
    writeFileSync(
      join(adrDir, 'adr-777-search-provider-proxy-auth.md'),
      `# ADR-777: search-provider proxy authentication\n\nThe search-provider search proxy returns 401 when the token middleware is misconfigured; this ADR fixes the session-format migration.`,
    );
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  beforeAll(async () => { ollamaUp = await checkOllamaAvailable(); });
  beforeEach(() => { db = docDb(); repo = fakeDocs(); });
  afterEach(() => { db.close(); repo.cleanup(); });

  it('a doc-shaped goal surfaces the ADR in doc_hits and marks semantic_available — live Ollama', async () => {
    if (!ollamaUp) { expect(ollamaUp).toBe(false); return; } // skip cleanly when Ollama down
    await embedDocs(db, repo.root);
    const ev = await stage1Fetch('why does the search-provider proxy return 401', db, { timeoutMs: 2000 });
    expect(ev.doc_hits.length).toBeGreaterThan(0);
    expect(ev.doc_hits[0]!.source).toBe('doc');
    expect(ev.doc_hits[0]!.id).toContain('adr-777');
    expect(ev.semantic_available).toBe(true);
    // Snippet obeys the ≤120-char recognition contract.
    for (const h of ev.doc_hits) expect(h.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    // Rendered block includes the docs section.
    const block = renderStage1EvidenceBlock(ev);
    expect(block).toContain('Related docs');
  });

  it('no doc_embeddings table / empty → doc_hits [] and no throw', async () => {
    const ev = await stage1Fetch('anything at all', bareDb());
    expect(Array.isArray(ev.doc_hits)).toBe(true);
  });
});

describe('recognition-feedback — computeRecognitionConfidence', () => {
  const H = (id: string, score: number) => ({
    source: 'catalog_hint' as const,
    id,
    score,
    snippet: `${id} score=${score}`,
  });

  it('clear strong winner → high', () => {
    const { recognition_confidence, confidence_signal } = computeRecognitionConfidence(
      [H('wi-blast-radius', 0.38), H('wi-investigate', 0.05)],
      [],
    );
    expect(recognition_confidence).toBe('high');
    expect(confidence_signal.top_skill).toBe('wi-blast-radius');
    expect(confidence_signal.top1_score).toBeCloseTo(0.38);
  });

  it('tied top-2 (margin too small) → low even when top1 clears the gate', () => {
    // Both above the 0.3 gate, but the 0.02 margin is below the 0.1 default.
    const { recognition_confidence, confidence_signal } = computeRecognitionConfidence(
      [H('wi-pr-review', 0.35), H('wi-investigate', 0.33)],
      [],
    );
    expect(recognition_confidence).toBe('low');
    expect(confidence_signal.top_skill).toBe('wi-pr-review');
  });

  it('top1 below the gate → low even with a wide margin', () => {
    const { recognition_confidence } = computeRecognitionConfidence(
      [H('wi-search', 0.2), H('wi-teams', 0.01)],
      [],
    );
    expect(recognition_confidence).toBe('low');
  });

  it('empty pool → low with null top_skill', () => {
    const { recognition_confidence, confidence_signal } = computeRecognitionConfidence([], []);
    expect(recognition_confidence).toBe('low');
    expect(confidence_signal.top_skill).toBeNull();
    expect(confidence_signal.top1_score).toBe(0);
  });

  it('merges catalog + prompt_memory by skill id, keeping the higher score', () => {
    // wi-investigate appears in both lanes; the higher (0.4) wins, so it is
    // top-1 and the 0.05 catalog dupe does NOT create a second entry that
    // would look like a tied field.
    const { confidence_signal, recognition_confidence } = computeRecognitionConfidence(
      [H('wi-investigate', 0.05), H('wi-blast-radius', 0.02)],
      [{ source: 'prompt_memory', id: 'wi-investigate', score: 0.4, snippet: 'x' }],
    );
    expect(confidence_signal.top_skill).toBe('wi-investigate');
    expect(confidence_signal.top1_score).toBeCloseTo(0.4);
    // top2 is wi-blast-radius at 0.02 → margin 0.38 ≥ 0.1 and top1 ≥ gate → high.
    expect(recognition_confidence).toBe('high');
  });

  it('respects explicit gate/margin overrides (env-tunable knobs)', () => {
    // With a punishing gate of 0.9, even a strong 0.4 winner is "low".
    const low = computeRecognitionConfidence([H('wi-x', 0.4), H('wi-y', 0.01)], [], 0.9, 0.1);
    expect(low.recognition_confidence).toBe('low');
    // With a lax gate of 0.1 and margin 0.0, the same field is "high".
    const high = computeRecognitionConfidence([H('wi-x', 0.4), H('wi-y', 0.39)], [], 0.1, 0.0);
    expect(high.recognition_confidence).toBe('high');
  });

  it('default knobs are the documented band values', () => {
    expect(RECOGNITION_CONFIDENCE_GATE_DEFAULT).toBe(0.3);
    expect(RECOGNITION_CONFIDENCE_MARGIN_DEFAULT).toBe(0.1);
  });

  it('stage1Fetch attaches a confidence flag + signal to the bundle', async () => {
    const ev = await stage1Fetch('some cold-start goal', bareDb());
    // bareDb has no embeddings → empty pool → low with a shaped signal object.
    expect(ev.recognition_confidence).toBe('low');
    expect(ev.confidence_signal).toMatchObject({
      top_skill: null,
      gate: RECOGNITION_CONFIDENCE_GATE_DEFAULT,
      margin: RECOGNITION_CONFIDENCE_MARGIN_DEFAULT,
    });
  });
});
