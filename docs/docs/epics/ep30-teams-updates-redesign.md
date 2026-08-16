---
sidebar_position: 30
title: EP-30 Teams Updates Redesign
---

# EP-30: Teams Updates Redesign

| Field | Value |
|-------|-------|
| **Status** | ✅ Done (code intelligence extension planned — requires EP-43) |
| **Priority** | High |
| **Blocked By** | EP-11 (Teams Sync) |
| **Schema version** | 16 (adds `teams_fav_keywords` table); no schema change for code context extension |

## Summary

Redesigned Teams Updates page to match JiraReportPage visual language. Added favourite keywords (DB-persisted, shown as chips) and a stacked result feed (one collapsible card per search query) instead of a single markdown panel.

## Decisions Made

- **Fav keywords in DB** (not localStorage) — persists across browser clears
- **Chip click fills input** (does not auto-submit) — user can tweak before pressing Search
- **Stacked result cards** — one collapsible card per search query; newest on top
- Options (since/max/meetings) collapsed behind a toggle to keep the top bar clean

## DB Schema (Migration 15 → 16)

```sql
CREATE TABLE IF NOT EXISTS teams_fav_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL UNIQUE,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/teams-fav-keywords` | List all saved keywords |
| POST | `/api/teams-fav-keywords` | Add `{ keyword }` |
| DELETE | `/api/teams-fav-keywords/:id` | Remove by id |

## Key Code Locations

- `web-server.js` — 3 new fav-keywords endpoints (near line ~982)
- `src/db/schema.ts` — migration 15→16
- `src/db/queries.ts` — `listFavKeywords`, `saveFavKeyword`, `deleteFavKeyword`, `TeamsFavKeyword`
- `web/src/pages/TeamsUpdatesPage.tsx` — full rewrite: `FavChip`, `ResultCard`, `MdBlock`, search state
- `web/src/lib/api.ts` — `TeamsFavKeyword`, `requestDelete`, `listFavKeywords`, `addFavKeyword`, `deleteFavKeyword`

## UX Layout

```
Top bar:  [Title + subtitle]  [search input]  [Search btn]  [Options ▾]
Favourites: ★ [chip ×] [chip ×] [+ Add]
Options (collapsible): Since | Max results | Include meetings
Results feed (newest first):
  ▼ "BDS deployment"  —  5s ago  [×]
     [ReactMarkdown content]
  ► "authentication"  —  2m ago  [×]  (collapsed)
```

## Acceptance Criteria

- [x] Visual language matches JiraReportPage (same card style, borders, colors)
- [x] Favourite keywords shown as chips; click fills search input
- [x] Add keyword via `+` chip inline input (Enter saves, Escape cancels)
- [x] Remove keyword chip → deleted from DB
- [x] Chips persist across page refresh (DB-stored)
- [x] Results stacked as collapsible cards; newest on top
- [x] Copy button per result card
- [x] "Clear all" removes all result cards
- [x] Options (since, max, meetings) collapsed by default
- [x] TypeScript builds clean

---

## Code Intelligence Extension (requires EP-43)

Once `code_graph` is available (EP-43), Teams search results get a **Code Context** section that bridges the conversation to the code it's about.

### What changes

**Code Context section in each `ResultCard`**

After the AI summary markdown, if any matched messages contain Jira keys or file-path-like tokens (`src/`, `.ts`, component names), query `code_graph` and render:

```
▼ "BDS deployment"  —  5s ago  [×]
   [AI summary content...]

   Code Context  ──────────────────────────
   Mentioned: PROJ-456 → src/auth/login.ts (LoginService)
   Related files: src/middleware/session.ts, src/api/users.ts
   Blast radius: 7 files  ·  Cross-repo: operations ⚠
   Owners: @alice (auth/), @bob (session)
```

### Implementation

**In `GET /api/teams-updates` response** — add optional `codeContext` field:

```typescript
export interface TeamsUpdateResult {
  markdown: string;
  // existing fields...
  codeContext?: {
    jiraKeys: string[];                     // extracted from messages
    relatedFiles: Array<{ repo: string; file: string; symbol?: string }>;
    blastRadius: number;                    // total count
    crossRepoImpact: boolean;
    owners: string[];                       // github handles
  };
}
```

**Extraction logic** (in `web-server.js`):

```javascript
// After AI summary is generated:
if (db_has_code_graph) {
  const jiraKeys = extractJiraKeys(matchedMessages);       // regex /[A-Z]+-\d+/
  const fileTokens = extractFileTokens(matchedMessages);   // regex /src\/[\w\/]+\.ts/
  const relatedFiles = getRelatedFiles(db, 'example-service', [...jiraKeys, ...fileTokens]);
  const blastRadius = relatedFiles.flatMap(f => getBlastRadius(db, 'example-service', f));
  result.codeContext = { jiraKeys, relatedFiles, blastRadius: blastRadius.length, ... };
}
```

**`ResultCard` update** — add collapsible "Code Context" footer:

```tsx
{result.codeContext && result.codeContext.relatedFiles.length > 0 && (
  <details className="code-context">
    <summary>Code Context · {result.codeContext.blastRadius} files affected</summary>
    <CodeContextPanel context={result.codeContext} />
  </details>
)}
```

**Code context is opt-out** — only shown when `code_graph` is indexed and matches exist. No change to existing behaviour if EP-43 is not yet done.

### Files to update (when EP-43 is done)

| File | Change |
|------|--------|
| `web-server.js` | Jira key + file token extraction from matched messages; `codeContext` field in response |
| `web/src/pages/TeamsUpdatesPage.tsx` | `CodeContextPanel` component inside `ResultCard` |
| `web/src/lib/api.ts` | Add `codeContext?` to `TeamsUpdateResult` type |
