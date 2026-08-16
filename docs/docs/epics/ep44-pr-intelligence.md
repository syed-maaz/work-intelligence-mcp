---
sidebar_position: 44
title: EP-44 PR Intelligence
---

# EP-44: PR Intelligence (Review + Enrich + Create + Follow)

| Field | Value |
|-------|-------|
| **Status** | ✅ Done (2026-04-19) |
| **Priority** | High |
| **Complexity** | Medium |
| **Depends On** | EP-43 (code_graph + blast radius) |
| **Schema version** | No change (v24) |

## Summary

Five capabilities unified under one PR workflow:

1. **List PRs** — `GET /api/pr/list` fetches via `gh pr list --json`; filterable by state (open/closed/merged).
2. **AI Review** — `GET /api/pr/review` reads diff + blast radius + Jira/Teams work context, runs Claude Sonnet structured review.
3. **Enrich description** — `GET /api/pr/enrich` generates a professional PR body (Summary / Changes / Test Evidence / Blast Radius sections).
4. **Code Impact** — `GET /api/pr/commits` returns commit list + per-file blast radius (depth 2), cross-repo flag, total impacted file count.
5. **Follow** — client-side follow list persisted to `localStorage`; followed PRs polled every 60s; toasts on new commits; impact auto-shown for followed PRs.

---

## Decisions Made

- **`gh` CLI for all GitHub ops** — no custom GitHub API client. `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr create` cover all needed operations.
- **Review is read-only** — returns `PRReview` object to the UI; does NOT auto-post a GitHub review comment (left as user action via the UI).
- **Work context from DB** — Jira key auto-detected from branch name (`/[A-Z]+-\d+/`), then fetched from `jira_issues` table. Teams context via `LIKE` on `messages`. No live API calls.
- **Blast radius scoped to depth 2** for review and commits endpoint; depth 1 for enrich (faster).
- **No PR review cache** — reviews are fast enough (~2s Sonnet) and staleness risk outweighs latency savings.
- **`prNum` always integer** — `parseInt(prNum, 10)` before all JSON responses.
- **Follow is client-only** — stored in `localStorage` under key `pr-followed` as `{ repo: number[] }`. No server state needed; polling handled by React Query `refetchInterval: 60_000`.
- **Filters are client-side** — search/PR-number-jump filter the already-fetched list; state filter triggers a new query.

---

## EP-44-1: AI Analyzer Methods — `src/services/analyzer.ts`

### Interfaces (exported)

```typescript
export interface PRWorkContext {
  jiraTickets: Array<{ key: string; summary: string; status: string }>;
  teamsMessages: string[];
  relatedMeetings: string[];
  notebookContent?: string;
}

export interface PRReviewInput {
  prTitle: string;
  prBody?: string;
  diff: string;                        // first 4000 chars of gh pr diff
  blastRadius: BlastRadiusNode[];
  testResults: Array<{ file: string; passed: boolean; duration: number; output?: string }>;
  workContext: PRWorkContext;
}

export interface PRReview {
  riskLevel: 'low' | 'medium' | 'high';
  riskReason: string;
  workContextSummary: string;
  testCoverageSummary: string;
  crossRepoImpact: string[];
  suggestedReviewers: string[];
  missingTests: string[];
  markdownBody: string;
}
```

### `reviewPR(input: PRReviewInput): Promise<PRReview>`
- Model: `DIGEST_MODEL` (Sonnet), `tool_choice: { type: 'tool', name: 'pr_review' }`
- Calls `this._track('reviewPR', ...)` for token tracking

### `generatePRDescription(opts): Promise<string>`
- Model: `DIGEST_MODEL`, plain text output
- Auto-detects Jira key from `opts.branch`; sections: Summary, Changes, Test Evidence, Blast Radius

### Import added
```typescript
import type { BlastRadiusNode } from '../db/queries/code-graph.js';
```

---

## EP-44-2: API Endpoints — `web-server.js`

All 5 endpoints placed before `// ── EP-45` comment.

### `GET /api/pr/list?repo=example-service&state=open`
- `state`: `open | closed | merged`, default `open`
- `gh pr list --repo <slug> --state <state> --json number,title,body,headRefName,baseRefName,url,author,createdAt,updatedAt,additions,deletions,files`
- Response: `{ prs: GithubPR[] }`

### `GET /api/pr/review?repo=example-service&pr=123`
- Fetches PR metadata + diff, blast radius per file (depth 2), Jira + Teams context from DB
- Calls `analyzer.reviewPR()`
- Response: `{ prNum: number, repo, review: PRReview, blastRadius: BlastRadiusNode[] }`

### `GET /api/pr/enrich?repo=example-service&pr=123`
- Blast radius depth 1; Jira context from DB; calls `analyzer.generatePRDescription()`
- Response: `{ prNum: number, description: string }`

### `GET /api/pr/commits?repo=example-service&pr=123`
- `gh pr view <pr> --json number,title,headRefName,files,commits`
- Per-file: `getBlastRadius(db, repo, file, 2)` inline in response
- Response:
```js
{
  prNum: number,
  repo: string,
  commits: PRCommit[],          // { oid, messageHeadline, messageBody, authoredDate, authors }
  files: PRFileImpact[],        // { path, additions, deletions, changeType, blastRadius[] }
  crossRepoImpact: boolean,
  totalImpactedFiles: number,   // deduplicated count of all downstream files
}
```

### `POST /api/pr/create`
- Body: `{ repo, branch, title, body?, base? }`
- `gh pr create --repo <slug> --head <branch> --base <base|defaultBranch> --title ... [--body ...]`
- Response 201: `{ url, repo, branch }`

---

## EP-44-3: PR Review Page — `web/src/pages/PRReviewPage.tsx`

Route: `/pr-review`

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  [GitPullRequest] PR Intelligence                           │
│  Repo: [example-service] [operations]  State: [open][closed][merged]│
│  3 followed                                    [↺]          │
├──────────────────┬──────────────────────────────────────────┤
│  [Search box]    │  Detail panel                            │
│  [PR# jump]      │                                          │
│                  │  #3299 feat: integration health check    │
│  ── Followed ──  │  Branch: fix/PROJ-15231 → main · 2h ago  │
│  #3299  3c·15f   │  [AI Review] [Generate Desc] [Code Impact]│
│  #3298           │  [Following ✓]              [Open PR ↗]  │
│                  │                                          │
│  ── All PRs ──   │  ┌─ ImpactPanel ────────────────────┐   │
│  #3299 ▶  🔔    │  │ Code Impact  15 files  21 downstream│  │
│  #3298 ▶        │  │ ── Commits (3) ──                  │  │
│  #3297 ▶        │  │ 52684208 feat: add health check    │  │
│  ...             │  │ ── Files ──                        │  │
│                  │  │ ● IntegrationHelpBanner.tsx +46/-8 │  │
│                  │  │   ▶ [1 deps]                       │  │
│                  │  └───────────────────────────────────┘   │
│                  │                                          │
│                  │  ┌─ ReviewCard / EnrichCard ──────────┐  │
│                  │  └───────────────────────────────────┘   │
└──────────────────┴──────────────────────────────────────────┘
```

### Filter behaviour
- **Search box** — filters by title, author login, or PR number substring (client-side, no refetch)
- **PR# jump** — type a number to jump directly; clears search; client-side filter
- **State tabs** — `open / closed / merged`; triggers new query fetch

### Follow behaviour
- `localStorage` key `pr-followed` → `{ [repo]: number[] }`
- Followed PRs shown in a dedicated section above the main list with commit/file counts
- React Query polls followed PRs every 60s via `GET /api/pr/commits`
- `useEffect` on `followedCommitsQuery.data` compares commit counts; toasts on new commits
- If a PR is followed and impact data is already loaded, `ImpactPanel` auto-renders below the PR header

### `ImpactPanel` component
- Commit list: short SHA, headline, author, relative time
- File list: colour-coded change type dot (green=ADDED, amber=MODIFIED, red=DELETED, purple=RENAMED)
- Per-file collapsible blast radius: depth, ref_type, cross-repo badge (red)
- Header badges: files changed count, downstream count, cross-repo warning

### CSS variables used
Only: `var(--bg)`, `var(--bg-2)`, `var(--bg-3)`, `var(--fg)`, `var(--fg-2)`, `var(--muted)`, `var(--accent)`, `var(--border)`, `var(--danger)`.

---

## EP-44-4: api.ts Types + Wiring

### Interfaces

```typescript
export interface GithubPR {
  number: number; title: string; body: string | null;
  headRefName: string; baseRefName: string; url: string;
  author: { login: string } | null;
  createdAt: string; updatedAt: string;
  additions: number | null; deletions: number | null;
}
export interface PRReview { riskLevel: 'low'|'medium'|'high'; riskReason: string;
  workContextSummary: string; testCoverageSummary: string;
  crossRepoImpact: string[]; suggestedReviewers: string[]; missingTests: string[]; markdownBody: string; }
export interface PRCommit {
  oid: string; messageHeadline: string; messageBody: string;
  authoredDate: string; authors: Array<{ login: string; name: string }>; }
export interface PRFileImpact {
  path: string; additions: number; deletions: number; changeType: string;
  blastRadius: Array<{ repo: string; file_path: string; ref_type: string; depth: number }>; }
export interface PRCommitsResponse {
  prNum: number; repo: string; commits: PRCommit[]; files: PRFileImpact[];
  crossRepoImpact: boolean; totalImpactedFiles: number; }
```

### API methods
```typescript
listPRs(repo, state?)           → { prs: GithubPR[] }
reviewPR(repo, prNum)           → { prNum, repo, review: PRReview, blastRadius }
enrichPR(repo, prNum)           → { prNum, description }
createPR(body)                  → { url, repo, branch }
prCommits(repo, prNum)          → PRCommitsResponse
```

### **Critical: `request()` body pattern**
`request<T>(path, body?)` — pass `body` directly (raw object). The helper handles `JSON.stringify` and sets method to POST. **Never** pass `{ method: 'POST', body: JSON.stringify(...) }` — that causes double serialization.

### Sidebar + routing
- `web/src/App.tsx`: `import { PRReviewPage }` + `<Route path="/pr-review" />`
- `web/src/components/shell/Sidebar.tsx`: `{ to: '/pr-review', icon: GitPullRequest, label: 'PR Review' }` between Teammates and System Health

---

## Bugs Fixed During QA (2026-04-19)

| # | File | Bug | Fix |
|---|------|-----|-----|
| BUG-18 | `web-server.js` | `qp is not defined` — used `qp.get()` instead of `url.searchParams.get()` | Changed all query param reads to `url.searchParams.get()` |
| BUG-19 | `web/src/lib/api.ts` | Double JSON serialization in `createPR` + `saveTicketLearning` | Pass `body` directly to `request()` |
| BUG-20 | `web-server.js` | `prNum` type mismatch — returned string, typed as number | `parseInt(prNum, 10)` before response |

---

## Key Code Locations

| File | Change |
|------|--------|
| `src/services/analyzer.ts` | `reviewPR()` + `generatePRDescription()`; `PRWorkContext`, `PRReviewInput`, `PRReview` interfaces |
| `web-server.js` | 5 endpoints under `// ── EP-44` (before `// ── EP-45`) |
| `web/src/pages/PRReviewPage.tsx` | Full page: filters, follow, ImpactPanel, ReviewCard, EnrichCard |
| `web/src/lib/api.ts` | `GithubPR`, `PRReview`, `PRCommit`, `PRFileImpact`, `PRCommitsResponse`; 5 api methods |
| `web/src/App.tsx` | `/pr-review` route |
| `web/src/components/shell/Sidebar.tsx` | `GitPullRequest` icon + nav entry |

---

## Acceptance Criteria

- [x] `GET /api/pr/list?repo=example-service&state=open` returns 30 open PRs
- [x] State filter: open/closed/merged tabs refetch correctly
- [x] Search box filters by title, author, PR number (client-side)
- [x] PR# jump input jumps directly to a specific PR
- [x] Follow button persists to `localStorage`, survives page refresh
- [x] Followed PRs shown in dedicated sidebar section with commit/file counts
- [x] New-commit toast fires when followed PR gets new commits (60s poll)
- [x] `GET /api/pr/commits` returns commits + per-file blast radius + cross-repo flag
- [x] ImpactPanel shows commits, file list, collapsible blast radius per file
- [x] Cross-repo files highlighted red in blast radius tree
- [x] `GET /api/pr/review` returns `PRReview` with blast radius
- [x] `GET /api/pr/enrich` returns AI-generated description
- [x] `POST /api/pr/create` validates required fields, returns 400 with field errors
- [x] TypeScript builds clean (backend + frontend)
- [x] Production bundle builds clean (`npm run build`)
- [x] `prNum` always `number` in all API responses
- [ ] Post review comment to GitHub via `gh pr review --comment` (deferred)


# EP-44: PR Intelligence (Review + Enrich + Create)

| Field | Value |
|-------|-------|
| **Status** | ✅ Done (2026-04-19) |
| **Priority** | High |
| **Complexity** | Medium |
| **Depends On** | EP-43 (code_graph + blast radius) |
| **Schema version** | No change (v24) |

## Summary

Four capabilities unified under one PR workflow:

1. **List open PRs** — `GET /api/pr/list` fetches via `gh pr list --json`.
2. **AI Review** — `GET /api/pr/review` reads diff + blast radius + Jira/Teams work context, runs Claude Sonnet structured review.
3. **Enrich description** — `GET /api/pr/enrich` generates a professional PR body (Summary / Changes / Test Evidence / Blast Radius sections).
4. **Create PR** — `POST /api/pr/create` calls `gh pr create` with optional AI-generated body.

---

## Decisions Made

- **`gh` CLI for all GitHub ops** — no custom GitHub API client. `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr create` cover all needed operations.
- **Review is read-only** — returns `PRReview` object to the UI; does NOT auto-post a GitHub review comment (left as user action via the UI).
- **Work context from DB** — Jira key auto-detected from branch name (`/[A-Z]+-\d+/`), then fetched from `jira_issues` table. Teams context fetched via `LIKE` on `messages` table. No live API calls.
- **Blast radius scoped to depth 2** for review, depth 1 for enrich (faster).
- **No PR review cache** — the original plan to cache in `digests` table was dropped; reviews are fast enough (~2s with Sonnet) and staleness is a bigger risk than latency.
- **`prNum` always integer in responses** — web-server.js parses `url.searchParams.get('pr')` to `parseInt` before returning, so api.ts type `{ prNum: number }` is always correct.

---

## EP-44-1: AI Analyzer Methods — `src/services/analyzer.ts`

### Interfaces (exported)

```typescript
export interface PRWorkContext {
  jiraTickets: Array<{ key: string; summary: string; status: string }>;
  teamsMessages: string[];
  relatedMeetings: string[];
  notebookContent?: string;
}

export interface PRReviewInput {
  prTitle: string;
  prBody?: string;
  diff: string;                        // first 4000 chars of gh pr diff
  blastRadius: BlastRadiusNode[];      // from getBlastRadius()
  testResults: Array<{ file: string; passed: boolean; duration: number; output?: string }>;
  workContext: PRWorkContext;
}

export interface PRReview {
  riskLevel: 'low' | 'medium' | 'high';
  riskReason: string;
  workContextSummary: string;
  testCoverageSummary: string;
  crossRepoImpact: string[];
  suggestedReviewers: string[];
  missingTests: string[];
  markdownBody: string;                // full review comment (GitHub-formatted)
}
```

### `reviewPR(input: PRReviewInput): Promise<PRReview>`

- Model: `DIGEST_MODEL` (Sonnet)
- Uses `tool_choice: { type: 'tool', name: 'pr_review' }` for structured output
- Inline tool schema with all 8 required properties
- Calls `this._track('reviewPR', DIGEST_MODEL, response.usage)` for token tracking
- Prompt includes: blast radius summary, cross-repo files, Jira tickets, Teams snippets, test results, first 2000 chars of diff

### `generatePRDescription(opts): Promise<string>`

```typescript
async generatePRDescription(opts: {
  branch: string;
  filesChanged: string[];
  jiraContext?: string;
  teamsContext?: string;
  testResults: Array<{ file: string; passed: boolean; duration: number }>;
  blastRadius?: BlastRadiusNode[];
}): Promise<string>
```

- Model: `DIGEST_MODEL` (Sonnet)
- Plain text output (no tool_use — markdown prose)
- Auto-detects Jira key from `opts.branch` via `/[A-Z]+-\d+/`
- Sections: Summary, Changes, Test Evidence (+ Blast Radius if provided)
- Calls `this._track('generatePRDescription', DIGEST_MODEL, response.usage)`

### Import added

```typescript
import type { BlastRadiusNode } from '../db/queries/code-graph.js';
```

---

## EP-44-2: API Endpoints — `web-server.js`

All 4 endpoints placed before the `// ── EP-45` comment block.

### `GET /api/pr/list?repo=example-service&state=open`

```
Query params:
  repo   — repo name (matches ConfigManager.getRepos()[].name), default: 'example-service'
  state  — 'open' | 'closed' | 'merged', default: 'open'

gh pr list --repo <githubSlug> --state <state> --json number,title,body,headRefName,baseRefName,url,author,createdAt,updatedAt,additions,deletions,files

Response 200: { prs: GithubPR[] }
Response 400: { error: 'Unknown repo: <name>' }
Response 500: { error: <gh stderr> }
```

**Verified:** returns 30 open PRs for acme/example-service.

### `GET /api/pr/review?repo=example-service&pr=123`

```
Steps:
  1. gh pr view <pr> --json number,title,body,headRefName,files,additions,deletions
  2. gh pr diff <pr>  → first 4000 chars
  3. changedFiles.flatMap(f => getBlastRadius(db, repo, f, 2))
  4. Extract Jira key from headRefName, fetch from jira_issues table
  5. FTS via LIKE on messages table (5 results, first 200 chars each)
  6. analyzer.reviewPR({ ... })
  7. Return { prNum: number, repo, review: PRReview, blastRadius: BlastRadiusNode[] }

Response 200: { prNum: number, repo: string, review: PRReview, blastRadius: BlastRadiusNode[] }
Response 400: { error: 'pr param required' | 'Unknown repo: ...' }
Response 500: { error: string }
```

**Important:** `prNum` is `parseInt(prNum, 10)` — always a number in response.

### `GET /api/pr/enrich?repo=example-service&pr=123`

```
Steps:
  1. gh pr view <pr> --json number,title,body,headRefName,files
  2. changedFiles.flatMap(f => getBlastRadius(db, repo, f, 1))  ← depth 1 only (faster)
  3. Jira key from headRefName → jira_issues table
  4. analyzer.generatePRDescription({ branch, filesChanged, jiraContext, testResults: [], blastRadius })

Response 200: { prNum: number, description: string }
```

**Verified:** returns 3505-char description for PR #3299.

### `POST /api/pr/create`

```
Body (Zod schema):
  { repo: string, branch: string, title: string, body?: string, base?: string }

Flow:
  1. Look up repo config via ConfigManager.getRepos()
  2. gh pr create --repo <slug> --head <branch> --base <base|defaultBranch> --title <title> [--body <body>]
  3. Parse last line of output as PR URL

Response 201: { url: string, repo: string, branch: string }
Response 400: { error: 'branch: Required' } (Zod validation)
Response 500: { error: <gh stderr> }
```

**Verified:** missing `branch` returns `{ error: 'branch: Required' }`.

---

## EP-44-3: PR Review Page — `web/src/pages/PRReviewPage.tsx`

Route: `/pr-review`

### Layout

```
┌─────────────────────────────────────────────────────┐
│  Header: [GitPullRequest icon] PR Intelligence      │
│  Repo tabs: [example-service] [operations]   [↺ refresh]  │
├──────────────┬──────────────────────────────────────┤
│  PR list     │  Detail panel                        │
│  (w-72)      │                                      │
│              │  #3299 "feat: integration health..."  │
│  #3299 ▶     │  Branch: fix/PROJ-15231 → main        │
│  #3298 ▶     │  [AI Review]  [Generate Description] │
│  ...         │  [Open PR ↗]                         │
│              │                                      │
│              │  ┌─ ReviewCard ──────────────────┐   │
│              │  │ [Summary] [Full Review] tabs  │   │
│              │  │ Risk: 🟢 Low Risk             │   │
│              │  │ Risk Reason: ...               │   │
│              │  │ Work Context: ...              │   │
│              │  └───────────────────────────────┘   │
│              │                                      │
│              │  ┌─ EnrichCard ──────────────────┐   │
│              │  │ AI-Generated PR Description   │   │
│              │  │ [Copy] button                 │   │
│              │  │ <ReactMarkdown>               │   │
│              │  └───────────────────────────────┘   │
└──────────────┴──────────────────────────────────────┘
```

### Key components

- **`ReviewCard`** — 2-tab view (Summary / Full Review). Summary tab shows all 6 structured fields. Full Review tab renders `review.markdownBody` via ReactMarkdown.
- **`EnrichCard`** — shows AI-generated description with 1-click Copy button (`navigator.clipboard`, `toast.success`).
- **`riskBadge(level)`** — color-coded chip: green=low, amber=medium, red=high with matching icon.
- Selecting a PR clears previous review/enrich results.
- "AI Review" and "Generate Description" buttons are mutually exclusive (each clears the other's result).

### State

```typescript
const [repo, setRepo] = useState('example-service');
const [selectedPR, setSelectedPR] = useState<GithubPR | null>(null);
const [expandedPR, setExpandedPR] = useState<number | null>(null);
const [reviewData, setReviewData] = useState<{ review: PRReview; blastRadius: unknown[] } | null>(null);
const [enrichDesc, setEnrichDesc] = useState<string | null>(null);
```

### CSS variables used

Only valid variables: `var(--bg)`, `var(--bg-2)`, `var(--bg-3)`, `var(--fg)`, `var(--fg-2)`, `var(--muted)`, `var(--accent)`, `var(--border)`, `var(--danger)`.

---

## EP-44-4: api.ts Types + Wiring

### New interfaces (`web/src/lib/api.ts`)

```typescript
export interface GithubPR {
  number: number;
  title: string;
  body: string | null;
  headRefName: string;
  baseRefName: string;
  url: string;
  author: { login: string } | null;
  createdAt: string;
  updatedAt: string;
  additions: number | null;
  deletions: number | null;
}

export interface PRReview {
  riskLevel: 'low' | 'medium' | 'high';
  riskReason: string;
  workContextSummary: string;
  testCoverageSummary: string;
  crossRepoImpact: string[];
  suggestedReviewers: string[];
  missingTests: string[];
  markdownBody: string;
}
```

### New api methods

```typescript
listPRs: (repo: string, state = 'open') => request<{ prs: GithubPR[] }>(`/pr/list?repo=${repo}&state=${state}`)
reviewPR: (repo: string, prNum: number) => request<{ prNum: number; repo: string; review: PRReview; blastRadius: unknown[] }>(`/pr/review?repo=${repo}&pr=${prNum}`)
enrichPR: (repo: string, prNum: number) => request<{ prNum: number; description: string }>(`/pr/enrich?repo=${repo}&pr=${prNum}`)
createPR: (body: { repo: string; branch: string; title: string; body?: string; base?: string }) => request<{ url: string; repo: string; branch: string }>('/pr/create', body)
```

**Important:** `createPR` passes `body` directly to `request()` — NOT `{ method, body: JSON.stringify() }`. The `request()` function handles `JSON.stringify` and the `POST` method automatically when `body !== undefined`.

### Wiring

- `web/src/App.tsx`: `import { PRReviewPage } from './pages/PRReviewPage'` + `<Route path="/pr-review" element={<PRReviewPage />} />`
- `web/src/components/shell/Sidebar.tsx`: `{ to: '/pr-review', icon: GitPullRequest, label: 'PR Review' }` (between Teammates and System Health)

---

## Bugs Fixed During QA (2026-04-19)

| Bug | Location | Fix |
|-----|----------|-----|
| `qp is not defined` — PR list/review/enrich used `qp.get()` instead of `url.searchParams.get()` | `web-server.js` lines 2512, 2531, 2575 | Changed all 3 to `url.searchParams.get()` |
| Double JSON serialization — `createPR` passed `{ method: 'POST', body: JSON.stringify(body) }` to `request()` which calls `JSON.stringify` again | `web/src/lib/api.ts` line 797 | Pass `body` directly: `request(..., body)` |
| Same double-serialization bug in `saveTicketLearning` (pre-existing) | `web/src/lib/api.ts` line 773 | Pass `body` directly |
| `prNum` type mismatch — `url.searchParams.get()` returns `string`, but api.ts typed it as `number` | `web-server.js` lines 2566, 2597 | Added `parseInt(prNum, 10)` before JSON response |

---

## Key Code Locations

| File | Change |
|------|--------|
| `src/services/analyzer.ts` | `reviewPR()` + `generatePRDescription()` methods (lines ~1317–1419); `PRWorkContext`, `PRReviewInput`, `PRReview` interfaces (lines ~1433–1462) |
| `web-server.js` | 4 endpoints under `// ── EP-44` comment (before `// ── EP-45`) |
| `web/src/pages/PRReviewPage.tsx` | NEW — PR list + review/enrich UI |
| `web/src/lib/api.ts` | `GithubPR`, `PRReview` interfaces; `listPRs`, `reviewPR`, `enrichPR`, `createPR` methods |
| `web/src/App.tsx` | `/pr-review` route |
| `web/src/components/shell/Sidebar.tsx` | `GitPullRequest` icon import + nav entry |

---

## Acceptance Criteria

- [x] `GET /api/pr/list?repo=example-service` returns 30 open PRs via `gh pr list`
- [x] `GET /api/pr/review?repo=example-service&pr=123` returns `PRReview` object with blast radius
- [x] Blast radius computed for each changed file (depth 2)
- [x] Jira key auto-detected from branch name regex `[A-Z]+-\d+`
- [x] `GET /api/pr/enrich?repo=example-service&pr=123` returns AI-generated description
- [x] `POST /api/pr/create` validates required fields (Zod) and returns 400 with field errors
- [x] `PRReviewPage` renders PR list in sidebar, detail panel with action buttons
- [x] AI Review card shows risk badge + 6 structured fields + Full Review tab
- [x] Enrich card shows ReactMarkdown-rendered description + Copy button
- [x] All PR types exported from `api.ts` — `GithubPR`, `PRReview`
- [x] TypeScript builds clean (backend + frontend, `npm run typecheck` + `tsc -b`)
- [x] Production bundle builds clean (`npm run build` in `web/`)
- [x] Vite proxy routes `/api/pr/*` correctly to bridge on port 3132
- [x] `prNum` is always `number` (not `string`) in all API responses
- [ ] Review comment posted to GitHub via `gh pr review --comment` (deferred — UI action only)
