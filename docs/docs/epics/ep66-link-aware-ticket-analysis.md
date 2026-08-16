---
id: ep66-link-aware-ticket-analysis
title: EP-66 — Link-Aware Ticket Analysis
---

# EP-66 — Link-Aware Ticket Analysis

| Field | Value |
|-------|-------|
| Sprint | Sprint 18 |
| Status | ✅ Done |
| ADR | [ADR-019](../adr/adr-019-link-aware-ticket-analysis) |
| Review | [Phase 64 Dual-Lens Review](.planning/phases/64-link-aware-analysis/64-REVIEW.md) |
| Schema | v42 (`web_cache` table + `jira_analysis.linked_content TEXT`) |
| Depends On | EP-64 ✅ (OrchestratorAgent), EP-65 ✅ (CorrelationAgent), ADR-018 ✅ (Cross-Repo Knowledge Sync) |
| Effort | 5 waves, 8 tasks (~3-4 days) |
| New Dependencies | `@mozilla/readability`, `linkedom`, `turndown`, `turndown-plugin-gfm`, `p-queue` (~153 KB total, all zero-dep) |

## Problem

When the Jira analyzer runs (`POST /api/jira/analyze`), it receives only the raw text of the ticket description and comments. URLs embedded in tickets — Confluence design docs, related Jira issues, GitHub PRs, wiki runbooks — are treated as opaque strings. This is equivalent to a developer who reads a ticket title but never clicks any links.

**Impact**: Analysis quality, effort estimation accuracy, and solution proposals all suffer from incomplete context. A ticket that says "See design doc: [wiki link]" gets analyzed without the design doc content.

**Scale**: In a sample of 50 BDS tickets, 78% contained at least one meaningful link. Average: 2.3 links per ticket. Most common: Jira issue links (45%), Confluence/Wiki (30%), GitHub PRs (15%), external docs (10%).

## Solution

Add a **Link Extraction & Content Fetching** stage between MCP ticket retrieval and AI analysis invocation. The system automatically:

1. **Extracts** all links from description + comments (regex for Jira keys, URL parsing for others)
2. **Fetches** content using the optimal method per link type (MCP for structured sources, Playwright for SSO-protected pages)
3. **Cleans** HTML → article extraction → markdown conversion → sanitization
4. **Filters** by relevance (keyword overlap with ticket title > 20%)
5. **Injects** cleaned markdown into the existing `allContext[]` array — zero prompt changes needed

### MCP-First Architecture (Key Decision)

We already have `jira` and `github-tools` MCP servers. The fetch routing prioritizes structured APIs over browser scraping:

| Link Type | Fetch Method | Latency | Browser Slot |
|-----------|-------------|---------|--------------|
| Jira issues | `jira` MCP / `jira_get_issue` | under 1s | None |
| GitHub PRs | `github-tools` MCP / `pull_request_read` | under 1s | None |
| GitHub commits | `github-tools` MCP / `get_commit` | under 1s | None |
| GitHub files | `github-tools` MCP / `get_file_contents` | under 1s | None |
| Cached content | `web_cache` SQLite table | under 1ms | None |
| Public URLs | `node fetch` + Readability | 1-3s | None |
| SSO-protected (Wiki, Confluence, SharePoint) | Playwright `BrowserSessionManager` | 5-15s | 1 (sequential) |

**Result**: For a typical ticket with 5 links (2 Jira + 1 GitHub PR + 1 wiki + 1 external), only 1 link requires Playwright. Total fetch time: ~8s vs. 75s if all used browser.

## Pipeline Extension

```text
POST /api/jira/analyze
  |
  +-- 1. Fetch ticket via jira MCP (EXISTING)
  |
  +-- 2. extractLinks(description + comments, selfKey)         <-- NEW
  |      Returns: ExtractedLink[] (max 10 detected, priority-ranked)
  |
  +-- 3. LinkFetcher.fetchAll(links.slice(0, 5), budget: 30s)  <-- NEW
  |      +-- Jira keys    -> jira MCP (parallel, instant)
  |      +-- GitHub URLs   -> github-tools MCP (parallel, instant)
  |      +-- Cached URLs   -> web_cache table (instant)
  |      +-- Public URLs   -> fetch() + Readability (parallel, fast)
  |      +-- SSO URLs      -> Playwright (sequential, 1 slot)
  |      Returns: FetchedLink[]
  |
  +-- 4. Filter by relevance (keyword overlap > 0.2)           <-- NEW
  |
  +-- 5. Build allContext[] (existing + linked content)         <-- MODIFIED
  |
  +-- 6. Run 5 parallel AI checks (UNCHANGED)
  |
  +-- 7. Save analysis + linked_content JSON                    <-- MODIFIED
  |
  +-- 8. Background: update web_cache + MemPalace triple        <-- NEW
```

## Content Quality Pipeline

Raw HTML is never injected directly into prompts. A 3-stage pipeline produces clean markdown:

```
RAW HTML → DOM cleanup → @mozilla/readability → turndown → sanitization → truncation (3000 chars)
```

- **DOM cleanup**: Remove `script`, `style`, `nav`, `header`, `footer`, `aside`, ads, sidebars
- **Readability**: Extract article content using Mozilla's battle-tested algorithm
- **Turndown**: Convert to GFM-flavored markdown (tables, code blocks, task lists)
- **Sanitization**: Strip prompt injection patterns ("SYSTEM:", "ignore previous", etc.)
- **Truncation**: At paragraph boundary, max 3000 chars per link

**Fallback**: If Readability returns fewer than 200 chars, use cleaned body textContent.

## Security: Prompt Injection Mitigation

Fetched web content is untrusted input. Four layers of protection:

1. **Boundary markers**: `<linked_document url="..." title="...">content</linked_document>`
2. **Content sanitization**: Strip lines matching injection patterns
3. **Size cap**: 3000 chars strictly enforced before injection
4. **Context level**: Linked content is user-level context only, never system prompt

## Caching Strategy

A `web_cache` table prevents redundant fetches:

```sql
CREATE TABLE web_cache (
  url TEXT PRIMARY KEY,
  content_markdown TEXT NOT NULL,
  title TEXT,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  error_reason TEXT,
  source_type TEXT
);
```

| Source Type | TTL | Rationale |
|-------------|-----|-----------|
| Confluence/Wiki | 4 hours | Content changes infrequently |
| SharePoint | 4 hours | Same |
| General URLs | 1 hour | External docs may update |
| Failed fetches | 30 minutes | Retry sooner for transient errors |

**Separation of concerns**: `web_cache` is temporary (TTL-based). Only internal docs (Confluence, Wiki, SharePoint) with > 500 chars are selectively indexed into `messages` table for FTS enrichment of future analyses.

## Wave Plan

| Wave | Deliverable | Files | Depends On |
|------|-------------|-------|------------|
| **0** | npm install: `@mozilla/readability`, `linkedom`, `turndown`, `turndown-plugin-gfm`, `p-queue`, `@types/turndown` | `package.json` | — |
| **1** | Schema v42 (`web_cache` + `linked_content` column) + `extractLinks()` pure function | `src/db/schema.ts`, `src/db/queries/web-cache.ts`, `src/services/link-extractor.ts` | Wave 0 |
| **2** | Content extractor (Readability + Turndown) + LinkFetcher class (MCP routing, cache, budget) | `src/services/content-extractor.ts`, `src/services/link-fetcher.ts` | Wave 1 |
| **3** | web-server.js integration (inject between MCP fetch and AI calls) | `web-server.js` | Wave 2 |
| **4** | UI: LinkedSourcesCard + progress display ("Fetching linked documents...") | `web/src/components/LinkedSourcesCard.tsx`, `web/src/pages/JiraReportPage.tsx` | Wave 3 |
| **5** | Unit tests for extractor, content pipeline, and fetcher | `tests/link-extractor.test.ts`, `tests/content-extractor.test.ts`, `tests/link-fetcher.test.ts` | Wave 3 |

## Touch Points

| File | Modification | Lines |
|------|-------------|-------|
| `src/services/link-extractor.ts` | **NEW** — regex extraction, URL classification, priority ranking, skip-list | ~150 |
| `src/services/content-extractor.ts` | **NEW** — DOM cleanup → Readability → Turndown → sanitization | ~120 |
| `src/services/link-fetcher.ts` | **NEW** — MCP-first routing, cache, Playwright fallback, p-queue, budget | ~250 |
| `src/db/schema.ts` | **EDIT** — v41→v42 migration: `web_cache` table + `linked_content` column | ~25 |
| `src/db/queries/web-cache.ts` | **NEW** — getCachedContent, setCachedContent, cleanExpiredCache | ~80 |
| `web-server.js` | **EDIT** — link extraction block inserted at line ~3271 | ~60 |
| `web/src/components/LinkedSourcesCard.tsx` | **NEW** — fetched/failed links with status badges | ~100 |
| `web/src/pages/JiraReportPage.tsx` | **EDIT** — render LinkedSourcesCard, progress state | ~15 |
| `tests/link-extractor.test.ts` | **NEW** — 15+ test cases | ~200 |
| `tests/content-extractor.test.ts` | **NEW** — 9+ test cases | ~150 |
| `tests/link-fetcher.test.ts` | **NEW** — 9+ test cases | ~180 |

**Total**: ~1300 new lines, ~100 modified lines

## Type Definitions

```typescript
// src/services/link-extractor.ts
export interface ExtractedLink {
  url: string;
  type: 'jira' | 'github-pr' | 'github-commit' | 'github-file' | 'confluence' | 'sharepoint' | 'wiki' | 'general';
  priority: 1 | 2 | 3 | 4 | 5;
  text: string;
  issueKey?: string;
  owner?: string;
  repo?: string;
  prNumber?: number;
  commitSha?: string;
  filePath?: string;
}

// src/services/link-fetcher.ts
export interface FetchedLink {
  url: string;
  type: ExtractedLink['type'];
  title: string;
  markdown: string;
  charCount: number;
  status: 'ok' | 'auth_failed' | 'timeout' | 'error' | 'cached';
  fetchMethod: 'mcp-jira' | 'mcp-github' | 'cache' | 'playwright' | 'http-fetch';
  fetchTimeMs: number;
  error?: string;
}

// stored as JSON in jira_analysis.linked_content
export interface LinkedContentReport {
  fetched: FetchedLinkSummary[];
  failed: FailedLinkSummary[];
  totalFetchTimeMs: number;
  cacheHits: number;
}
```

## Constraints

| Constraint | Value | Rationale |
|------------|-------|-----------|
| Max links per ticket | 5 | Prevent unbounded fetch time |
| Max content per link | 3000 chars | Token budget balance |
| Fetch timeout per link | 15 seconds | Prevent stalls |
| Total fetch budget | 30 seconds | Hard deadline for all links |
| Playwright concurrency | 1 (sequential) | Never hold 2 browser slots |
| MCP concurrency | Unlimited (parallel) | Instant calls, no constraints |
| Cache TTL (internal) | 4 hours | Wiki/Confluence change rate |
| Cache TTL (external) | 1 hour | More volatile |
| Relevance threshold | 0.2 keyword overlap | Prevent context pollution |
| Prompt injection | Sanitized + bounded | Security requirement |

## New Endpoints

None — this feature is entirely server-side enrichment within the existing `POST /api/jira/analyze` flow. The `GET /api/jira/analysis/:key` response gains a new `linked_content` JSON field.

## New Environment Variables

None — uses existing `jira` MCP client, existing `github-tools` MCP client, existing `BrowserSessionManager`, existing browser profile. Feature flag: not needed — transparent when no links detected.

## Success Criteria

- [ ] Tickets with Jira links: linked issue summary in analysis context (verified via linked_content JSON)
- [ ] Tickets with GitHub PR links: PR title + description + changed files in analysis context
- [ ] Tickets with wiki/Confluence links: page content (markdown) in analysis context
- [ ] Tickets with no links: zero regression, zero extra latency, zero new errors
- [ ] Total link-fetch phase ≤ 30 seconds (hard budget enforced)
- [ ] Browser slot contention: zero (MCP-first routing, sequential Playwright)
- [ ] Cached content served on repeat analysis (no redundant fetches)
- [ ] Cache hit rate > 50% after warmup period
- [ ] Prompt injection sanitization active (boundary markers + content filtering)
- [ ] UI shows fetched/failed links with status badges in analysis detail view
- [ ] Progress UI: "Fetching linked documents..." displayed during fetch phase
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] Unit tests pass with > 80% coverage on new modules
- [ ] No new `npm audit` vulnerabilities

## Token Budget Impact

| Component | Before | After | Delta |
|-----------|--------|-------|-------|
| System prompt | ~500 tokens | ~500 tokens | 0 |
| Ticket metadata | ~800 | ~800 | 0 |
| Comments | ~600 | ~600 | 0 |
| Code context | ~3000 | ~3000 | 0 |
| DB context | ~1000 | ~1000 | 0 |
| **Link content** | **0** | **~4500** | **+4500** |
| **Total input per AI call** | **~5900** | **~10400** | **+76%** |

**Cost impact**: 5 analyses/day × 5 AI calls × 4500 extra tokens = ~112K tokens/day ≈ $0.34/day. Negligible.

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Playwright slot starvation | Medium | Analysis delayed | MCP-first routing, 1 slot only, 30s budget |
| SSO session expired for wiki | Low | Some links fail | Graceful degradation, mark as auth_failed |
| Readability returns garbage | Medium | Bad AI context | Quality check (>200 chars), relevance filter |
| Prompt injection via wiki | Low | Misled analysis | Boundary markers, sanitization, size cap |
| p-queue ESM compatibility | Low | Build breaks | Test in Wave 0 first; fallback: p-limit |
| GitHub MCP token expired | Low | GitHub links fail | Auto-refresh; mark failed, continue |
| Performance regression | Medium | Bad UX | Progress UI, parallel MCP, aggressive caching |

## Future Extensions

1. **Smart caching**: Content-hash-based change detection (re-fetch only when page changes)
2. **Incremental re-fetch**: On re-analysis, only re-fetch links older than TTL
3. **Link graph visualization**: Which tickets share linked resources (knowledge clustering)
4. **Proactive alerting**: When a wiki page linked by 5+ tickets changes, notify assignees
5. **PDF/attachment support**: Extract text from attached PDFs (pdf-parse) and Office docs (mammoth)
6. **LLM link selection**: For tickets with >10 links, use Haiku to select the 5 most relevant
7. **Knowledge graph enrichment**: Build a "ticket → references → document" graph in MemPalace for cross-ticket intelligence

## Sprint Plan

Full wave-by-wave execution plan with code snippets, acceptance criteria per task, and verification checklist:

→ [64-SPRINT-PLAN.md](/.planning/phases/64-link-aware-analysis/64-SPRINT-PLAN.md)
