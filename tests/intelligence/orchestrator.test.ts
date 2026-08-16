import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { initializeDatabase } from '../../src/db/schema.js';
import {
  InvestigationOrchestrator,
  type InvestigationInput,
  type InvestigationReport,
} from '../../src/intelligence/investigation-orchestrator.js';
import { DEFAULT_OWNERSHIP_MAP } from '../../src/intelligence/ownership-map.js';
import {
  createInvestigationSession,
  completeInvestigation,
  getInvestigationSession,
  type PastInvestigation,
} from '../../src/db/queries/investigation.js';

// ---------------------------------------------------------------------------
// Test database helpers
// ---------------------------------------------------------------------------

function openTestDatabase(): Database.Database {
  const db = new Database(':memory:');
  initializeDatabase(db);
  return db;
}

function seedInvestigationSession(db: Database.Database, report: Partial<InvestigationReport> & { issueKey: string }): void {
  createInvestigationSession(db, report.issueKey, '2026-04-16', 'high');
  completeInvestigation(db, report.issueKey, {
    hypothesis:               report.rootCauseType ?? 'dep-upgrade',
    conclusion:               report.rootCause ?? '@types/openui5 1.145→1.146 broke async getResourceBundle()',
    confidence:               report.confidence ?? 0.9,
    ownerTeam:                report.fixOwner ?? 'SMRDP',
    regressionDate:           '2026-04-16',
    regressionDateConfidence: 'high',
    reportJson:               report,
  });
}

// ---------------------------------------------------------------------------
// DEMO-15257 scenario fixture
// ---------------------------------------------------------------------------

const BDS15257_SCENARIO = {
  ticket: {
    issueKey:    'DEMO-15257',
    title:       'BIS Recommended Links Not Showing After April 17',
    description: 'Since April 17, BIS recommended links are blank on every page. The component renders but returns no data. Checked console — no errors visible.',
    status:      'In Progress',
    assignee:    'maaz',
    createdAt:   '2026-04-17',
  },
  gitLog: {
    commits: [{
      sha:              '44a5ed8912',
      date:             '2026-04-16T10:00:00Z',
      author:           'dependabot',
      message:          'chore(deps): bump @types/openui5 from 1.145.0 to 1.146.0',
      filesChanged:     ['package.json', 'package-lock.json'],
      isDependencyBump: true,
    }],
    dependencyChanges: [{
      packageName: '@types/openui5', from: '1.145.0', to: '1.146.0', type: 'changed',
    }],
    summary: 'Found 1 commit: @types/openui5 1.145.0 → 1.146.0 (Apr16, dependabot)',
  },
  grepResult:  'No matches in example-service/src for getResourceBundle',
  callGraph: {
    nodes: [
      { file: 'apps/recommended-links/useRecommendedLinks.ts', repo: 'example-service', team: 'Saturn', isExternal: false, symbol: null },
      { file: 'webapps/plugins/Component.js', repo: 'smrdp-ui-plugins', team: 'SMRDP', isExternal: true, symbol: null },
    ],
    crossRepoBoundaries: [{ fromRepo: 'example-service', toRepo: 'smrdp-ui-plugins', via: 'webapps/plugins/Component.js' }],
    externalDeps: ['smrdp-ui-plugins'],
    edges: [], maxDepthReached: false,
    summary: 'Crossed into smrdp-ui-plugins (SMRDP team) via webapps/plugins/Component.js',
  },
  ownership: 'Owner: SMRDP. Note: Not in ./repos/, read-only reference',
};

// ---------------------------------------------------------------------------
// INCONCLUSIVE_SCENARIO — never calls conclude, exhausts 8 iterations
// ---------------------------------------------------------------------------

const INCONCLUSIVE_TICKET: InvestigationInput = {
  issueKey:    'DEMO-99999',
  title:       'Unknown intermittent flakiness in prod',
  description: 'Sometimes things fail, no clear pattern.',
  status:      'Open',
  assignee:    null,
  createdAt:   '2026-04-21',
};

// Tool response that never reaches conclude — just keeps calling git_log_window
const INCONCLUSIVE_TOOL_RESPONSE = (toolUseId: string) => ({
  id: 'msg_inconclusive',
  type: 'message' as const,
  role: 'assistant' as const,
  model: 'claude-sonnet-latest',
  stop_reason: 'tool_use' as const,
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  content: [
    { type: 'text' as const, text: 'Still investigating...' },
    {
      type: 'tool_use' as const,
      id:   toolUseId,
      name: 'git_log_window',
      input: { repo: 'example-service', since: '2026-04-14', until: '2026-04-21' },
    },
  ],
});

// ---------------------------------------------------------------------------
// Mock orchestrator builder
// ---------------------------------------------------------------------------

interface MockTools {
  calls: Array<{ name: string; input: Record<string, unknown> }>;
}

/**
 * Build an InvestigationOrchestrator with a mocked Anthropic client.
 * The mock cycles through a predefined sequence of tool calls, then
 * concludes with a DEMO-15257-style dep-upgrade finding.
 */
function buildMockOrchestrator(
  scenario: typeof BDS15257_SCENARIO,
  db?: Database.Database
): { orchestrator: InvestigationOrchestrator; mockTools: MockTools } {
  const testDb = db ?? openTestDatabase();
  const mockTools: MockTools = { calls: [] };

  // Scripted tool call sequence for DEMO-15257
  let callCount = 0;
  const toolSequence = [
    // Iteration 1: git_log_window
    {
      name: 'git_log_window',
      input: { repo: 'example-service', since: '2026-04-14', until: '2026-04-19' },
      observation: scenario.gitLog.summary,
    },
    // Iteration 2: trace_call_graph
    {
      name: 'trace_call_graph',
      input: { repo: 'example-service', startFile: 'apps/recommended-links/useRecommendedLinks.ts', direction: 'callees', maxDepth: 3 },
      observation: scenario.callGraph.summary,
    },
    // Iteration 3: get_ownership
    {
      name: 'get_ownership',
      input: { file: 'webapps/plugins/Component.js', repo: 'smrdp-ui-plugins' },
      observation: scenario.ownership,
    },
    // Iteration 4: get_flag_diff (required by GATE before dep-upgrade conclude)
    {
      name: 'get_flag_diff',
      input: { since: '2026-04-13', until: '2026-04-19' },
      observation: 'No flag changes in this window.',
    },
    // Iteration 5: conclude
    {
      name: 'conclude',
      input: {
        rootCauseType:  'dep-upgrade',
        isExternalDep:  true,
        fixOwner:       'SMRDP',
        confidence:     0.92,
        rootCause:      '@types/openui5 bumped from 1.145.0 to 1.146.0 on Apr 16 — async getResourceBundle() breaking change in smrdp-ui-plugins Component.js',
        nextAction: 'Escalate to SMRDP team — no Saturn code change required',
        proposedFix:    null,
        evidence: [
          { type: 'git-commit', description: 'dependabot bumped @types/openui5 1.145→1.146 on Apr 16', sha: '44a5ed8912' },
          { type: 'dep-diff',   description: '@types/openui5: 1.145.0 → 1.146.0 (type changed)' },
          { type: 'call-graph', description: 'example-service crosses into smrdp-ui-plugins via webapps/plugins/Component.js' },
          { type: 'ownership',  description: 'webapps/plugins/Component.js owned by SMRDP team' },
        ],
      },
      observation: 'Conclusion recorded.',
    },
  ];

  // Create mock Anthropic client
  const mockCreate = vi.fn(async () => {
    const step = toolSequence[callCount];
    if (!step) {
      // Exhausted — return text-only (no tool call)
      return {
        id: `msg_end_${callCount}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-latest',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [{ type: 'text', text: 'Investigation complete.' }],
      };
    }

    const toolUseId = `toolu_${callCount.toString().padStart(3, '0')}`;
    callCount++;

    mockTools.calls.push({ name: step.name, input: step.input as Record<string, unknown> });

    return {
      id: `msg_${callCount}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-latest',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [
        { type: 'text', text: `Iteration ${callCount}: calling ${step.name}` },
        { type: 'tool_use', id: toolUseId, name: step.name, input: step.input },
      ],
    };
  });

  const mockClient = {
    messages: { create: mockCreate },
  } as unknown as Anthropic;

  const orchestrator = new InvestigationOrchestrator(
    mockClient,
    testDb,
    { 'example-service': '/tmp/mock-example-service', operations: '/tmp/mock-operations' },
    DEFAULT_OWNERSHIP_MAP
  );

  return { orchestrator, mockTools };
}

/**
 * Build a mock orchestrator that never calls conclude — used for max-iterations test.
 */
function buildInconclusiveMockOrchestrator(
  db?: Database.Database
): { orchestrator: InvestigationOrchestrator; mockTools: MockTools } {
  const testDb = db ?? openTestDatabase();
  const mockTools: MockTools = { calls: [] };
  let callCount = 0;

  const mockCreate = vi.fn(async () => {
    const toolUseId = `toolu_inc_${callCount.toString().padStart(3, '0')}`;
    callCount++;

    const resp = INCONCLUSIVE_TOOL_RESPONSE(toolUseId);
    mockTools.calls.push({ name: 'git_log_window', input: resp.content[1].input as Record<string, unknown> });

    return resp;
  });

  const mockClient = {
    messages: { create: mockCreate },
  } as unknown as Anthropic;

  const orchestrator = new InvestigationOrchestrator(
    mockClient,
    testDb,
    { 'example-service': '/tmp/mock-example-service', operations: '/tmp/mock-operations' },
    DEFAULT_OWNERSHIP_MAP
  );

  return { orchestrator, mockTools };
}

// ---------------------------------------------------------------------------
// SIMILAR_TO_BDS15257 — for pattern-match short-circuit test
// ---------------------------------------------------------------------------

const BDS15257_COMPLETED_REPORT = {
  issueKey:      'DEMO-15257',
  rootCauseType: 'dep-upgrade',
  rootCause:     '@types/openui5 bumped from 1.145.0 to 1.146.0 — breaking change in smrdp-ui-plugins',
  confidence:    0.9,
  fixOwner:      'SMRDP',
};

const SIMILAR_TICKET: InvestigationInput = {
  issueKey:    'DEMO-99888',
  title:       'BIS Recommended Links blank after openui5 upgrade',
  description: 'Same as DEMO-15257, links are not showing after openui5 type bump.',
  status:      'Open',
  assignee:    null,
  createdAt:   '2026-04-21',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InvestigationOrchestrator — Integration Tests', () => {

  describe('DEMO-15257 mock replay', () => {
    it('reaches correct root cause within 6 iterations', async () => {
      const { orchestrator, mockTools } = buildMockOrchestrator(BDS15257_SCENARIO);
      const report = await orchestrator.investigate(BDS15257_SCENARIO.ticket);

      expect(report.rootCauseType).toBe('dep-upgrade');
      expect(report.isExternalDep).toBe(true);
      expect(report.fixOwner).toContain('SMRDP');
      expect(report.confidence).toBeGreaterThanOrEqual(0.8);
      expect(report.reactTrace.length).toBeLessThanOrEqual(6);
    });

    it('git_log_window is called first', async () => {
      const { orchestrator, mockTools } = buildMockOrchestrator(BDS15257_SCENARIO);
      await orchestrator.investigate(BDS15257_SCENARIO.ticket);

      expect(mockTools.calls[0].name).toBe('git_log_window');
    });

    it('proposes no example-service code fix when owner is external', async () => {
      const { orchestrator } = buildMockOrchestrator(BDS15257_SCENARIO);
      const report = await orchestrator.investigate(BDS15257_SCENARIO.ticket);

      expect(report.proposedFix).toBeNull();
      expect(report.nextAction).toMatch(/no.*change|SMRDP|external|escalate/i);
    });

    it('evidence includes dep-diff entry', async () => {
      const { orchestrator } = buildMockOrchestrator(BDS15257_SCENARIO);
      const report = await orchestrator.investigate(BDS15257_SCENARIO.ticket);

      const depEvidence = report.evidence.find(e => e.type === 'dep-diff');
      expect(depEvidence).toBeDefined();
      expect(depEvidence!.description).toContain('@types/openui5');
    });

    it('persists session to DB with status done', async () => {
      const db = openTestDatabase();
      const { orchestrator } = buildMockOrchestrator(BDS15257_SCENARIO, db);
      await orchestrator.investigate(BDS15257_SCENARIO.ticket);

      const session = getInvestigationSession(db, 'DEMO-15257');
      expect(session).not.toBeNull();
      expect(session!.status).toBe('done');
      expect(session!.owner_team).toBe('SMRDP');
      expect(session!.confidence).toBeGreaterThanOrEqual(0.8);
    });
  });

  describe('Edge cases', () => {
    it('terminates at max 8 iterations with uncertainty report', async () => {
      const { orchestrator } = buildInconclusiveMockOrchestrator();
      const report = await orchestrator.investigate(INCONCLUSIVE_TICKET);

      expect(report.reactTrace.length).toBe(8);
      expect(report.confidence).toBeLessThan(0.5);
      expect(report.rootCauseType).toBe('unknown');
    });

    it('uncertainty report has null proposedFix', async () => {
      const { orchestrator } = buildInconclusiveMockOrchestrator();
      const report = await orchestrator.investigate(INCONCLUSIVE_TICKET);

      expect(report.proposedFix).toBeNull();
    });

    it('skips loop and returns pattern match when similar investigation exists', async () => {
      const db = openTestDatabase();
      seedInvestigationSession(db, BDS15257_COMPLETED_REPORT);

      // Build a mock orchestrator pointing at the pre-seeded DB
      // (the mock Claude should never be called since pattern match short-circuits)
      const mockCreate = vi.fn(async () => {
        throw new Error('Claude should not be called when pattern match short-circuits');
      });
      const mockClient = {
        messages: { create: mockCreate },
      } as unknown as Anthropic;

      const orchestrator = new InvestigationOrchestrator(
        mockClient,
        db,
        { 'example-service': '/tmp/mock-example-service', operations: '/tmp/mock-operations' },
        DEFAULT_OWNERSHIP_MAP
      );

      const report = await orchestrator.investigate(SIMILAR_TICKET);

      expect(report.rootCauseType).toBe('unknown');  // pattern match sets from prior conclusion string
      expect(report.reactTrace.length).toBe(0);       // skipped loop
      expect(report.evidence[0].type).toBe('pattern-match');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('does not propose fix for external team even with concrete code evidence', async () => {
      const { orchestrator } = buildMockOrchestrator(BDS15257_SCENARIO);
      const report = await orchestrator.investigate(BDS15257_SCENARIO.ticket);
      expect(report.proposedFix).toBeNull();
    });

    it('report is stored as JSON in DB react_trace field', async () => {
      const db = openTestDatabase();
      const { orchestrator } = buildMockOrchestrator(BDS15257_SCENARIO, db);
      await orchestrator.investigate(BDS15257_SCENARIO.ticket);

      const session = getInvestigationSession(db, 'DEMO-15257');
      expect(session).not.toBeNull();

      const trace = JSON.parse(session!.react_trace ?? '[]');
      expect(Array.isArray(trace)).toBe(true);
      expect(trace.length).toBeGreaterThan(0);
      expect(trace[0]).toHaveProperty('tool');
      expect(trace[0]).toHaveProperty('iteration');
    });

    it('report_json field is populated after completion', async () => {
      const db = openTestDatabase();
      const { orchestrator } = buildMockOrchestrator(BDS15257_SCENARIO, db);
      await orchestrator.investigate(BDS15257_SCENARIO.ticket);

      const session = getInvestigationSession(db, 'DEMO-15257');
      expect(session!.report_json).not.toBeNull();

      const report = JSON.parse(session!.report_json!);
      expect(report.rootCauseType).toBe('dep-upgrade');
      expect(report.isExternalDep).toBe(true);
    });
  });
});
