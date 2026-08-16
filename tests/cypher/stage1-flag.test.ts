/**
 * ADR-042 Phase 1b — WI_STAGE1_ENABLED flag integration.
 *
 * Verifies:
 *   - Flag off (default): loop's SCOPE refiner prompt does NOT contain
 *     the Stage 1 evidence block.
 *   - Flag on: loop's SCOPE refiner prompt PREPENDS the Stage 1 evidence
 *     block, so 1b has access to the full recognition bundle.
 *
 * We don't spin up the full runLoop (that would need a mocked Anthropic
 * SDK, DB fixtures, and a live posture registry — all out of scope for
 * a Stage 1 wiring test). Instead we verify the composition logic by
 * exercising the same imports the loop uses and asserting the block
 * shape.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  stage1Fetch,
  renderStage1EvidenceBlock,
} from '../../src/services/cypher/stage1.js';

function bareDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  return db;
}

// Reproduce the loop.ts prepend logic (kept in sync with loop.ts:1030-1032).
function composeRefinerPrompt(basePrompt: string, stage1Block: string): string {
  if (stage1Block) {
    return `${stage1Block}\n\n---\n\n${basePrompt}`;
  }
  return basePrompt;
}

describe('ADR-042 Stage 1 — WI_STAGE1_ENABLED flag composition', () => {
  let db: Database.Database;
  beforeEach(() => { db = bareDb(); });
  afterEach(() => db.close());

  it('flag off (empty block): refiner prompt is unchanged (base only)', () => {
    const base = 'BASE REFINER PROMPT — you are Cypher, refine goals';
    const composed = composeRefinerPrompt(base, '');
    expect(composed).toBe(base);
  });

  it('flag on: refiner prompt starts with the Stage 1 evidence block', async () => {
    const ev = await stage1Fetch('any test goal', db);
    const block = renderStage1EvidenceBlock(ev);
    const base = 'BASE REFINER PROMPT — you are Cypher, refine goals';
    const composed = composeRefinerPrompt(base, block);
    expect(composed.startsWith('## Stage 1a evidence')).toBe(true);
    expect(composed).toContain('---');
    expect(composed.endsWith(base)).toBe(true);
  });

  it('flag on: Stage 1 block includes the load-bearing 1-pass instruction', async () => {
    const ev = await stage1Fetch('some goal', db);
    const block = renderStage1EvidenceBlock(ev);
    expect(block).toContain('one pass');
    expect(block).toContain('recognition-only');
  });

  it('Stage 1 evidence block never contains executable dispatch instructions', async () => {
    const ev = await stage1Fetch('another goal', db);
    const block = renderStage1EvidenceBlock(ev);
    // Explicitly forbidden: execute-phase tool names shouldn't be in the block
    expect(block).not.toContain('wi_search_all');
    expect(block).not.toContain('brain_decide');
    expect(block).not.toContain('typecheck_run');
    // The block IS about recognition — say so.
    expect(block).toContain('do NOT execute');
  });
});
