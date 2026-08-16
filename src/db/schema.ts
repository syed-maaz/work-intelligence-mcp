import Database from 'better-sqlite3';
import { z } from 'zod';
import migrateV45 from './migrations/v45_brain_tables.js';
import migrateV46 from './migrations/v46_budget_bucket.js';
import migrateV47 from './migrations/v47_brain_evidence_format.js';
import migrateV48 from './migrations/v48_embedding_model_label.js';
import migrateV49 from './migrations/v49_code_graph_non_ts_ref_types.js';
import migrateV50 from './migrations/v50_reminders.js';
import migrateV51 from './migrations/v51_user_profile_observations.js';
import migrateV52 from './migrations/v52_model_config.js';
import migrateV53 from './migrations/v53_bug_capture_tables.js';
import migrateV54 from './migrations/v54_bug_last_investigation.js';
import migrateV55 from './migrations/v55_bug_severity_override.js';
import migrateV56 from './migrations/v56_bug_resolver.js';
import migrateV57 from './migrations/v57_chat_modes_messages.js';
import migrateV58 from './migrations/v58_persona_memory_loop.js';
import migrateV59 from './migrations/v59_cypher_tables.js';
import migrateV60 from './migrations/v60_cypher_pm.js';
import migrateV61 from './migrations/v61_pm_auto_actions.js';
import migrateV62 from './migrations/v62_skill_actually_invoked.js';
import migrateV63 from './migrations/v63_skill_catalog.js';
import migrateV64 from './migrations/v64_cypher_outcomes.js';
import migrateV65 from './migrations/v65_cypher_outcomes_legacy_upgrade.js';
import migrateV66 from './migrations/v66_cap13_birth_decisions.js';
import migrateV67 from './migrations/v67_cypher_loop_columns.js';
import migrateV68 from './migrations/v68_topic_notebooks_state_json.js';
import migrateV69 from './migrations/v69_plan_shape_gap_observed.js';
import migrateV70 from './migrations/v70_cypher_outcomes_failure_pattern.js';
import migrateV71 from './migrations/v71_cypher_sessions_posture.js';
import migrateV72 from './migrations/v72_cypher_capability_summary_view.js';
import migrateV73 from './migrations/v73_cypher_capability_summary_string_outcome.js';
import migrateV74 from './migrations/v74_cypher_sessions_self_assess_at_entry.js';
import migrateV75 from './migrations/v75_d2_task_memory.js';
import migrateV76 from './migrations/v76_d3_projects_table.js';
import migrateV77 from './migrations/v77_d3_tasks_project_fk.js';
import migrateV78 from './migrations/v78_d3_repair_task_history_fk.js';
import migrateV79 from './migrations/v79_d3_repair_cypher_sessions_task_id_fk.js';
import migrateV80 from './migrations/v80_d18_reasoning_trace.js';
import migrateV81 from './migrations/v81_d19_recurate_pending.js';
import migrateV82 from './migrations/v82_d5_permissions_ledger.js';
import migrateV83 from './migrations/v83_d6_retention_gc.js';
import migrateV84 from './migrations/v84_d4_boundary_audit.js';
import migrateV85 from './migrations/v85_cypher_sessions_refined_goal.js';
import migrateV86 from './migrations/v86_prompt_outcomes_user_verdict.js';
import migrateV87 from './migrations/v87_outcome_check_widen.js';
import migrateV88 from './migrations/v88_prompt_outcomes_session_id.js';
import migrateV89 from './migrations/v89_cypher_steps_phase.js';
import migrateV90 from './migrations/v90_adr040_tasks_kanban.js';
import migrateV91 from './migrations/v91_adr040_outcome_evidence.js';
import migrateV92 from './migrations/v92_adr040_subagent_dispatches.js';
import migrateV93 from './migrations/v93_adr040_interaction_tokens.js';
import migrateV94 from './migrations/v94_adr040_card_number.js';
import migrateV95 from './migrations/v95_adr040_card_comments.js';
import migrateV96 from './migrations/v96_dispatch_bucket.js';
import migrateV97 from './migrations/v97_adr040_task_stalled.js';
import migrateV98 from './migrations/v98_prompt_memory.js';
import migrateV99 from './migrations/v99_adr043_pm_layer.js';
import migrateV100 from './migrations/v100_captured_to_board_outcome.js';
import migrateV101 from './migrations/v101_doc_embeddings.js';
import migrateV102 from './migrations/v102_fetch_runs.js';
import migrateV103 from './migrations/v103_drop_dead_tables.js';
import migrateV104 from './migrations/v104_dispatch_source.js';
import migrateV105 from './migrations/v105_external_observations.js';
import migrateV106 from './migrations/v106_obsidian_notes.js';
import migrateV107 from './migrations/v107_sub_task_events.js';
import migrateV108 from './migrations/v108_posture_enum_widen.js';

export const CURRENT_SCHEMA_VERSION = 108;

export const TopicSchema = z.object({
  id: z.number(),
  name: z.string(),
  created_at: z.string(),
  config: z.string().nullable(),
});

export const MessageSchema = z.object({
  id: z.number(),
  topic_id: z.number(),
  source: z.string(),
  content: z.string(),
  author: z.string(),
  timestamp: z.string(),
  metadata: z.string().nullable(),
  source_id: z.string().nullable(),
  subject: z.string().nullable(),
  raw_data: z.string().nullable(),
});

export const ActionItemSchema = z.object({
  id: z.number(),
  topic_id: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  assignee: z.string().nullable(),
  status: z.string(),
  due_date: z.string().nullable(),
  source_message_id: z.number().nullable(),
  content_hash: z.string().nullable(),
});

export const MeetingSchema = z.object({
  id: z.number(),
  topic_id: z.number().nullable(),
  title: z.string(),
  date: z.string(),
  attendees: z.string().nullable(),
  notes: z.string().nullable(),
  decisions: z.string().nullable(),
  transcript: z.string().nullable(),
  topics: z.string().nullable(),
  summary: z.string().nullable(),
  chat_name: z.string().nullable(),
  source_id: z.string().nullable(),
});

export const GroupChatSchema = z.object({
  id: z.number(),
  name: z.string(),
  last_message_at: z.string().nullable(),
  is_active: z.number(), // 1 = active, 0 = inactive
  last_scraped_at: z.string().nullable(),
  inactive_since: z.string().nullable(),
  message_count: z.number(),
  digest: z.string().nullable().optional(),
  digest_generated_at: z.string().nullable().optional(),
  jira_links: z.string().optional(),
});

export const DecisionSchema = z.object({
  id: z.number(),
  topic_id: z.number(),
  meeting_id: z.number().nullable(),
  decision: z.string(),
  context: z.string().nullable(),
  date: z.string(),
});

export const QuestionSchema = z.object({
  id: z.number(),
  topic_id: z.number(),
  question: z.string(),
  status: z.string(),
  answer: z.string().nullable(),
  asked_date: z.string(),
  answered_date: z.string().nullable(),
});

export type Topic = z.infer<typeof TopicSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ActionItem = z.infer<typeof ActionItemSchema>;
export type Meeting = z.infer<typeof MeetingSchema>;
export type GroupChat = z.infer<typeof GroupChatSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type Question = z.infer<typeof QuestionSchema>;

export function initializeDatabase(db: Database.Database): void {
  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Create metadata table for schema versioning
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Check current schema version
  const versionRow = db.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('schema_version') as { value: string } | undefined;
  const currentVersion = versionRow ? Number.parseInt(versionRow.value, 10) : 0;

  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    applyMigrations(db, currentVersion);
  }
}

function applyMigrations(db: Database.Database, fromVersion: number): void {
  const migrations: Array<() => void> = [
    // Migration 0 -> 1: Initial schema
    () => {
      db.exec(`
        -- Topics table
        CREATE TABLE IF NOT EXISTS topics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          config TEXT
        );

        -- Messages table
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic_id INTEGER NOT NULL,
          source TEXT NOT NULL,
          content TEXT NOT NULL,
          author TEXT NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          metadata TEXT,
          FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
        );

        -- Action items table
        CREATE TABLE IF NOT EXISTS action_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          assignee TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          due_date TEXT,
          source_message_id INTEGER,
          FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
          FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL
        );

        -- Meetings table
        CREATE TABLE IF NOT EXISTS meetings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          date TEXT NOT NULL,
          attendees TEXT,
          notes TEXT,
          decisions TEXT,
          FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
        );

        -- Decisions table
        CREATE TABLE IF NOT EXISTS decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic_id INTEGER NOT NULL,
          meeting_id INTEGER,
          decision TEXT NOT NULL,
          context TEXT,
          date TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
          FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL
        );

        -- Questions table
        CREATE TABLE IF NOT EXISTS questions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic_id INTEGER NOT NULL,
          question TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          answer TEXT,
          asked_date TEXT NOT NULL DEFAULT (datetime('now')),
          answered_date TEXT,
          FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
        );

        -- Indexes for performance
        CREATE INDEX IF NOT EXISTS idx_messages_topic_timestamp ON messages(topic_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
        CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author);
        CREATE INDEX IF NOT EXISTS idx_action_items_topic_status ON action_items(topic_id, status);
        CREATE INDEX IF NOT EXISTS idx_action_items_assignee ON action_items(assignee);
        CREATE INDEX IF NOT EXISTS idx_action_items_due_date ON action_items(due_date);
        CREATE INDEX IF NOT EXISTS idx_meetings_topic_date ON meetings(topic_id, date);
        CREATE INDEX IF NOT EXISTS idx_decisions_topic_date ON decisions(topic_id, date);
        CREATE INDEX IF NOT EXISTS idx_decisions_meeting ON decisions(meeting_id);
        CREATE INDEX IF NOT EXISTS idx_questions_topic_status ON questions(topic_id, status);
      `);

      // Update schema version
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '1');
    },

    // Migration 1 -> 2: Generic document storage + sync state
    () => {
      db.exec(`
        ALTER TABLE messages ADD COLUMN source_id TEXT;
        ALTER TABLE messages ADD COLUMN subject TEXT;
        ALTER TABLE messages ADD COLUMN raw_data TEXT;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_dedup
          ON messages(source, source_id)
          WHERE source_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS sync_state (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic_id TEXT NOT NULL,
          source TEXT NOT NULL,
          last_synced_at TEXT,
          last_message_count INTEGER DEFAULT 0,
          UNIQUE(topic_id, source)
        );
      `);

      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '2');
    },

    // Migration 2 -> 3: Group chats, meeting enhancements, FTS5
    // WAL mode is now set unconditionally in connection.ts before migrations
    // run, so the PRAGMA is omitted here.
    () => {
      db.exec(`
        -- Group chats tracking table
        CREATE TABLE IF NOT EXISTS group_chats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          last_message_at TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          last_scraped_at TEXT,
          inactive_since TEXT,
          message_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_group_chats_active ON group_chats(is_active, last_message_at);

        -- Extend meetings table with new columns
        ALTER TABLE meetings ADD COLUMN transcript TEXT;
        ALTER TABLE meetings ADD COLUMN topics TEXT;
        ALTER TABLE meetings ADD COLUMN summary TEXT;
        ALTER TABLE meetings ADD COLUMN chat_name TEXT;
        ALTER TABLE meetings ADD COLUMN source_id TEXT;

        -- Make topic_id nullable (meetings may not belong to a topic)
        -- SQLite can't ALTER COLUMN, so we leave it as-is; topic_id = 0 means unassigned

        CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_source_dedup
          ON meetings(source_id)
          WHERE source_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_meetings_chat ON meetings(chat_name);

        -- FTS5 full-text search over messages
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          subject,
          content,
          author,
          source,
          content='messages',
          content_rowid='id',
          tokenize='porter unicode61'
        );

        -- Populate FTS from existing messages
        INSERT INTO messages_fts(rowid, subject, content, author, source)
          SELECT id, COALESCE(subject,''), content, author, source FROM messages;

        -- FTS5 over meetings (title + transcript + summary + topics)
        CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(
          title,
          transcript,
          summary,
          topics,
          chat_name,
          content='meetings',
          content_rowid='id',
          tokenize='porter unicode61'
        );

        -- Triggers to keep FTS in sync with messages
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, subject, content, author, source)
          VALUES (new.id, COALESCE(new.subject,''), new.content, new.author, new.source);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, subject, content, author, source)
          VALUES ('delete', old.id, COALESCE(old.subject,''), old.content, old.author, old.source);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, subject, content, author, source)
          VALUES ('delete', old.id, COALESCE(old.subject,''), old.content, old.author, old.source);
          INSERT INTO messages_fts(rowid, subject, content, author, source)
          VALUES (new.id, COALESCE(new.subject,''), new.content, new.author, new.source);
        END;

        -- Triggers to keep FTS in sync with meetings
        CREATE TRIGGER IF NOT EXISTS meetings_ai AFTER INSERT ON meetings BEGIN
          INSERT INTO meetings_fts(rowid, title, transcript, summary, topics, chat_name)
          VALUES (new.id, new.title, COALESCE(new.transcript,''), COALESCE(new.summary,''), COALESCE(new.topics,''), COALESCE(new.chat_name,''));
        END;

        CREATE TRIGGER IF NOT EXISTS meetings_ad AFTER DELETE ON meetings BEGIN
          INSERT INTO meetings_fts(meetings_fts, rowid, title, transcript, summary, topics, chat_name)
          VALUES ('delete', old.id, old.title, COALESCE(old.transcript,''), COALESCE(old.summary,''), COALESCE(old.topics,''), COALESCE(old.chat_name,''));
        END;

        CREATE TRIGGER IF NOT EXISTS meetings_au AFTER UPDATE ON meetings BEGIN
          INSERT INTO meetings_fts(meetings_fts, rowid, title, transcript, summary, topics, chat_name)
          VALUES ('delete', old.id, old.title, COALESCE(old.transcript,''), COALESCE(old.summary,''), COALESCE(old.topics,''), COALESCE(old.chat_name,''));
          INSERT INTO meetings_fts(rowid, title, transcript, summary, topics, chat_name)
          VALUES (new.id, new.title, COALESCE(new.transcript,''), COALESCE(new.summary,''), COALESCE(new.topics,''), COALESCE(new.chat_name,''));
        END;
      `);

      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '3');
    },

    // Migration 3 -> 4: Action item deduplication via content_hash
    () => {
      db.exec(`
        -- Add content_hash column for deduplication.
        -- Hash is sha256(topic_id || '|' || title) computed in application code.
        ALTER TABLE action_items ADD COLUMN content_hash TEXT;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_action_items_content_hash
          ON action_items(content_hash)
          WHERE content_hash IS NOT NULL;
      `);

      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '4');
    },

    // Migration 4 -> 5: Digests cache table
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS digests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic_name TEXT NOT NULL,
          date TEXT NOT NULL,
          markdown TEXT NOT NULL,
          generated_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          UNIQUE(topic_name, date)
        );
      `);

      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '5');
    },

    // Migration 5 -> 6: Error logs table (EP-18)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS error_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
          source TEXT NOT NULL,
          message TEXT NOT NULL,
          stack TEXT,
          request_path TEXT,
          severity TEXT NOT NULL DEFAULT 'error',
          category TEXT,
          suggested_fix TEXT,
          resolved INTEGER NOT NULL DEFAULT 0,
          jira_ticket_key TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_error_logs_occurred_at ON error_logs(occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_error_logs_resolved ON error_logs(resolved, occurred_at DESC);
      `);

      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '6');
    },

    // Migration 6 -> 7: Calendar events table (EP-25)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS calendar_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT,
          location TEXT,
          organizer TEXT,
          attendees TEXT NOT NULL DEFAULT '[]',
          body TEXT,
          is_all_day INTEGER NOT NULL DEFAULT 0,
          response_status TEXT,
          scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_calendar_start_time ON calendar_events(start_time);
        CREATE INDEX IF NOT EXISTS idx_calendar_source_id ON calendar_events(source_id);
      `);

      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '7');
    },

    // Migration 7 -> 8: Jira issue cache (EP-20/21) — persists sprint board + My Issues
    // across server restarts so users don't see blank sections after a restart.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jira_issue_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          list_name TEXT NOT NULL,
          key TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Unknown',
          assignee TEXT,
          priority TEXT,
          updated_at TEXT NOT NULL,
          url TEXT NOT NULL,
          scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(list_name, key)
        );
        CREATE INDEX IF NOT EXISTS idx_jira_cache_list ON jira_issue_cache(list_name, scraped_at DESC);
      `);

      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '8');
    },

    // Migration 8 -> 9: Topic notebooks (LLM memory per topic)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS topic_notebooks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic_name TEXT NOT NULL UNIQUE,
          content TEXT NOT NULL,
          last_message_id INTEGER,
          last_updated TEXT NOT NULL DEFAULT (datetime('now')),
          message_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_topic_notebooks_name ON topic_notebooks(topic_name);
      `);

      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '9');
    },

    // Migration 9 -> 10: Notebook chat history (persist Q&A per topic)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notebook_chat_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic_name TEXT NOT NULL,
          question TEXT NOT NULL,
          answer TEXT NOT NULL,
          asked_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_notebook_chat_topic ON notebook_chat_history(topic_name, asked_at DESC);
      `);

      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '10');
    },

    // Migration 10 -> 11: Topic suggestions (EP-14-3 auto-discovery) + lookback_days (EP-14-4)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS topic_suggestions (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          keyword       TEXT NOT NULL UNIQUE,
          message_count INTEGER NOT NULL,
          author_count  INTEGER NOT NULL,
          sample_msgs   TEXT,
          suggested_at  TEXT NOT NULL DEFAULT (datetime('now')),
          dismissed     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_topic_suggestions_dismissed ON topic_suggestions(dismissed, suggested_at DESC);

        ALTER TABLE topics ADD COLUMN lookback_days INTEGER NOT NULL DEFAULT 30;
      `);

      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '11');
    },

    // Migration 11 -> 12: Browser session pool slot tracking (EP-14-5)
    // No new tables needed — pool state is in-memory. Version bump reserves
    // the slot for future pool config storage if needed.
    () => {
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '12');
    },

    // Migration 12 -> 13: Epic fields on jira_issue_cache (EP-10 epic categorization)
    () => {
      db.exec(`
        ALTER TABLE jira_issue_cache ADD COLUMN epic_key TEXT;
        ALTER TABLE jira_issue_cache ADD COLUMN epic_name TEXT;
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '13');
    },

    // Migration 13 -> 14: Pre-meeting briefs column on calendar_events (EP-15-4)
    () => {
      db.exec(`
        ALTER TABLE calendar_events ADD COLUMN pre_brief TEXT;
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '14');
    },

    // Migration 14 -> 15: Jira analysis cache (persisted per-ticket analysis)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jira_analysis (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_key TEXT NOT NULL UNIQUE,
          analysis TEXT,
          effort TEXT,
          explanation TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '15');
    },

    // Migration 15 -> 16: Favourite keywords for Teams Updates search
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS teams_fav_keywords (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          keyword TEXT NOT NULL UNIQUE,
          added_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '16');
    },

    // Migration 16 -> 17: User annotations on topic notebooks (EP-27)
    () => {
      db.exec(`
        ALTER TABLE topic_notebooks ADD COLUMN user_annotation TEXT;
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '17');
    },

    // Migration 17 -> 18: Token usage tracking (EP-32)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          method TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_token_usage_method ON token_usage(method);
        CREATE INDEX IF NOT EXISTS idx_token_usage_recorded_at ON token_usage(recorded_at);
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '18');
    },

    // Migration 18 -> 19: Data quality & observability tables (EP-33)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ingestion_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          topic_name TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          finished_at TEXT,
          records_fetched INTEGER NOT NULL DEFAULT 0,
          records_inserted INTEGER NOT NULL DEFAULT 0,
          error_message TEXT
        );

        CREATE TABLE IF NOT EXISTS data_quality (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER REFERENCES messages(id),
          meeting_id INTEGER REFERENCES meetings(id),
          rule TEXT NOT NULL,
          severity TEXT NOT NULL CHECK(severity IN ('warning','error')),
          detail TEXT,
          resolved_at TEXT,
          detected_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_data_quality_message ON data_quality(message_id);
        CREATE INDEX IF NOT EXISTS idx_data_quality_resolved ON data_quality(resolved_at);
        CREATE INDEX IF NOT EXISTS idx_ingestion_log_source ON ingestion_log(source);
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '19');
    },

    // Migration 19 -> 20: Action item confidence triage (EP-35)
    () => {
      db.exec(`
        ALTER TABLE action_items ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
        ALTER TABLE action_items ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE action_items ADD COLUMN confirmed_at TEXT;
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '20');
    },

    // Migration 20 -> 21: Cross-topic relationship detection (EP-39)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS topic_relationships (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic_a TEXT NOT NULL,
          topic_b TEXT NOT NULL,
          relationship_type TEXT NOT NULL CHECK(relationship_type IN ('jira_overlap','shared_people')),
          strength REAL NOT NULL CHECK(strength >= 0 AND strength <= 1),
          evidence TEXT,
          detected_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(topic_a, topic_b, relationship_type)
        );
        CREATE INDEX IF NOT EXISTS idx_topic_rel_a ON topic_relationships(topic_a);
        CREATE INDEX IF NOT EXISTS idx_topic_rel_b ON topic_relationships(topic_b);
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '21');
    },

    // Migration 21 -> 22: Message embeddings for semantic search (EP-37)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS message_embeddings (
          message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL,
          model TEXT NOT NULL DEFAULT 'nomic-embed-text',
          embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '22');
    },

    // Migration 22 -> 23: Jira transition history + implementation memory (EP-42)
    () => {
      db.exec(`
        -- Rename jira_issue_cache to jira_issues to reflect source-of-truth status
        ALTER TABLE jira_issue_cache RENAME TO jira_issues;

        -- Transition history: append-only, diff-detected on each sync
        CREATE TABLE IF NOT EXISTS jira_transitions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_key TEXT NOT NULL,
          project_key TEXT NOT NULL,
          from_status TEXT,
          to_status TEXT NOT NULL,
          transitioned_at TEXT NOT NULL DEFAULT (datetime('now')),
          detected_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(issue_key, to_status, transitioned_at)
        );
        CREATE INDEX IF NOT EXISTS idx_jira_trans_issue   ON jira_transitions(issue_key);
        CREATE INDEX IF NOT EXISTS idx_jira_trans_project ON jira_transitions(project_key, transitioned_at);
        CREATE INDEX IF NOT EXISTS idx_jira_trans_status  ON jira_transitions(to_status);

        -- FK guard trigger: prevent orphaned transitions
        CREATE TRIGGER IF NOT EXISTS trg_jira_trans_fk
          BEFORE INSERT ON jira_transitions
        BEGIN
          SELECT RAISE(ABORT, 'FK violation: issue_key not in jira_issues')
          WHERE NOT EXISTS (SELECT 1 FROM jira_issues WHERE key = NEW.issue_key);
        END;

        -- Implementation memory flywheel (EP-42-7)
        CREATE TABLE IF NOT EXISTS ticket_learnings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_key TEXT NOT NULL UNIQUE,
          project_key TEXT NOT NULL,
          summary TEXT NOT NULL,
          solution TEXT NOT NULL,
          files_changed TEXT,
          traps TEXT,
          cycle_time_hours REAL,
          auto_captured INTEGER NOT NULL DEFAULT 0,
          learned_at TEXT NOT NULL DEFAULT (datetime('now')),
          embedding BLOB
        );
        CREATE INDEX IF NOT EXISTS idx_learnings_project ON ticket_learnings(project_key);

        -- New columns on jira_analysis for EP-42-8 (code impact + solution tabs)
        ALTER TABLE jira_analysis ADD COLUMN code_impact TEXT;
        ALTER TABLE jira_analysis ADD COLUMN solution TEXT;
        ALTER TABLE jira_analysis ADD COLUMN blast_radius TEXT;

        -- New columns on jira_issues for EP-42-6 (hierarchy)
        ALTER TABLE jira_issues ADD COLUMN linked_issues TEXT;
        ALTER TABLE jira_issues ADD COLUMN parent_key TEXT;
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '23');
    },
    // v24: code_graph table for multi-repo code intelligence (EP-43)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS code_graph (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo TEXT NOT NULL,
          file_path TEXT NOT NULL,
          symbol TEXT,
          ref_repo TEXT NOT NULL,
          ref_file TEXT NOT NULL,
          ref_symbol TEXT,
          ref_type TEXT NOT NULL CHECK(ref_type IN (
            'import', 'call', 'type', 'api_call', 'env_var',
            'test_covers', 'config_ref',
            'docker_base_image', 'helm_chart_dep', 'shell_env_ref'
          )),
          line_number INTEGER,
          indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type)
        );
        CREATE INDEX IF NOT EXISTS idx_code_graph_source ON code_graph(repo, file_path);
        CREATE INDEX IF NOT EXISTS idx_code_graph_ref    ON code_graph(ref_repo, ref_file);
        CREATE INDEX IF NOT EXISTS idx_code_graph_type   ON code_graph(ref_type);
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '24');
    },
    // v25 — EP-45: Teammate Intelligence
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS team_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT,
          github_handle TEXT,
          jira_username TEXT,
          teams_display_name TEXT,
          marked INTEGER NOT NULL DEFAULT 0,
          added_at TEXT NOT NULL DEFAULT (datetime('now')),
          deleted_at TEXT,
          notes TEXT
        );

        CREATE TABLE IF NOT EXISTS member_aliases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
          alias TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS member_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
          profile_content TEXT NOT NULL,
          summary TEXT,
          activity_level TEXT CHECK(activity_level IN ('high','medium','low','new','unknown')),
          activity_score REAL,
          workload_signal TEXT CHECK(workload_signal IN ('available','busy','overloaded','unknown')),
          domains TEXT NOT NULL DEFAULT '[]',
          jira_open_count INTEGER NOT NULL DEFAULT 0,
          jira_overdue_count INTEGER NOT NULL DEFAULT 0,
          top_topics TEXT NOT NULL DEFAULT '[]',
          code_files_owned TEXT NOT NULL DEFAULT '[]',
          last_updated TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(member_id)
        );

        CREATE INDEX IF NOT EXISTS idx_team_members_handle ON team_members(github_handle);
        CREATE INDEX IF NOT EXISTS idx_team_members_teams  ON team_members(teams_display_name);
        CREATE INDEX IF NOT EXISTS idx_team_members_jira   ON team_members(jira_username);
        CREATE INDEX IF NOT EXISTS idx_member_aliases_mbr  ON member_aliases(member_id);
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '25');
    },

    // v25 → v26: mcp_oauth_tokens — universal OAuth token storage for headless MCP clients
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
          server_name  TEXT PRIMARY KEY,
          server_url   TEXT NOT NULL,
          client_id    TEXT NOT NULL,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at   INTEGER NOT NULL,
          scope        TEXT NOT NULL DEFAULT 'mcp',
          updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '26');
    },
    // v26 → v27: topic_notebooks.user_corrections — human feedback for notebook accuracy (EP-49-4)
    () => {
      db.exec(`ALTER TABLE topic_notebooks ADD COLUMN user_corrections TEXT DEFAULT '[]'`);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '27');
    },
    // v27 → v28: jira_issues.data_source — track whether issue came from MCP or browser scraper (EP-49-6)
    () => {
      db.exec(`ALTER TABLE jira_issues ADD COLUMN data_source TEXT DEFAULT 'unknown'`);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '28');
    },
    // v28 → v29: jira_issues sprint columns — sprint_name + sprint_context for EP-50 Jira My Work Cockpit
    () => {
      db.exec(`
        ALTER TABLE jira_issues ADD COLUMN sprint_name TEXT DEFAULT NULL;
        ALTER TABLE jira_issues ADD COLUMN sprint_context TEXT DEFAULT 'no_sprint';
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '29');
    },
    // v29 → v30: jira_issues issue_type + labels — pipeline fix for /api/jira/board (GAP-P6)
    () => {
      db.exec(`
        ALTER TABLE jira_issues ADD COLUMN issue_type TEXT DEFAULT NULL;
        ALTER TABLE jira_issues ADD COLUMN labels TEXT DEFAULT '[]';
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '30');
    },
    // v30 → v31: meeting_topic_links join table + meetings.auto_captured flag (EP-52)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meeting_topic_links (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
          topic_id   INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
          confidence REAL NOT NULL DEFAULT 0.0,
          confirmed  INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(meeting_id, topic_id)
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_topic_links_meeting ON meeting_topic_links(meeting_id);
        CREATE INDEX IF NOT EXISTS idx_meeting_topic_links_topic ON meeting_topic_links(topic_id);
        ALTER TABLE meetings ADD COLUMN auto_captured INTEGER NOT NULL DEFAULT 0;
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '31');
    },
    // v31 → v32: jira_analysis.notes — manual investigation notes, never overwritten by AI re-analysis
    () => {
      db.exec(`ALTER TABLE jira_analysis ADD COLUMN notes TEXT;`);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '32');
    },
    // v32 → v33: chat_activity rollup table + group_chats digest columns (EP-53)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_activity (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_name       TEXT NOT NULL,
          date            TEXT NOT NULL,
          message_count   INTEGER NOT NULL DEFAULT 0,
          unique_authors  INTEGER NOT NULL DEFAULT 0,
          has_decisions   INTEGER NOT NULL DEFAULT 0,
          has_action_items INTEGER NOT NULL DEFAULT 0,
          jira_links      TEXT NOT NULL DEFAULT '[]',
          mentions_me     INTEGER NOT NULL DEFAULT 0,
          UNIQUE(chat_name, date)
        );
        CREATE INDEX IF NOT EXISTS idx_chat_activity_date ON chat_activity(date, message_count DESC);
        ALTER TABLE group_chats ADD COLUMN digest TEXT;
        ALTER TABLE group_chats ADD COLUMN digest_generated_at TEXT;
        ALTER TABLE group_chats ADD COLUMN jira_links TEXT NOT NULL DEFAULT '[]';
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '33');
    },
    // v33 → v34: pr_review_cache (SHA-keyed) + watched_prs (server-side PR follow) (EP-53)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pr_review_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo TEXT NOT NULL,
          pr_num INTEGER NOT NULL,
          head_sha TEXT NOT NULL,
          review_json TEXT NOT NULL,
          work_context_json TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(repo, pr_num, head_sha)
        );
        CREATE TABLE IF NOT EXISTS watched_prs (
          repo TEXT NOT NULL,
          pr_num INTEGER NOT NULL,
          watched_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (repo, pr_num)
        );
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '34');
    },
    // v34 → v35: Bug Investigation Engine foundation tables (Phase 55)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS codebase_knowledge (
          id          INTEGER PRIMARY KEY,
          repo        TEXT NOT NULL,
          area        TEXT NOT NULL,
          type        TEXT NOT NULL CHECK(type IN ('architecture','ownership','pattern','dependency','subsystem')),
          title       TEXT NOT NULL,
          content     TEXT NOT NULL,
          source_file TEXT,
          indexed_at  TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(repo, area, type, title)
        );

        CREATE TABLE IF NOT EXISTS subsystem_owners (
          id          INTEGER PRIMARY KEY,
          repo        TEXT NOT NULL,
          path_glob   TEXT NOT NULL,
          team        TEXT,
          owner       TEXT,
          notes       TEXT,
          UNIQUE(repo, path_glob)
        );

        CREATE TABLE IF NOT EXISTS investigation_sessions (
          id              INTEGER PRIMARY KEY,
          issue_key       TEXT NOT NULL UNIQUE,
          status          TEXT NOT NULL DEFAULT 'running'
                            CHECK(status IN ('running','done','failed')),
          regression_date TEXT,
          regression_date_confidence TEXT,
          hypothesis      TEXT,
          conclusion      TEXT,
          confidence      REAL,
          owner_team      TEXT,
          react_trace     TEXT DEFAULT '[]',
          report_json     TEXT,
          started_at      TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at    TEXT
        );
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '35');
    },
    // v35 → v36: Self-Learning Brain tables (Phase 56)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pattern_feedback (
          id               INTEGER PRIMARY KEY,
          pattern_id       INTEGER NOT NULL REFERENCES codebase_knowledge(id),
          session_id       INTEGER NOT NULL REFERENCES investigation_sessions(id),
          confirmed        INTEGER NOT NULL DEFAULT 0,
          contradicted     INTEGER NOT NULL DEFAULT 0,
          confidence_delta REAL NOT NULL DEFAULT 0.0,
          recorded_at      TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(pattern_id, session_id)
        );

        CREATE TABLE IF NOT EXISTS tool_effectiveness (
          id                  INTEGER PRIMARY KEY,
          tool_name           TEXT NOT NULL,
          root_cause_type     TEXT NOT NULL,
          invocations         INTEGER NOT NULL DEFAULT 0,
          led_to_conclusion   INTEGER NOT NULL DEFAULT 0,
          effectiveness_score REAL NOT NULL DEFAULT 0.0,
          last_updated        TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(tool_name, root_cause_type)
        );

        CREATE TABLE IF NOT EXISTS hypothesis_accuracy (
          id                   INTEGER PRIMARY KEY,
          session_id           INTEGER NOT NULL UNIQUE REFERENCES investigation_sessions(id),
          issue_key            TEXT NOT NULL,
          predicted_root_cause TEXT NOT NULL,
          predicted_fix_owner  TEXT,
          actual_root_cause    TEXT,
          actual_fix_owner     TEXT,
          was_correct          INTEGER,
          fix_applied_at       TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_hypothesis_accuracy_issue_key ON hypothesis_accuracy(issue_key);
        CREATE INDEX IF NOT EXISTS idx_pattern_feedback_pattern_id ON pattern_feedback(pattern_id);
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '36');
    },
    // v36 → v37: Palace payload for investigation rebuild (EP-58, B3)
    () => {
      db.exec(`
        ALTER TABLE investigation_sessions ADD COLUMN palace_payload TEXT;
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '37');
    },
    // v37 → v38: proactive_queue — agent-written notification queue for SSE drain (Phase 61)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS proactive_queue (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          agent       TEXT NOT NULL,
          source_id   TEXT,
          type        TEXT NOT NULL,
          payload     TEXT NOT NULL,
          read_at     TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_proactive_queue_unread
          ON proactive_queue(read_at, id)
          WHERE read_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_proactive_queue_agent_source
          ON proactive_queue(agent, source_id, created_at);
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '38');
    },
    // v38 → v39: sprint_config — persists active sprint name/dates replacing hardcoded sample sprint (Phase 62)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sprint_config (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          sprint_name TEXT NOT NULL,
          project_key TEXT NOT NULL,
          start_date  TEXT NOT NULL,
          end_date    TEXT NOT NULL,
          active      INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_sprint_config_active ON sprint_config(active);
        INSERT OR IGNORE INTO sprint_config (id, sprint_name, project_key, start_date, end_date, active)
          VALUES (1, 'Demo-1', 'DEMO', '2026-04-20', '2026-05-02', 1);
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '39');
    },
    // v39 → v40: changes_log — CDC table for event-driven agent pipeline (Phase 63)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS changes_log (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          row_id     INTEGER NOT NULL,
          operation  TEXT NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_changes_log_created_at
          ON changes_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_changes_log_id
          ON changes_log(id);

        -- CDC triggers: messages (_cdc_ infix avoids collision with FTS trigger messages_ai)
        CREATE TRIGGER IF NOT EXISTS messages_cdc_ai AFTER INSERT ON messages BEGIN
          INSERT INTO changes_log (table_name, row_id, operation) VALUES ('messages', new.id, 'INSERT');
        END;

        -- CDC triggers: jira_issues
        CREATE TRIGGER IF NOT EXISTS jira_issues_cdc_ai AFTER INSERT ON jira_issues BEGIN
          INSERT INTO changes_log (table_name, row_id, operation) VALUES ('jira_issues', new.id, 'INSERT');
        END;
        CREATE TRIGGER IF NOT EXISTS jira_issues_cdc_au AFTER UPDATE ON jira_issues BEGIN
          INSERT INTO changes_log (table_name, row_id, operation) VALUES ('jira_issues', new.id, 'UPDATE');
        END;

        -- CDC triggers: calendar_events
        CREATE TRIGGER IF NOT EXISTS calendar_events_cdc_ai AFTER INSERT ON calendar_events BEGIN
          INSERT INTO changes_log (table_name, row_id, operation) VALUES ('calendar_events', new.id, 'INSERT');
        END;
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '40');
    },
    // v40 → v41: knowledge_events — cross-repo edit event capture for knowledge bridge
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          repo       TEXT NOT NULL,
          file_path  TEXT NOT NULL,
          event_type TEXT NOT NULL DEFAULT 'edit',
          timestamp  TEXT NOT NULL DEFAULT (datetime('now')),
          metadata   TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_events_repo ON knowledge_events(repo);
        CREATE INDEX IF NOT EXISTS idx_knowledge_events_timestamp ON knowledge_events(timestamp DESC);
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '41');
    },
    // v41 → v42: research_findings + finding_references — Research Engine knowledge cache (ADR-020)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS research_findings (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          question_hash   TEXT NOT NULL,
          question_text   TEXT NOT NULL,
          answer_summary  TEXT NOT NULL,
          confidence      REAL NOT NULL DEFAULT 0.0,
          findings_json   TEXT,
          model_used      TEXT,
          tokens_used     INTEGER DEFAULT 0,
          iterations_used INTEGER DEFAULT 0,
          duration_ms     INTEGER DEFAULT 0,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at    TEXT NOT NULL DEFAULT (datetime('now')),
          use_count       INTEGER NOT NULL DEFAULT 1,
          stale           INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_research_findings_hash ON research_findings(question_hash);
        CREATE INDEX IF NOT EXISTS idx_research_findings_stale ON research_findings(stale);

        CREATE TABLE IF NOT EXISTS finding_references (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          finding_id INTEGER NOT NULL REFERENCES research_findings(id) ON DELETE CASCADE,
          ref_type   TEXT NOT NULL,
          ref_value  TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_finding_references_finding ON finding_references(finding_id);
        CREATE INDEX IF NOT EXISTS idx_finding_references_value ON finding_references(ref_type, ref_value);
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '42');
    },
    // v42→v43: web_cache for link-fetcher + linked_content on jira_analysis
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS web_cache (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          url         TEXT NOT NULL UNIQUE,
          content     TEXT NOT NULL,
          source_type TEXT NOT NULL DEFAULT 'generic',
          fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_web_cache_expires ON web_cache(expires_at);
      `);
      const cols = db.prepare("PRAGMA table_info(jira_analysis)").all() as { name: string }[];
      if (!cols.some(c => c.name === 'linked_content')) {
        db.exec(`ALTER TABLE jira_analysis ADD COLUMN linked_content TEXT`);
      }
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '43');
    },
    // v43→v44: Claude Code Research Engine tables (EP-67/ADR-021)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS claude_code_research (
          id INTEGER PRIMARY KEY,
          input_hash TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          question TEXT NOT NULL,
          repos TEXT NOT NULL,
          template_id INTEGER REFERENCES prompt_templates(id),
          result TEXT NOT NULL,
          confidence REAL,
          quality_score REAL,
          tokens_used INTEGER,
          cost_usd REAL,
          latency_ms INTEGER,
          model TEXT,
          expires_at TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(input_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_research_hash ON claude_code_research(input_hash);
        CREATE INDEX IF NOT EXISTS idx_research_expires ON claude_code_research(expires_at);

        CREATE TABLE IF NOT EXISTS prompt_templates (
          id INTEGER PRIMARY KEY,
          trigger_type TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          template TEXT NOT NULL,
          system_context TEXT,
          effectiveness_score REAL DEFAULT 0.5,
          invocation_count INTEGER DEFAULT 0,
          avg_quality_score REAL,
          is_active INTEGER DEFAULT 0,
          ab_weight REAL DEFAULT 0.0,
          promoted_at TEXT,
          deprecated_at TEXT,
          evolution_source TEXT DEFAULT 'manual',
          parent_version INTEGER,
          known_dead_ends TEXT,
          high_signal_paths TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(trigger_type, version)
        );
        CREATE INDEX IF NOT EXISTS idx_templates_active ON prompt_templates(trigger_type, is_active);

        CREATE TABLE IF NOT EXISTS prompt_outcomes (
          id INTEGER PRIMARY KEY,
          template_id INTEGER NOT NULL REFERENCES prompt_templates(id),
          research_id INTEGER REFERENCES claude_code_research(id),
          trigger_input TEXT NOT NULL,
          quality_score REAL,
          relevance_score REAL,
          depth_score REAL,
          actionability_score REAL,
          user_feedback INTEGER,
          context_was_used INTEGER,
          tokens_used INTEGER,
          cost_usd REAL,
          latency_ms INTEGER,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_outcomes_template ON prompt_outcomes(template_id, created_at);

        CREATE TABLE IF NOT EXISTS research_exemplars (
          id INTEGER PRIMARY KEY,
          trigger_type TEXT NOT NULL,
          repo TEXT NOT NULL,
          area TEXT,
          input_summary TEXT NOT NULL,
          output_summary TEXT NOT NULL,
          quality_score REAL NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_exemplars_type ON research_exemplars(trigger_type, repo, quality_score);
      `);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '44');
    },

    // v44→v45: Unified Brain API tables (ADR-024 / Phase 69-01)
    () => {
      migrateV45(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '45');
    },

    // v45→v46: Budget bucket column + composite UNIQUE index (ADR-025 / Phase 72-05)
    () => {
      migrateV46(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '46');
    },

    // v46→v47: U-10 structured brain evidence_json (app-level; no DDL)
    () => {
      migrateV47(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '47');
    },

    // v47→v48: Relabel message_embeddings.model from 'text-embedding-3-small'
    // to 'nomic-embed-text' (the actual model that produced the bytes) and
    // flip the column DEFAULT to match. (post-graphify action plan, step 2)
    () => {
      migrateV48(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '48');
    },

    // v48→v49: Widen code_graph.ref_type CHECK enum to include the three new
    // non-TS regex extractor outputs (docker_base_image, helm_chart_dep,
    // shell_env_ref). (post-graphify action plan, step 5)
    () => {
      migrateV49(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '49');
    },

    // v49→v50: reminders table (wi_remind — Apple Reminders + chat/email auto-detection)
    () => {
      migrateV50(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '50');
    },

    // v50→v51: user_profile_observations — continuous progressive learning substrate
    // Closes the 'doesn't learn me' gap from the Hermes decline. Every consumer
    // signal (tool call, Jira open, message sent, code edit) writes a row;
    // GET /api/persona aggregates rolling window for the synthesized prompt.
    () => {
      migrateV51(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '51');
    },

    // v51→v52: model_config — Tier 2 per-bucket model + effort configuration.
    // Six rows seeded with evidence-backed defaults from Anthropic docs (May
    // 2026). Editable via /api/model-config and /setup/models admin UI. See
    // src/services/model-config.ts for the validation table and recommendations.
    () => {
      migrateV52(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '52');
    },

    // v52→v53: ADR-030 Phase A — Self-Healing Bug Loop. Five tables ship
    // together (bugs + bug_occurrences populated in Phase A; bug_investigations
    // empty until Phase B; auto_merge_* empty until Phase D). The bugs.source
    // CHECK enum includes 'bug-investigator' so Phase B's polling SELECT can
    // use WHERE source != 'bug-investigator' as the recursion guard without
    // another migration. Originally drafted as v52; renumbered to v53 because
    // Tier 2 model_config landed in v52 first.
    () => {
      migrateV53(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '53');
    },

    // v53→v54: ADR-030 Phase B (Plan 75-01). Two additive changes — adds
    // `bugs.last_investigation_id` column + index so /api/bugs/:id can
    // resolve the latest investigation in O(1), and seeds a model_config
    // row for the new `bug-investigator` bucket so Phase B's agent reads
    // its model + effort config from the same registry the rest of the
    // analyzer reads from.
    () => {
      migrateV54(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '54');
    },
    // v55 — manual severity override on bugs (escalation UX). Three additive
    // columns: severity_override + severity_override_reason + severity_override_at.
    // Preserves the "severity is a measurement" invariant by keeping the
    // override on a separate column; computeSeverity() returns the override
    // when present, otherwise the ring-buffer-computed value.
    () => {
      migrateV55(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '55');
    },
    // v56 — ADR-030 Phase C (Phase 76-01) BugResolverAgent foundation. Three
    // changes ship together: (1) bugs.status enum widens with 'auto-resolved'
    // | 'resolving' | 'unable-to-resolve' via SQLite create-new-copy-drop-rename
    // (SQLite doesn't support ALTER CHECK); (2) new bug_resolutions audit table
    // with one row per resolver attempt; (3) new model_config row for the
    // 'bug-resolver' bucket (reserved for Phase 77 brain-escalation; Phase 76's
    // local-apply path doesn't call the brain).
    () => {
      migrateV56(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '56');
    },
    // v57 — Phase 78a (Plan 78a-01) chat fix only. Two net-new tables ship
    // together: chat_modes (one row per conversation, UPSERTed on every turn
    // with manual_mode + last_detected + signals + confidence) and
    // chat_messages (one row per user/assistant turn, mode-tagged so
    // downstream filters can scope by mode). Three indexes: full
    // idx_chat_messages_conv_ts for the chat-render hot path; partial
    // idx_chat_messages_mode_ts for telemetry; partial idx_chat_messages_private
    // for the Phase 78c privacy filter. No new model_config bucket — mode
    // detection is heuristic-only per 78a-SPEC. Idempotent CREATE TABLE /
    // INDEX IF NOT EXISTS throughout; no FK rewiring needed.
    () => {
      migrateV57(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '57');
    },
    // v58 — Phase 80 wave 77a-01: Persona Memory Loop foundation. Five
    // net-new tables ship together: pr_review_comments (Tier-1 raw signal),
    // lessons_learned (propose-then-approve gate), rule_cards (active rules
    // with SQL counters per BLOCKER-3), code_diff_outcomes (forward-looking
    // signal source 1.2), persona_rule_snapshots (durability + replay seed
    // for palace:rebuild — PERSONA-A-11 + A-12). Plus 1 idempotent
    // INSERT OR IGNORE into model_config registering the 'persona-extract'
    // bucket per ADR-031 — Haiku low/2k-tok default for canonical-prose
    // extraction (77a-03) and clustering (77b).
    () => {
      migrateV58(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '58');
    },
    // v59 — Cypher v1 spine (Slice A+B). Three net-new tables:
    // cypher_sessions (one row per wi_dispatch engagement), cypher_steps
    // (audit trail of the 9-step contract transitions), skill_priors
    // (Beta(α, β) per skill per task class — fed by outcome writes,
    // read by getRankedSkills at plan stage). No new model_config bucket
    // — Cypher uses existing buckets per call site (decide for plan,
    // analyse for execute, etc.).
    () => {
      migrateV59(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '59');
    },
    // v60 — Cypher PM lens (PM-1). Two net-new tables: work_items
    // (one row per AC / milestone with status + priority + deps) and
    // work_item_links (many-to-many evidence map: commit_sha,
    // cypher_session_id, smoke_section, file_path, pr_url). Replaces
    // the GSD discipline (dropped 2026-06-12) with a minimal SQL-
    // backed source of truth for project status. Markdown stays as
    // human-readable narrative; SQL becomes the read model.
    () => {
      migrateV60(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '60');
    },
    // v61 — PM-AUTO (slice 81a). One net-new audit table
    // pm_auto_actions logging every autonomous PM write Cypher
    // makes (link_session, link_commit, transition_in_progress,
    // transition_shipped). Closes the suggest->write gap left by
    // PM-4 (which surfaced suggestions but never persisted them).
    // Additive only.
    () => {
      migrateV61(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '61');
    },
    // v62 — slice 82a-2. Additive nullable column
    // cypher_sessions.skill_actually_invoked. Backwards-compatible —
    // null preserves today's credit-assignment behavior (chosen_skill).
    // When supplied at outcome time, the Beta prior credits the actual
    // invoked skill instead of the suggested one.
    () => {
      migrateV62(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '62');
    },
    // v63 — phase 82b. Net-new skill_catalog table holding every
    // SKILL.md the discovery scanner finds across ~/.claude/skills/
    // and plugin marketplaces. Lets Cypher route to non-wi-* skills
    // by description-keyword match instead of the hand-curated
    // DEFAULT_CANDIDATES alone. Idempotent (CREATE only if missing).
    () => {
      migrateV63(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '63');
    },
    // v64 — phase 87 / ADR-034 L1.1 (2026-06-15). Net-new
    // cypher_outcomes ledger: multi-signal weighted outcome rows per
    // Cypher session (verdict + thumbs + rerun in L1.1; edit_distance
    // + ci reserved for L1.2 / L1.3). The measurement substrate
    // ADR-033 §10 promised. Backfills one verdict row per existing
    // closed session with the ADR-034 §Layer 1 weight table
    // (success +0.8 / mixed 0 / failed -0.8). Idempotent.
    () => {
      migrateV64(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '64');
    },
    // v65 — phase 87 / ADR-034 L1.1 follow-up (2026-06-16). Upgrade
    // legacy cypher_outcomes shape (parked phase-83 worktree:
    // weight/captured_at/evidence + thumbs_up/thumbs_down enum) into
    // the v64 PRD-blessed shape (value/weight/metadata/created_by +
    // 'thumbs' enum). Signature-checks the existing table — runs only
    // when the old shape is detected. Idempotent: fresh DBs already
    // on v64 are no-op; rerunning on a DB that already has
    // cypher_outcomes_v_old is no-op.
    () => {
      migrateV65(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '65');
    },
    // v66 — ADR-037 Phase 2 / D21 (2026-06-22). CAP-13 birth-gate
    // ledger table. Records every CAP-13 (skill birth) decision —
    // approved / rejected / skipped — with a skipped_reason TEXT NULL
    // column that makes "no candidates qualified" distinguishable from
    // "Maaz skipped because the slog wasn't worth it" in telemetry.
    // ADR-037 D21 explicitly calls out skipped_reason as the friction-
    // instrumentation signal v2.5 W2's codegen acceptance gate reads.
    () => {
      migrateV66(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '66');
    },
    // v67 — ADR-037 Phase 3-A (2026-06-22). Cypher tool-use loop columns
    // (D15 + D16 + D17 + D18 + D20) across cypher_sessions / cypher_outcomes
    // / cypher_steps. Includes a table-rebuild on cypher_sessions to widen
    // the outcome CHECK constraint to admit halted / abandoned /
    // rejected_non_interactive. Plan called out "verdict CHECK on
    // cypher_outcomes" but cypher_outcomes is the multi-signal ledger
    // (signal_kind+value+weight, no verdict) — the enum lives on
    // cypher_sessions.outcome; this migration widens THAT.
    () => {
      migrateV67(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '67');
    },
    // v68 — Option 3 of updateNotebook cost-reduction (2026-06-23).
    // Adds topic_notebooks.state_json TEXT NULL. Holds the structured
    // NotebookState that the new patch_notebook tool returns; the canonical
    // 7-section markdown is re-rendered server-side from state, so downstream
    // regex consumers (obsidian-export, relationship-detector, graph endpoint)
    // see byte-identical output. Existing rows backfill on first read via
    // parseMarkdownToState; on parse failure callers fall back to a cold
    // buildNotebook rather than write a corrupt state_json.
    // See .planning/updatenotebook-cost-reduction/01-...md § 7 Option 3.
    () => {
      migrateV68(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '68');
    },
    // v69 — CAP-13-LITE plan-shape gap recognition (2026-06-24). New
    // table plan_shape_gap_observed holds the recognition output of
    // ADR-037.5 v2's α-LITE design: when a loop dispatch completes
    // with prior_count >= 5 AND prior_success_rate < 0.3 on its
    // plan_shape_hash, the recognition hook in loop.ts opportunistically
    // writes one row here. No drafter, no LLM call — pure observation.
    // Architecturally honest successor to the pipeline-era
    // skill_gap_observed (which lived on an unmerged branch).
    // See docs/docs/adr/adr-037-5-cap13-skill-self-extension.md § D4
    // and .planning/cap-13-alpha-lite/PRD.md § Schema.
    () => {
      migrateV69(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '69');
    },
    // v70 — Cypher v2.5 D8 self-model substrate, part 1 (2026-06-25).
    // ADD COLUMN cypher_outcomes.failure_pattern TEXT NULL + partial
    // index. Holds a coarse failure-mode tag classified at verdict-write
    // time. v2.5 D8's cypher.self_assess returns the top-3 failure modes
    // per winning aggregation tier; this column is the source. v1 tags
    // are heuristic (budget_exhaustion / timeout / iteration_cap /
    // user_halt / unknown_failure); D2's curator-driven tagger
    // (ADR-038 Gap 2) will write to the same column when shipped.
    // See .planning/cypher/v2.5-D8-self-model-design.md § Q-2.5.3 + § Q-2.5.6.
    () => {
      migrateV70(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '70');
    },
    // v71 — Cypher v2.5 D8 self-model substrate, part 2 (2026-06-25).
    // ADD COLUMN cypher_sessions.posture TEXT NULL + composite index on
    // (posture, task_class, user). Persists the loop posture for each
    // dispatch (pr-review | bug-investigate | pm | generic). The T1/T2
    // aggregation tiers in self_assess (Q-2.5.1) need posture on every
    // session — posture is encoded in plan_shape_hash but the SHA is
    // not reversible; plan_shape_gap_observed has it only on gap-firing
    // sessions. Forward-only population; historical rows stay NULL and
    // contribute only to T3's uniform Beta(1,1) prior.
    // See .planning/cypher/v2.5-D8-self-model-design.md § Q-2.5.6 v71.
    () => {
      migrateV71(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '71');
    },
    // v72 — Cypher v2.5 D8 self-model substrate, part 3 (2026-06-25).
    // CREATE VIEW cypher_capability_summary aggregating cypher_sessions
    // (engine='loop' AND posture IS NOT NULL) joined to cypher_outcomes
    // (signal_kind='verdict'), keyed by (posture, task_class, user,
    // plan_shape_hash). Half-credit accounting for mixed outcomes mirrors
    // cap13-lite.ts. View, not materialized — at current corpus size
    // the aggregation runs in single-digit ms. selfAssess() runs its
    // own per-tier GROUP BY on top of this view.
    // See .planning/cypher/v2.5-D8-self-model-design.md § Q-2.5.6 v72.
    () => {
      migrateV72(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '72');
    },
    // v73 — Cypher v2.5 D8 substrate bugfix (2026-06-25). The v72 view
    // aggregated cypher_outcomes.value which is REAL-valued
    // (VERDICT_SUCCESS=0.8 / VERDICT_MIXED=0.0 / VERDICT_FAILED=-0.8).
    // The Q-2.5 design called for string-keyed accounting against
    // cypher_sessions.outcome ('success' | 'mixed' | 'failed'). v73
    // DROPs the v72 view and recreates it reading s.outcome instead.
    // Also fixes a duplicate-counting bug: v72 LEFT JOIN over
    // cypher_outcomes counted sessions multiple times when they had
    // both a verdict and rerun rows. v73 counts each session exactly
    // once.
    () => {
      migrateV73(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '73');
    },
    // v74 — Cypher v2.5 D8 shadow-mode logging (2026-06-25). Adds
    // cypher_sessions.self_assess_at_entry TEXT NULL. The loop persists
    // the JSON-serialized SelfAssessment returned by selfAssess() at
    // dispatch entry. Used for the Q-2.5.7 soak-then-promote protocol:
    // 2 weeks of organic data → manual review → orchestrator (D9)
    // starts consuming the recommendation as a gate.
    () => {
      migrateV74(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '74');
    },
    // v75 — ADR-038 v2.5 D2: task memory primitive (2026-06-26). Adds
    // tasks, task_contexts, task_history tables + cypher_sessions.task_id.
    // See .planning/cypher/Q-2.1-D2-task-memory.md for design decisions.
    () => {
      migrateV75(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '75');
    },
    // v76 — ADR-038 v2.5 D3 slice 1: projects table + seed (2026-06-26).
    // Introduces `projects` as first-class scope dimension; seeds `wi` +
    // other configured projects; backfills any other tasks.project values. No FK
    // constraint yet — slice 2 adds it via table-rebuild migration.
    // See docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D3.
    () => {
      migrateV76(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '76');
    },
    // v77 — ADR-038 v2.5 D3 slice 2: tasks.project FK constraint
    // (2026-06-26). Table-rebuild migration adds FOREIGN KEY (project)
    // REFERENCES projects(id) ON DELETE RESTRICT to tasks. Relies on
    // v76's backfill to guarantee no orphan rows; verifies with
    // PRAGMA foreign_key_check and aborts the migration if any orphans.
    () => {
      migrateV77(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '77');
    },
    // v78 — ADR-038 v2.5 D3 slice 2 hotfix (2026-06-26). Repairs
    // task_history and task_contexts FK references that were silently
    // rewritten to "tasks_old_v76" by the first (broken) v77 cut, then
    // orphaned when v77 dropped the renamed table. See
    // src/db/migrations/v78_d3_repair_task_history_fk.ts for the full
    // bug story. No-op on fresh-install DBs (v77 post-fix is correct).
    () => {
      migrateV78(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '78');
    },
    // v79 — ADR-038 v2.5 D3 slice 2 hotfix part 2 (2026-06-26).
    // Repairs cypher_sessions.task_id FK that suffered the same
    // tasks_old_v76 rewrite. Separate from v78 because cypher_sessions
    // has many additive columns and the column-drop dance is its own
    // unit of revertability. Guarded — no-op on clean DBs.
    () => {
      migrateV79(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '79');
    },
    // v80 — ADR-038 v2.5 D18: reasoning-trace observability (2026-06-26).
    // Adds reasoning_trace + controller_model columns to cypher_steps and
    // widens the stage CHECK to allow 'tool_use'. Table-rebuild with
    // legacy_alter_table=1 (v77 pattern). See
    // src/db/migrations/v80_d18_reasoning_trace.ts.
    () => {
      migrateV80(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '80');
    },
    // v81 — ADR-038 v2.5 D19: tasks.recurate_pending_at (2026-06-26).
    // Additive nullable column; flag set by cypher_task_recurate, read +
    // cleared by the curator at next dispatch close.
    // See src/db/migrations/v81_d19_recurate_pending.ts.
    () => {
      migrateV81(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '81');
    },
    // v82 — ADR-038 v2.5 D5: permissions ledger (2026-06-26).
    // Creates permissions + permission_uses tables. Additive; no
    // existing row touched. See
    // src/db/migrations/v82_d5_permissions_ledger.ts.
    () => {
      migrateV82(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '82');
    },
    // v83 — ADR-038 v2.5 D6: retention + GC substrate (2026-06-26).
    // Creates dispatch_snapshots, cypher_steps_summary,
    // cypher_sessions_summary, gc_log tables. Daemon wiring is a
    // follow-up slice; this migration ships the schema only.
    () => {
      migrateV83(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '83');
    },
    // v84 — ADR-038 v2.5 D4: tool-layer boundary audit columns
    // (2026-06-26). Adds nullable path_arg + boundary_violation columns
    // to cypher_steps for D4 boundary-check audit. Substrate slice
    // only — worktree creation + loop hook are follow-up slices.
    () => {
      migrateV84(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '84');
    },
    // v85 — ADR-039 AC-3 (2026-06-26): cypher_sessions.refined_goal +
    // scope_iters columns. Substrate for the SCOPE phase's structured
    // brief output (refined_goal JSON) and the per-session refinement
    // loop counter (scope_iters, default 0). Loop wiring (T6/T7) lands
    // on follow-up cards. See
    // src/db/migrations/v85_cypher_sessions_refined_goal.ts.
    () => {
      migrateV85(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '85');
    },
    // v86 — ADR-039 AC-14 (2026-06-27): prompt_outcomes.user_verdict.
    // Adds the user-disagreement signal that lets OPRO learn about
    // prompt clarity (was the question right?) rather than only output
    // quality (was the answer right?). 4-enum CHECK: useful |
    // wrong_question | wrong_scope | unrated. See
    // src/db/migrations/v86_prompt_outcomes_user_verdict.ts.
    () => {
      migrateV86(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '86');
    },
    // v87 — ADR-038 v2.5 A1 (2026-06-28): widen cypher_sessions.outcome
    // CHECK from 3-value ('success','mixed','failed') to 6-value
    // (+'halted','abandoned','rejected_non_interactive'). Closes the gap
    // between the cypher_record_outcome tool's input schema (6-value
    // enum) and the DB CHECK. Companion boot-reaper flip lands in the
    // same commit — orphan-on-reboot sessions now write
    // outcome='abandoned' instead of 'mixed', so crash-orphans no
    // longer pollute the real 'mixed' verdict population in Beta
    // priors. See src/db/migrations/v87_outcome_check_widen.ts.
    () => {
      migrateV87(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '87');
    },
    // v88 — ADR-039 AC-19 measurement scaffold (2026-06-29):
    // prompt_outcomes.session_id FK + index. Unblocks the dogfood
    // SQL that joins refinement-enabled dispatches to their
    // user_verdicts. Forward-only: existing rows get NULL; the
    // loop's QualityScorer call populates it on every new INSERT.
    // See src/db/migrations/v88_prompt_outcomes_session_id.ts.
    () => {
      migrateV88(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '88');
    },
    // v89 — ADR-039 AC-19a per-phase token telemetry (2026-06-29):
    // cypher_steps.phase TEXT NULL CHECK(phase IS NULL OR
    // phase IN ('scope','execute')) + partial index. Lets the AC-19
    // dogfood compute scope_phase_tokens / total_dispatch_tokens
    // per dispatch. Forward-only: existing rows get NULL; SCOPE
    // and EXECUTE phase cypher_steps INSERTs tag the rows.
    // See src/db/migrations/v89_cypher_steps_phase.ts.
    () => {
      migrateV89(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '89');
    },
    // v90 — ADR-040 commit 1 (2026-06-30): outcome-honest delivery kanban
    // substrate. Extends `tasks` with 9 columns (goal_text, acceptance_text,
    // kanban_column, kanban_order, assigned_worker_id, blocked flag+reason,
    // entered_column_at, depends_on_json). Creates 5 new tables: workers
    // (with idempotent seed of Worker 1..4), panel_reviews,
    // panel_review_messages, panel_agent_config, worker_reassignment_log.
    // Adds the workers_delete_requires_no_assignments trigger closing the
    // FK integrity gap for tasks.assigned_worker_id. DDL is verbatim from
    // scripts/adr040-dry-run.mjs — dry-run-verified in 19ms against a
    // 480MB production-shape v89 DB (see ADR-040 §11.1).
    // See src/db/migrations/v90_adr040_tasks_kanban.ts.
    () => {
      migrateV90(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '90');
    },
    // v91 — ADR-040 commit 2 (2026-06-30): outcome-honest DoD contract.
    // outcome_evidence table + 3 CHECK constraints (author-independence,
    // non-fixture id, output hash) + 2 DoD triggers (UPDATE + INSERT)
    // enforcing verified_via='user_observed' as sole path to
    // tasks.kanban_column='done'. cost_ledger + verifier_health tables
    // ship empty here; cron scripts populate verifier_health starting
    // commit 3, panel writes to cost_ledger starting commit 5.
    // See src/db/migrations/v91_adr040_outcome_evidence.ts.
    () => {
      migrateV91(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '91');
    },
    // v92 — ADR-040 commit 3 (2026-06-30): subagent_dispatches audit table.
    // Every skill dispatch through runSkillSubagent() writes a row here.
    // Closes GAP-001 at the audit-visibility layer.
    // See src/db/migrations/v92_adr040_subagent_dispatches.ts.
    () => {
      migrateV92(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '92');
    },
    // v93 — ADR-040 commit 4.5 (2026-07-06): interaction_tokens table.
    // Guards POST /api/outcome-evidence — the DoD §2.4 condition (2)
    // mechanism. Short-lived (5min) single-use tokens issued per
    // (task_id, session_id) pair. Server-side spoof of user_observed
    // is impossible without a token.
    // See src/db/migrations/v93_adr040_interaction_tokens.ts.
    () => {
      migrateV93(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '93');
    },
    // v94 — ADR-040 F-UI (2026-07-09): human-readable card_number on tasks.
    // Sequential display number so cards can be referred to as "#42"
    // instead of the opaque task_<hex> id. Backfilled in created_at order.
    // See src/db/migrations/v94_adr040_card_number.ts.
    () => {
      migrateV94(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '94');
    },
    // v95 — ADR-040 F-UI (2026-07-09): card_comments thread + needs_answer.
    // Per-card activity + Q&A thread. When a session hits asked_user the
    // question lands as a comment and the card flags needs_answer=1 (badge
    // + colour on the board). User answers in the ticket → clears the flag.
    // See src/db/migrations/v95_adr040_card_comments.ts.
    () => {
      migrateV95(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '95');
    },
    // v96 — dispatch bucket (2026-07-10): Sonnet-backed model_config bucket for
    // routine /wi loop controllers. pickControllerBucket() in cypher/loop.ts
    // routes fetch/summarize/review task_classes here; decide stays Opus.
    // See src/db/migrations/v96_dispatch_bucket.ts.
    () => {
      migrateV96(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '96');
    },
    // v97 — ADR-040 F-UI (2026-07-10): tasks.stalled + stalled_reason.
    // Flags a card whose session is a zombie (pending, no live dispatch)
    // so it's shown as stalled + retriggerable instead of being recycled
    // ready↔in_progress forever. See v97_adr040_task_stalled.ts.
    () => {
      migrateV97(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '97');
    },
    // v98 — prompt_memory: learned prompt→skill recognition store for the
    // SCOPE refiner's getCatalogHint. Goal embeddings + chosen_skill + outcome,
    // backfilled from cypher_sessions. See v98_prompt_memory.ts.
    () => {
      migrateV98(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '98');
    },
    // v99 — ADR-043 PM Orchestration Layer, Phase 1: adds priority (0-100),
    // effort_points (Fibonacci 1/2/3/5/8/13, nullable), intent
    // (brainstorm|plan|execute|decide) to `tasks`, plus a composite covering
    // index for the ranker + BoardWorkerAgent hot paths. Consumers:
    // src/services/board/ranker.ts + BoardWorkerAgent filter (intent='execute').
    // See v99_adr043_pm_layer.ts.
    () => {
      migrateV99(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '99');
    },
    // v100 — ADR-043 Phase 3 (Shape A): widen cypher_sessions.outcome CHECK to
    // admit 'captured_to_board'. AC-A1 closes non-execute-intent sessions with
    // this label when the Stage 1 hook re-routes them to the PM backlog instead
    // of dispatching Stage 2. See v100_captured_to_board_outcome.ts.
    () => {
      migrateV100(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '100');
    },
    // v101 — doc_embeddings: ADR/architecture/epic markdown embedded for
    // Stage-1 recognition (ADR-042 "Gap 2"). Pure DDL; embedDocs() fills it
    // at boot (Ollama-gated). See v101_doc_embeddings.ts.
    () => {
      migrateV101(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '101');
    },
    // v102 — fetch_runs: append-only per-source fetch telemetry ledger
    // (ADR-044 S2.6). Persists the orchestrator's FetchProgress result envelope
    // so a timed-out / errored / silently-empty source becomes queryable and
    // surfaces via /api/sync/telemetry + captureBug. See v102_fetch_runs.ts.
    () => {
      migrateV102(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '102');
    },
    // v103 — drop 12 dead tables (storage audit cleanup, 2026-07-18). 10 truly
    // dead (0 rows, no writer, no reader) + decisions/questions (0 rows, readers
    // migrated off in src/tools/digest.ts same commit). Keeps plan_shape_gap_observed
    // (0 rows but live gated writer). See v103_drop_dead_tables.ts.
    () => {
      migrateV103(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '103');
    },
    // v104 — dispatch_source column on cypher_sessions (write-time provenance).
    // ADR-050 Phase 0 (2026-07-26) exposed that string-heuristic filters over
    // goal-text cannot separate real user dispatches from smoke/test/agent
    // dispatches — five successive filter iterations produced M2 numbers
    // ranging from 35% to 70.9%. Fix is a machine-readable provenance column
    // set by the caller at dispatch time. Enum: user | smoke | test | agent |
    // unknown. Legacy rows default 'unknown' (no backfill — retroactive
    // labeling would be another round of string-heuristics, which is the
    // failure mode this exists to end). See GATE-RESOLVED-2026-07-26.md §11.
    () => {
      migrateV104(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '104');
    },
    // v105 — external_observations: one-shot backfill target for mem-claude's
    // ~20k curated observations. FTS5 shadow for narrative/facts/concepts search.
    // Populated by scripts/ingest-mem-claude.ts (idempotent, deduped by
    // content_hash). Wired as a 5th recall lane in recallMemory. Phase 79-07.
    () => {
      migrateV105(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '105');
    },
    // v106 — obsidian_notes + obsidian_notes_fts (Phase 79-08).
    // Indexes vault .md files for a 6th recall lane. Splits wi_body (WI-authoritative,
    // above separator) from user_annotations (user-authoritative, below separator).
    // Populated at boot by vault-indexer.ts; live-updated via chokidar watcher.
    () => {
      migrateV106(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '106');
    },
    // v107 — sub_task_events (ADR-053 Q7 Option B). Executors emit structured
    // events (question | partial | blocker | scope_discovery) during runs; PM
    // re-enters and reads unresolved rows. Partial index idx_ste_unresolved
    // speeds up the PM re-entry query.
    () => {
      migrateV107(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '107');
    },

    // v108 — add CHECK constraint to cypher_sessions.posture (admits pm/architect/pm-resume; preserves NULL).
    () => {
      migrateV108(db);
      db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '108');
    },
  ];

  // Apply migrations in sequence, each wrapped in its own transaction so a
  // partial failure leaves the DB unchanged and the version number only
  // advances when all DDL in that migration succeeds.
  for (let version = fromVersion; version < CURRENT_SCHEMA_VERSION; version++) {
    const migration = migrations[version];
    if (migration) {
      db.transaction(() => {
        migration();
      })();
    }
  }
}

export function createBackup(db: Database.Database, backupPath: string): void {
  db.backup(backupPath);
}
