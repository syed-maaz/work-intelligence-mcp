import { createHash } from 'crypto';
import type { PalaceClient } from './palace-client.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { PromptCachingBetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/prompt-caching/messages.js';
import type Database from 'better-sqlite3';
import { bucketCallParams } from '../services/model-config.js';

// ---------------------------------------------------------------------------
// MemoryEnricher — Phase 58 Wave 2
//
// Transforms sync data (topics, Jira transitions, conversations, meetings,
// messages) into palace drawers and KG triples. Haiku NER extracts entities
// at sync time. All palace writes are fire-and-forget — errors never propagate.
// ---------------------------------------------------------------------------

export interface EnrichmentInput {
  topicNotebooks: Array<{ name: string; content: string }>;
  jiraTransitions: Array<{
    issue_key: string;
    from_status: string;
    to_status: string;
    transitioned_at: string;
    assignee: string | null;
    component: string | null;
  }>;
  conversations: Array<{
    chatSlug: string;
    summary: string;
    participants: string[];
    topicName: string | null;
  }>;
  meetings: Array<{
    meetingSlug: string;
    title: string;
    transcript: string;
    decisions: string[];
    date: string;
  }>;
  messages: Array<{
    content: string;
    author: string;
    subject: string;
    source: string;
  }>;
}

export interface EnrichmentResult {
  drawersWritten: number;
  triplesWritten: number;
  entitiesExtracted: number;
  relationshipTriplesWritten: number;
  skippedDeduplicated: number;
  errors: string[];
}

export class MemoryEnricher {
  // key -> SHA-256 hash for content deduplication
  private contentHashes = new Map<string, string>();

  constructor(
    private readonly palace: PalaceClient,
    private readonly anthropicClient?: Anthropic,
    private readonly db?: Database.Database, // optional — enables ADR-031 bucket-aware model routing
  ) {}

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  /**
   * Enrich palace memory from a sync batch. All sections are individually
   * guarded — a single failure never aborts the entire enrichment run.
   */
  async enrichFromSync(input: EnrichmentInput): Promise<EnrichmentResult> {
    const result: EnrichmentResult = {
      drawersWritten: 0,
      triplesWritten: 0,
      entitiesExtracted: 0,
      relationshipTriplesWritten: 0,
      skippedDeduplicated: 0,
      errors: [],
    };

    // All sections wrapped in individual try/catch — errors collected, never thrown
    await this.enrichTopics(input.topicNotebooks, result);
    await this.enrichJiraTransitions(input.jiraTransitions, result);
    await this.enrichConversations(input.conversations, result);
    await this.enrichMeetings(input.meetings, result);

    // Entity extraction (Haiku NER) — runs last, fire-and-forget
    if (this.anthropicClient && input.messages.length > 0) {
      await this.extractAndWriteEntities(input.messages, result);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Topic notebooks → topics wing
  // ---------------------------------------------------------------------------

  private async enrichTopics(
    notebooks: EnrichmentInput['topicNotebooks'],
    result: EnrichmentResult
  ): Promise<void> {
    for (const notebook of notebooks) {
      try {
        const hash = this.sha256(notebook.content);
        const cacheKey = 'topic:' + notebook.name;

        if (this.contentHashes.get(cacheKey) === hash) {
          result.skippedDeduplicated++;
          continue;
        }

        // fire-and-forget palace write
        await this.palace.addDrawer('topics', notebook.name, notebook.content);
        this.contentHashes.set(cacheKey, hash);
        result.drawersWritten++;
      } catch (err) {
        result.errors.push(
          `enrichTopics[${notebook.name}]: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Jira transitions → KG triples (60-C1: kgInvalidate old status)
  // ---------------------------------------------------------------------------

  private async enrichJiraTransitions(
    transitions: EnrichmentInput['jiraTransitions'],
    result: EnrichmentResult
  ): Promise<void> {
    for (const transition of transitions) {
      try {
        // End-date old status (60-C1: kgInvalidate for stale triples)
        await this.palace.kgInvalidate(
          transition.issue_key,
          'has-status',
          transition.from_status,
          transition.transitioned_at
        );
        // Note: invalidation is not counted as triplesWritten (it removes, not adds)

        // Add new status
        await this.palace.kgAdd(
          transition.issue_key,
          'has-status',
          transition.to_status,
          transition.transitioned_at
        );
        result.triplesWritten++;

        if (transition.assignee) {
          await this.palace.kgAdd(transition.issue_key, 'assigned-to', transition.assignee);
          result.triplesWritten++;
        }

        if (transition.component) {
          await this.palace.kgAdd(transition.issue_key, 'component', transition.component);
          result.triplesWritten++;
        }
      } catch (err) {
        result.errors.push(
          `enrichJiraTransitions[${transition.issue_key}]: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Conversation summaries → conversations wing
  // ---------------------------------------------------------------------------

  private async enrichConversations(
    conversations: EnrichmentInput['conversations'],
    result: EnrichmentResult
  ): Promise<void> {
    for (const conv of conversations) {
      try {
        const hash = this.sha256(conv.summary);
        const cacheKey = 'conv:' + conv.chatSlug;

        if (this.contentHashes.get(cacheKey) === hash) {
          result.skippedDeduplicated++;
          continue;
        }

        await this.palace.addDrawer('conversations', conv.chatSlug, conv.summary);
        this.contentHashes.set(cacheKey, hash);
        result.drawersWritten++;

        const today = new Date().toISOString().slice(0, 10);
        const topic = conv.topicName ?? conv.chatSlug;
        for (const participant of conv.participants) {
          try {
            await this.palace.kgAdd(participant, 'discussed', topic, today);
            result.triplesWritten++;
          } catch (kgErr) {
            result.errors.push(
              `enrichConversations KG[${conv.chatSlug}][${participant}]: ${kgErr instanceof Error ? kgErr.message : String(kgErr)}`
            );
          }
        }
      } catch (err) {
        result.errors.push(
          `enrichConversations[${conv.chatSlug}]: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Meeting transcripts → meetings wing
  // ---------------------------------------------------------------------------

  private async enrichMeetings(
    meetings: EnrichmentInput['meetings'],
    result: EnrichmentResult
  ): Promise<void> {
    for (const meeting of meetings) {
      try {
        const hash = this.sha256(meeting.transcript);
        const cacheKey = 'meeting:' + meeting.meetingSlug;

        if (this.contentHashes.get(cacheKey) === hash) {
          result.skippedDeduplicated++;
          continue;
        }

        await this.palace.addDrawer('meetings', meeting.meetingSlug, meeting.transcript);
        this.contentHashes.set(cacheKey, hash);
        result.drawersWritten++;

        for (const decision of meeting.decisions) {
          try {
            await this.palace.kgAdd(meeting.title, 'decided', decision, meeting.date);
            result.triplesWritten++;
          } catch (kgErr) {
            result.errors.push(
              `enrichMeetings KG[${meeting.meetingSlug}]: ${kgErr instanceof Error ? kgErr.message : String(kgErr)}`
            );
          }
        }
      } catch (err) {
        result.errors.push(
          `enrichMeetings[${meeting.meetingSlug}]: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Entity extraction via Haiku NER — produces KG triples from raw messages
  // ---------------------------------------------------------------------------

  private async extractAndWriteEntities(
    messages: EnrichmentInput['messages'],
    result: EnrichmentResult
  ): Promise<void> {
    // Batch messages into chunks of 50 (match AIAnalyzer pattern)
    const CHUNK_SIZE = 50;
    const chunks: Array<EnrichmentInput['messages']> = [];
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      chunks.push(messages.slice(i, i + CHUNK_SIZE));
    }

    for (const chunk of chunks) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const messagesText = chunk
          .map(
            (m, idx) =>
              `[${idx + 1}] source=${m.source} author=${m.author} subject=${m.subject}\n${m.content}`
          )
          .join('\n---\n');

        const bucketParams = this.db ? bucketCallParams(this.db, 'fetch', 1024) : {
          model: 'claude-haiku-4-5-20251001' as const,
          max_tokens: 1024,
        };
        const cachedSystem: PromptCachingBetaTextBlockParam[] = [
          { type: 'text', text: 'Extract named entities from the following messages. Return structured data.', cache_control: { type: 'ephemeral' } },
        ];

        const response = await this.anthropicClient!.beta.promptCaching.messages.create({
          ...bucketParams,
          system: cachedSystem,
          messages: [{ role: 'user', content: messagesText }],
          tools: [
            {
              name: 'extract_entities',
              description: 'Extract named entities from messages',
              input_schema: {
                type: 'object',
                properties: {
                  jiraKeys: {
                    type: 'array',
                    items: { type: 'string' },
                     description: 'Jira issue keys like JIRA-12345',
                  },
                  people: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Person names mentioned',
                  },
                  flags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Feature flags like FF_RM_XXXXX',
                  },
                  files: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'File paths mentioned',
                  },
                },
                required: ['jiraKeys', 'people', 'flags', 'files'],
              },
            },
          ],
          tool_choice: { type: 'tool', name: 'extract_entities' },
        });

        const toolUse = response.content.find((b) => b.type === 'tool_use');
        if (!toolUse || toolUse.type !== 'tool_use') continue;

        const entities = toolUse.input as {
          jiraKeys: string[];
          people: string[];
          flags: string[];
          files: string[];
        };

        // Write KG triples for each discovered entity
        const allEntities = [
          ...entities.jiraKeys.map((e) => ({ entity: e, type: 'jira-key' })),
          ...entities.people.map((e) => ({ entity: e, type: 'person' })),
          ...entities.flags.map((e) => ({ entity: e, type: 'feature-flag' })),
          ...entities.files.map((e) => ({ entity: e, type: 'file-path' })),
        ];

        for (const { entity, type } of allEntities) {
          try {
            await this.palace.kgAdd(entity, 'mentioned-in', type, today);
            result.entitiesExtracted++;
          } catch (kgErr) {
            result.errors.push(
              `extractEntities KG[${entity}]: ${kgErr instanceof Error ? kgErr.message : String(kgErr)}`
            );
          }
        }

        // Relationship-aware KG triples (59-C2: richer sync-time NER)
        // Person + Jira key pairs → "discussed"
        for (const person of entities.people) {
          for (const jiraKey of entities.jiraKeys) {
            try {
              await this.palace.kgAdd(person, 'discussed', jiraKey, today);
              result.relationshipTriplesWritten++;
            } catch (kgErr) {
              result.errors.push(
                `extractEntities relationship KG[${person} discussed ${jiraKey}]: ${kgErr instanceof Error ? kgErr.message : String(kgErr)}`
              );
            }
          }
        }

        // Flag + Jira key pairs → "related-to"
        for (const flag of entities.flags) {
          for (const jiraKey of entities.jiraKeys) {
            try {
              await this.palace.kgAdd(flag, 'related-to', jiraKey, today);
              result.relationshipTriplesWritten++;
            } catch (kgErr) {
              result.errors.push(
                `extractEntities relationship KG[${flag} related-to ${jiraKey}]: ${kgErr instanceof Error ? kgErr.message : String(kgErr)}`
              );
            }
          }
        }

        // Person + topic (from message subject as proxy) → "active-in"
        const topicNames = [...new Set(chunk.map((m) => m.subject).filter(Boolean))];
        for (const person of entities.people) {
          for (const topicName of topicNames) {
            try {
              await this.palace.kgAdd(person, 'active-in', topicName, today);
              result.relationshipTriplesWritten++;
            } catch (kgErr) {
              result.errors.push(
                `extractEntities relationship KG[${person} active-in ${topicName}]: ${kgErr instanceof Error ? kgErr.message : String(kgErr)}`
              );
            }
          }
        }
      } catch (err) {
        // Entire extraction is try/catch — failure means 0 entities, not a crash
        result.errors.push(
          `extractAndWriteEntities chunk: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Decisions wing (Phase 71-01) — closes the learning loop for /api/brain/learn
  //
  // Each call writes a single drawer to the 'decisions' wing keyed by
  // decision_id. Re-calling with the same decision_id overwrites the existing
  // drawer (idempotent palace replace), keeping the palace in sync with the
  // latest outcome. The body carries the human-readable decision plus a
  // metadata header so palace recall surfaces the outcome alongside the text.
  // ---------------------------------------------------------------------------

  /**
   * Write a brain_decisions row into the palace 'decisions' wing.
   *
   * Palace addDrawer is idempotent on (wing, room) — calling enrichDecision
   * twice for the same decision_id replaces the existing drawer rather than
   * duplicating it. Errors are caught so a palace outage never breaks the
   * learn endpoint (mirrors the fire-and-forget contract used by all other
   * enrichment paths).
   */
  async enrichDecision(row: BrainDecisionRow): Promise<void> {
    try {
      // Single source of truth for evidence_signatures — accept either an
      // array or a JSON-encoded string from SQLite (evidence_json column).
      let evidenceSignatures: unknown[] = [];
      if (Array.isArray(row.evidence_signatures)) {
        evidenceSignatures = row.evidence_signatures;
      } else if (typeof row.evidence_json === 'string' && row.evidence_json.length > 0) {
        try {
          const parsed = JSON.parse(row.evidence_json);
          evidenceSignatures = Array.isArray(parsed) ? parsed : [];
        } catch {
          evidenceSignatures = [];
        }
      }

      const metadata = {
        decision_id: row.id,
        outcome: row.outcome ?? null,
        confidence: row.confidence ?? null,
        evidence_signatures: evidenceSignatures,
        outcome_recorded_at: row.outcome_recorded_at ?? null,
        question: row.question ?? null,
      };

      const body =
        '---\n' +
        JSON.stringify(metadata) +
        '\n---\n' +
        (row.decision ?? '');

      await this.palace.addDrawer('decisions', row.id, body, row.id);
    } catch (err) {
      // Fire-and-forget: palace failures never bubble up to the caller.
      // eslint-disable-next-line no-console
      console.warn(
        `[MemoryEnricher.enrichDecision] palace write failed for ${row.id}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}

// ---------------------------------------------------------------------------
// Public types — imported by /api/brain/learn handler (Phase 71-01)
// ---------------------------------------------------------------------------

/** Shape of a `brain_decisions` row passed to enrichDecision. */
export interface BrainDecisionRow {
  id: string;
  question?: string | null;
  decision: string;
  confidence?: number | null;
  outcome?: string | null;
  outcome_recorded_at?: number | string | null;
  /** Either a parsed array or the raw JSON column from SQLite. */
  evidence_signatures?: unknown[] | null;
  evidence_json?: string | null;
}
