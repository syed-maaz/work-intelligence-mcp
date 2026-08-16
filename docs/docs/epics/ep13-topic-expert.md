---
title: "EP-13: Topic Expert"
sidebar_label: "EP-13: Topic Expert"
---

# EP-13: Topic Expert (`ask_topic_expert`)

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Agent Role** | AI / Integration Engineer |
| **Depends On** | [EP-0](./ep0-foundation), [EP-7](./ep7-schema-migration) |
| **Blocks** | — |
| **File Scope** | `src/connectors/github.ts` (new), `src/tools/topic-expert.ts` (new), `src/connectors/types.ts` (edit), `src/services/analyzer.ts` (edit), `src/server.ts` (edit) |

## Goal

A natural language "topic expert" tool: ask any question about a project or topic and get a rich AI-synthesized answer pulling from Jira, GitHub, Teams, and Email. The response includes a narrative prose summary plus structured sections — key decisions, open items, open PRs, participants, and source citations.

Unlike `search_all` (which does live browser fetches), `ask_topic_expert` queries the local SQLite DB (already-synced data) plus the GitHub REST API (live, no Playwright needed). It is fast and does not require a browser session.

## What Was Built

### `src/connectors/github.ts` (new)
`GitHubConnector` class — REST-only GitHub connector:
- `searchIssues(query, since?, limit=30): Promise<UnifiedMessage[]>`
  - Calls `GET /search/issues?q={query}+updated:>YYYY-MM-DD&sort=updated&per_page=30`
  - Auth: `Authorization: token ${GITHUB_TOKEN}`
  - Maps issues and PRs to `UnifiedMessage[]` with `source: MessageSource.GitHub`
  - PRs detected by `'pull_request' in item`; state: open / closed / merged
  - On non-200: logs to stderr, returns `[]`
- `createGitHubConnector(): GitHubConnector | null` — factory that reads `GITHUB_API_URL` + `GITHUB_TOKEN` from env; returns null if either missing

### `src/connectors/types.ts` (edit)
- Added `GitHub = 'github'` to `MessageSource` enum
- Added `github?` optional block to `UnifiedMessage.metadata`:
  ```ts
  github?: {
    number: number;
    state: 'open' | 'closed' | 'merged';
    isPR: boolean;
    url: string;
    labels?: string[];
    repository?: string;
  };
  ```

### `src/services/analyzer.ts` (edit — additive)
Added two exported interfaces and one new method:
- `ContextItem` — a single piece of evidence (source, title, content, url, author, timestamp, metadata)
- `TopicExpertAnswer` — structured answer (narrative, keyDecisions, openItems, openPRs, participants)
- `answerQuestion(question, context): Promise<TopicExpertAnswer>` — uses `claude-sonnet-4-6` with tool use + prompt caching; caps context at 60 items × 500 chars each; no API call if context is empty

### `src/tools/topic-expert.ts` (new)
Main tool with three-pass DB search + GitHub fetch + AI synthesis:

**Keyword extraction**: strips stop words, splits on `\W+`, prepends `projectKey` — so "What's happening with authentication in BDS?" → `["BDS", "authentication"]`

**FTS5 search** (three passes):
1. `messages_fts MATCH ?` — BM25-ranked FTS5 across all sources
2. Jira direct match: `source_id LIKE 'BDS-%'` — catches Jira issues even if FTS misses them
3. LIKE fallback if both above return 0 results

**GitHub**: calls `GitHubConnector.searchIssues()` live; skips gracefully if `GITHUB_TOKEN` not set

**AI**: passes all context items to `AIAnalyzer.answerQuestion()` with `claude-sonnet-4-6`

**Report format:**
```
## Topic Expert: <question>
_Searched: jira, teams, email, github | Found: N items | Since: date | Generated: date_

### Summary
&lt;2-4 paragraph prose synthesis&gt;

### Key Decisions
- ...

### Open Items
- ...

### Open PRs
- ...

### Participants
Alice, Bob, Charlie

### Sources Used
Jira: 12 | GitHub: 3 | Teams: 5
- [JIRA] PROJ-123 — Fix auth token expiry (2026-04-10)
- [GITHUB] PR #45: Implement token refresh — https://...
...

---
_Notes: GitHub skipped: GITHUB_TOKEN not set_
```

### `src/server.ts` (edit)
- Registered `ask_topic_expert` tool with full input schema
- Added `handleAskTopicExpert()` private method

## Acceptance Criteria

- [x] `GitHubConnector` in `src/connectors/github.ts` — REST only, no Playwright
- [x] `createGitHubConnector()` returns null when env vars absent (graceful skip)
- [x] `MessageSource.GitHub = 'github'` added to enum
- [x] `AIAnalyzer.answerQuestion()` — additive, all existing methods unchanged
- [x] `ask_topic_expert` registered in `server.ts`, tool schema has `question` as required field
- [x] FTS5 search with LIKE fallback and direct Jira `source_id LIKE` secondary pass
- [x] Works without GitHub token (skips GitHub, notes it in output)
- [x] Works without Anthropic key (returns raw context dump, no AI synthesis)
- [x] `npm run typecheck` passes with zero errors
- [x] `npm run build` compiles cleanly

## Environment Variables

```
# Required for GitHub search
GITHUB_API_URL=https://github.com/api/v3
GITHUB_TOKEN=ghp_...

# Optional — Jira base URL for generating issue links
JIRA_BASE_URL=https://jira.example.com
```

Both GitHub variables are optional — the tool works without them (GitHub is skipped).

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-13-1 | Add `GitHub = 'github'` to `MessageSource` enum and `github?` to metadata | ✅ Done |
| EP-13-2 | Create `src/connectors/github.ts` — REST API connector + factory | ✅ Done |
| EP-13-3 | Add `ContextItem`, `TopicExpertAnswer`, `answerQuestion()` to `AIAnalyzer` | ✅ Done |
| EP-13-4 | Create `src/tools/topic-expert.ts` — FTS5 search, GitHub fetch, AI synthesis, markdown render | ✅ Done |
| EP-13-5 | Wire `ask_topic_expert` into `src/server.ts` | ✅ Done |

---

## Sample Prompts

```
# General topic question
ask_topic_expert with question "What's happening with BDS deployment?" and projectKey "BDS"

# Who is working on what
ask_topic_expert with question "Who is working on authentication and what are the blockers?" and projectKey "BDS"

# Open PRs
ask_topic_expert with question "What are the open PRs for the new API?" and sources ["github", "jira"]

# Recent decisions
ask_topic_expert with question "What decisions were made about the Saturn release?" and since "2026-04-01"

# GitHub only
ask_topic_expert with question "Find all open PRs related to token refresh" and sources ["github"]
```
