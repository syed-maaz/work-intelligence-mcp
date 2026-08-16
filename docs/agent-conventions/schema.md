---
paths:
  - "src/db/schema.ts"
  - "src/db/queries.ts"
---

## Current schema version
**Read `CURRENT_SCHEMA_VERSION` directly from `src/db/schema.ts`** — do not pin a number here. This rule's job is enforcing patterns (column names, INSERT OR IGNORE, ON CONFLICT upserts, FTS5 trigger sync), not version constants. Pinning a number caused doc-drift (v26 here, v46 in CLAUDE.md, v50 in code) — fixed 2026-05-30.

## Migration pattern
Each migration is a zero-indexed array entry in `src/db/schema.ts`. Always: create table/column → bump version → never modify existing migrations. Recent additions: v45 brain_decisions/clusters/verifications → v46 budget bucket → v47 brain evidence format → v48 message_embeddings model relabel → v49 code_graph CHECK enum widening (Dockerfile/Helm/shell ref_types) → v50 reminders table.

## messages table columns
`id, topic_id, source, content, author, timestamp, metadata, source_id, subject, raw_data`
**Use `author` — NOT `sender`.** SQL against `messages` must join on `author` for teammate identity resolution.

## FK guard pattern — never hardcode topic_id
Before any `upsertMessage()` / `upsertMeeting()`, insert the default topic with `INSERT OR IGNORE INTO topics` first, then use the returned id. Never hardcode `topic_id = 0`.

## saveDigest / upsert pattern
Use `INSERT ... ON CONFLICT(unique_col) DO UPDATE SET ...` for upserts. See `saveDigest()` in queries.ts as the canonical example.

## FTS5 sync
`messages_fts` and `meetings_fts` are kept in sync by AFTER INSERT/UPDATE/DELETE triggers — do not manually insert into FTS tables.
