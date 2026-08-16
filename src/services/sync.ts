/**
 * Sync Service
 *
 * Background polling service for syncing data from Teams, Email, and Jira
 */

import type Database from 'better-sqlite3';
import type { UnifiedMessage } from '../fetcher/sources/types.js';
import { listTopics } from '../db/queries.js';
import { upsertMessage, insertActionItem, getSyncState, updateSyncState } from '../db/queries.js';
import type { Topic as DbTopic } from '../db/schema.js';
import { AIAnalyzer } from './analyzer.js';
import type { Message as AnalyzerMessage } from './analyzer.js';
import { detectTopicCandidates } from '../tools/topic-suggestions.js';

export interface SyncConfig {
  intervals: {
    teams: number; // milliseconds
    email: number; // milliseconds
    jira: number; // milliseconds
  };
  retryAttempts: number;
  retryDelay: number; // milliseconds
}

export interface TopicSource {
  type: 'teams' | 'email' | 'jira';
  enabled: boolean;
  config: Record<string, unknown>;
  lastSyncTimestamp?: Date;
}

export interface Topic {
  id: string;
  name: string;
  sources: TopicSource[];
}

export interface SyncResult {
  topicId: string;
  source: 'teams' | 'email' | 'jira';
  success: boolean;
  messagesCount: number;
  messages: UnifiedMessage[];
  error?: string;
  syncedAt: Date;
}

// ADR-044 S5: the DataSource contract now lives in the fetcher module
// (src/fetcher/types.ts). Imported for internal use and re-exported so existing
// `import { DataSource } from '../services/sync.js'` consumers keep resolving.
import type { DataSource } from '../fetcher/types.js';
export type { DataSource };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the config JSON stored in a DB topic into a sources array.
 * Returns an empty array if config is null/unparseable.
 */
function parseTopicSources(dbTopic: DbTopic): TopicSource[] {
  if (!dbTopic.config) return [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(dbTopic.config) as Record<string, unknown>;
  } catch {
    return [];
  }

  const sources: TopicSource[] = [];

  for (const sourceType of ['teams', 'email', 'jira'] as const) {
    const sourceConfig = parsed[sourceType];
    if (sourceConfig && typeof sourceConfig === 'object') {
      sources.push({
        type: sourceType,
        enabled: true,
        config: sourceConfig as Record<string, unknown>,
      });
    }
  }

  return sources;
}

/** Convert a DB topic row to the sync Topic shape. */
function dbTopicToSyncTopic(dbTopic: DbTopic): Topic {
  return {
    id: String(dbTopic.id),
    name: dbTopic.name,
    sources: parseTopicSources(dbTopic),
  };
}

/** Map a UnifiedMessage to the shape AIAnalyzer.detectActionItems expects. */
function toAnalyzerMessage(msg: UnifiedMessage): AnalyzerMessage {
  return {
    id: msg.id,
    source: msg.source as AnalyzerMessage['source'],
    content: msg.content,
    author: msg.sender.name,
    timestamp: msg.createdAt,
  };
}

// ---------------------------------------------------------------------------
// SyncService
// ---------------------------------------------------------------------------

/**
 * Background sync service for polling multiple data sources
 */
export class SyncService {
  private config: SyncConfig;
  private dataSources: Map<string, DataSource>;
  private syncIntervals: Map<string, NodeJS.Timeout>;
  private lastSyncTimestamps: Map<string, Date>;
  private isRunning: boolean;
  private db: Database.Database | null = null;
  private analyzer: AIAnalyzer | null = null;
  /** Interval ID for the recurring full-sync loop */
  private globalIntervalId: NodeJS.Timeout | null = null;

  constructor(config: SyncConfig) {
    this.config = config;
    this.dataSources = new Map();
    this.syncIntervals = new Map();
    this.lastSyncTimestamps = new Map();
    this.isRunning = false;
  }

  /**
   * Register a data source
   */
  registerDataSource(type: 'teams' | 'email' | 'jira', source: DataSource): void {
    this.dataSources.set(type, source);
  }

  /**
   * Attach the database and AI analyzer used by the persistent sync loop.
   * Must be called before start().
   */
  configure(db: Database.Database, analyzer: AIAnalyzer): void {
    this.db = db;
    this.analyzer = analyzer;
  }

  /**
   * Start the sync service.
   * Loads all topics from DB, does an initial sync pass, then schedules
   * a recurring pass every SYNC_INTERVAL_MS (default 15 min).
   */
  start(): void {
    if (this.isRunning) {
      console.warn('Sync service is already running');
      return;
    }

    this.isRunning = true;
    console.error('[SyncService] started');

    const intervalMs =
      Number(process.env.SYNC_INTERVAL_MS) || 900_000; // default 15 min

    // Initial sync — fire-and-forget, errors swallowed inside
    this.syncAllTopics().catch(() => {
      // already logged inside syncAllTopics
    });

    // Recurring sync
    this.globalIntervalId = setInterval(() => {
      this.syncAllTopics().catch(() => {
        // already logged inside syncAllTopics
      });
    }, intervalMs);
  }

  /**
   * Stop the sync service
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    // Clear all intervals
    for (const interval of this.syncIntervals.values()) {
      clearInterval(interval);
    }
    this.syncIntervals.clear();

    if (this.globalIntervalId !== null) {
      clearInterval(this.globalIntervalId);
      this.globalIntervalId = null;
    }

    this.isRunning = false;
    console.error('[SyncService] stopped');
  }

  /**
   * Trigger an immediate sync for a single topic by its DB id string.
   * Called by configure_topic after a topic is saved. Never throws.
   */
  triggerSync(topicId: string): void {
    this.syncTopicById(topicId).catch(() => {
      // already logged inside syncTopicById
    });
  }

  /**
   * Sync all topics in the DB. Never throws — logs all errors to stderr.
   */
  async syncAllTopics(): Promise<void> {
    if (!this.db) return;

    let dbTopics: DbTopic[];
    try {
      dbTopics = listTopics(this.db);
    } catch (err) {
      console.error('[SyncService] failed to list topics:', err);
      return;
    }

    for (const dbTopic of dbTopics) {
      await this.syncTopicById(String(dbTopic.id));
    }
  }

  /**
   * Sync a single topic by its string id. Never throws.
   */
  async syncTopicById(topicId: string): Promise<void> {
    if (!this.db) return;

    let dbTopic: DbTopic | null = null;
    try {
      const numId = Number(topicId);
      dbTopic = this.db
        .prepare('SELECT * FROM topics WHERE id = ?')
        .get(numId) as DbTopic | null;
    } catch (err) {
      console.error(`[SyncService] failed to load topic ${topicId}:`, err);
      return;
    }

    if (!dbTopic) {
      console.error(`[SyncService] topic ${topicId} not found`);
      return;
    }

    const topic = dbTopicToSyncTopic(dbTopic);

    for (const source of topic.sources) {
      if (!source.enabled) continue;
      await this.syncSourceForTopic(topic, source);
    }
  }

  // ---------------------------------------------------------------------------
  // Private sync helpers
  // ---------------------------------------------------------------------------

  private async syncSourceForTopic(topic: Topic, source: TopicSource): Promise<void> {
    const key = `${topic.id}-${source.type}`;
    const dataSource = this.dataSources.get(source.type);

    if (!dataSource) {
      // No connector registered for this source — skip silently
      return;
    }

    // Determine `since` from DB sync state, then in-memory cache
    let since: Date | undefined = this.lastSyncTimestamps.get(key);
    if (!since && this.db) {
      try {
        const state = getSyncState(this.db, topic.id, source.type);
        if (state?.last_synced_at) {
          since = new Date(state.last_synced_at);
        }
      } catch {
        // non-fatal — proceed without `since`
      }
    }

    let messages: UnifiedMessage[];
    try {
      messages = await this.fetchWithRetry(
        dataSource,
        source.config,
        since,
        this.config.retryAttempts
      );
    } catch (err) {
      console.error(`[SyncService] fetch failed for ${key}:`, err);
      return;
    }

    if (messages.length === 0) {
      // Still update sync state so `since` advances
      this.recordSyncSuccess(topic.id, source.type, key, 0);
      return;
    }

    // Persist messages
    const newMessageIds: number[] = [];
    if (this.db) {
      const topicNumId = Number(topic.id);
      for (const msg of messages) {
        try {
          const saved = upsertMessage(this.db, {
            topic_id: topicNumId,
            source: msg.source,
            content: msg.content,
            author: msg.sender.name,
            timestamp: msg.createdAt.toISOString(),
            source_id: msg.id,
            subject: msg.subject || null,
            metadata: msg.metadata ? JSON.stringify(msg.metadata) : null,
            raw_data: msg.raw ? JSON.stringify(msg.raw) : null,
          });
          newMessageIds.push(saved.id);
        } catch (err) {
          console.error(`[SyncService] upsertMessage failed for ${msg.id}:`, err);
        }
      }
    }

    // EP-14-3: Auto-topic discovery — cluster new messages for suggestions
    if (this.db && newMessageIds.length > 0) {
      try {
        detectTopicCandidates(this.db, newMessageIds);
      } catch (err) {
        console.error('[SyncService] detectTopicCandidates failed:', err);
      }
    }

    // Detect action items from this batch
    if (this.analyzer && this.db) {
      const topicNumId = Number(topic.id);
      try {
        const analyzerMessages = messages.map(toAnalyzerMessage);
        const actionItems = await this.analyzer.detectActionItems(analyzerMessages);

        for (const item of actionItems) {
          try {
            insertActionItem(this.db, {
              topic_id: topicNumId,
              title: item.description,
              description: null,
              assignee: item.assignee ?? null,
              status: item.status,
              due_date: item.dueDate ? item.dueDate.toISOString() : null,
              source_message_id: null,
            });
          } catch (err) {
            console.error(`[SyncService] insertActionItem failed:`, err);
          }
        }
      } catch (err) {
        console.error(`[SyncService] detectActionItems failed for ${key}:`, err);
      }
    }

    this.recordSyncSuccess(topic.id, source.type, key, messages.length);
  }

  private recordSyncSuccess(
    topicId: string,
    sourceType: 'teams' | 'email' | 'jira',
    key: string,
    count: number
  ): void {
    const now = new Date();
    this.lastSyncTimestamps.set(key, now);

    if (this.db) {
      try {
        updateSyncState(this.db, topicId, sourceType, now.toISOString(), count);
      } catch (err) {
        console.error(`[SyncService] updateSyncState failed for ${key}:`, err);
      }
    }
  }


  /**
   * Fetch messages with retry logic
   */
  private async fetchWithRetry(
    dataSource: DataSource,
    config: Record<string, unknown>,
    since: Date | undefined,
    attempts: number
  ): Promise<UnifiedMessage[]> {
    let lastError: Error | undefined;

    for (let index = 0; index < attempts; index++) {
      try {
        return await dataSource.fetchMessages(config, since);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`Fetch attempt ${index + 1}/${attempts} failed:`, lastError.message);

        if (index < attempts - 1) {
          await this.delay(this.config.retryDelay);
        }
      }
    }

    throw lastError || new Error('Fetch failed after retries');
  }

  /**
   * Delay helper
   */
  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}
