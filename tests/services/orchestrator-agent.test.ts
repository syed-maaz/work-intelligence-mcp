/**
 * Unit tests for OrchestratorAgent — Phase 64 Plan 01
 *
 * Tests the tool_use agentic loop: topic routing, alert scoring,
 * max turns enforcement, dedup guard, and null source_id skip.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { OrchestratorAgent } from '../../src/services/orchestrator-agent.js';

// Mock scoreMessageSeverity
vi.mock('../../src/services/analyzer.js', () => ({
  scoreMessageSeverity: vi.fn(),
}));

// Mock Anthropic SDK
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: vi.fn().mockImplementation(function(this: any) {
    this.beta = { promptCaching: { messages: { create: mockCreate } } };
  }),
}));

import { scoreMessageSeverity } from '../../src/services/analyzer.js';

// Helper: create a tool_use response
function createMockToolUseResponse(toolName: string, input: Record<string, unknown>) {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
        name: toolName,
        input,
      },
    ],
  };
}

// Helper: create an end_turn response
function createMockEndTurnResponse() {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Done — no further action needed.' }],
  };
}

describe('OrchestratorAgent', () => {
  let db: Database.Database;
  let orchestrator: OrchestratorAgent;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create in-memory DB with minimal schema
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        config TEXT
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER,
        source TEXT,
        content TEXT,
        author TEXT,
        timestamp TEXT,
        metadata TEXT,
        source_id TEXT,
        subject TEXT,
        raw_data TEXT
      );

      CREATE TABLE proactive_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        source_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        read_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_proactive_queue_agent_source ON proactive_queue(agent, source_id, created_at);
    `);

    orchestrator = new OrchestratorAgent(db, 'test-api-key');
  });

  afterEach(() => {
    db.close();
  });

  describe('dispatch flow', () => {
    it('dispatches new-message event through tool_use loop', async () => {
      // Insert topic with matching config
      db.prepare(`INSERT INTO topics (name, config) VALUES (?, ?)`).run(
        'Saturn',
        JSON.stringify({ teams: { channels: ['saturn'] } })
      );

      // Insert message that matches the topic
      const result = db.prepare(
        `INSERT INTO messages (source_id, content, author, subject, source) VALUES (?, ?, ?, ?, ?)`
      ).run('msg-1', 'Discussion about saturn release plan', 'Alice', 'Saturn Release', 'teams');
      const msgId = Number(result.lastInsertRowid);

      // Mock: 1st call returns topic_router, 2nd returns alert_scorer, 3rd returns end_turn
      mockCreate
        .mockResolvedValueOnce(
          createMockToolUseResponse('topic_router', {
            content_snippet: 'Discussion about saturn release plan',
            source: 'teams',
          })
        )
        .mockResolvedValueOnce(
          createMockToolUseResponse('alert_scorer', {
            content: 'Discussion about saturn release plan',
            author: 'Alice',
            subject: 'Saturn Release',
          })
        )
        .mockResolvedValueOnce(createMockEndTurnResponse());

      // Mock scoreMessageSeverity to return medium
      (scoreMessageSeverity as ReturnType<typeof vi.fn>).mockResolvedValue({
        severity: 'medium',
        summary: 'Saturn release discussion',
        reason: 'Release planning requires attention',
      });

      await orchestrator.handleNewMessage(msgId);

      // Verify: mockCreate called 3 times (initial + 2 tool loops)
      expect(mockCreate).toHaveBeenCalledTimes(3);

      // Verify: proactive_queue has 1 row (medium severity was queued)
      const queueRows = db.prepare(`SELECT * FROM proactive_queue`).all();
      expect(queueRows).toHaveLength(1);
    });
  });

  describe('topic router', () => {
    it('topic router returns relevant for matching topic config', async () => {
      // Insert topic with config matching 'release-train'
      db.prepare(`INSERT INTO topics (name, config) VALUES (?, ?)`).run(
        'Release Train',
        JSON.stringify({ teams: { channels: ['release-train'] } })
      );

      // Insert message containing release-train keyword
      const result = db.prepare(
        `INSERT INTO messages (source_id, content, author, subject, source) VALUES (?, ?, ?, ?, ?)`
      ).run('msg-rt', 'The release-train is delayed this week', 'Bob', 'Delay Notice', 'teams');
      const msgId = Number(result.lastInsertRowid);

      // Mock: model calls topic_router, then ends turn after getting relevant result
      mockCreate
        .mockResolvedValueOnce(
          createMockToolUseResponse('topic_router', {
            content_snippet: 'The release-train is delayed this week',
            source: 'teams',
          })
        )
        .mockResolvedValueOnce(createMockEndTurnResponse());

      await orchestrator.handleNewMessage(msgId);

      // Verify: only 2 calls (topic_router returned relevant, model ended)
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('topic router returns irrelevant for non-matching content', async () => {
      // Insert topic with config for 'saturn'
      db.prepare(`INSERT INTO topics (name, config) VALUES (?, ?)`).run(
        'Saturn',
        JSON.stringify({ teams: { channels: ['saturn'] } })
      );

      // Insert message NOT containing saturn keyword
      const result = db.prepare(
        `INSERT INTO messages (source_id, content, author, subject, source) VALUES (?, ?, ?, ?, ?)`
      ).run('msg-other', 'The weather is nice today', 'Carol', 'General Chat', 'teams');
      const msgId = Number(result.lastInsertRowid);

      // Mock: model calls topic_router, gets irrelevant, ends turn
      mockCreate
        .mockResolvedValueOnce(
          createMockToolUseResponse('topic_router', {
            content_snippet: 'The weather is nice today',
            source: 'teams',
          })
        )
        .mockResolvedValueOnce(createMockEndTurnResponse());

      await orchestrator.handleNewMessage(msgId);

      // Verify: model called twice (topic check + end turn) — no alert_scorer
      expect(mockCreate).toHaveBeenCalledTimes(2);
      // Verify: no proactive_queue entries
      const queueRows = db.prepare(`SELECT * FROM proactive_queue`).all();
      expect(queueRows).toHaveLength(0);
    });
  });

  describe('max turns enforcement', () => {
    it('max turns enforced — loop exits after 3 iterations', async () => {
      // Insert message
      const result = db.prepare(
        `INSERT INTO messages (source_id, content, author, subject, source) VALUES (?, ?, ?, ?, ?)`
      ).run('msg-loop', 'Infinite loop test', 'Dave', 'Test', 'teams');
      const msgId = Number(result.lastInsertRowid);

      // Mock: always return topic_router tool_use (never ends)
      mockCreate.mockResolvedValue(
        createMockToolUseResponse('topic_router', {
          content_snippet: 'Infinite loop test',
          source: 'teams',
        })
      );

      await orchestrator.handleNewMessage(msgId);

      // Verify: 4 calls total (1 initial + 3 max turns)
      expect(mockCreate).toHaveBeenCalledTimes(4);
    });
  });

  describe('dedup guard', () => {
    it('dedup skips if already scored within 10 minutes', async () => {
      // Insert message
      const result = db.prepare(
        `INSERT INTO messages (source_id, content, author, subject, source) VALUES (?, ?, ?, ?, ?)`
      ).run('msg-dup', 'Duplicate test', 'Eve', 'Test', 'teams');
      const msgId = Number(result.lastInsertRowid);

      // Insert existing proactive_queue row for same source_id within 10 min
      db.prepare(
        `INSERT INTO proactive_queue (agent, source_id, type, payload, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
      ).run('orchestrator', 'msg-dup', 'alert', '{}');

      await orchestrator.handleNewMessage(msgId);

      // Verify: mockCreate never called (dedup skipped)
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('null source_id handling', () => {
    it('null source_id skips processing — no AI call made', async () => {
      // Insert message with NULL source_id
      const result = db.prepare(
        `INSERT INTO messages (source_id, content, author, subject, source) VALUES (?, ?, ?, ?, ?)`
      ).run(null, 'No source id message', 'Frank', 'Test', 'teams');
      const msgId = Number(result.lastInsertRowid);

      await orchestrator.handleNewMessage(msgId);

      // Verify: mockCreate never called
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('alert scoring', () => {
    it('alert_scorer writes to proactive_queue for medium severity', async () => {
      // Insert message
      const result = db.prepare(
        `INSERT INTO messages (source_id, content, author, subject, source) VALUES (?, ?, ?, ?, ?)`
      ).run('msg-med', 'Urgent: server down', 'Grace', 'Incident', 'teams');
      const msgId = Number(result.lastInsertRowid);

      // Mock flow: topic_router -> alert_scorer -> end_turn
      mockCreate
        .mockResolvedValueOnce(
          createMockToolUseResponse('topic_router', {
            content_snippet: 'Urgent: server down',
            source: 'teams',
          })
        )
        .mockResolvedValueOnce(
          createMockToolUseResponse('alert_scorer', {
            content: 'Urgent: server down',
            author: 'Grace',
            subject: 'Incident',
          })
        )
        .mockResolvedValueOnce(createMockEndTurnResponse());

      // Mock scoreMessageSeverity to return medium
      (scoreMessageSeverity as ReturnType<typeof vi.fn>).mockResolvedValue({
        severity: 'medium',
        summary: 'Server incident',
        reason: 'Production server down',
      });

      await orchestrator.handleNewMessage(msgId);

      // Verify: proactive_queue has entry
      const rows = db.prepare(`SELECT * FROM proactive_queue`).all() as Array<{ payload: string; agent: string; source_id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].agent).toBe('orchestrator');
      expect(rows[0].source_id).toBe('msg-med');
      const payload = JSON.parse(rows[0].payload);
      expect(payload.severity).toBe('medium');
    });

    it('alert_scorer skips proactive_queue for low severity', async () => {
      // Insert message
      const result = db.prepare(
        `INSERT INTO messages (source_id, content, author, subject, source) VALUES (?, ?, ?, ?, ?)`
      ).run('msg-low', 'FYI: minor update', 'Hank', 'Info', 'teams');
      const msgId = Number(result.lastInsertRowid);

      // Mock flow: topic_router -> alert_scorer -> end_turn
      mockCreate
        .mockResolvedValueOnce(
          createMockToolUseResponse('topic_router', {
            content_snippet: 'FYI: minor update',
            source: 'teams',
          })
        )
        .mockResolvedValueOnce(
          createMockToolUseResponse('alert_scorer', {
            content: 'FYI: minor update',
            author: 'Hank',
            subject: 'Info',
          })
        )
        .mockResolvedValueOnce(createMockEndTurnResponse());

      // Mock scoreMessageSeverity to return low
      (scoreMessageSeverity as ReturnType<typeof vi.fn>).mockResolvedValue({
        severity: 'low',
        summary: 'Minor update notification',
        reason: 'FYI message, no action needed',
      });

      await orchestrator.handleNewMessage(msgId);

      // Verify: no proactive_queue entries
      const rows = db.prepare(`SELECT * FROM proactive_queue`).all();
      expect(rows).toHaveLength(0);
    });
  });
});

/**
 * Integration tests — verifies end-to-end flow:
 * message insert -> OrchestratorAgent.handleNewMessage -> tool_use loop -> proactive_queue
 *
 * Uses real in-memory SQLite. Only Anthropic API is mocked.
 */
describe('OrchestratorAgent integration', () => {
  let db: Database.Database;
  let orchestrator: OrchestratorAgent;

  beforeEach(() => {
    vi.clearAllMocks();

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        config TEXT
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER,
        source TEXT,
        content TEXT,
        author TEXT,
        timestamp TEXT,
        metadata TEXT,
        source_id TEXT,
        subject TEXT,
        raw_data TEXT
      );

      CREATE TABLE proactive_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        source_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        read_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_proactive_queue_agent_source ON proactive_queue(agent, source_id, created_at);
    `);

    orchestrator = new OrchestratorAgent(db, 'test-api-key');
  });

  afterEach(() => {
    db.close();
  });

  it('message insert triggers proactive_queue entry via full tool_use loop', async () => {
    // Setup: topic with saturn channel config
    db.prepare(`INSERT INTO topics (name, config) VALUES (?, ?)`).run(
      'Saturn',
      JSON.stringify({ teams: { channels: ['saturn'] } })
    );

    // Setup: message matching the topic
    const result = db.prepare(
      `INSERT INTO messages (source_id, content, author, subject, source) VALUES (?, ?, ?, ?, ?)`
    ).run('int-test-1', 'saturn release train update — blocker identified', 'Alice', 'Saturn Sprint', 'teams');
    const msgId = Number(result.lastInsertRowid);

    // Mock API: 1st call -> topic_router, 2nd call -> alert_scorer, 3rd call -> end_turn
    mockCreate
      .mockResolvedValueOnce(
        createMockToolUseResponse('topic_router', {
          content_snippet: 'saturn release train update — blocker identified',
          source: 'teams',
        })
      )
      .mockResolvedValueOnce(
        createMockToolUseResponse('alert_scorer', {
          content: 'saturn release train update — blocker identified',
          author: 'Alice',
          subject: 'Saturn Sprint',
        })
      )
      .mockResolvedValueOnce(createMockEndTurnResponse());

    // Mock scoreMessageSeverity -> high severity
    (scoreMessageSeverity as ReturnType<typeof vi.fn>).mockResolvedValue({
      severity: 'high',
      summary: 'Release blocker',
      reason: 'Urgent release mention',
    });

    // Execute: full end-to-end flow
    await orchestrator.handleNewMessage(msgId);

    // Assert: proactive_queue has exactly 1 row
    const rows = db.prepare(`SELECT * FROM proactive_queue`).all() as Array<{
      agent: string; source_id: string; type: string; payload: string;
    }>;
    expect(rows).toHaveLength(1);

    // Assert: row has agent = 'orchestrator'
    expect(rows[0].agent).toBe('orchestrator');

    // Assert: row has source_id = 'int-test-1'
    expect(rows[0].source_id).toBe('int-test-1');

    // Assert: row has type = 'alert'
    expect(rows[0].type).toBe('alert');

    // Assert: payload contains severity and summary
    const payload = JSON.parse(rows[0].payload);
    expect(payload.severity).toBe('high');
    expect(payload.body).toContain('Release blocker');
    expect(payload.body).toContain('Urgent release mention');
  });

  it('irrelevant message produces no proactive_queue entry', async () => {
    // Setup: topic with saturn channel config
    db.prepare(`INSERT INTO topics (name, config) VALUES (?, ?)`).run(
      'Saturn',
      JSON.stringify({ teams: { channels: ['saturn'] } })
    );

    // Setup: message that does NOT match any topic keyword
    const result = db.prepare(
      `INSERT INTO messages (source_id, content, author, subject, source) VALUES (?, ?, ?, ?, ?)`
    ).run('int-test-2', 'random unrelated stuff about the weekend', 'Bob', 'Weekend Plans', 'teams');
    const msgId = Number(result.lastInsertRowid);

    // Mock API: 1st call -> topic_router (model calls it), 2nd call -> end_turn (irrelevant)
    mockCreate
      .mockResolvedValueOnce(
        createMockToolUseResponse('topic_router', {
          content_snippet: 'random unrelated stuff about the weekend',
          source: 'teams',
        })
      )
      .mockResolvedValueOnce(createMockEndTurnResponse());

    // Execute
    await orchestrator.handleNewMessage(msgId);

    // Assert: proactive_queue has 0 rows — no alert_scorer was called
    const rows = db.prepare(`SELECT * FROM proactive_queue`).all();
    expect(rows).toHaveLength(0);

    // Assert: scoreMessageSeverity was never called (no alert scoring for irrelevant messages)
    expect(scoreMessageSeverity).not.toHaveBeenCalled();
  });
});
