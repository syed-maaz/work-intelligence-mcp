---
sidebar_position: 45
title: EP-45 Teammate Intelligence
---

# EP-45: Teammate Intelligence

| Field | Value |
|-------|-------|
| **Status** | ✅ Complete |
| **Priority** | High |
| **Complexity** | Medium (2–3 days) |
| **Blocked By** | EP-43 (code_graph for code ownership — tables present, data optional) |
| **Schema version** | v25 — adds `team_members`, `member_aliases`, `member_profiles` |
| **Completed** | 2026-04-19 |

## Summary

You mark your teammates explicitly. The system builds rich AI profiles for marked members — activity patterns, Jira workload, meeting attendance, code ownership. Unmarked people who appear in channels get only basic stats (message count, last active) — no AI analysis, no profiling.

This is **opt-in profiling**: you control who gets a full profile. The system never builds profiles without explicit marking.

## Privacy Model

```
marked member (marked = 1):
  → AI-generated profile built and refreshed on every sync
  → Full analytics: activity, Jira, meetings, code, communication style

unmarked person (marked = 0):
  → Stored only if they appear in synced channels
  → Basic stats only: message count, last active date
  → NO AI analysis, NO profile generation, NO cross-system correlation

Data sent to Claude:
  → ONLY data from marked members
  → Unmarked person data never leaves the local DB
  → notes field structurally excluded via TypeScript Omit<> — compiler-enforced
```

## Decisions Made

- **Explicit opt-in list** — you manage the list via the UI. No auto-discovery.
- **Marked = full profile** — all four dimensions: activity, Jira, meetings, code ownership.
- **Others = basic stats** — message count + last active. Anonymized in aggregate views.
- **Profile updated on every sync** — refreshed after `runFullSync()` via `Promise.allSettled` (same pattern as notebooks).
- **GitHub handle is the code ownership join key** — connects `team_members.github_handle` to `code_graph` commit data.
- **Notes field** — private field only you see. Never sent to AI. Structurally excluded from `MemberProfileInput` via `Omit<TeamMember, 'notes' | 'id' | 'added_at' | 'deleted_at'>`.
- **`messages.author` column** — Teams messages use `author` (not `sender`). All teammate SQL queries use `author` for joins.
- **Sonnet for profile generation** — `buildMemberProfile()` uses `DIGEST_MODEL` (Sonnet), not Haiku. Cross-source synthesis requires reasoning depth.
- **Haiku for expert reranking** — `rankReviewers()` uses `EXTRACTION_MODEL` (Haiku). Simple ranking, not synthesis.
- **Incremental rebuild guard** — skip AI call if no new messages or commits since `last_updated`. Reduces cost from ~$1.92/day to ~$0.04/day at 5 members.
- **Soft-delete only** — `DELETE /api/teammates/:id` sets `deleted_at`; hard delete not exposed.
- **`getTeamAverages()` per-member** — computes `AVG(cnt)` across a `GROUP BY tm.id` subquery so each member contributes one row, not a single total.

---

## EP-45-1: Schema Migration v25

**File**: `src/db/schema.ts` — migration at index 24 (v24→v25), `CURRENT_SCHEMA_VERSION` = 26 (v26 added by EP-46 for `mcp_oauth_tokens`).

```typescript
// v25 — EP-45: Teammate Intelligence
() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      github_handle TEXT,
      jira_username TEXT,
      teams_display_name TEXT,   -- matches messages.author (canonical form)
      marked INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT,           -- soft-delete; NULL = active
      notes TEXT                 -- private; never sent to AI
    );

    CREATE TABLE IF NOT EXISTS member_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
      alias TEXT NOT NULL UNIQUE, -- variant form found in messages (e.g. "Alice C.")
      source TEXT NOT NULL        -- 'teams' | 'jira' | 'github' | 'manual'
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
```

---

## EP-45-2: Data Aggregation (`src/db/queries/teammates.ts`)

New file: `src/db/queries/teammates.ts` — all teammate queries live here. Exported from `src/db/queries/index.ts`.

### Key functions

```typescript
// Member management
addTeamMember(db, member)       → number (new id)
markMember(db, id, marked)      → void
softDeleteMember(db, id)        → void   // sets deleted_at = datetime('now')
getTeamMember(db, id)           → TeamMember | null
getMarkedMembers(db)            → TeamMember[]
getAllMembers(db)                → MemberWithStats[]   // includes message_count, last_active

// Alias management
addMemberAlias(db, memberId, alias, source)   → void (INSERT OR IGNORE)
resolveMemberByAlias(db, rawName)             → TeamMember | null
getMemberAliases(db, memberId)                → MemberAlias[]

// Profile queries
getMemberProfile(db, memberId)                → MemberProfile | null
saveMemberProfile(db, memberId, profile)      → void (upsert)
countNewMessages(db, memberId, since)         → number
countNewCommits(db, memberId, since)          → number (via code_graph; 0 if not populated)

// Activity aggregation
getMemberActivity(db, memberId, days=30)      → MemberActivity
getTeamAverages(db)                           → TeamAverages
getExpertCandidates(db, repo, filePath)       → ExpertCandidate[]
```

### SQL patterns

All `messages` queries join via `author` (not `sender`):

```sql
-- getAllMembers: join messages by author or alias
LEFT JOIN messages m ON (
  m.author = tm.teams_display_name
  OR m.author IN (SELECT alias FROM member_aliases WHERE member_id = tm.id)
)

-- getMemberActivity: queries all name variants
WHERE author IN (
  SELECT alias FROM member_aliases WHERE member_id = ?
  UNION
  SELECT teams_display_name FROM team_members WHERE id = ?
)

-- getTeamAverages: per-member subquery (correct AVG)
SELECT AVG(cnt) as avg FROM (
  SELECT tm.id, COUNT(m.id) as cnt
  FROM team_members tm
  LEFT JOIN messages m ON (
    m.author = tm.teams_display_name
    OR m.author IN (SELECT alias FROM member_aliases WHERE member_id = tm.id)
  ) AND m.timestamp > ?
  WHERE tm.marked = 1 AND tm.deleted_at IS NULL
  GROUP BY tm.id
)
```

### Activity Score Formula

```
activity_score = 0.4 × MIN(1.0, messageCount / teamAvgMessages)
               + 0.3 × MIN(1.0, commits / teamAvgCommits)
               + 0.3 × MIN(1.0, jiraActivity / teamAvgJiraActivity)

where team_avg = mean across all marked members (score is relative, not absolute)
```

### `top_topics` weighted by BM25 relevance density

```sql
SELECT t.name,
       COUNT(*) as count,
       AVG(ABS(bm25(messages_fts))) as avg_relevance
FROM messages m
JOIN topics t ON m.topic_id = t.id
JOIN messages_fts mf ON mf.rowid = m.id
WHERE m.author IN (...)
GROUP BY t.name
ORDER BY count * avg_relevance DESC
LIMIT 5
```

Falls back to raw `COUNT(*)` if FTS5 unavailable.

### Member tenure guard

`getMemberActivity()` computes `effectiveDays = MIN(days, daysSinceFirstMessage)`. New members won't show falsely low activity.

---

## EP-45-3: Identity Resolver (`src/tools/identity-resolver.ts`)

Four-step fuzzy matcher:

1. **Exact match** (case-insensitive)
2. **Abbreviated name** — "Alice C." → "Alice Chen"
3. **Email prefix** — "alice.chen" → "Alice Chen" (first 3 chars of surname)
4. **Levenshtein ≤ 2** — encoding diffs, typos

```typescript
export function resolveTeamsName(input: string, candidates: string[]): string | null
export async function buildAliasesForMember(db, memberId): Promise<number>
```

`buildAliasesForMember()` scans `SELECT DISTINCT author FROM messages`, runs the resolver for each sender, inserts matches into `member_aliases`. Also adds the canonical `teams_display_name` as an alias. Returns count of new aliases inserted.

Called: on member add (background), on `PATCH mark` (before profile build).

---

## EP-45-4: AI Profile Builder (`src/tools/profile-builder.ts`)

```typescript
export async function buildOrUpdateMemberProfile(
  db: Database,
  memberId: number,
  analyzer: AIAnalyzer,
  _repos: RepoConfig[] = [],
): Promise<void>
```

**Incremental rebuild guard**: skips if `countNewMessages === 0 && countNewCommits === 0` since `last_updated`.

**Privacy enforcement** (compile-time):
```typescript
type SafeMemberInput = {
  name: string;
  email: string | null;
  github_handle: string | null;
  jira_username: string | null;
  teams_display_name: string | null;
};
// notes, id, added_at, deleted_at never reach MemberProfileInput
```

**Data gathered**:
- `getMemberActivity(db, memberId, 30)` — messages, top topics (BM25), last active, recent message samples
- `jira_issues WHERE assignee = jira_username` — open tickets, overdue tickets (with daysPast)
- `meetings WHERE attendees LIKE %name%` — recent meetings (last 30d)
- `action_items WHERE assignee = name AND status = 'pending'` — pending items
- `code_graph WHERE symbol = github_handle AND ref_type = 'commit'` — top 10 files by commit count
- `getTeamAverages(db)` — for activity score normalization

---

## EP-45-5: AI Analyzer Methods (`src/services/analyzer.ts`)

### `buildMemberProfile()` — model: DIGEST_MODEL (Sonnet)

Tool schema `build_member_profile` returns structured output:

```typescript
export interface MemberProfileOutput {
  summary: string;                  // one-sentence, max 200 chars
  activityLevel: 'high' | 'medium' | 'low' | 'new' | 'unknown';
  activityScore: number;            // 0.0–1.0 per weighted formula
  workloadSignal: 'available' | 'busy' | 'overloaded' | 'unknown';
  domains: string[];                // top 5 domain areas
  currentFocus: string;             // max 300 chars
  overdueSummary: string | null;
  codeOwnership: string[];          // top 5 owned file paths
  collaborators: string[];          // frequent co-authors
  profileMarkdown: string;          // full human-readable markdown
}
```

### `rankReviewers()` — model: EXTRACTION_MODEL (Haiku)

```typescript
async rankReviewers(
  file: string,
  candidates: Array<{ member: { name: string; github_handle: string | null }; commitCount: number; workloadSignal: string }>,
  prContext?: string,
): Promise<{ bestIndex: number; reasoning: string }>
// returns 0-based index into candidates array
```

Tool schema `rank_reviewer` — picks best reviewer weighting expertise vs workload. Haiku is sufficient for this ranking task (no cross-source synthesis needed).

---

## EP-45-6: API Endpoints (`web-server.js`)

All 7 endpoints implemented:

| Method | Path | Response | Notes |
|--------|------|----------|-------|
| `GET` | `/api/teammates` | `TeamMember[]` | `notes` field stripped; profile embedded for marked members |
| `POST` | `/api/teammates` | `{ id: number }` (201) | Zod-validated; `buildAliasesForMember` fires in background |
| `PATCH` | `/api/teammates/:id/mark` | `{ ok: true }` | Triggers `buildAliasesForMember + buildOrUpdateMemberProfile` in background when marking |
| `GET` | `/api/teammates/:id/profile` | `MemberFullProfile` | 404 if not marked or profile not yet built |
| `DELETE` | `/api/teammates/:id` | `{ ok: true }` | Soft-delete (sets `deleted_at`) |
| `GET` | `/api/teammates/expert?repo=&file=` | `{ member, reasoning }` | Haiku rerank if >1 candidate; `member: null` if no code_graph data |
| `POST` | `/api/teammates/sync` | `{ ok: true, count: N }` (202) | Background `Promise.allSettled` for all marked members |

`runFullSync()` step 10: rebuilds profiles for all marked members after each sync cycle.

---

## EP-45-7: TeammatesPage UI (`web/src/pages/TeammatesPage.tsx`)

Route: `/teammates` — registered in `App.tsx`, added to `Sidebar.tsx` NAV with `Users` icon.

**Components**:
- `AddMemberModal` — modal form: name (required), email, GitHub handle, Jira username, Teams display name
- `ProfilePanel` — right slide-out panel (fixed inset-y-0 right-0, max-w-sm): workload badge, activity level badge, activity score, summary, domains chips, Jira open/overdue counts, top topics, code ownership, full AI profile markdown, last_updated date
- Main page: header (member count, Sync button, Add Member button), Marked Members section, Other Members section, empty state

**Mutations**: `markTeammate` (PATCH), `deleteTeammate` (DELETE), `addTeammate` (POST), `teammatesSync` (POST) — all via React Query `useMutation` with `toast.success/error` feedback and `queryClient.invalidateQueries`.

**API types** (`web/src/lib/api.ts`):
```typescript
interface MemberProfileSummary {
  summary: string | null;
  activity_level: 'high' | 'medium' | 'low' | 'new' | 'unknown' | null;
  activity_score: number | null;
  workload_signal: 'available' | 'busy' | 'overloaded' | 'unknown' | null;
  domains: string[];
  jira_open_count: number;
  jira_overdue_count: number;
  top_topics: Array<{ name: string; count: number; relevanceWeight: number }>;
  last_updated: string;
}
interface TeamMember {
  id: number; name: string; email: string | null;
  github_handle: string | null; jira_username: string | null;
  teams_display_name: string | null; marked: number;
  added_at: string; message_count: number; last_active: string | null;
  profile: MemberProfileSummary | null;
}
interface MemberFullProfile {
  member: Omit<TeamMember, 'profile'>;
  profile: MemberProfileSummary & { profile_content: string; code_files_owned: string[] };
}
```

---

## Key Code Locations

| File | What's there |
|------|-------------|
| `src/db/schema.ts` | v25 migration (index 24), `CURRENT_SCHEMA_VERSION = 26` |
| `src/db/queries/teammates.ts` | All member/alias/profile/activity queries — uses `author` column |
| `src/db/queries/index.ts` | Re-exports all teammates.ts exports |
| `src/tools/identity-resolver.ts` | `resolveTeamsName()` + `buildAliasesForMember()` |
| `src/tools/profile-builder.ts` | `buildOrUpdateMemberProfile()` — incremental guard + privacy enforcement |
| `src/services/analyzer.ts` | `buildMemberProfile()` (Sonnet) + `rankReviewers()` (Haiku); interfaces at EOF |
| `web-server.js` | 7 teammate endpoints (lines ~2634–2760); step 10 in `runFullSync()` |
| `web/src/pages/TeammatesPage.tsx` | Full page: AddMemberModal + ProfilePanel + list |
| `web/src/lib/api.ts` | Types + `requestPatch<T>()` helper + 7 API methods |
| `web/src/components/shell/Sidebar.tsx` | `Users` icon added, `/teammates` in NAV |
| `web/src/App.tsx` | `<Route path="/teammates" element={<TeammatesPage />} />` |

---

## Bugs Found and Fixed During QA (2026-04-19)

### BUG-EP45-1: `messages.sender` column does not exist — should be `author`

**Root cause**: All SQL queries in `teammates.ts` and `identity-resolver.ts` referenced `messages.sender`. The actual column name is `messages.author` (verified via `PRAGMA table_info(messages)`).

**Impact**: `GET /api/teammates` returned `{ error: "no such column: m.sender" }` for all requests. Entire feature was broken at runtime despite passing TypeScript compile.

**Fix**: 
- `src/db/queries/teammates.ts` — replaced all `m.sender` / `WHERE sender IN` with `m.author` / `WHERE author IN` (6 query sites)
- `src/tools/identity-resolver.ts` — `SELECT DISTINCT sender FROM messages` → `SELECT DISTINCT author FROM messages`
- Schema comment updated: `teams_display_name TEXT -- matches messages.author`
- Docs comment in `ARCH-45-B` updated from `messages.sender` to `messages.author`

### BUG-EP45-2: `getTeamAverages()` message subquery computed total count, not per-member average

**Root cause**: Inner subquery `SELECT COUNT(*) as cnt FROM messages WHERE author IN (all-aliases-for-all-members)` returns one row (total message count across all marked members). `AVG()` of a single number is itself — so `avgMessages` was the total, not the mean per member.

**Impact**: Activity scores were computed against a wildly inflated `teamAvgMessages`, making all members appear to have near-zero relative activity.

**Fix**: Rewrote subquery to `GROUP BY tm.id` so each member contributes one count row, then `AVG()` aggregates correctly:

```sql
SELECT AVG(cnt) as avg FROM (
  SELECT tm.id, COUNT(m.id) as cnt
  FROM team_members tm
  LEFT JOIN messages m ON (
    m.author = tm.teams_display_name
    OR m.author IN (SELECT alias FROM member_aliases WHERE member_id = tm.id)
  ) AND m.timestamp > ?
  WHERE tm.marked = 1 AND tm.deleted_at IS NULL
  GROUP BY tm.id
)
```

---

## Cost & Performance Budget

| Operation | Model | Est. Cost | Frequency |
|-----------|-------|-----------|-----------|
| Profile rebuild | Sonnet (DIGEST_MODEL) | ~$0.004/member | Only when new messages or commits exist |
| Expert rerank | Haiku (EXTRACTION_MODEL) | ~$0.0001/call | On-demand from EP-44 reviewer suggestion |
| Alias resolution | None (pure JS) | $0 | On member add + each mark |
| Activity aggregation | None (SQL) | $0 | Per sync |

**Estimated daily cost at 5 marked members, 15-min sync cycle**: ~$0.04/day (incremental guard skips ~80% of Sonnet calls).

---

## Acceptance Criteria

- [x] `team_members`, `member_aliases`, `member_profiles` tables created in migration v25
- [x] All `messages` queries use `author` column (not `sender`)
- [x] `buildAliasesForMember()` called on member add + on mark
- [x] `getMemberActivity()` queries via `member_aliases` UNION `teams_display_name`
- [x] Marked members get AI profiles built on first mark + refreshed only when new data exists since `last_updated`
- [x] Unmarked members: only `message_count` + `last_active` — no AI call made
- [x] `buildMemberProfile()` uses `DIGEST_MODEL` (Sonnet)
- [x] `buildMemberProfile()` returns structured tool output — all fields populated from tool schema
- [x] `activity_score` uses documented weighted formula (0.4 messages + 0.3 commits + 0.3 jira), normalized per member against team averages
- [x] `getTeamAverages()` computes per-member AVG via `GROUP BY tm.id` subquery
- [x] `top_topics` ranked by BM25 relevance-weighted count; fallback to raw count
- [x] `notes` field excluded from `MemberProfileInput` via TypeScript structural typing
- [x] `softDeleteMember()` sets `deleted_at`; hard delete not exposed via API
- [x] `GET /api/teammates` returns `notes: undefined` (stripped server-side)
- [x] `GET /api/teammates/expert` runs Haiku reranking on top-3 commit owners
- [x] `PATCH /api/teammates/:id/mark` triggers alias build + profile build in background
- [x] `POST /api/teammates/sync` returns 202 + count, rebuilds all marked members in background
- [x] TeammatesPage renders at `/teammates` with Add Member, Sync, Mark/Unmark, Archive, View Profile
- [x] ProfilePanel shows workload badge, activity level, score, domains, Jira counts, top topics, code ownership, AI markdown
- [x] TypeScript (`npm run typecheck`) and frontend (`cd web && npm run build`) both clean
- [x] All 7 endpoints smoke-tested and returning correct HTTP responses
