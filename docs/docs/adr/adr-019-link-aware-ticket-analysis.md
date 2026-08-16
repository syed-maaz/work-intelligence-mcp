---
sidebar_label: "ADR-019: Link-Aware Ticket Analysis"
sidebar_position: 19
---

# ADR-019: Link-Aware Ticket Analysis

**Status**: Implemented (EP-66 ✅, Sprint 18 — 2026-05-05, verified & completed 2026-05-06)  
**Date**: 2026-05-05  
**Deciders**: Syed Maaz  
**Drivers**: Jira tickets frequently contain links to wiki pages, Confluence docs, other Jira issues, PRs, and external resources. The analyzer currently ignores these links, missing critical context that a developer would naturally follow when investigating.  
**Review**: See `.planning/phases/64-link-aware-analysis/64-REVIEW.md` for full Senior Architect + ML Engineer assessment.

---

## Implementation Status

| # | Component | Location | Status | Notes |
|---|-----------|----------|--------|-------|
| 0 | npm dependencies | `package.json` | ✅ Done | `@mozilla/readability`, `linkedom`, `turndown`, `turndown-plugin-gfm`, `p-queue`, `@types/turndown` |
| 1 | `extractLinks()` | `src/services/link-extractor.ts` | ✅ Done | URL regex + Jira key regex + skip-list + dedup, max 5 links |
| 2 | `extractMarkdownFromHtml()` + `sanitizeContent()` | `src/services/content-extractor.ts` | ✅ Done | DOM cleanup → Readability → Turndown → 3000 char truncation |
| 3 | `LinkFetcher` class | `src/services/link-fetcher.ts` | ✅ Done | MCP-first routing (Jira/GitHub), HTTP+Readability fallback, `web_cache` integration, p-queue concurrency |
| 4 | Schema v42→v43 migration | `src/db/schema.ts:1096-1111` | ✅ Done | `web_cache` table + `jira_analysis.linked_content` column |
| 5 | Cache query helpers | `src/db/queries/web-cache.ts` | ✅ Done | `getCachedContent`, `upsertWebCache`, `pruneExpiredCache`, `getTtlForUrl` |
| 6 | Pipeline integration in `POST /api/jira/analyze` | `web-server.js:3314-3357` | ✅ Done | extractLinks → LinkFetcher.fetchAll between MCP fetch and AI analysis |
| 7 | Context enrichment with boundary markers | `web-server.js:3332-3339` | ✅ Done | Maps to `<linked_document>` tagged ContextItems with source/url/strategy attributes |
| 8 | Knowledge indexing into `messages` | `web-server.js:3343-3354` | ✅ Done | INSERT OR IGNORE into `messages` with `source='linked_doc'`, topic='jira-linked-docs', sha256 source_id; only internal docs (confluence/jira) >500 chars |
| 9 | MemPalace enrichment | `web-server.js:3356-3360` | ✅ Done | `palaceClient.kgAdd(issueKey, 'references', url)` — fire-and-forget for each successful fetch |
| 10 | UI: LinkedSourcesCard | `web/src/pages/JiraReportPage.tsx:289-563` | ✅ Done | `LinkedSourceItem` component + "Sources" tab with fetched docs list, type badges, strategy labels |
| 11 | Unit tests | — | ❌ NOT DONE | No test files for link-extractor, content-extractor, or link-fetcher |
| 12 | Cache pruning scheduled | `web-server.js:5193-5197` | ✅ Done | `pruneExpiredCache(db)` called every sync tick (15 min), logs count when >0 |

### What was built (2026-05-05)

**Link Extraction** (`src/services/link-extractor.ts`, 58 lines):
- `ExtractedLink` interface: `{ url, type: 'jira'|'github'|'confluence'|'general', key? }`
- `extractLinks(texts[], selfKey, maxLinks=5)` — scans text arrays for URLs and Jira keys, deduplicates, applies skip-list (images, binaries, CI), returns prioritized list
- `shouldSkip(url, selfKey)` — filters self-references and non-content URLs

**Content Extraction** (`src/services/content-extractor.ts`, 48 lines):
- `extractMarkdownFromHtml(html, url, maxChars=3000)` — full pipeline: `parseHTML` (linkedom) → strip scripts/styles/nav → `Readability` article extraction → `TurndownService` + GFM plugin → truncation at paragraph boundary
- `sanitizeContent(text, maxChars=3000)` — strips prompt-injection patterns ("SYSTEM:", "ignore previous", excessive repetition), enforces size cap

**Link Fetcher** (`src/services/link-fetcher.ts`, 169 lines):
- `LinkFetcher` class with MCP-first strategy routing:
  - `fetchViaJiraMcp(url)` — calls `jira_get_issue` for Jira links (instant, structured)
  - `fetchViaGithubMcp(url)` — calls `pull_request_read`/`get_commit`/`get_file_contents` for GitHub links (instant)
  - `fetchViaHttp(url)` — `node fetch` + `extractMarkdownFromHtml` for public/general URLs
- `p-queue` concurrency control
- `web_cache` integration: checks cache before fetching, upserts after successful fetch
- Returns `FetchedLink[]` with `{ content, strategy, fetchedAt }`

**Web Cache** (`src/db/queries/web-cache.ts`, 47 lines):
- `WebCacheRow` interface: `{ url, content, source_type, fetched_at, expires_at }`
- `getTtlForUrl(type)` — returns TTL in hours: confluence/wiki=4h, general=1h
- `getCachedContent(db, url)` — returns cached row if not expired
- `upsertWebCache(db, url, content, sourceType)` — insert or replace with calculated TTL
- `pruneExpiredCache(db)` — DELETE WHERE expires_at < now (never called on schedule — future extension)

**Schema v42→v43** (`src/db/schema.ts:1096-1111`):
```sql
CREATE TABLE IF NOT EXISTS web_cache (
  url TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_cache_expires ON web_cache(expires_at);
ALTER TABLE jira_analysis ADD COLUMN linked_content TEXT;
```

**Pipeline Integration** (`web-server.js:3314-3343`):
- Extracts links from ticket description + all comments
- Instantiates `McpClient` (jira) + `GitHubMcpClient` for MCP-based fetching
- Creates `LinkFetcher` with both MCP callTool adapters
- Calls `fetcher.fetchAll(links)` → filters successful results → stores as JSON in `linked_content` column
- Maps successful fetches to `linkedContext[]` array with `<linked_document>` boundary markers
- Non-fatal: wrapped in try/catch, errors logged to stderr, analysis continues without links

**UI: LinkedSourcesCard** (`web/src/pages/JiraReportPage.tsx:289-563`):
- `LinkedSourceItem` component renders each fetched source with type badge, URL link, strategy label, and fetched timestamp
- "Sources" tab in analysis results shows count + full list
- Parses `analysis.linked_content` JSON on render
- Graceful degradation: tab hidden when `linkedSources.length === 0`

### Deviations from ADR

1. **No Playwright browser fallback** — the ADR specified Playwright BrowserSessionManager as step 7 (SSO-protected URLs). Implementation uses only MCP (Jira, GitHub) + HTTP fetch. SSO-protected pages (Confluence, SharePoint with auth) will fail with `fetchViaHttp` since they return login pages. This is acceptable because: (a) most useful links are Jira/GitHub which work via MCP, (b) public docs work via HTTP, (c) adding Playwright fallback later is non-breaking.
2. **No relevance threshold filtering** — ADR specified 0.2 keyword overlap filter before injection. All successfully fetched content is injected regardless of relevance (simpler, but may add noise for tickets with many tangential links).
3. **No failed-link display in UI** — only successful fetches are rendered. Failed links are silently dropped (no "Content unavailable" warning to user).

### Known Gaps (carried forward)

1. **Unit tests (Step 11)** — no test coverage for `link-extractor.ts`, `content-extractor.ts`, or `link-fetcher.ts`. All 3 are pure-function modules ideal for unit testing.
2. **Playwright fallback for SSO pages** — needed for  Confluence/Wiki/SharePoint URLs that require authenticated browser session. Low priority since most actionable links are Jira/GitHub (covered by MCP).
3. **Failed link display in UI** — users should see which links couldn't be fetched and why (auth_required, timeout, etc.) so they can paste content manually.
4. **Relevance threshold filtering** — ADR specifies 0.2 keyword overlap. Currently all fetched content is injected regardless of relevance.

---

## Context

When a developer reads a Jira ticket like PROJ-15702, they instinctively follow embedded links to understand the full picture — reading attached Confluence design docs, checking linked PRs for code context, reviewing related Jira issues for history. The current AI analyzer receives only the raw text of the description and comments, treating URLs as opaque strings.

This creates a significant context gap:
- Design docs linked in tickets contain architectural decisions, constraints, and acceptance criteria
- Linked Jira issues provide history, related bugs, and prior investigations
- PR/commit links show actual code changes and review discussions
- Wiki pages contain team runbooks, service documentation, and configuration guides

Without following these links, the analyzer's output (analysis, effort estimation, solution proposal) operates on incomplete information — equivalent to a developer who only reads the ticket title and description without clicking any links.

---

## Decision

Add a **Link Extraction & Content Fetching** stage to the Jira analysis pipeline, positioned between MCP ticket retrieval and AI analysis invocation:

### Pipeline Extension

```
FETCH ticket via MCP
  ↓
EXTRACT links from description + comments (NEW)
  ↓
FETCH link content via Playwright browser (NEW)
  ↓
BUILD enriched context (MODIFIED — includes fetched content)
  ↓
RUN 5 parallel AI checks (unchanged)
```

### Architecture

#### 1. Link Extraction (`extractLinks`)

Parse description and comment text to identify:

| Link Type | Detection Pattern | Example |
|-----------|------------------|---------|
| **Jira issues** | `[A-Z][A-Z0-9]+-\d+` (not self-referencing) | PROJ-12345, DEVOPS-789 |
| **Confluence/Wiki** | URLs matching `*.atlassian.net`, `wiki.*`, `confluence.*`, SharePoint | `https://wiki.wdf..corp/wiki/...` |
| **GitHub/Bitbucket** | URLs matching `github.com`, `github.com`, `bitbucket.org` | PRs, commits, files |
| **General HTTP(S)** | Any remaining `https?://` URL not in skip-list | Stack Overflow, MDN, npm docs |

**Skip-list** (URLs to ignore):
- Image URLs (`.png`, `.jpg`, `.gif`, `.svg`, `.ico`)
- Binary/download URLs (`.zip`, `.tar`, `.pdf`, `.jar`)
- Build/CI URLs (Jenkins, Bamboo job links)
- Avatar/profile image URLs

#### 2. Content Fetching (`fetchLinkContent`)

Use the **existing Playwright BrowserSessionManager** to fetch link content:

```
For each extracted URL (max 5 per ticket, parallelism: 2):
  1. Navigate via Playwright page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
  2. Extract text content via page.evaluate() — strip nav, sidebars, ads
  3. Truncate to 3000 chars per link
  4. Return { url, title, content, fetchedAt, success }
```

**Why Playwright (not plain fetch):**
-  internal links (Confluence, Wiki, SharePoint, Jira) require SSO authentication
- The existing browser session already has authenticated cookies from Teams/Jira connectors
- Single-page apps (Confluence, SharePoint) need JS rendering to extract content
- Handles redirects, SSO challenge pages, and cookie consent automatically

**Error handling:**
- Login/auth redirects detected → mark as `{ success: false, reason: 'auth_required' }`
- Timeout (>15s) → mark as `{ success: false, reason: 'timeout' }`
- Navigation error → mark as `{ success: false, reason: 'fetch_failed' }`
- Failed links are included in the analysis context as "Link could not be fetched — content unavailable"

**For Jira issue links specifically:**
- Use MCP `jira_get_issue` (already available) instead of browser — faster and structured
- Extract: title, status, description (truncated), last 3 comments

#### 3. Context Enrichment

Fetched content is added to `allContext[]` as additional `ContextItem` entries:

```typescript
{
  source: 'linked_document',
  title: `Linked: ${pageTitle} (${url})`,
  content: extractedTextContent,  // max 3000 chars
  author: '',
  timestamp: ''
}
```

The AI prompts for all 5 checks already receive `allContext` — no prompt changes needed. The additional context naturally enriches the analysis without modifying prompt templates.

#### 4. Unfetchable Link Reporting

When links cannot be fetched (auth failure, timeout, paywall), include them in the analysis output:

- Add a `linked_content` column to `jira_analysis` table (JSON blob):
  ```json
  {
    "fetched": [{ "url": "...", "title": "...", "chars": 2847 }],
    "failed": [{ "url": "...", "reason": "auth_required" }]
  }
  ```
- UI shows a "Linked Sources" section in the Analysis tab:
  - Successfully fetched links shown with checkmark
  - Failed links shown with warning + "Content unavailable — paste manually into Notes"

#### 5. Knowledge Indexing

After successful analysis, store fetched link content for future retrieval:

- Insert into `messages` table with `source = 'linked_doc'`, `source_id = sha256(url)`, `content = fetchedText`
- FTS5 indexes the content automatically (existing trigger)
- Future analyses of related tickets can find this content via keyword search (existing `dbContext` enrichment)
- MemPalace enrichment: write `(issue_key, 'references', url)` triple to knowledge graph

---

## Constraints & Limits

| Constraint | Value | Rationale |
|------------|-------|-----------|
| Max links per ticket | 5 | Prevent unbounded fetch times; most tickets have 1-3 meaningful links |
| Max content per link | 3000 chars | Balance context richness vs. prompt token budget |
| Fetch timeout per link | 15 seconds | Prevent pipeline stalls on slow internal pages |
| Playwright concurrency | 1 (sequential) | Never hold 2 browser slots; reuse one page for all wiki/SharePoint fetches |
| MCP fetch concurrency | Unlimited (parallel) | Jira + GitHub MCP calls are instant, no slot constraint |
| Total link-fetch budget | 30 seconds | Hard timeout for entire link-fetching phase |
| Retry on failure | None | Link content is best-effort enrichment, not critical path |
| Jira link fetch method | jira MCP | Structured data, faster, no browser slot consumption |
| GitHub link fetch method | github-tools MCP | Structured PR/commit/file data, instant |
| Public URL fetch method | node fetch + Readability | No auth needed, no browser slot consumed |
| Cache TTL (wiki/confluence) | 4 hours | Content changes infrequently |
| Cache TTL (general URLs) | 1 hour | External docs may update more often |
| Relevance threshold | 0.2 keyword overlap | Only inject content with >20% keyword match to ticket title |

---

## Alternatives Considered

| Alternative | Why rejected |
|-------------|-------------|
| **Plain HTTP fetch (node-fetch/undici)** |  internal links require SSO cookies. Plain fetch gets login redirects for Confluence, Wiki, SharePoint. Would only work for public URLs (~20% of links in BDS tickets). |
| **Headless browser per-request (new Playwright context)** | Cold-start cost (~3s per new context). No SSO cookies. Would need separate auth flow. Existing BrowserSessionManager already solves this. |
| **MCP-based link fetching (hypothetical)** | No MCP server exists for Confluence/Wiki content. Building one would be a separate multi-week effort. |
| **User pastes content manually** | Current state — bad UX. Developers shouldn't have to copy-paste wiki content into notes. Automation is the point. |
| **LLM-driven link selection (let AI choose which links to follow)** | Adds a serial AI call before fetching. Unnecessary — follow all links (up to 5), let the AI weight relevance naturally during analysis. |
| **Cache fetched content indefinitely** | Wiki/Confluence content changes. Index with `fetched_at` timestamp; re-fetch if older than 7 days on subsequent analysis runs. |

---

## Consequences

### Positive

- Analysis quality dramatically improves for tickets with linked design docs, specs, or related issues
- Effort estimation becomes more accurate when the analyzer sees the full scope (not just the ticket summary)
- Solution proposals can reference specific patterns/approaches from linked documentation
- Indexed content enriches future analyses of related tickets (knowledge accumulation)
- Failed link detection surfaces "invisible dependencies" — linked docs the AI couldn't access

### Negative

- Analysis time increases by 5-30s depending on link count and page load times (mitigated: parallel fetching, hard timeout)
- Playwright browser slot contention — link fetching may delay concurrent Teams/Jira scraping (mitigated: only uses 1 of 2 slots)
- Stale content risk — fetched wiki content may be outdated (mitigated: 7-day re-fetch policy, `fetched_at` tracking)
- Additional storage — ~3KB per link × 5 links × thousands of tickets = marginal disk impact
- Browser must be running (BROWSER_PROFILE_PATH set) for link fetching to work — graceful degradation: skip link fetching if no browser available

### Neutral

- No changes to AI prompts — context injection is additive
- No changes to the 5-check analysis structure
- No changes to polling/202 pattern — link fetching happens server-side in the background phase
- Feature is transparent to users who don't have linked content — zero regression for plain-text tickets

---

## Implementation Plan

| # | Component | File(s) | Scope |
|---|-----------|---------|-------|
| 0 | npm dependencies | `package.json` | `@mozilla/readability`, `linkedom`, `turndown`, `turndown-plugin-gfm`, `p-queue`, `@types/turndown` |
| 1 | `extractLinks(text, selfKey): ExtractedLink[]` | `src/services/link-extractor.ts` (new) | URL regex, Jira key regex, GitHub URL parsing, skip-list, priority ranking, dedup |
| 2 | `extractMarkdownFromHtml(html, url)` | `src/services/content-extractor.ts` (new) | DOM cleanup → Readability → Turndown → truncation pipeline |
| 3 | `LinkFetcher` class | `src/services/link-fetcher.ts` (new) | MCP-first routing, cache lookup, Playwright fallback, budget enforcement, p-queue |
| 4 | Schema migration v42: `web_cache` table + `jira_analysis.linked_content` | `src/db/schema.ts` | CREATE TABLE + ALTER TABLE |
| 5 | Cache query helpers | `src/db/queries/web-cache.ts` (new) | getCachedContent, setCachedContent, cleanExpiredCache, getCacheStats |
| 6 | Pipeline integration in `POST /api/jira/analyze` | `web-server.js` | Call extractLinks → LinkFetcher.fetchAll between MCP fetch and AI analysis |
| 7 | Context enrichment with relevance filter | `web-server.js` | Filter by keyword overlap > 0.2, map to ContextItem[], boundary markers |
| 8 | Knowledge indexing (selective) | `web-server.js` | INSERT internal docs (>500 chars) into `messages` with source='linked_doc' |
| 9 | MemPalace enrichment | `web-server.js` | `(issue_key, 'references', url)` triple via PalaceClient |
| 10 | UI: LinkedSourcesCard + progress display | `web/src/components/LinkedSourcesCard.tsx`, `web/src/pages/JiraReportPage.tsx` | Fetched/failed links with status badges, progress during fetch phase |
| 11 | Unit tests | `tests/link-extractor.test.ts`, `tests/content-extractor.test.ts`, `tests/link-fetcher.test.ts` | Full coverage of extraction, routing, caching, budget enforcement |

**Sprint plan**: See `.planning/phases/64-link-aware-analysis/64-REVIEW.md` Part 4 for full wave breakdown.

---

## Content Extraction Strategy (per link type)

### Confluence/Wiki Pages
```javascript
// Remove navigation, sidebar, footer — extract main content area
const content = await page.evaluate(() => {
  const main = document.querySelector('#main-content, .wiki-content, [role="main"], article');
  return main?.textContent?.trim() ?? document.body.textContent?.trim() ?? '';
});
```

### Jira Issues (via jira MCP — fast and structured)
```typescript
const raw = await mcpClient.callTool('jira_get_issue', {
  issue_key: linkedKey,
  fields: 'summary,status,description,comment,issuetype,priority',
  comment_limit: 5
});
const p = JSON.parse(raw);
const f = p?.fields || p;
// Format: "LINKED ISSUE: KEY — Title [Status]\nDescription (truncated)\nLast 3 comments"
```

### GitHub/Bitbucket PRs (via MCP — NOT Playwright)
```typescript
// Use github-tools MCP for structured access — no browser slot consumed
const { meta, diff, files } = await githubClient.getPRDetail(owner, repo, prNumber);
const content = [
  `PR #${meta.number}: ${meta.title} [${meta.state}]`,
  `Author: ${meta.user?.login}  Branch: ${meta.head.ref} → ${meta.base.ref}`,
  `+${meta.additions} -${meta.deletions} in ${meta.changed_files} files`,
  meta.body ? `\nDescription:\n${meta.body.slice(0, 1500)}` : '',
  `\nChanged files:\n${files.map(f => `  ${f.status} ${f.filename}`).join('\n')}`,
].filter(Boolean).join('\n');
```

### General URLs (Stack Overflow, docs, etc.)
```javascript
// Generic content extraction — strip boilerplate
const content = await page.evaluate(() => {
  // Remove script, style, nav, header, footer, aside
  document.querySelectorAll('script,style,nav,header,footer,aside,.sidebar,.ad').forEach(el => el.remove());
  const main = document.querySelector('main, article, [role="main"], #content, .post-body');
  return (main ?? document.body).textContent?.trim() ?? '';
});
```

---

## MCP-First Fetch Strategy (Added 2026-05-05 Review)

The system already has `jira` and `github-tools` MCP servers connected. These provide structured, authenticated, instant access to Jira issues and GitHub PRs/commits/files. Browser-based fetching should ONLY be used for sources without MCP coverage.

**Fetch priority routing:**

```
For each extracted link:
  1. Jira issue key?   → jira MCP → jira_get_issue (instant, structured)
  2. GitHub PR URL?    → github-tools MCP → pull_request_read (instant, structured)
  3. GitHub commit?    → github-tools MCP → get_commit (instant, structured)
  4. GitHub file?      → github-tools MCP → get_file_contents (instant, structured)
  5. In web_cache?     → Return cached content (instant)
  6. Public URL?       → node fetch + Readability + Turndown (fast, no auth)
  7. SSO-protected?    → Playwright BrowserSessionManager (slow, limited)
```

**Impact**: Steps 1-5 consume ZERO browser slots. Only step 7 uses the scarce Playwright pool. For a typical ticket with 2 Jira links + 1 GitHub PR + 1 wiki + 1 external, only 1 link requires Playwright.

---

## Prompt Injection Mitigation (Added 2026-05-05 Review)

Fetched web content is UNTRUSTED INPUT injected into AI prompts. Mitigations:

1. **Boundary markers** — wrap linked content in explicit tags:
```
<linked_document url="..." title="..." fetched_at="...">
[content here]
</linked_document>
```

2. **Content sanitization** — strip prompt-injection patterns:
   - Lines starting with "SYSTEM:", "HUMAN:", "ASSISTANT:", "ignore previous"
   - Excessive repetition (>10 identical lines)
   - Obvious injection templates

3. **Size cap enforcement** — 3000 chars per link, strictly enforced before injection

4. **User-level context only** — linked content is NEVER elevated to system prompt

---

## Content Quality Pipeline (Added 2026-05-05 Review)

Raw HTML extraction produces noisy text. A 3-stage pipeline ensures clean markdown for AI consumption:

```
RAW HTML → DOM cleanup → @mozilla/readability → turndown → truncation
```

- **DOM cleanup**: Remove `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>`, `<aside>`, ads, sidebars
- **Readability extraction**: Returns article content if identifiable (>200 chars)
- **Markdown conversion**: `turndown` + GFM plugin for tables/code/task lists
- **Fallback**: If Readability returns null, use cleaned body textContent
- **Truncation**: At paragraph boundary (not mid-word), max 3000 chars

---

## Caching Strategy (Added 2026-05-05 Review)

A `web_cache` table (schema v42) stores fetched content with TTL-based expiry:

| Source Type | TTL | Rationale |
|-------------|-----|-----------|
| Confluence/Wiki | 4 hours | Content changes infrequently |
| SharePoint | 4 hours | Same |
| General URLs | 1 hour | External docs may update |
| Failed fetches | 30 minutes | Retry sooner for transient errors |

Cache is separate from `messages` table. Only internal docs (Confluence, Wiki, SharePoint) with >500 chars are selectively indexed into `messages` for FTS enrichment of future analyses.

---

## Future Extensions

1. **Smart caching**: If the same URL appears in multiple tickets, serve from cache instead of re-fetching
2. **Incremental re-fetch**: On re-analysis, only re-fetch links whose content is older than 7 days
3. **Link graph visualization**: Show which tickets share linked resources (knowledge clustering)
4. **Proactive alerting**: When a wiki page linked by 5+ tickets changes, notify relevant assignees
5. **PDF/attachment support**: Extract text from attached PDFs and Office documents (requires pdf-parse, mammoth)
6. **SessionEnd hook integration**: When a Claude Code session modifies a file that's linked from a Jira ticket, auto-update the analysis
