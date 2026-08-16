---
sidebar_label: "System, Memory & Workflow Skills"
---

# Skills Reference — System, Memory & Workflow

---

## /wi-morning-brief

Full morning briefing in one command. See [dedicated page](./wi-morning-brief.md).

---

## /wi-pre-meeting

Context card for an upcoming meeting.

```
/wi-pre-meeting <meeting name>
```

**Examples:**
```
/wi-pre-meeting standup
/wi-pre-meeting architecture review
```

**What's in the context card:**
- Attendees with resolved names (via alias table)
- Recent relevant messages and Jira tickets from/to attendees
- Last 3 past meetings with this group: date + key decisions
- Open action items assigned to any attendee
- AI-suggested agenda points based on open items

---

## /wi-daily-digest

AI digest of the last 24 hours for a topic.

```
/wi-daily-digest <topic-name> [--date YYYY-MM-DD]
```

**Examples:**
```
/wi-daily-digest BDS
/wi-daily-digest "auth team" --date 2026-05-16
```

Digest is served from the 7-day cache when available. Offer to regenerate if stale (>6h).

---

## /wi-action-items

List your open action items across all sources.

```
/wi-action-items [--assignee <name>] [--topic <name>] [--status open|all]
```

**Default:** `--assignee me --status open`

Also shows **pending review queue** — AI-extracted items not yet confirmed. You can confirm or dismiss each one inline.

---

## /wi-save-to-ticket

Save findings from the current conversation to a Jira ticket.

```
/wi-save-to-ticket <TICKET-KEY> [--notes "custom text"]
```

**Examples:**
```
/wi-save-to-ticket PROJ-15257
/wi-save-to-ticket PROJ-15257 --notes "Root cause confirmed: FF_RM_11372 in ops PR #6107"
```

If no `--notes` given, automatically synthesizes a summary from the investigation/analysis in the current conversation.

---

## /wi-weekly-report

Weekly engineering health report.

```
/wi-weekly-report [--project BDS] [--week YYYY-WNN]
```

**Sections:** Velocity sparkline • Cycle time trend • Action item close rate • Teams activity • AI pattern analysis • Highlights

---

## /wi-sync

Trigger a full data sync and monitor completion.

```
/wi-sync [--topic <name>]
```

Polls every 5s until done, then reports: messages added per source, action items extracted, meetings transcribed, errors.

---

## /wi-palace-query

Query the MemPalace semantic knowledge graph.

```
/wi-palace-query <natural language question>
```

**Examples:**
```
/wi-palace-query "why did the recommended links break in April?"
/wi-palace-query "what did Alice decide about the auth timeout?"
```

**How it works:**
1. Checks palace health — falls back to `/wi-search-all` if palace is down
2. Palace semantic search (cosine similarity across 5 wings)
3. KG traversal finds connected entities (subject → predicate → object triples)
4. Claude synthesizes with palace context injected

See [ADR-015: MemPalace Integration](../adr/adr-015-mempalace-integration.md) and [ADR-016: Second Brain Architecture](../adr/adr-016-second-brain-architecture.md).

---

## /wi-correlate

Discover cross-domain relationships between topics, tickets, and people.

```
/wi-correlate [--topic <name>] [--entity <name>]
```

Runs the correlation agent on-demand. Surfaces topic clusters, entity connections, and emerging signals not yet in a configured topic.

---

## /wi-ticket-links

Extract, fetch, and summarize all linked content from a Jira ticket.

```
/wi-ticket-links <TICKET-KEY>
```

Fetches: Jira issue links • GitHub PRs • External URLs (HTML → markdown via Readability).
Uses MCP-first routing (Jira MCP → GitHub MCP → HTTP fallback) with 24h caching.

---

## /wi-health

Full system health check.

```
/wi-health
```

| Component | What's Checked |
|-----------|---------------|
| Bridge (port 3132) | Up/down + uptime |
| Last sync | Time since last sync, topics covered |
| MemPalace KG | Entity count, ChromaDB status, last enrichment |
| Jira MCP | OAuth token validity |
| GitHub MCP | OAuth token validity |
| Anthropic API | Tokens used today + this month |
| Recent errors | Last 5 errors with AI analysis |

For each failed component the skill prints the exact fix command.
