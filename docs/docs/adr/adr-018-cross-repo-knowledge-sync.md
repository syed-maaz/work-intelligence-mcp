---
sidebar_label: "ADR-018: Cross-Repo Knowledge Sync"
sidebar_position: 18
---

# ADR-018: Cross-Repo Knowledge Sync

**Status**: Implemented (Schema v41, Post-Sprint 17 — 2026-05-04, verified 2026-05-06)  
**Date**: 2026-05-04  
**Drivers**: Need visibility into example-service/operations code changes from within the intelligence system  

---

## Implementation Status

| Component | Location | Status | Notes |
|-----------|----------|--------|-------|
| `knowledge_events` table (schema v41) | `src/db/schema.ts` | ✅ Done | Table + indexes auto-migrate on DB open |
| `POST /api/knowledge/ingest` endpoint | `web-server.js:4408` | ✅ Done | Accepts `{repo, file, event, timestamp}`, writes to SQLite |
| `GET /api/knowledge/events` endpoint | `web-server.js:4433` | ✅ Done | Query by repo + limit, returns recent events |
| MemPalace KG enrichment on ingest | `web-server.js:4425-4427` | ✅ Done | `palaceClient.kgAdd(repo, 'file-edited', file, ts)` — fire-and-forget with `.catch(() => {})` |
| Hook script (`knowledge-ingest.sh`) | `~/.claude/hooks/knowledge-ingest.sh` | ✅ Done | Fires curl POST for example-service/operations file paths in background |
| Hook registration in settings.json | `~/.claude/settings.json` → PostToolUse | ✅ Done | Registered as `Edit\|Write` matcher, 5s timeout |
| example-service CLAUDE.md instructions | `~/Desktop/projects/acme/example-service/CLAUDE.md` | ✅ Done | Cross-Repo Knowledge Sync section added (2026-05-06) |

### What was built

**Schema v41** — `knowledge_events` table:
```sql
CREATE TABLE knowledge_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  file_path TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'edit',
  timestamp TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX idx_knowledge_events_repo ON knowledge_events(repo);
CREATE INDEX idx_knowledge_events_timestamp ON knowledge_events(timestamp DESC);
```

**`POST /api/knowledge/ingest`** (`web-server.js:4408`):
- Validates via Zod: `{repo: string, file: string, event?: string, timestamp?: string}`
- Inserts to `knowledge_events` table
- If `palaceClient` is connected, fires `palaceClient.kgAdd(repo, 'file-edited', file, ts)` (fire-and-forget, error swallowed)
- Returns `201 {ok: true, repo, file, event, timestamp}`

**`GET /api/knowledge/events`** (`web-server.js:4433`):
- Query params: `repo` (optional filter), `limit` (default 50, max 200)
- Returns `{events: [...], total: number}` ordered by timestamp DESC

**Hook script** (`~/.claude/hooks/knowledge-ingest.sh`):
- Reads `TOOL_INPUT_FILE_PATH` or `TOOL_INPUT_file_path` from environment
- Pattern matches against `*/acme/example-service/*`, `*/repos/example-service/*`, `*/acme/operations/*`, `*/repos/operations/*`
- Fires background `curl -sf POST` to `http://localhost:3132/api/knowledge/ingest` with 5s timeout
- Non-blocking: uses `&` and `>/dev/null 2>&1`, always exits 0

**Hook registration** (`~/.claude/settings.json`):
```json
{
  "matcher": "Edit|Write",
  "hooks": [{
    "type": "command",
    "timeout": 5
  }]
}
```
Registered in the `PostToolUse` array — fires on every Edit/Write operation across all Claude Code sessions.

**example-service CLAUDE.md** — added a "Cross-Repo Knowledge Sync" section explaining:
- Events are auto-captured via PostToolUse hook
- Bridge must be running on port 3132 for capture
- Events during downtime are silently lost (non-blocking)
- What gets captured: repo, file path, event type, timestamp

### Deviations from Original ADR

None — implementation matches the ADR specification exactly:
1. PostToolUse hook inspects file paths ✓
2. Background curl POST to bridge ✓
3. Bridge writes to `knowledge_events` + enriches MemPalace KG ✓
4. Fire-and-forget palace writes (never fails due to palace being down) ✓

### Future Extensions

- **SessionEnd hook**: Post session summary to bridge when closing example-service/operations sessions — captures intent/outcome alongside granular file edits
- **Git remote in repos/example-service**: Point to `~/Desktop/projects/acme/example-service` for branch-targeted code analysis without full rsync
- **Knowledge events UI**: Dashboard widget showing recent cross-repo activity (timeline, heatmap)
- **Correlation**: CorrelationAgent can query `knowledge_events` to link file edits with Jira ticket transitions
- **Eviction policy**: TTL-based cleanup for old events (currently append-only, no pruning)

The Work Intelligence MCP system indexes Jira, Teams, email, and GitHub activity — but has no visibility into what Claude Code sessions are actually *doing* in connected repositories (example-service, operations). When an investigation reveals a root cause or a bug fix is applied, that knowledge dies with the session unless manually captured.

Sprint 17 completed the "Second Brain" architecture (MemPalace + CDC pipeline + autonomous agents), creating the infrastructure to receive and process external events. The missing piece: a bridge that captures edit events from other repos and feeds them into the knowledge graph.

---

## Decision

Implement a **PostToolUse hook + HTTP ingest endpoint** pattern:

1. A bash hook (`~/.claude/hooks/knowledge-ingest.sh`) fires on every `Edit|Write` tool use
2. The hook inspects the file path — if it matches `*/acme/example-service/*` or `*/repos/example-service/*` (and equivalent for operations), it POSTs to the bridge
3. `POST /api/knowledge/ingest` on port 3132 receives `{repo, file, event, timestamp}`, writes to `knowledge_events` table, and enriches MemPalace KG with a `(repo, 'file-edited', file)` triple
4. Palace writes are fire-and-forget — the endpoint never fails due to MemPalace being down

---

## Alternatives Considered

| Alternative | Why rejected |
|-------------|-------------|
| **File watcher (chokidar/fswatch)** | Requires a persistent process watching the repo directory. Too fragile — dies on sleep, needs restart logic, unclear what constitutes a "meaningful" change vs. git operations |
| **Git hooks (post-commit)** | Only fires on commits, missing the many edits that happen between commits. Also requires modifying the target repo's `.git/hooks/` |
| **Full rsync after every session** | Too heavy — example-service is 545MB. Already used for bulk refresh, but wrong tool for incremental event capture |
| **SessionEnd hook with session summary** | Captures intent but not granular file-level changes. Good complementary approach (planned for item 4) but not sufficient alone |
| **Claude-mem observations** | Already captures observations automatically, but they're tagged by project — not structured as file-level events queryable by repo/path |

---

## Consequences

### Positive

- Intelligence system gains real-time visibility into code changes across repos
- MemPalace KG accumulates temporal file-edit triples — enables queries like "what files in example-service were edited in the last week?"
- Zero impact on example-service/operations repo structure — all infrastructure lives in work-intelligence-mcp + global Claude settings
- Non-blocking — hook fires in background (`&`), 5s timeout, curl failures are silent
- Queryable via `GET /api/knowledge/events?repo=example-service` for debugging and future UI

### Negative

- Requires bridge to be running for events to be captured (events during bridge downtime are lost)
- Hook fires on every Edit/Write in matching paths — high-frequency edits generate many rows (mitigated: SQLite handles thousands of inserts/sec)
- File paths are absolute (machine-specific) — not portable, but this is a single-developer system

### Neutral

- Schema version bumped to v41 — automatic migration on next DB open
- `knowledge_events` table is append-only — no cleanup/eviction strategy yet (can add later via TTL like `proactive_queue`)

---

## Implementation

| Component | Location |
|-----------|----------|
| Hook script | `~/.claude/hooks/knowledge-ingest.sh` |
| Hook registration | `~/.claude/settings.json` → PostToolUse array (matcher: `Edit\|Write`, timeout: 5s) |
| Ingest endpoint | `web-server.js:4408` → `POST /api/knowledge/ingest` |
| Query endpoint | `web-server.js:4433` → `GET /api/knowledge/events` |
| MemPalace KG enrichment | `web-server.js:4425-4427` → `palaceClient.kgAdd(repo, 'file-edited', file, ts)` |
| Schema migration | `src/db/schema.ts` → v40→v41 (`knowledge_events` table + indexes) |
| example-service instructions | `~/Desktop/projects/acme/example-service/CLAUDE.md` → "Cross-Repo Knowledge Sync" section |

---

## Future Extensions

- **SessionEnd hook**: Post session summary to bridge when closing example-service/operations sessions — captures intent/outcome alongside granular file edits
- **Git remote in repos/example-service**: Point to `~/Desktop/projects/acme/example-service` for branch-targeted code analysis without full rsync
- **Knowledge events UI**: Dashboard widget showing recent cross-repo activity (timeline, heatmap)
- **Correlation**: CorrelationAgent can query `knowledge_events` to link file edits with Jira ticket transitions
- **Eviction policy**: TTL-based cleanup for old events (currently append-only, no pruning)
