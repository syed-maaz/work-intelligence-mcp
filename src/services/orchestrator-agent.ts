/**
 * OrchestratorAgent — Phase 64 Managed Agent Sessions
 *
 * Implements a tool_use agentic loop using Claude Haiku to route CDC events
 * to sub-agent tools: topic_router (relevance check) and alert_scorer (severity).
 *
 * Four-Stage Pipeline: Analyze stage — works only on data already in SQLite.
 * No external API calls (Fetch). No direct DB schema changes (Process).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { PromptCachingBetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/prompt-caching/messages.js';
import type Database from 'better-sqlite3';
import { scoreMessageSeverity } from './analyzer.js';
import { bucketCallParams } from './model-config.js';
import { maybeNotifyInvestigationPattern } from '../intelligence/investigation-pattern-notify.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface MessageRow {
  id: number;
  source_id: string | null;
  content: string;
  author: string;
  subject: string;
  source: string;
}

interface TopicRow {
  id: number;
  name: string;
  config: string | null;
}

interface TopicConfig {
  teams?: { channels?: string[] };
  email?: { channels?: string[] };
  jira?: { projects?: string[] };
  [key: string]: { channels?: string[]; projects?: string[] } | undefined;
}

interface TopicRouterInput {
  content_snippet: string;
  source: string;
  author: string;
  subject: string;
}

interface AlertScorerInput {
  content: string;
  author: string;
  subject: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_TURNS = 3;
// Per-call model + effort + thinking comes from the `agents` bucket in the
// model_config registry (ADR-031). Don't re-introduce a hard-coded MODEL
// constant here — every Anthropic call below spreads bucketCallParams().
const DEDUP_WINDOW_MINUTES = 10;

// ── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'topic_router',
    description: 'Check if a message is relevant to any configured topic. Returns topic name or irrelevant.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content_snippet: { type: 'string', description: 'First 200 chars of message content' },
        source: { type: 'string', enum: ['teams', 'email', 'jira'], description: 'Message source type' },
        author: { type: 'string', description: 'Message author or sender name' },
        subject: { type: 'string', description: 'Message subject or chat name' },
      },
      required: ['content_snippet', 'source', 'author', 'subject'],
    },
  },
  {
    name: 'alert_scorer',
    description: 'Score a message for urgency. Only call for topic-relevant messages.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'Full message content (truncated to 500 chars)' },
        author: { type: 'string', description: 'Message author name' },
        subject: { type: 'string', description: 'Message subject line' },
      },
      required: ['content', 'author', 'subject'],
    },
  },
];

// ── System Prompt (cached) ───────────────────────────────────────────────────

const SYSTEM_PROMPT: PromptCachingBetaTextBlockParam[] = [
  {
    type: 'text',
    text: `You are an event routing orchestrator for a work intelligence system.
When a new work message arrives, decide what to do:
1. First call topic_router to check relevance.
2. If relevant, call alert_scorer to score severity.
3. If irrelevant, stop (end_turn) — no further action needed.
Never call alert_scorer without first checking topic relevance.`,
    cache_control: { type: 'ephemeral' },
  },
];

// ── OrchestratorAgent Class ──────────────────────────────────────────────────

export class OrchestratorAgent {
  private client: Anthropic;
  private readonly apiKey: string;

  constructor(
    private readonly db: Database.Database,
    apiKey: string,
  ) {
    this.apiKey = apiKey;
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    this.client = new Anthropic({
      apiKey: baseURL ? 'x-proxy' : apiKey,
      ...(baseURL ? {
        baseURL,
        defaultHeaders: { Authorization: `Bearer ${apiKey}` },
      } : {}),
    });
  }

  /**
   * Main entry point — called for each new-message CDC event.
   * Hydrates message from DB, checks dedup, runs tool_use dispatch loop.
   */
  async handleNewMessage(rowId: number): Promise<void> {
    // 1. Hydrate message from DB
    const msg = this.db.prepare(
      `SELECT id, source_id, content, author, subject, source FROM messages WHERE id = ?`
    ).get(rowId) as MessageRow | undefined;

    if (!msg) {
      process.stderr.write(`[Orchestrator] Message not found: rowId=${rowId}\n`);
      return;
    }

    // 2. Early return for null source_id (T-64-04 / Pitfall 4)
    if (!msg.source_id) {
      process.stderr.write(`[Orchestrator] Skipping null source_id: rowId=${rowId}\n`);
      return;
    }

    // 3. Dedup guard — skip if already scored within DEDUP_WINDOW_MINUTES
    const dedup = this.db.prepare(
      `SELECT id FROM proactive_queue WHERE agent = 'orchestrator' AND source_id = ? AND created_at >= datetime('now', '-${DEDUP_WINDOW_MINUTES} minutes')`
    ).get(msg.source_id) as { id: number } | undefined;

    if (dedup) {
      process.stderr.write(`[Orchestrator] Dedup skip: source_id=${msg.source_id}\n`);
      return;
    }

    // 4. Build event context (truncate content to 500 chars — T-64-01 mitigation)
    const eventContext = `From: ${msg.author}\nSubject: ${msg.subject}\nSource: ${msg.source}\n\n${(msg.content || '').slice(0, 500)}`;

    // 5. Run dispatch loop
    await this.dispatch(eventContext, msg);
  }

  async handleJiraUpdate(rowId: number, operation: 'INSERT' | 'UPDATE' = 'UPDATE'): Promise<void> {
    const issue = this.db.prepare(
      `SELECT id, key, title, status, assignee, priority FROM jira_issues WHERE id = ?`
    ).get(rowId) as { id: number; key: string; title: string; status: string; assignee: string | null; priority: string | null } | undefined;

    if (!issue) {
      process.stderr.write(`[Orchestrator] Jira issue not found: rowId=${rowId}\n`);
      return;
    }

    // GAP-003: proactive pattern match on newly synced issues (INSERT only)
    if (operation === 'INSERT') {
      try {
        maybeNotifyInvestigationPattern(this.db, { key: issue.key, title: issue.title });
      } catch (err) {
        process.stderr.write(
          `[Orchestrator] investigation-pattern notify failed for ${issue.key}: ${(err as Error).message}\n`,
        );
      }
    }

    const dedup = this.db.prepare(
      `SELECT id FROM proactive_queue WHERE agent = 'orchestrator' AND source_id = ? AND created_at >= datetime('now', '-${DEDUP_WINDOW_MINUTES} minutes')`
    ).get(issue.key) as { id: number } | undefined;
    if (dedup) return;

    const syntheticMsg: MessageRow = {
      id: issue.id,
      source_id: issue.key,
      content: `Jira issue updated: ${issue.key} — ${issue.title}\nStatus: ${issue.status}\nAssignee: ${issue.assignee ?? 'Unassigned'}\nPriority: ${issue.priority ?? 'None'}`,
      author: issue.assignee ?? 'Jira',
      subject: `${issue.key}: ${issue.title}`,
      source: 'jira',
    };
    const eventContext = `Source: jira\nIssue: ${issue.key}\nTitle: ${issue.title}\nStatus: ${issue.status}\nAssignee: ${issue.assignee ?? 'Unassigned'}\nPriority: ${issue.priority ?? 'None'}`;
    await this.dispatch(eventContext, syntheticMsg);
  }

  async handleCalendarChange(rowId: number): Promise<void> {
    const event = this.db.prepare(
      `SELECT id, source_id, title, start_time, organizer FROM calendar_events WHERE id = ?`
    ).get(rowId) as { id: number; source_id: string; title: string; start_time: string; organizer: string | null } | undefined;

    if (!event) {
      process.stderr.write(`[Orchestrator] Calendar event not found: rowId=${rowId}\n`);
      return;
    }

    if (!event.source_id) {
      process.stderr.write(`[Orchestrator] Skipping calendar event id=${event.id} — null source_id\n`);
      return;
    }

    const dedup = this.db.prepare(
      `SELECT id FROM proactive_queue WHERE agent = 'orchestrator' AND source_id = ? AND created_at >= datetime('now', '-${DEDUP_WINDOW_MINUTES} minutes')`
    ).get(event.source_id) as { id: number } | undefined;
    if (dedup) return;

    const syntheticMsg: MessageRow = {
      id: event.id,
      source_id: event.source_id,
      content: `Calendar event: ${event.title} at ${event.start_time}${event.organizer ? ` (organizer: ${event.organizer})` : ''}`,
      author: event.organizer ?? 'Calendar',
      subject: event.title,
      source: 'calendar',
    };
    const eventContext = `Source: calendar\nEvent: ${event.title}\nStart: ${event.start_time}\nOrganizer: ${event.organizer ?? 'Unknown'}`;
    await this.dispatch(eventContext, syntheticMsg);
  }

  /**
   * Agentic tool_use loop — sends event context to Claude Haiku,
   * executes requested tools locally, repeats until end_turn or MAX_TURNS.
   */
  private async dispatch(eventContext: string, msg: MessageRow): Promise<void> {
    const messages: Array<{ role: 'user' | 'assistant'; content: any }> = [
      { role: 'user', content: eventContext },
    ];

    const params = bucketCallParams(this.db, 'agents', 512);
    let response = await this.client.beta.promptCaching.messages.create({
      ...params,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages,
    });

    let turns = 0;
    while (response.stop_reason === 'tool_use' && turns < MAX_TURNS) {
      turns++;

      const toolUseBlock = response.content.find((b: any) => b.type === 'tool_use') as
        | { type: 'tool_use'; id: string; name: string; input: unknown }
        | undefined;

      if (!toolUseBlock) break;

      // Execute tool locally
      const result = await this.executeTool(toolUseBlock.name, toolUseBlock.input, msg);

      // Build conversation continuation
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseBlock.id,
            content: JSON.stringify(result),
          },
        ],
      });

      // Next turn — re-fetch params so a model_config write between turns
      // takes effect on the very next dispatch turn (cache TTL is 60s; this
      // call still hits the cached value most of the time).
      const turnParams = bucketCallParams(this.db, 'agents', 512);
      response = await this.client.beta.promptCaching.messages.create({
        ...turnParams,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages,
      });
    }
  }

  /**
   * Tool router — dispatches tool execution to the appropriate handler.
   */
  private async executeTool(
    name: string,
    input: unknown,
    msg: MessageRow,
  ): Promise<unknown> {
    switch (name) {
      case 'topic_router':
        return this.routeTopic(input as TopicRouterInput);
      case 'alert_scorer':
        return this.scoreAlert(input as AlertScorerInput, msg);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  /**
   * TopicRouter — SQL-based topic relevance check.
   * Checks if message content, author, or subject matches any configured topic's keywords.
   */
  private routeTopic(input: TopicRouterInput): { relevant: boolean; topic?: string } {
    const { content_snippet, source, author, subject } = input;

    // Get all configured topics
    const topics = this.db.prepare(
      `SELECT id, name, config FROM topics`
    ).all() as TopicRow[];

    for (const topic of topics) {
      if (!topic.config) continue;

      let config: TopicConfig;
      try {
        config = JSON.parse(topic.config);
      } catch {
        continue;
      }

      // Check if source config exists for this topic
      const sourceConfig = config[source];
      if (!sourceConfig) continue;

      // Match keywords against content, author, and subject — channel/project names
      // typically appear in author or subject fields, not in the message body itself.
      const searchText = [content_snippet, author, subject].join(' ').toLowerCase();
      const keywords = sourceConfig.channels || sourceConfig.projects || [];
      const match = keywords.some((kw: string) =>
        searchText.includes(kw.toLowerCase())
      );

      if (match) {
        return { relevant: true, topic: topic.name };
      }
    }

    // No topic config match found
    return { relevant: false };
  }

  /**
   * AlertScorer — delegates to existing scoreMessageSeverity.
   * Writes to proactive_queue for medium/high severity; skips for low.
   *
   * FEATURE-001 (dedup): suppresses inserts when a notification with the same
   * (severity, subject) signature was queued within ALERT_COOLDOWN_MS (default
   * 4h). Prevents alert fatigue from recurring CI failures, retry loops, etc.
   * Uses `json_extract` on `payload._dedup_signature` — no schema change.
   */
  private async scoreAlert(
    input: AlertScorerInput,
    msg: MessageRow,
  ): Promise<{ severity: string; summary: string; reason: string; action: string }> {
    const { content, author, subject } = input;

    const result = await scoreMessageSeverity(
      content,
      author,
      subject,
      this.apiKey,
      undefined,    // legacy `model` arg — superseded by db+bucket below
      this.db,      // ADR-031: registry drives model/effort via 'fetch' bucket
    );

    if (result.severity === 'low') {
      return { ...result, action: 'skipped' };
    }

    // FEATURE-001: dedup signature = (severity, normalized subject).
    // Normalization strips trailing IDs / numbers so "Checkmarx 401 #12345"
    // and "Checkmarx 401 #12346" hash to the same key.
    const normalizedSubject = (msg.subject || msg.author || '')
      .toLowerCase()
      .replace(/[#:]\s*\d+/g, '')         // strip ticket-like numbers
      .replace(/\b[0-9a-f]{8,}\b/g, '')   // strip hashes / ids
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    const signature = `${result.severity}|${normalizedSubject}`;

    const cooldownMs = Math.max(0, parseInt(process.env.ALERT_COOLDOWN_MS || '14400000', 10)); // 4h default
    const cooldownSec = Math.floor(cooldownMs / 1000);

    if (cooldownSec > 0) {
      const recent = this.db
        .prepare(
          `SELECT id FROM proactive_queue
           WHERE agent = 'orchestrator'
             AND type = 'alert'
             AND json_extract(payload, '$._dedup_signature') = ?
             AND created_at >= datetime('now', '-' || ? || ' seconds')
           LIMIT 1`,
        )
        .get(signature, cooldownSec) as { id: number } | undefined;
      if (recent) {
        process.stderr.write(
          `[Orchestrator] Suppressed duplicate alert (signature="${signature}" matches queue row ${recent.id})\n`,
        );
        return { ...result, action: 'suppressed_cooldown' };
      }
    }

    // Write to proactive_queue for medium/high (with dedup signature embedded)
    this.db.prepare(
      `INSERT INTO proactive_queue (agent, source_id, type, payload) VALUES (?, ?, ?, ?)`
    ).run(
      'orchestrator',
      msg.source_id,
      'alert',
      JSON.stringify({
        title: `[${result.severity.toUpperCase()}] ${msg.subject || msg.author}`,
        body: `${result.summary}\n\n_Reason: ${result.reason}_`,
        severity: result.severity,
        messageId: msg.id,
        author: msg.author,
        subject: msg.subject,
        _dedup_signature: signature, // FEATURE-001
      }),
    );

    return { ...result, action: 'queued' };
  }
}
