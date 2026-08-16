---
sidebar_label: "More Skills (Reference)"
---

# Skills Reference — Search, Teams & Jira

Quick reference for search and Teams skills. For full docs on each, see the individual pages.

---

## /wi-teams-search

Search Teams messages and meeting transcripts.

```
/wi-teams-search <query> [--since YYYY-MM-DD] [--meetings-only]
```

**How it works:**
1. FTS5 BM25 search on `messages` + `meetings` tables
2. Falls back to `LIKE` when FTS returns 0 results
3. Groups results by chat
4. Detects meetings with missing transcripts and prompts you to paste them

**Example output:**
```
## Teams Search: "FF_RM_11372"

### #bds-dev (3 messages)
Alice [Apr 17 09:42] — "just promoted FF_RM_11372 in operations PR #6107"
Bob   [Apr 17 10:05] — "seeing 500s on the recommended links endpoint"
Alice [Apr 17 10:22] — "rolling back, will investigate SMRDP compat"

### Meeting: Sprint Review Apr 17 (transcript)
Decisions: Rollback FF_RM_11372, schedule SMRDP compatibility spike
Action items: PROJ-15257 — Alice to investigate
```

---

## /wi-ask-topic

Natural language Q&A over Jira + Teams + Email + GitHub.

```
/wi-ask-topic <question> [--project BDS] [--since YYYY-MM-DD]
```

**Example:**
```
/wi-ask-topic "what decisions were made about the recommendation engine?" --project BDS
```

**Output sections:** Summary • Key Decisions • Open Items • Open PRs • Participants

**How it works:** Extracts keywords → FTS5 search across all sources → Claude Sonnet synthesis with prompt caching.

---

## /wi-jira-report

Sprint health report for a Jira project.

```
/wi-jira-report <PROJECT-KEY>
```

**Example:**
```
/wi-jira-report BDS
```

**Output sections:** Sprint Health • Blocked Issues • At-Risk Items • Team Breakdown • PR Summary • Velocity • Risks • Recommendations

**Default board URL:** `https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=BDS`

---

## /wi-search-all

Cross-source FTS search with AI synthesis.

```
/wi-search-all <query> [--since YYYY-MM-DD] [--sources jira,teams,email,github]
```

**Example:**
```
/wi-search-all "feature flag FF_RM_11372"
```

Results are grouped by source (Jira / Teams / Email / GitHub) with an AI summary synthesizing across all of them.
