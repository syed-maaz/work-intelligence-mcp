/**
 * ADR-039 T4 — phase-aware catalog tests.
 *
 * Covers AC-5 (scope/execute/both per tool; scope refuses
 * write/commit/push), AC-9 (refiner receives task_classes filtered as
 * hint), and AC-10 (hint is non-binding).
 *
 * Verification matrix:
 *   1. getCatalogForPhase('scope') returns ZERO phase=execute tools.
 *   2. getCatalogForPhase('execute') returns the full catalog.
 *   3. Every well-known mutator (write / commit / push surface — the
 *      brain-decide / project / task / grant / wi-resolve / smoke /
 *      gc / compact / record-outcome / reindex / save-to-ticket /
 *      sync / bug-report / bug-resolve / bug-resolve-all /
 *      skill-install / update-context cluster) has phase=execute.
 *      This is the registry-level enforcement AC-5 calls out.
 *   4. effectiveToolPhase defaults to 'both' for tools that omit the
 *      field — confirming the read-only default is preserved.
 *   5. getCatalogHint('investigate DEMO-15702', db) returns a
 *      non-empty hint when the catalog is seeded with a matching
 *      skill description.
 *   6. Empty / junk goals return '' so the refiner sees no hint.
 *   7. The hint surface names the skill — refiner remains free to
 *      ignore it (AC-10 non-binding). Test #5 is enough to satisfy
 *      AC-10's static guarantee: nothing in the public API forces the
 *      refiner to act on the hint.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  TOOL_CATALOG,
  getCatalogForPhase,
  getCatalogHint,
  effectiveToolPhase,
  type ToolDefinition,
} from '../../src/services/cypher/tool-catalog.js';
import migrateV63 from '../../src/db/migrations/v63_skill_catalog.js';

// ──────────────────────────────────────────────────────────────────────────
// Known-mutator allowlist
//
// These tools mutate fs / repo / external state and therefore MUST be
// phase='execute'. When a new mutator lands in the catalog, add its
// name here so the test pins it.
// ──────────────────────────────────────────────────────────────────────────
const KNOWN_MUTATORS = [
  // brain.decide writes to brain_decisions (and burns Opus tokens).
  'brain_decide',
  // code-graph reindex spawns ts-morph worker, holds repo lock.
  'code_graph_reindex',
  // wi.* mutators: every one writes external state (Jira, GitHub,
  // local files, or the skill-symlink tree).
  'wi_update_context',
  'wi_bug_resolve',
  'wi_bug_resolve_all',
  'wi_sync',
  'wi_bug_report',
  'wi_skill_install',
  'wi_save_to_ticket',
  // cypher_* project/task/grant CRUD: SQLite writes against
  // operator-visible records.
  'cypher_project_create',
  'cypher_task_create',
  'cypher_task_close',
  'cypher_task_recurate',
  'cypher_grant_create',
  'cypher_grant_revoke',
  // Context-management mutators: compact_context burns Haiku tokens,
  // gc_run sweeps tables, record_outcome writes the verdict row.
  'cypher_compact_context',
  'cypher_gc_run',
  'cypher_record_outcome',
  // Subprocess sandbox: smoke_run spawns npm; not strictly a mutator
  // but it has side-effects and must NOT run in scope phase.
  'smoke_run',
  // Heavy execute/analyze actions (tagged phase='execute' 2026-07-14 after
  // the SCOPE-hang investigation). Not fs/repo mutators, but each does
  // EXECUTE-class work — CQRS explicit-fetch (wi_search_all scrapes the
  // browser), AI/subagent pipelines (wi_investigate, wi_jira_analyze,
  // wi_pr_review, wi_morning_brief, wi_pre_meeting), external-MCP verify
  // (brain_verify), and a tsc subprocess (typecheck_run). Pinned here so a
  // future duration-lowering + dropped tag can't silently re-leak them into
  // the read-only scope surface. See bug_scope_phase_heavyweight_tool_leak.
  'brain_verify',
  'wi_investigate',
  'wi_pr_review',
  'wi_jira_analyze',
  'wi_pre_meeting',
  'wi_morning_brief',
  'wi_search_all',
  'typecheck_run',
];

describe('ADR-039 AC-5 — getCatalogForPhase', () => {
  it("scope phase returns zero phase='execute' tools", () => {
    const scope = getCatalogForPhase('scope');
    const leaked = scope.filter((t) => effectiveToolPhase(t) === 'execute');
    expect(leaked, `phase=execute tools must not appear in scope surface: ${leaked.map(t => t.name).join(', ')}`).toEqual([]);
  });

  it('execute phase returns every tool in the catalog (full surface)', () => {
    const exec = getCatalogForPhase('execute');
    expect(exec.length).toBe(TOOL_CATALOG.length);
    const names = new Set(exec.map((t) => t.name));
    for (const t of TOOL_CATALOG) {
      expect(names.has(t.name)).toBe(true);
    }
  });

  it('scope phase surface is non-empty (read tools survive)', () => {
    // Without this assertion the scope filter could be "match nothing"
    // and AC-5 would falsely pass. The catalog has read-only brain/palace/
    // wi-* tools that should always be in scope.
    const scope = getCatalogForPhase('scope');
    expect(scope.length).toBeGreaterThan(0);
    const scopeNames = new Set(scope.map((t) => t.name));
    expect(scopeNames.has('brain_recall')).toBe(true);
    expect(scopeNames.has('palace_search')).toBe(true);
  });

  it('every known mutator declares phase=execute', () => {
    for (const name of KNOWN_MUTATORS) {
      const tool = TOOL_CATALOG.find((t) => t.name === name);
      expect(tool, `mutator '${name}' missing from catalog`).toBeDefined();
      expect(
        effectiveToolPhase(tool as ToolDefinition),
        `mutator '${name}' must declare phase='execute' (registry-level enforcement, AC-5)`,
      ).toBe('execute');
    }
  });

  it("effectiveToolPhase defaults to 'both' when tool omits the field", () => {
    const synthetic: ToolDefinition = {
      name: 'synthetic_test_tool',
      description: 'test',
      category: 'auto',
      posture_eligibility: ['generic'],
      input_schema: { type: 'object', properties: {}, required: [] },
      estimated_duration_ms: 50,
      handler: async () => ({}),
    };
    expect(effectiveToolPhase(synthetic)).toBe('both');
  });

  it("effectiveToolPhase duration net: untagged tool > 3000ms is 'execute'", () => {
    // Safety net (SCOPE_UNTAGGED_MAX_DURATION_MS = 3000, added 2026-07-14):
    // an untagged tool heavier than the scope budget can absorb is treated
    // as execute-only, so a future heavy tool that forgets to declare a
    // phase can't silently leak into the read-only scope surface.
    const base = {
      name: 'synthetic_heavy_tool',
      description: 'test',
      category: 'auto' as const,
      posture_eligibility: ['generic'] as const,
      input_schema: { type: 'object' as const, properties: {}, required: [] },
      handler: async () => ({}),
    };
    // Boundary: 3000 stays 'both', 3001 flips to 'execute'.
    expect(effectiveToolPhase({ ...base, estimated_duration_ms: 3000 } as ToolDefinition)).toBe('both');
    expect(effectiveToolPhase({ ...base, estimated_duration_ms: 3001 } as ToolDefinition)).toBe('execute');
    expect(effectiveToolPhase({ ...base, estimated_duration_ms: 5000 } as ToolDefinition)).toBe('execute');
    // Explicit phase always wins over the duration net.
    expect(effectiveToolPhase({ ...base, estimated_duration_ms: 5000, phase: 'both' } as ToolDefinition)).toBe('both');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// AC-9 — getCatalogHint
// ──────────────────────────────────────────────────────────────────────────

function freshDbWithCatalog(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV63(db);
  return db;
}

function insertSkill(
  db: Database.Database,
  name: string,
  description: string,
  task_classes: string[],
  source: 'wi' | 'global' | 'plugin' | 'builtin' = 'wi',
): void {
  db.prepare(
    `INSERT INTO skill_catalog (skill_name, source, source_path, description, trigger_phrases, task_classes)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    name,
    source,
    `/tmp/${name}/SKILL.md`,
    description,
    JSON.stringify([]),
    JSON.stringify(task_classes),
  );
}

describe('ADR-039 AC-9 — getCatalogHint', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDbWithCatalog(); });
  afterEach(() => db.close());

  it('returns non-empty hint for "investigate DEMO-15702" when a matching skill exists', async () => {
    insertSkill(
      db,
      'wi-investigate',
      'Investigate a Jira ticket. Trace git log, feature flags, deps.',
      ['investigate', 'bug-resolution', 'jira'],
    );
    insertSkill(
      db,
      'unrelated-skill',
      'Configure smart home devices via Philips Hue.',
      ['smart-home', 'iot'],
    );

    const hint = await getCatalogHint('investigate DEMO-15702', db);
    expect(hint).not.toBe('');
    expect(hint).toContain('wi-investigate');
    // Surface task_classes per AC-9 phrasing ("task_classes filtered ...").
    expect(hint).toMatch(/task_classes/);
    // Should NOT surface the smart-home skill — no token overlap.
    expect(hint).not.toContain('unrelated-skill');
  });

  it('empty goal returns empty string', async () => {
    insertSkill(db, 'wi-investigate', 'Investigate bugs.', ['investigate']);
    expect(await getCatalogHint('', db)).toBe('');
    expect(await getCatalogHint('   ', db)).toBe('');
  });

  it('junk goal (only stopwords / 1-2 char tokens) returns empty string', async () => {
    insertSkill(db, 'wi-investigate', 'Investigate bugs.', ['investigate']);
    expect(await getCatalogHint('a an the', db)).toBe('');
    expect(await getCatalogHint('!! ?? ##', db)).toBe('');
  });

  it('returns empty string when no skill description overlaps the goal tokens', async () => {
    insertSkill(db, 'wi-something', 'Configure smart home devices.', ['smart-home']);
    expect(await getCatalogHint('investigate DEMO-15702', db)).toBe('');
  });

  it('returns empty string when skill_catalog table is missing (degrades silently)', async () => {
    const bareDb = new Database(':memory:');
    expect(await getCatalogHint('investigate DEMO-15702', bareDb)).toBe('');
    bareDb.close();
  });

  it('hint is advisory text only — AC-10 non-binding: caller is free to ignore', async () => {
    insertSkill(db, 'wi-investigate', 'Investigate Jira tickets.', ['investigate']);
    const hint = await getCatalogHint('investigate DEMO-15702', db);
    // AC-10: the hint is a string the refiner appends to its prompt;
    // there is no programmatic dispatch path from this function. The
    // public API returns ONLY a string — nothing executes the hint.
    expect(typeof hint).toBe('string');
    // Sanity: the advisory framing is visible to the LLM.
    expect(hint.toLowerCase()).toMatch(/advisory|non-binding|hint|candidate/);
  });

  it('ranks higher-overlap skills above lower-overlap and tops out at 5', async () => {
    // Fixtures use the wi- prefix: getCatalogHintWordOverlap filters
    // skill_catalog to Cypher-dispatchable wi-* skills only (recognition-recall
    // fix, ADR-042 2026-07-25). Non-wi fixtures would be filtered out and the
    // ranking assertion below would see an empty hint.
    insertSkill(db, 'wi-skill-a', 'investigate jira ticket bug analysis', ['investigate']);
    insertSkill(db, 'wi-skill-b', 'investigate something', ['investigate']);
    insertSkill(db, 'wi-skill-c', 'jira automation', ['jira']);
    insertSkill(db, 'wi-skill-d', 'bug report capture', ['bug']);
    insertSkill(db, 'wi-skill-e', 'ticket triage', ['triage']);
    insertSkill(db, 'wi-skill-f', 'analysis tools', ['analysis']);
    insertSkill(db, 'wi-skill-g', 'jira investigate analysis', ['investigate']);

    const hint = await getCatalogHint('investigate jira ticket bug analysis', db);
    expect(hint).not.toBe('');
    // wi-skill-a has 5 overlapping tokens (investigate, jira, ticket, bug,
    // analysis) → must outrank wi-skill-c (2: jira, automation* — but
    // 'automation' isn't in the goal, so only 1: jira).
    const aIdx = hint.indexOf('wi-skill-a');
    const cIdx = hint.indexOf('wi-skill-c');
    expect(aIdx).toBeGreaterThan(-1);
    expect(cIdx === -1 || aIdx < cIdx).toBe(true);
    // Cap at 5 results — count `  - ` line prefixes.
    const lineCount = (hint.match(/\n {2}- /g) ?? []).length;
    expect(lineCount).toBeLessThanOrEqual(5);
  });
});
