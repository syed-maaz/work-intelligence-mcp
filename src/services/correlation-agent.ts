/**
 * CorrelationAgent — Phase 65 Plan 01
 *
 * Traverses the MemPalace knowledge graph to find cross-topic signal convergence
 * (shared KG entities between topic pairs) and generates AI-summarized digests.
 *
 * Four-Stage Pipeline: Analyze stage — works only on data already in SQLite + KG.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { PromptCachingBetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/prompt-caching/messages.js';
import type Database from 'better-sqlite3';
import type { PalaceClient } from '../intelligence/palace-client.js';
import { bucketCallParams } from './model-config.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CorrelationPair {
  topic_a: string;
  topic_b: string;
  shared_entities: string[];
  summary: string;
}

export interface CorrelationDigest {
  pairs: CorrelationPair[];
  generated_at: string;
}

interface TopicRow {
  id: number;
  name: string;
  config: string | null;
}

interface KgTriple {
  subject: string;
  predicate: string;
  object: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

// Pairwise comparison cap (T-65-02). Per-call model + effort + thinking comes
// from the `agents` bucket in the model_config registry (ADR-031).
const MAX_TOPICS = 20;

const SYSTEM_PROMPT: PromptCachingBetaTextBlockParam[] = [
  {
    type: 'text',
    text: 'You summarize why two work topics are converging based on shared knowledge graph entities. One sentence, actionable.',
    cache_control: { type: 'ephemeral' },
  },
];

const SUMMARIZE_TOOL = {
  name: 'summarize_convergence',
  description: 'Provide a one-sentence summary of why two topics are converging.',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: { type: 'string', description: 'One-sentence actionable summary of convergence.' },
    },
    required: ['summary'],
  },
};

// ── CorrelationAgent Class ───────────────────────────────────────────────────

export class CorrelationAgent {
  private client: Anthropic;

  constructor(
    private readonly db: Database.Database,
    private readonly palace: PalaceClient,
    apiKey: string,
  ) {
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
   * Find cross-topic correlations by shared KG entities.
   * Returns top N pairs sorted by co-mention density (descending).
   */
  async findCorrelations(topN?: number): Promise<CorrelationPair[]> {
    const limit = topN ?? parseInt(process.env.CORRELATION_TOP_N || '3', 10);

    // Gate: palace must be connected
    if (!this.palace.isConnected) return [];

    // Load all topics
    const topics: TopicRow[] = this.db.prepare('SELECT id, name, config FROM topics').all() as TopicRow[];
    if (topics.length < 2) return [];

    // T-65-02: cap at MAX_TOPICS to prevent combinatorial explosion
    const topicSlice = topics.slice(0, MAX_TOPICS);

    // For each topic, gather subject entities from KG triples
    const entityMap = new Map<string, Set<string>>();

    for (const topic of topicSlice) {
      const subjects = await this.getTopicEntities(topic.name);
      entityMap.set(topic.name, subjects);
    }

    // Compute pairwise shared entities
    const pairs: CorrelationPair[] = [];
    const topicNames = Array.from(entityMap.keys());

    for (let i = 0; i < topicNames.length; i++) {
      for (let j = i + 1; j < topicNames.length; j++) {
        const a = topicNames[i];
        const b = topicNames[j];
        const entitiesA = entityMap.get(a)!;
        const entitiesB = entityMap.get(b)!;

        // Intersection
        const shared: string[] = [];
        for (const entity of entitiesA) {
          if (entitiesB.has(entity)) shared.push(entity);
        }

        if (shared.length > 0) {
          pairs.push({
            topic_a: a,
            topic_b: b,
            shared_entities: shared,
            summary: '', // filled by generateDigest
          });
        }
      }
    }

    // Sort descending by shared entity count
    pairs.sort((a, b) => b.shared_entities.length - a.shared_entities.length);

    return pairs.slice(0, limit);
  }

  /**
   * Generate a full digest with AI summaries for each converging pair.
   * Returns null if no correlations found (skip silently).
   */
  async generateDigest(): Promise<CorrelationDigest | null> {
    const pairs = await this.findCorrelations();
    if (pairs.length === 0) return null;

    // Summarize each pair with Haiku
    for (const pair of pairs) {
      pair.summary = await this.summarizePair(pair);
    }

    return {
      pairs,
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Check if a CorrelationAgent digest was already written within 24 hours.
   */
  isDuplicateWithin24h(): boolean {
    const row = this.db.prepare(
      `SELECT id FROM proactive_queue WHERE agent = ? AND created_at >= datetime('now', '-24 hours') LIMIT 1`
    ).get('CorrelationAgent');
    return !!row;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Extract subject entities from KG triples for a topic.
   * T-65-01: wraps kgQuery in try/catch — unparseable responses return empty set.
   * Falls back to FTS noun-phrase extraction when KG yields fewer than 3 entities,
   * so CorrelationAgent fires even when MemPalace KG is stale (Phase 88 Loop A fix).
   */
  private async getTopicEntities(topicName: string): Promise<Set<string>> {
    const subjects = new Set<string>();
    try {
      const raw = await this.palace.kgQuery(topicName);
      if (!raw) return subjects;

      const parsed = JSON.parse(raw);
      const triples: KgTriple[] = parsed.triples ?? parsed.results ?? [];
      for (const triple of triples) {
        if (triple.subject) subjects.add(triple.subject);
      }
    } catch {
      // T-65-01: treat unparseable as empty
    }

    // FTS fallback: when KG is sparse, extract capitalized noun phrases from
    // recent messages matching the topic name via full-text search.
    if (subjects.size < 3) {
      try {
        const rows = this.db.prepare(
          `SELECT content FROM messages_fts WHERE messages_fts MATCH ? LIMIT 50`,
        ).all(topicName) as { content: string }[];
        for (const row of rows) {
          const matches = row.content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) ?? [];
          for (const m of matches) subjects.add(m);
        }
      } catch {
        // FTS unavailable or topic name not a valid FTS query — leave subjects as-is
      }
    }

    return subjects;
  }

  /**
   * Call Haiku to generate a one-sentence convergence summary for a pair.
   */
  private async summarizePair(pair: CorrelationPair): Promise<string> {
    try {
      const params = bucketCallParams(this.db, 'agents', 256);
      const response = await this.client.beta.promptCaching.messages.create({
        ...params,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Topic A: ${pair.topic_a}, Topic B: ${pair.topic_b}, Shared entities: ${pair.shared_entities.join(', ')}`,
          },
        ],
        tool_choice: { type: 'tool', name: 'summarize_convergence' },
        tools: [SUMMARIZE_TOOL],
      });

      const toolBlock = response.content.find((b: { type: string }) => b.type === 'tool_use');
      if (toolBlock && 'input' in toolBlock) {
        return (toolBlock.input as { summary: string }).summary ?? '';
      }
      return '';
    } catch {
      return '';
    }
  }
}
