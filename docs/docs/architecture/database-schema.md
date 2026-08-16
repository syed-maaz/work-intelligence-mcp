---
sidebar_label: "Database Schema"
sidebar_position: 2
---

# Database Schema

Work Intelligence uses **SQLite** via `better-sqlite3` for all local storage. The database file lives at `./data/intelligence.db` by default (override via `DATABASE_PATH` env var).

**WAL mode** is enabled unconditionally at connection time — writes never block reads, critical for the sync loop running concurrently with API requests.

---

## Schema Versioning

Versioning is tracked in a `schema_metadata` table (`key='schema_version'`). On every DB open, `initializeDatabase()` reads the current version and applies any pending migrations in sequence. Each migration runs in its own transaction — a partial failure leaves the version number unchanged and can be retried.

**Current version: 53**

| Migration | Added by | What changed |
|-----------|----------|-------------|
| 0 → 1 | EP-0 | Initial schema: `topics`, `messages`, `action_items`, `meetings`, `decisions`, `questions` |
| 1 → 2 | EP-7/10 | `messages.source_id`, `messages.subject`, `messages.raw_data`; `sync_state` table; dedup index |
| 2 → 3 | EP-11 | `group_chats` table; extended `meetings` columns; `messages_fts` + `meetings_fts` FTS5 virtual tables + all sync triggers |
| 3 → 4 | EP-11 | `action_items.content_hash` for dedup; unique index on content_hash |
| 4 → 5 | EP-19 | `digests` table — persistent AI digest cache |
| 5 → 6 | EP-18 | `error_logs` table — application error tracking |
| 6 → 7 | EP-25 | `calendar_events` table — Outlook calendar sync |
| 7 → 8 | EP-20/21 | `jira_issue_cache` table — Saturn board + My Issues persistence |
| 8 → 9 | EP-26 | `topic_notebooks` table — LLM memory per topic |
| 9 → 10 | EP-26 | `notebook_chat_history` table — persistent Q&A per topic |
| 10 → 11 | EP-14 | `topic_suggestions` table; `topics.lookback_days` column |
| 11 → 12 | EP-14 | Version bump only (browser pool state is in-memory) |
| 12 → 13 | EP-29 | `jira_issue_cache.epic_key`, `jira_issue_cache.epic_name` columns |
| 13 → 14 | EP-15 | `calendar_events.pre_brief` column — pre-meeting briefs |
| 14 → 15 | EP-29 | `jira_analysis` table — per-ticket deep analysis cache |
| 15 → 16 | EP-30 | `teams_fav_keywords` table — favourite search keywords |
| 16 → 17 | EP-26 | `topic_notebooks.user_annotation` column |
| 17 → 18 | EP-32 | `token_usage` table — AI cost tracking per model/tool |
| 18 → 19 | EP-33 | `ingestion_log` + `data_quality` tables — observability |
| 19 → 20 | EP-35 | `action_items.confidence`, `.confirmed`, `.confirmed_at` columns |
| 20 → 21 | EP-39 | `topic_relationships` table — cross-topic entity links |
| 21 → 22 | EP-37 | `message_embeddings` table — Ollama vector embeddings |
| 22 → 23 | EP-42 | `jira_issues` (renamed from `jira_issue_cache`) + `jira_transitions` + `ticket_learnings` + new cols on `jira_analysis` |
| 23 → 24 | EP-43 | `code_graph` table with 3 indexes — multi-repo code intelligence |
| 24 → 25 | EP-45 | `team_members` + `member_aliases` + `member_profiles` tables |
| 25 → 26 | EP-46 | `mcp_oauth_tokens` table — MCP server OAuth token storage |
| 26 → 27 | EP-47 | `jira_analysis` extended columns for solution engine |
| 27 → 28 | EP-48 | `ticket_learnings` extended; `jira_analysis.notes` column |
| 28 → 29 | EP-49 | UX functional columns on various tables |
| 29 → 30 | EP-50 | `jira_issues.issue_type`, `.labels` columns |
| 30 → 31 | EP-51 | `calendar_events` extended; meeting context columns |
| 31 → 32 | EP-50 | `jira_analysis.notes` persistent notes column |
| 32 → 33 | EP-53 | Teams intelligence feed columns |
| 33 → 34 | EP-55 | `investigation_sessions` + `investigation_steps` tables — bug investigation engine |
| 34 → 35 | EP-56 | `codebase_knowledge` table — self-learning brain knowledge store |
| 35 → 36 | EP-57 | MemPalace integration columns on `investigation_sessions` |
| 36 → 37 | EP-58 | `investigation_sessions.palace_payload` — Universal Memory Writer rebuild support |
| 37 → 38 | EP-61 | `proactive_queue` table — SSE event buffer for agent notifications |
| 38 → 39 | EP-62 | `sprint_config` table — runtime sprint management (replaces hardcoded values) |
| 39 → 40 | EP-63 | `changes_log` table + 4 CDC triggers — event-driven agent pipeline |
| 40 → 41 | Post-S17 | `knowledge_events` table — cross-repo edit event capture for knowledge bridge |
| 41 → 42 | EP-67 | `research_cache` columns + `claude_code_runs` table — research engine cache |
| 42 → 43 | EP-66 | `web_cache` table + `link_extractions` — link-fetcher / content-extractor pipeline |
| 43 → 44 | EP-67 | `research_exemplars` table — A/B prompt evaluation seed data |
| 44 → 45 | ADR-024 / Phase 69-01 | `brain_decisions` + `brain_clusters` + `brain_verifications` tables — Unified Brain API |
| 45 → 46 | ADR-025 / Phase 72-05 | `brain_user_budget_ledger.bucket` column + composite UNIQUE index |
| 46 → 47 | U-10 | `brain_decisions.evidence_json` structured format (app-level migration; no DDL) |
| 47 → 48 | post-graphify | `message_embeddings` model relabel + DEFAULT flip (`text-embedding-3-small` → `nomic-embed-text`) |
| 48 → 49 | post-graphify | `code_graph.ref_type` CHECK enum widened (`docker_base_image`, `helm_chart_dep`, `shell_env_ref`) |
| 49 → 50 | wi_remind | `reminders` table — Apple Reminders bridge / smart-detection engine |
| 50 → 51 | substrate fix | `user_profile_observations` table — continuous user-profile learning (POST `/api/profile/observe`) |
| 51 → 52 | ADR-031 / Tier 2 | `model_config` table — per-bucket (model, effort, thinking_mode) admin UI; 6 rows seeded |
| 52 → 53 | ADR-030 / Phase 74 | Five bug-capture tables atomic: `bugs`, `bug_occurrences`, `bug_investigations`, `auto_merge_blocklist`, `auto_merge_audit` |

---

## Entity Relationships

```
topics
  ├── messages              (topic_id FK, CASCADE delete)
  │     └── action_items    (source_message_id FK, SET NULL on delete)
  ├── sync_state            (topic_id, no FK constraint — TEXT column)
  ├── meetings              (topic_id FK, CASCADE delete; topic_id nullable = unassigned)
  ├── decisions             (topic_id FK, CASCADE delete)
  └── questions             (topic_id FK, CASCADE delete)

topic_notebooks             (keyed by topic_name TEXT, no FK)
notebook_chat_history       (keyed by topic_name TEXT, no FK)
topic_suggestions           (standalone — auto-discovered keywords)
topic_relationships         (links entities across topics — EP-39)

group_chats                 (standalone — Teams chat activity state)
calendar_events             (standalone — Outlook calendar)
digests                     (keyed by topic_name + date, no FK)
error_logs                  (standalone — application errors)
jira_issues                 (keyed by list_name + key, no FK — renamed from jira_issue_cache v23)
jira_analysis               (keyed by issue_key, no FK)
jira_transitions            (keyed by issue_key + timestamp — EP-42)
ticket_learnings            (keyed by issue_key — solution patterns — EP-48)
teams_fav_keywords          (standalone — favourite search chips)

team_members                (standalone — teammate identity model — EP-45)
member_aliases              (FK → team_members)
member_profiles             (FK → team_members)

code_graph                  (standalone — multi-repo file/dep edges — EP-43)
mcp_oauth_tokens            (standalone — OAuth token storage — EP-46)
token_usage                 (standalone — AI cost tracking — EP-32)
ingestion_log               (standalone — sync observability — EP-33)
data_quality                (standalone — quality checks — EP-33)
message_embeddings          (FK → messages — vector embeddings — EP-37)

investigation_sessions      (standalone — bug investigation engine — EP-55)
investigation_steps         (FK → investigation_sessions — EP-55)
codebase_knowledge          (standalone — self-learning brain — EP-56)

proactive_queue             (standalone — SSE event buffer for agent notifications — EP-61)
sprint_config               (standalone — runtime sprint management — EP-62)
changes_log                 (standalone — CDC event backbone — EP-63)
knowledge_events            (standalone — cross-repo edit capture — Post-S17)

schema_metadata             (internal — schema version tracking)

messages_fts                (FTS5 virtual table, mirrors messages)
meetings_fts                (FTS5 virtual table, mirrors meetings)
```

---

## Core Tables

### `topics`

Stores each monitored topic/project. Topics are the primary organizational unit — most other tables hang off a `topic_id`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `name` | TEXT NOT NULL UNIQUE | Human-readable (e.g. `"BDS"`, `"MIGRATION"`) |
| `created_at` | TEXT | `datetime('now')` default |
| `config` | TEXT nullable | JSON blob — Teams channels, Jira projects, email filters |
| `lookback_days` | INTEGER NOT NULL DEFAULT 30 | Days of history to fetch on sync (added v11) |

`config` JSON shape (example):
```json
{
  "teams": { "channels": ["https://teams.microsoft.com/l/channel/..."] },
  "jira":  { "projects": ["BDS"], "baseUrl": "https://jira.example.com" }
}
```

---

### `messages`

Cached messages from all connectors. Single table for all sources — `source` column distinguishes them.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `topic_id` | INTEGER NOT NULL FK → topics | CASCADE delete |
| `source` | TEXT NOT NULL | `"teams"`, `"email"`, `"jira"` |
| `content` | TEXT NOT NULL | Body text (HTML stripped) |
| `author` | TEXT NOT NULL | Sender name |
| `timestamp` | TEXT NOT NULL | ISO datetime from source |
| `metadata` | TEXT nullable | JSON — source-specific extras |
| `source_id` | TEXT nullable | Stable dedup key in source system (v2+) |
| `subject` | TEXT nullable | Subject / chat name (v2+) |
| `raw_data` | TEXT nullable | Full raw JSON from source (v2+) |

**Dedup constraint** (v2): `UNIQUE(source, source_id) WHERE source_id IS NOT NULL` — `INSERT OR IGNORE` prevents duplicates across syncs.

**Teams `source_id`**: `sha256(chatName|sender|timestamp|contentPrefix).slice(0,16)`.

**Indexes**: `(topic_id, timestamp)`, `(source)`, `(author)`, `(source, source_id)`.

---

### `action_items`

AI-detected tasks extracted from messages via `AIAnalyzer.detectActionItems()`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `topic_id` | INTEGER NOT NULL FK → topics | CASCADE delete |
| `title` | TEXT NOT NULL | Short task description |
| `description` | TEXT nullable | Optional detail |
| `assignee` | TEXT nullable | Person assigned |
| `status` | TEXT NOT NULL DEFAULT `'pending'` | `"pending"`, `"in_progress"`, `"completed"` |
| `due_date` | TEXT nullable | ISO date |
| `source_message_id` | INTEGER FK → messages | SET NULL on delete |
| `content_hash` | TEXT nullable | `sha256(topic_id|title)` for dedup (v4+) |

**Indexes**: `(topic_id, status)`, `(assignee)`, `(due_date)`, `(content_hash)` unique where not null.

---

### `meetings`

Meeting records extracted from Teams Recap tabs via `TeamsMeetingsScraper`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `topic_id` | INTEGER nullable FK → topics | CASCADE delete; NULL = not assigned to a topic |
| `title` | TEXT NOT NULL | Meeting title |
| `date` | TEXT NOT NULL | ISO datetime |
| `attendees` | TEXT nullable | JSON array of names |
| `notes` | TEXT nullable | Manual notes |
| `decisions` | TEXT nullable | JSON array of decisions (v3+) |
| `transcript` | TEXT nullable | Full transcript text (v3+) |
| `topics` | TEXT nullable | JSON array of topic strings (v3+) |
| `summary` | TEXT nullable | Claude Haiku-generated summary (v3+) |
| `chat_name` | TEXT nullable | Source Teams chat name (v3+) |
| `source_id` | TEXT nullable | `chatName\|datetime` dedup key (v3+) |

**Dedup constraint**: `UNIQUE(source_id) WHERE source_id IS NOT NULL`.

**Indexes**: `(topic_id, date)`, `(chat_name)`, `(source_id)`.

---

### `decisions`

Significant decisions extracted by the AI analyzer from messages and meetings.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `topic_id` | INTEGER NOT NULL FK → topics | CASCADE delete |
| `meeting_id` | INTEGER nullable FK → meetings | SET NULL on delete |
| `decision` | TEXT NOT NULL | The decision text |
| `context` | TEXT nullable | Surrounding context |
| `date` | TEXT NOT NULL | `datetime('now')` default |

**Indexes**: `(topic_id, date)`, `(meeting_id)`.

---

### `questions`

Open questions per topic tracked by the AI.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `topic_id` | INTEGER NOT NULL FK → topics | CASCADE delete |
| `question` | TEXT NOT NULL | Question text |
| `status` | TEXT NOT NULL DEFAULT `'open'` | `"open"`, `"answered"` |
| `answer` | TEXT nullable | Answer when resolved |
| `asked_date` | TEXT NOT NULL | `datetime('now')` default |
| `answered_date` | TEXT nullable | ISO datetime when answered |

**Index**: `(topic_id, status)`.

---

### `sync_state`

Tracks last-sync timestamp per `(topic_id, source)` pair so each sync only fetches new data.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `topic_id` | TEXT NOT NULL | Topic ID (stored as TEXT, no FK constraint) |
| `source` | TEXT NOT NULL | `"teams"`, `"email"`, `"jira"` |
| `last_synced_at` | TEXT nullable | ISO datetime of last successful sync |
| `last_message_count` | INTEGER DEFAULT 0 | Messages fetched in last sync |

**Unique constraint**: `(topic_id, source)`.

---

## Intelligence Tables

### `digests`

Persistent AI digest cache. Prevents regenerating the same digest twice on the same day.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `topic_name` | TEXT NOT NULL | Topic name (e.g. `"BDS"`, `"__morning_brief__"`) |
| `date` | TEXT NOT NULL | ISO date or shortcut key |
| `markdown` | TEXT NOT NULL | Full generated digest |
| `generated_at` | TEXT NOT NULL | `datetime('now')` default |
| `expires_at` | TEXT NOT NULL | When cache expires |

**Unique constraint**: `(topic_name, date)` — `INSERT OR REPLACE` for updates.

**Special key**: `topic_name = "__morning_brief__"` stores the morning brief, cached 1h.

---

### `topic_notebooks`

Living LLM memory per topic (EP-26). Claude maintains a structured 7-section notebook that is updated incrementally on each sync rather than regenerated from scratch.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `topic_name` | TEXT NOT NULL UNIQUE | Topic name (matches `topics.name`) |
| `content` | TEXT NOT NULL | Full notebook markdown — Claude's memory |
| `last_message_id` | INTEGER nullable | Highest `messages.id` seen at last update |
| `last_updated` | TEXT NOT NULL | `datetime('now')` default |
| `message_count` | INTEGER NOT NULL DEFAULT 0 | Total messages processed |
| `created_at` | TEXT NOT NULL | `datetime('now')` default |

**Index**: `(topic_name)`.

**Update pattern**: `getOrBuildNotebook()` calls `buildNotebook()` on first access, then `updateNotebook()` for incremental updates passing messages with `id > last_message_id`.

---

### `notebook_chat_history`

Persistent Q&A per topic from the Topic Expert chat panel.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `topic_name` | TEXT NOT NULL | Topic name |
| `question` | TEXT NOT NULL | User's question |
| `answer` | TEXT NOT NULL | Claude's answer |
| `asked_at` | TEXT NOT NULL | `datetime('now')` default |

**Index**: `(topic_name, asked_at DESC)`.

---

### `topic_suggestions`

Auto-discovered topic candidates from FTS frequency analysis. Shown in the Topics page "Suggestions" section.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `keyword` | TEXT NOT NULL UNIQUE | Candidate topic keyword |
| `message_count` | INTEGER NOT NULL | How many messages contain this keyword |
| `author_count` | INTEGER NOT NULL | How many distinct authors mention it |
| `sample_msgs` | TEXT nullable | JSON array of sample message snippets |
| `suggested_at` | TEXT NOT NULL | `datetime('now')` default |
| `dismissed` | INTEGER NOT NULL DEFAULT 0 | `1` = user dismissed |

**Index**: `(dismissed, suggested_at DESC)`.

---

### `jira_analysis`

Per-ticket deep analysis cache (EP-29). Analysis is triggered async (202 response), runs 3 parallel AI calls in background, stored here for polling.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `issue_key` | TEXT NOT NULL UNIQUE | Jira issue key (e.g. `"PROJ-1234"`) |
| `analysis` | TEXT nullable | Technical analysis markdown |
| `effort` | TEXT nullable | Effort estimate markdown |
| `explanation` | TEXT nullable | Plain-language explanation markdown |
| `status` | TEXT NOT NULL DEFAULT `'pending'` | `"pending"`, `"done"` |
| `analyzed_at` | TEXT NOT NULL | `datetime('now')` default |

---

## Operational Tables

### `group_chats`

Tracks Teams group chat activity state. Used by `markInactiveChats()` to determine which chats to scrape.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `name` | TEXT NOT NULL UNIQUE | Chat display name |
| `last_message_at` | TEXT nullable | ISO datetime of most recent message |
| `is_active` | INTEGER NOT NULL DEFAULT 1 | `1` = active (last message within 7 days), `0` = inactive |
| `last_scraped_at` | TEXT nullable | ISO datetime of last sync attempt |
| `inactive_since` | TEXT nullable | ISO datetime when chat went inactive |
| `message_count` | INTEGER NOT NULL DEFAULT 0 | Total messages stored for this chat |

**Index**: `(is_active, last_message_at)`.

**Active threshold**: `INACTIVE_THRESHOLD_DAYS = 7`. `markInactiveChats()` runs at end of every teams-sync run.

---

### `calendar_events`

Outlook calendar events synced by the browser connector (EP-25).

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `source_id` | TEXT NOT NULL UNIQUE | Stable ID from Outlook |
| `title` | TEXT NOT NULL | Event title |
| `start_time` | TEXT NOT NULL | ISO datetime |
| `end_time` | TEXT nullable | ISO datetime |
| `location` | TEXT nullable | Location string |
| `organizer` | TEXT nullable | Organizer name |
| `attendees` | TEXT NOT NULL DEFAULT `'[]'` | JSON array of names |
| `body` | TEXT nullable | Event description |
| `is_all_day` | INTEGER NOT NULL DEFAULT 0 | Boolean flag |
| `response_status` | TEXT nullable | `"accepted"`, `"tentative"`, `"declined"` |
| `scraped_at` | TEXT NOT NULL | `datetime('now')` default |
| `pre_brief` | TEXT nullable | AI-generated pre-meeting brief (v14+, EP-15) |

**Indexes**: `(start_time)`, `(source_id)`.

---

### `jira_issue_cache`

Persists Saturn board and My Issues data across server restarts (EP-20/21). Prevents blank sections after restart.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `list_name` | TEXT NOT NULL | `"saturn"` or `"my_issues"` |
| `key` | TEXT NOT NULL | Jira issue key (e.g. `"PROJ-1234"`) |
| `title` | TEXT NOT NULL | Issue summary |
| `status` | TEXT NOT NULL DEFAULT `'Unknown'` | Jira status |
| `assignee` | TEXT nullable | Assignee name |
| `priority` | TEXT nullable | `"High"`, `"Medium"`, `"Low"` |
| `updated_at` | TEXT NOT NULL | Last update in Jira |
| `url` | TEXT NOT NULL | Full Jira URL |
| `scraped_at` | TEXT NOT NULL | `datetime('now')` default |
| `epic_key` | TEXT nullable | Epic issue key (v13+) |
| `epic_name` | TEXT nullable | Epic display name (v13+) |

**Unique constraint**: `(list_name, key)`.

**Index**: `(list_name, scraped_at DESC)`.

---

### `error_logs`

Application error tracking (EP-18). Populated by `persistError()` in `web-server.js` on any caught exception.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `occurred_at` | TEXT NOT NULL | `datetime('now')` default |
| `source` | TEXT NOT NULL | Component that threw (e.g. `"jira-sync"`, `"teams-scraper"`) |
| `message` | TEXT NOT NULL | Error message |
| `stack` | TEXT nullable | Stack trace |
| `request_path` | TEXT nullable | HTTP path if from web request |
| `severity` | TEXT NOT NULL DEFAULT `'error'` | `"error"`, `"warn"`, `"info"` |
| `category` | TEXT nullable | `"sync"`, `"auth"`, `"browser"`, etc. |
| `suggested_fix` | TEXT nullable | AI-generated fix suggestion |
| `resolved` | INTEGER NOT NULL DEFAULT 0 | `1` = resolved |
| `jira_ticket_key` | TEXT nullable | Linked Jira ticket if created |

**Indexes**: `(occurred_at DESC)`, `(resolved, occurred_at DESC)`.

---

### `teams_fav_keywords`

Favourite search keyword chips in the Teams Updates page (EP-30). Clicking a chip pre-fills the search input.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `keyword` | TEXT NOT NULL UNIQUE | The keyword |
| `added_at` | TEXT NOT NULL | `datetime('now')` default |

---

### `schema_metadata`

Internal — tracks schema version and any future metadata.

| Column | Type | Notes |
|--------|------|-------|
| `key` | TEXT PK | e.g. `"schema_version"` |
| `value` | TEXT NOT NULL | e.g. `"16"` |

---

## Self-Healing Bug Capture (v53 + v54 + v55 + v56)

Five tables shipped together in v53 for [ADR-030 Phase A](../adr/adr-030-self-healing-bug-loop.md). Only `bugs` and `bug_occurrences` are populated in Phase A; the other three are skeletons for Phase B/D so the schema bump is atomic.

**v54 (Phase B / 2026-05-31):** Two tiny additive changes — a new column on `bugs` and one new row in `model_config`:

```sql
ALTER TABLE bugs ADD COLUMN last_investigation_id INTEGER
  REFERENCES bug_investigations(id);
CREATE INDEX IF NOT EXISTS idx_bugs_last_investigation
  ON bugs(last_investigation_id);

INSERT OR IGNORE INTO model_config (bucket, model, effort, thinking_mode)
  VALUES ('bug-investigator', 'claude-opus-4-8', 'max', 'adaptive');
```

`bugs.last_investigation_id` lets `/api/bugs/:id` find the latest investigation in O(1) instead of scanning `bug_investigations`. Updated atomically when the BugInvestigatorAgent writes a new investigation. Cleared back to `NULL` by `POST /api/bugs/:id/reinvestigate`. The `bug-investigator` `model_config` row mirrors the `decide` bucket — see [ADR-031](../adr/adr-031-per-bucket-model-effort-config.md) for the defaults table.

> **Slot history.** PLAN.md drafted Phase A as v52. Tier 2 model_config landed in v52 first while Phase 74 was paused; bug-capture renumbered to v53. Phase B's column and bucket-row addition is v54. `src/db/migrations/v52_model_config.ts` header documents and predicts the renumbering.

**v55 (Phase 75.5 / 2026-05-31):** Three additive columns on `bugs` for the manual severity override (escalation UX). The override is the user's "this matters" signal — preserved across recomputes, cleared only when the user explicitly removes it via the new `POST /api/bugs/:id/severity` endpoint.

```sql
ALTER TABLE bugs ADD COLUMN severity_override TEXT
  CHECK (severity_override IS NULL OR severity_override IN ('low','medium','high'));
ALTER TABLE bugs ADD COLUMN severity_override_reason TEXT;
ALTER TABLE bugs ADD COLUMN severity_override_at TEXT;
```

When `severity_override` is non-null, `computeSeverity()` returns it instead of running the ring-buffer queries. The legacy `bugs.severity` column is kept in sync via COALESCE on every override write, so list / filter / system-health rollups continue to work without code change.

Why a separate column? The scope fence in `src/routes/bugs.ts` is explicit: severity must NEVER be derived from `occurrence_count + last_seen_at`. Storing manual overrides in their own column preserves that invariant — `severity` remains a measurement, `severity_override` is the manual signal layered on top.

**v56 (Phase 76 / 2026-06-01):** Three changes shipped together for [ADR-030 Phase C](../adr/adr-030-self-healing-bug-loop.md) — the BugResolverAgent.

```sql
-- 1. Widen bugs.status CHECK enum with three resolver-flow values via SQLite
--    create-new-copy-drop-rename pattern (SQLite doesn't support ALTER CHECK).
--    All four FK-holding tables (bug_occurrences, bug_investigations,
--    auto_merge_blocklist, auto_merge_audit) are stashed and rebuilt against
--    the new bugs table so FK target identity is preserved.
status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
  'new','investigating','proposed','auto-merged','resolved','wont-fix',
  'auto-resolved','resolving','unable-to-resolve'                     -- new in v56
));

-- 2. New audit table — one row per resolver attempt regardless of outcome.
CREATE TABLE bug_resolutions (
  id INTEGER PRIMARY KEY,
  bug_id INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  attempt_at TEXT NOT NULL,                                    -- ISO-8601
  outcome TEXT NOT NULL CHECK (outcome IN ('auto-resolved','unable-to-resolve')),
  cwd TEXT NOT NULL,                                           -- WI repo root in Phase 76
  files_changed TEXT,                                          -- JSON array of file paths
  commit_sha TEXT,                                             -- NULL when outcome='unable-to-resolve'
  failure_reason TEXT,                                         -- non-null when outcome='unable-to-resolve'
  brain_decision_id INTEGER REFERENCES brain_decisions(id)     -- NULL in Phase 76
);
CREATE INDEX idx_bug_resolutions_bug_attempt ON bug_resolutions(bug_id, attempt_at DESC);

-- 3. Eighth model_config row — reserved for Phase 77 brain-escalation.
INSERT OR IGNORE INTO model_config (bucket, model, effort, thinking_mode)
  VALUES ('bug-resolver', 'claude-opus-latest', 'max', 'off');
```

The three new statuses describe the resolver flow:
- `'resolving'` — set when `POST /api/bugs/:id/resolve-attempt` enqueues the agent. The agent picks up the row from this state.
- `'auto-resolved'` — terminal success: patch applied + typecheck clean + commit landed locally (never pushed).
- `'unable-to-resolve'` — terminal failure: any pre-flight or apply gate failed. Reason recorded in `bug_resolutions.failure_reason`.

The `top_fingerprints` query in `buildBugsHealthBlock` excludes both `'auto-resolved'` and `'unable-to-resolve'` alongside `'resolved'` / `'wont-fix'` so the rollup focuses on actionable work. New rollup counters: `resolving`, `auto_resolved_24h`, `unable_to_resolve`.

The `bug-resolver` `model_config` row is reserved — Phase 76's local-apply path doesn't call the brain. The bucket is seeded so the `/setup/models` admin UI surfaces it and the §16 smoke can count 8 buckets.

### `bugs` — captured exceptions

Source: `src/db/migrations/v53_bug_capture_tables.ts`. Indexed on `status`, `last_seen_at`, `source`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `fingerprint` | TEXT NOT NULL UNIQUE | 16-char sha256 prefix; UPSERT key |
| `source` | TEXT NOT NULL CHECK | `bridge` / `agent` / `web-ui` / `sync` / `bug-investigator` |
| `error_name` | TEXT NOT NULL | `Error.name` or synthetic label |
| `message` | TEXT NOT NULL | Raw message; normalization happens in fingerprint, not stored |
| `top_frame` | TEXT | First non-library, non-wrapper stack frame; null when only library frames |
| `first_seen_at` | TEXT NOT NULL | ISO-8601 |
| `last_seen_at` | TEXT NOT NULL | ISO-8601; updated on every UPSERT hit |
| `occurrence_count` | INTEGER NOT NULL DEFAULT 1 | Incremented atomically by the UPSERT statement |
| `status` | TEXT NOT NULL DEFAULT `'new'` CHECK | `new` / `investigating` / `proposed` / `auto-merged` / `resolved` / `wont-fix` |
| `severity` | TEXT NOT NULL DEFAULT `'low'` CHECK | `low` / `medium` / `high`; recomputed on every capture against `bug_occurrences` ring buffer |
| `context_json` | TEXT | Free-form context; `JSON.stringify(payload.context)` |
| `investigation_attempts` | INTEGER NOT NULL DEFAULT 0 | Phase B's anti-recursion cap (`< 3`) reads this |
| `last_investigation_id` | INTEGER REFERENCES bug_investigations(id) | **v54 / Phase B.** Points at the most recent `bug_investigations` row for this bug. `NULL` until first investigation runs; cleared by `POST /api/bugs/:id/reinvestigate`. |
| `severity_override` | TEXT CHECK (low/medium/high or NULL) | **v55 / Phase 75.5.** Manual escalation. When non-null, takes precedence over the ring-buffer-computed value in `computeSeverity()`. Cleared by `POST /api/bugs/:id/severity` with `{severity: null}`. |
| `severity_override_reason` | TEXT | **v55 / Phase 75.5.** Free-form note (≤2000 chars) explaining the escalation. Surfaced inline in BugDetailPanel. |
| `severity_override_at` | TEXT | **v55 / Phase 75.5.** ISO-8601 timestamp recording when the override was set. Cleared back to NULL on remove. |

**Why `bug-investigator` is in the source enum:** Phase B's polling SELECT uses `WHERE source != 'bug-investigator'` as a recursion guard. The CHECK accepts the value today (round-trip verified by smoke § 11d) so Phase B doesn't need a migration.

### `bug_occurrences` — ring buffer

Source: same migration. Indexed on `(bug_id, seen_at DESC)` for time-window queries.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `bug_id` | INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE | Cascades on bug delete |
| `seen_at` | TEXT NOT NULL | ISO-8601 |

Severity recomputation queries this:

```sql
-- agent crash-loop: ≥5 in 10min → high
SELECT COUNT(*) FROM bug_occurrences
 WHERE bug_id = ? AND seen_at > datetime('now','-10 minutes');

-- general high: ≥10 in 1h
SELECT COUNT(*) FROM bug_occurrences
 WHERE bug_id = ? AND seen_at > datetime('now','-1 hour');

-- general medium: ≥5 in 24h
SELECT COUNT(*) FROM bug_occurrences
 WHERE bug_id = ? AND seen_at > datetime('now','-1 day');
```

Three indexed `COUNT(*)`s; cheap enough that we don't bother caching.

### `bug_investigations` — Phase B target (live in v54)

Populated by `BugInvestigatorAgent` (Phase 75). One row per investigation; the most recent row for a given bug is reachable in O(1) via `bugs.last_investigation_id`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `bug_id` | INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE | |
| `root_cause` | TEXT NOT NULL | Brain-produced root-cause sentence |
| `files_to_change` | TEXT NOT NULL | JSON array of file paths |
| `lines_changed` | INTEGER NOT NULL DEFAULT 0 | Estimate; final count from the diff |
| `confidence` | REAL NOT NULL CHECK (0..1) | Brain's self-reported confidence |
| `suggested_patch` | TEXT | Unified diff; Phase C runs `git apply --check` on this |
| `decided_at` | TEXT NOT NULL | ISO-8601 |
| `brain_decision_id` | INTEGER REFERENCES brain_decisions(id) | Trace back to the brain call |

### `auto_merge_blocklist` — Phase D target (empty in Phase A)

| Column | Type | Notes |
|--------|------|-------|
| `fingerprint` | TEXT PK REFERENCES bugs(fingerprint) | A bug fingerprint that should NEVER auto-merge again |
| `reason` | TEXT NOT NULL | Free-form reason (e.g. "auto-merged then reverted within 24h") |
| `blocked_at` | TEXT NOT NULL | ISO-8601 |

Written by Phase D's revert reconciler when `git log --grep='^auto-fix:'` shows a revert of a previously auto-merged commit.

### `auto_merge_audit` — Phase D target (empty in Phase A)

Indexed on `merged_at DESC`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `bug_id` | INTEGER NOT NULL REFERENCES bugs(id) | |
| `fingerprint` | TEXT NOT NULL | Denormalized; survives even if bug row is deleted |
| `merged_at` | TEXT NOT NULL | ISO-8601 |
| `commit_sha` | TEXT | The auto-fix commit's SHA |
| `reverted_at` | TEXT | NULL until Phase D's reconciler sees a revert |

Persists across bridge restarts so the rate limiter (Review Finding #3) doesn't reset on every reboot.

---

## Per-Bucket Model Config (v52 + v54 + v56)

Source: `src/db/migrations/v52_model_config.ts`. One row per functional bucket. Six rows seeded in v52 with evidence-backed defaults from Anthropic's May 2026 docs; **v54 adds a seventh row, `bug-investigator`, for [ADR-030 Phase B](../adr/adr-030-self-healing-bug-loop.md)**; **v56 adds an eighth row, `bug-resolver`, for [ADR-030 Phase C](../adr/adr-030-self-healing-bug-loop.md) — reserved for Phase 77 brain-escalation, not used by Phase 76's local-apply path**.

### `model_config`

| Column | Type | Notes |
|--------|------|-------|
| `bucket` | TEXT PK | `fetch` / `digest` / `chat` / `analyse` / `decide` / `agents` / `bug-investigator` (v54) |
| `model` | TEXT NOT NULL | `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-8`, etc. |
| `effort` | TEXT NOT NULL | Anthropic effort enum: `low` / `medium` / `high` / `xhigh` / `max` |
| `thinking_mode` | TEXT NOT NULL | `off` / `adaptive`. Manual `{type:'enabled', budget_tokens:N}` is rejected by Opus 4.8 with a 400, so we never expose that path |
| `updated_at` | TEXT NOT NULL DEFAULT `datetime('now')` | |

Validation lives in `src/services/model-config.ts:MODEL_CAPS` (per-model effort whitelist) — not in the SQL CHECK constraint, because the valid combinations differ per model.

User-editable via:
- `GET /api/model-config` — returns 7 buckets + recommendations + per-model capability matrix
- `POST /api/model-config` — bulk-update one or more buckets in a single transaction

See [ADR-031](../adr/adr-031-per-bucket-model-effort-config.md) for the full rationale and the per-bucket evidence table.

---

## Full-Text Search (FTS5)

Two FTS5 virtual tables provide BM25-ranked full-text search. They are **content tables** — data is not stored in them directly, it is indexed from the underlying real tables via triggers.

### `messages_fts`

Indexes `messages(subject, content, author, source)`. Used by `search_messages`, `get_teams_updates`, `search_all`.

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, content, author, source,
  content='messages', content_rowid='id',
  tokenize='porter unicode61'
);
```

**Triggers**: `messages_ai` (INSERT), `messages_ad` (DELETE), `messages_au` (UPDATE) keep the index in sync.

**Porter stemmer**: `porter` tokenizer means searching `"running"` also matches `"ran"`, `"runs"`.

### `meetings_fts`

Indexes `meetings(title, transcript, summary, topics, chat_name)`.

```sql
CREATE VIRTUAL TABLE meetings_fts USING fts5(
  title, transcript, summary, topics, chat_name,
  content='meetings', content_rowid='id',
  tokenize='porter unicode61'
);
```

**Triggers**: `meetings_ai`, `meetings_ad`, `meetings_au`.

### FTS Search Pattern

```sql
-- BM25 ranked search
SELECT m.author, m.subject, m.content, m.timestamp
FROM messages_fts
JOIN messages m ON messages_fts.rowid = m.id
WHERE messages_fts MATCH '"exact phrase"'
ORDER BY bm25(messages_fts)
LIMIT 20;

-- LIKE fallback when FTS returns 0 results
SELECT * FROM messages
WHERE content LIKE '%keyword%' OR subject LIKE '%keyword%'
LIMIT 20;

-- Rebuild FTS index if it gets out of sync
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
INSERT INTO meetings_fts(meetings_fts) VALUES('rebuild');
```

---

## Key Patterns

### Message Deduplication

```sql
-- Insert-or-ignore on (source, source_id) — safe to call on every sync
INSERT OR IGNORE INTO messages (topic_id, source, source_id, content, author, timestamp)
VALUES (?, ?, ?, ?, ?, ?);
```

### Topic FK Guard

Before inserting any message or meeting, ensure the default topic exists:
```sql
-- Always insert-or-ignore the 'teams' default topic first
INSERT OR IGNORE INTO topics (name) VALUES ('teams');
-- Then use its id — never hardcode topic_id = 0
```

### Notebook Update Pattern

```typescript
// getOrBuildNotebook() in src/tools/notebook.ts
const existing = getNotebook(db, topicName);
if (!existing) {
  const content = await analyzer.buildNotebook(topicName, allMessages, allMeetings);
  saveNotebook(db, topicName, content, maxMessageId, messageCount);
} else {
  const newMessages = getMessagesAfter(db, topicName, existing.last_message_id);
  if (newMessages.length > 0) {
    const content = await analyzer.updateNotebook(topicName, existing.content, newMessages, newMeetings);
    saveNotebook(db, topicName, content, newMaxId, newCount);
  }
  // else: return cached content as-is
}
```

### Digest Cache Pattern

```sql
-- Cache lookup
SELECT markdown FROM digests WHERE topic_name = ? AND date = ? AND expires_at > datetime('now');

-- Cache write
INSERT OR REPLACE INTO digests (topic_name, date, markdown, generated_at, expires_at)
VALUES (?, ?, ?, datetime('now'), datetime('now', '+1 hour'));
```

---

## Sample Queries

### All active Teams chats with message counts
```sql
SELECT name, message_count, last_message_at
FROM group_chats
WHERE is_active = 1
ORDER BY last_message_at DESC;
```

### Today's calendar events with pre-briefs
```sql
SELECT title, start_time, attendees, pre_brief
FROM calendar_events
WHERE date(start_time) = date('now')
ORDER BY start_time;
```

### Pending Jira analyses (for polling)
```sql
SELECT issue_key FROM jira_analysis WHERE status = 'pending';
```

### Search messages by keyword (FTS5 + LIKE fallback)
```sql
-- FTS first
SELECT m.author, m.subject, m.content, m.timestamp
FROM messages_fts
JOIN messages m ON messages_fts.rowid = m.id
WHERE messages_fts MATCH ?
ORDER BY bm25(messages_fts) LIMIT 20;

-- LIKE fallback if above returns nothing
SELECT author, subject, content, timestamp FROM messages
WHERE content LIKE '%' || ? || '%' OR subject LIKE '%' || ? || '%'
ORDER BY timestamp DESC LIMIT 20;
```

### Stale action items (open for > 3 days)
```sql
SELECT ai.title, ai.assignee, ROUND(JULIANDAY('now') - JULIANDAY(ai.due_date)) AS days_overdue
FROM action_items ai
WHERE ai.status != 'completed'
  AND ai.due_date IS NOT NULL
  AND JULIANDAY('now') > JULIANDAY(ai.due_date)
ORDER BY days_overdue DESC;
```

---

## Maintenance

```bash
# Backup live database
sqlite3 ./data/intelligence.db ".backup backup-$(date +%Y%m%d).db"

# Restore (stop web-server.js first)
cp ~/backups/intelligence-20260415.db ./data/intelligence.db
```

```sql
-- Rebuild FTS indexes (if triggers got out of sync)
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
INSERT INTO meetings_fts(meetings_fts) VALUES('rebuild');

-- WAL checkpoint (flush WAL → main DB file)
PRAGMA wal_checkpoint(FULL);

-- Integrity check
PRAGMA integrity_check;

-- Reclaim space after bulk deletes
VACUUM;
```
