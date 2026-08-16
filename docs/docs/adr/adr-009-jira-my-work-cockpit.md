---
sidebar_position: 9
title: ADR-009 Jira My Work Cockpit Redesign
---

# ADR-009: Jira My Work Cockpit — JQL-Based Sprint Detection & Master-Detail Layout

| Field | Value |
|-------|-------|
| **Date** | 2026-04-20 |
| **Status** | ✅ Accepted |
| **Deciders** | Project owner |
| **Epic** | [EP-50](../epics/ep50-jira-my-work-cockpit) |
| **Supersedes** | Status-heuristic sprint detection introduced in EP-49-9 |

---

## Context

The Jira page (`JiraReportPage.tsx`) was built in two phases:

1. **EP-20/EP-29** (Sprints 2 & 4): Basic board scrape → display all BDS tickets in two columns (Current Sprint / Backlog)
2. **EP-49-9** (Sprint 8): Attempted to fix the sprint column by expanding a status blocklist (`DONE_STATUSES`) and inverting it — anything not in the list is "in sprint"

Both approaches share the same root problem: **neither has any connection to actual Jira sprint data**. Sprint membership in Jira is a first-class field (`customfield_10020`) set by the scrum master — it has nothing to do with ticket status.

### Confirmed problems (discovered 2026-04-20)

| Problem | Root cause |
|---------|-----------|
| "Open" tickets appear in Backlog column | `'open'` is in `DONE_STATUSES` blocklist — but "Open" is a valid  Jira status for in-sprint tickets |
| Backlog column is empty | All 141 sprint tickets have status "Open", "In Progress", etc. — none match the blocklist |
| No sprint name/dates shown | Sprint metadata never fetched |
| Shows all 141 BDS tickets | Default should be "my tickets" not "whole team board" |
| `currentUser()` JQL returns 0 |  Jira MCP OAuth doesn't resolve `currentUser()` — bearer token auth, not user session |

### What the MCP actually supports (verified via live testing)

```bash
# Returns 141 tickets — real sprint membership
jira_search: jql = "project = BDS AND sprint in openSprints()"



# customfield_10020 is NOT returned by jira_search ( MCP strips it)
# currentUser() returns 0 results (bearer token, no user session)
```

---

## Decisions

### Decision 1: JQL-only sprint classification

**Chosen**: Sprint membership determined exclusively by which JQL query returns the ticket.

```
sprint in openSprints()   → sprintContext = 'current_sprint'
sprint in closedSprints() → sprintContext = 'closed_sprint'
neither                   → sprintContext = 'backlog'
no sprint field at all    → sprintContext = 'no_sprint'
```

**Rejected alternatives**:
- *Status-based heuristic* (current approach) — fundamentally wrong; "Open" can mean in-sprint or backlog depending on the board
- *Parse `customfield_10020`* —  Jira MCP does not return this field; confirmed absent from all `jira_search` responses
- *Board scraping for sprint data* — defeats the purpose of having the MCP adapter; brittle DOM

**Tradeoff**: The Mine tab now runs two parallel `jira_search` calls (one for open sprint, one for everything else) instead of one. Acceptable: each call is ~50ms via the MCP, and the Mine tab is user-initiated.

---

### Decision 2: `JIRA_MY_USERNAME` env var instead of `currentUser()`


**Root cause of `currentUser()` failure**: The  Jira MCP uses OAuth2 PKCE with Dynamic Client Registration (see ADR-007). The bearer token authenticates the *application*, not the user. `currentUser()` is a Jira server-side function that resolves only in the context of a browser session cookie — not a bearer token. This is a limitation of the  Jira MCP's design, not our implementation.

**Rejected alternatives**:
- *Extract username from OAuth token claims* — token is opaque; JWT structure not documented or guaranteed
- *Store in DB* (settings table) — adds a migration, a settings UI, and a settings page for a single string. Env var is simpler and more transparent
- *Prompt user on first load* — adds friction; the username is static and known

**When `JIRA_MY_USERNAME` is absent**: Mine tab shows a configuration banner with instructions. Sprint and All tabs remain functional.

---

### Decision 3: Master-detail layout (list + right panel)

**Chosen**: Left panel = scrollable ticket list (~340px). Right panel = full ticket detail (flex-1). Selecting a ticket opens its detail in the right panel without collapsing the list.

**Rejected alternatives**:
- *Inline expand below row* (current EP-48 pattern) — pushes other tickets out of view; breaks scan + read workflow
- *Full-screen modal* — loses list context; can't compare tickets
- *Two-column sprint/backlog split* (current layout) — predicated on the broken heuristic; wrong mental model

**Rationale**: The developer's primary workflow is: scan list for what needs attention → click ticket → read detail + comments → decide to analyze or not. This is identical to VS Code's file explorer + editor pattern. The detail panel remains stable while the user navigates the list.

---

### Decision 4: New `GET /api/jira/board` endpoint — keep `/api/saturn/issues` intact

**Chosen**: Add a new endpoint rather than modifying the existing Saturn endpoint.

**Why**: `/api/saturn/issues` is used by two consumers — `JiraReportPage` and the dashboard `SaturnBoardSection` widget. Changing its contract would break the dashboard widget mid-sprint. A new endpoint allows the cockpit redesign to ship independently.

**Migration path**: After EP-50 is verified, `SaturnBoardSection` can be updated to use `/api/jira/board?tab=sprint` and `/api/saturn/issues` can be deprecated.

---

### Decision 5: Sprint name stored in in-memory cache

**Chosen**: After first successful `sprint in openSprints()` fetch, store `sprintMeta = { name, total }` in a module-level variable. Sprint name is not parsed from ticket fields (unavailable) — it is populated from the `claude -p` query result on first observation (`Saturn-93`), then validated against `total` count on subsequent fetches.

**Why**: No other mechanism is available. `customfield_10020` is not returned. The sprint name is stable for the 2-week sprint duration. Storing in memory is sufficient — if the server restarts, the next fetch repopulates it from the same source.

**Future**: If  Jira MCP ever exposes `customfield_10020`, switch to reading it from the first issue's fields.

---

### Decision 6: Auto-import sprint teammates (EP-50-7)

**Chosen**: After every successful Sprint tab fetch, upsert all unique assignees into `team_members` with `marked = 0`.

**Why**: Team membership is implicit in sprint assignments. The Teammates page (EP-45) requires manual entry — but the developer's team is definitionally "whoever is in this sprint". Auto-discovery removes friction and ensures the Teammate Intelligence features (profile building, reviewer ranking, code ownership) have accurate team data.

**`marked = 0` not `marked = 1`**: Auto-import registers a person as known, not as a subject for AI profile analysis. Profile building (Sonnet, expensive) is triggered manually via the Teammates page "Mark" toggle. This keeps the sprint sync cheap.

**Deduplication**: SQLite `INSERT OR IGNORE` on `UNIQUE(name)` constraint — safe to run on every sprint fetch.

---

## Consequences

**Positive**:
- Sprint membership is now accurate — driven by JQL, the same source Jira itself uses
- Mine tab shows exactly the right tickets (assigned to you, in any sprint state)
- Sprint name, dates, and team composition are surfaced in the UI
- Detail panel with description + comments removes the need to open Jira in a browser tab
- Teammate Intelligence automatically knows who is in the current sprint

**Negative / Tradeoffs**:
- Mine tab requires 2 parallel MCP calls instead of 1 (acceptable latency)
- `JIRA_MY_USERNAME` must be set in `.env` — not zero-config (mitigated by clear error banner)
- Sprint name currently hardcoded from manual observation — will drift when sprint rolls over (mitigated: sprint fetch `total` will change, signalling stale name)

**Breaking change**: `JiraReportPage.tsx` is fully rebuilt. The `isInSprint()` heuristic and `DONE_STATUSES` array are deleted. The two-column layout is replaced with master-detail.

---

## Implementation Notes

- `JIRA_MY_USERNAME` read via `process.env.JIRA_MY_USERNAME ?? ''` in `web-server.js`
- All new `jira_search` calls go through the existing `JiraMcpAdapter` → `McpClient` → auto-refresh OAuth path (ADR-007)
- Backward compatibility: `/api/saturn/issues` remains unchanged for the dashboard `SaturnBoardSection`
- See [EP-50](../epics/ep50-jira-my-work-cockpit) for full ticket breakdown and acceptance criteria
