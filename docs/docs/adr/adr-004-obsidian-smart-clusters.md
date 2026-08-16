---
title: "ADR-004: Obsidian Export — People + Smart Clusters over Per-Ticket Mirror"
sidebar_label: "ADR-004: Obsidian Export Strategy"
sidebar_position: 4
---

# ADR-004: Obsidian Export — People + Smart Clusters over Per-Ticket Mirror

| Field | Value |
|-------|-------|
| **Status** | Implemented (EP-27 ✅, EP-57 ✅ — PalaceClient + Seeder) |
| **Date** | 2026-04-18 |
| **Epic** | EP-27 (Obsidian Knowledge Graph Mirror) |
| **Deciders** | Syed Maaz (product), Claude Code (architecture) |

---

## Context

Work Intelligence syncs data from Jira (247 tickets), email (13 threads), and Teams (143 messages). When implementing the Obsidian vault export, three strategies were considered for how granular the output should be.

The goal is **productivity** — the vault should help the user quickly understand who owns what, what's blocked, and how work connects across systems. It is not a backup of the database.

---

## Decision Drivers

1. **Signal-to-noise ratio** — more files ≠ more insight
2. **Graph meaningfulness** — edges in Obsidian's graph view must represent real relationships, not database joins
3. **Maintenance cost** — 300 stale files are worse than 50 accurate ones
4. **Build time** — export runs on every sync; must complete in &lt;1 second
5. **Cognitive load** — the user should be able to open Obsidian and immediately orient, not search through noise

---

## Options Considered

### Option A: One note per Jira ticket (rejected)

Write `tickets/PROJ-15043.md`, `tickets/PROJ-15044.md`, ... for all 247 tickets.

**Pros:** Complete. Every ticket is addressable. Wikilinks between tickets work.

**Cons:**
- Creates a slower, read-only mirror of the Jira board that already exists in the web UI
- 247 ticket files + people + components = ~300 files on every sync
- Obsidian graph becomes a hairball — too many nodes, no clear clusters

**Decision: Rejected.** Duplicates existing functionality without adding insight.

---

### Option B: All granularity levels — tickets + people + components + threads (rejected)

Write all four levels simultaneously: one note per ticket, one per person, one per component tag, one per thread.

**Pros:** Maximum completeness. Every axis is navigable.

**Cons:**
- ~300+ files, most of which contain redundant information already available in the web UI
- Component notes (tags like `[KBA]`, `[CONCUR]`) map 1:1 to Jira filter queries — not a new insight
- Per-ticket and per-component notes go stale instantly (ticket status changes on every sync)
- Building and writing 300 files in a sync loop, even at 500ms, adds latency to every background sync

**Decision: Rejected.** High cost, low signal delta over Option C.

---

### Option C: People notes + Smart Cluster notes (accepted)

Write **one note per real human** and **one note per meaningful work cluster** (≥3 related messages). Topic summaries remain the entry points.

**People notes** (`people/Gahr_Alexander.md`): aggregates everything a person is involved in across all topics — their Jira tickets, email threads, Teams mentions, and action items assigned to them. This is information that doesn't exist in any single system today.

**Cluster notes** (`clusters/KBA_Viewer.md`, `clusters/Document_Service.md`): groups ≥3 messages that share a common signal (Jira tag prefix, email subject, Teams chat name). Security scanner bot tickets are grouped into a single `Security_Violations.md` rather than creating individual notes.

**Vault structure:**
```
vault/
  BDS.md, KBA.md, teams.md     ← topic summaries (entry points)
  _index.md                    ← master table
  people/                      ← ~20-40 humans
  clusters/                    ← ~10-20 meaningful work clusters
```

~50-80 files total.

**Pros:**
- People notes provide **cross-system insight that doesn't exist elsewhere** — Gahr's note shows he owns infra tickets AND was in the document service email thread AND raised the w7-proxy issue
- Cluster notes represent *ongoing work*, not individual events — they're stable enough to annotate
- Graph edges are meaningful: `Gahr_Alexander → Document_Service → Rigo_Peter` is a real working relationship
- ~50-80 files stay fresh and navigable; export completes in &lt;200ms
- Bot accounts (security scanners, CI bots, noreply) are filtered — only real humans in `people/`

**Cons:**
- Individual tickets not directly addressable in Obsidian (must go to web UI for ticket detail)
- Cluster detection is heuristic — a cluster with exactly 2 messages is excluded even if significant

**Decision: Accepted.** Maximises insight-per-file. Obsidian becomes a complement to the web UI, not a duplicate.

---

## Consequences

### Positive
- Obsidian graph view immediately shows real working relationships between people and clusters
- People notes are the only place that aggregates one person's work across Jira + email + Teams
- Small file count means the vault stays fast and the graph stays readable
- Export is fast enough to run on every sync without adding measurable latency

### Negative
- Per-ticket granularity not available in Obsidian — users wanting ticket detail must use the Jira board page in the web UI
- Cluster detection threshold (≥3 messages) means some small but important discussions may not get their own cluster note. Mitigation: user annotations in My Notes tab can capture these manually

### Neutral
- Cluster membership is recomputed on every export — no cluster state is persisted in the DB
- The `people/` folder will grow as more data sources are synced; no cap needed

---

## Implementation Notes

- Cluster detection: pure regex on message subjects + author fields — no AI calls, no extra DB tables
- Bot filter: regex `T_[A-Z]+|.*\[bot\]|.*serviceuser|noreply.*|DEVOPS|AppOps` on author field
- People threshold: ≥2 messages to create a person note (one-off participants filtered)
- Cluster threshold: ≥3 messages sharing a signal to create a cluster note
- Security noise grouping: any ticket with subject matching `\[Critical\].*Security violation|Vulnerabilities detected` authored by a bot → grouped into `clusters/Security_Violations.md`
- Wikilinks injected explicitly in header/footer lines only — not via regex scan of full content (avoids false positives in Jira descriptions)

---

## Related

- [EP-27: Obsidian Knowledge Graph Mirror](../epics/ep27-obsidian-vault-mirror)
- [ADR-001: Browser-Based Extraction](./adr-001-browser-extraction)
