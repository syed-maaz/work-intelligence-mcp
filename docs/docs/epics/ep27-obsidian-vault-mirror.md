---
title: "EP-27: Obsidian Knowledge Graph Mirror"
sidebar_label: "EP-27: Obsidian Knowledge Graph"
sidebar_position: 27
---

# EP-27: Obsidian Knowledge Graph Mirror

| Field | Value |
|-------|-------|
| **Status** | ✅ Done (v2) |
| **Priority** | Medium |
| **Depends On** | EP-26 (Topic Notebooks) |
| **Schema version** | 17 (`topic_notebooks.user_annotation`) |
| **File Scope** | `src/tools/obsidian-export.ts`, `src/db/queries.ts`, `web-server.js`, `web/src/pages/TopicExpertPage.tsx`, `web/src/pages/TopicsPage.tsx` |
| **ADR** | [ADR-004: Obsidian Export — People + Smart Clusters](../adr/adr-004-obsidian-smart-clusters) |

---

## Summary

Topic Notebooks give each topic a living Claude memory document. This epic mirrors that knowledge into an Obsidian vault so the user gets graph view, backlinks, personal annotations, and cross-topic connections — without leaving Obsidian.

It also makes the system **learn from the user**: annotations written in the Web UI's "My Notes" tab are injected as authoritative context into every chat answer for that topic.

---

## Architecture Decision (v2 — Smart Clusters)

> See [ADR-004](../adr/adr-004-obsidian-smart-clusters) for the full decision record.

**v1 (naive):** One `.md` file per topic — a flat summary dump identical to what's in the web UI. No graph depth, no sub-topic navigation. Not useful.

**v1.1 (rejected plan):** One `.md` file per Jira ticket (247 files), per person, per tag component, per thread — ~300 files. Technically complete but creates a noisy mirror of Jira inside Obsidian. You'd be browsing a slower version of your Jira board.

**v2 (implemented):** Lean, high-signal output:

| File | Content | Why |
|------|---------|-----|
| `BDS.md`, `KBA.md`, `teams.md` | AI topic summaries (existing) | Entry points into each domain |
| `people/<Name>.md` | One note per real human — all their tickets, threads, action items across all topics | People are the connective tissue between work streams |
| `clusters/<Name>.md` | One note per meaningful work cluster (≥3 related messages) | Signal over noise — only groups that represent real ongoing work |
| `_index.md` | Master overview table | Quick orientation |

**Why this is more productive:**


People notes and cluster notes are the right abstraction for *how work actually happens*: a person owns multiple things across multiple systems, and clusters represent ongoing discussions not individual tickets.

---

## Vault Structure

```
vault/
  BDS.md                    ← AI topic summary + user annotation
  KBA.md
  teams.md
  search_saturn.md
  _index.md                 ← master table of all topics + stats
  people/
    Gahr_Alexander.md       ← all tickets + threads + action items
    Manju_Manju.md
    ...                     (~20-40 real humans, bots filtered)
  clusters/
    KBA_Viewer.md           ← 8 tickets + stale PRs + action items
    Document_Service.md     ← email thread + decisions + open items
    Security_Violations.md  ← 12 security scanner tickets grouped
    Daily_Delivery.md
    ...                     (only clusters with ≥3 related messages)
```

~50-80 files total. Obsidian graph view renders this in under a second.

---

## Web UI additions

### Topic Expert Page — 3-tab left panel

The left panel now has three tabs:

**Notebook** — existing AI markdown summary, Rebuild button.

**Graph** — pure SVG circular layout. Topics as circles, edges for shared Key People. Click a node to switch topic. Hover edge to see shared person names. No D3, no animation, loads instantly.

**My Notes** — personal annotation textarea with 2-second autosave. Notes are stored in `topic_notebooks.user_annotation` and injected as the **highest-priority context** in every chat answer for that topic. The AI treats them as authoritative.

### Topics Page — Vault status card

Bottom of the Topics page shows vault configuration, note count, last export time, and an Export Now button.

---

## Bidirectional Flow

```
Work Intelligence DB
  topic_notebooks.content        ←── AI builds from messages
  topic_notebooks.user_annotation ←── User writes in My Notes tab
        │
        ▼
  exportNotebooksToVault()
        │
        ├── BDS.md (AI content + user annotation below separator)
        ├── people/Gahr_Alexander.md
        └── clusters/KBA_Viewer.md
              │
              ▼
        Obsidian vault
        (graph view, backlinks, local search)
              │
              ▼ (My Notes tab saves to DB, not from file)
        chatWithContext() receives userAnnotation as context[0]
```

The **separator** `<!-- USER ANNOTATIONS BELOW — DO NOT EDIT ABOVE -->` in every topic note ensures the AI-generated section is always regenerated fresh while user content below is preserved.

---

## DB Schema (v17)

```sql
ALTER TABLE topic_notebooks ADD COLUMN user_annotation TEXT;
```

No other schema changes. Cluster detection is computed at export time from message content — no persistence needed.

---

## New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/vault/status` | `{ configured, vaultPath, noteCount }` |
| `POST` | `/api/vault/export` | Full export, returns `ExportResult` |
| `GET` | `/api/notebooks/graph` | SVG graph data `{ nodes, edges }` |
| `GET` | `/api/notebooks/:id/annotation` | User annotation for topic |
| `PUT` | `/api/notebooks/:id/annotation` | Save annotation → triggers single-file vault update |

---

## Cluster Detection Logic

A cluster is created when **≥3 messages** share a common signal. Detection runs at export time (no AI, no DB writes):

| Source | Cluster signal | Example |
|--------|---------------|---------|
| Jira | Subject tag prefix `[KBA]`, `[CONCUR]`, `[SES]` | All `[KBA]` tickets → `clusters/KBA_Component.md` |
| Email | Same subject (normalized) across ≥2 messages | "Document service discussion" x3 → `clusters/Document_Service.md` |
| Teams | Same chat name across ≥3 messages | "BDS Stand-up" x15 → `clusters/BDS_Standup.md` |
| Mixed | Jira ticket referenced in email/Teams | `PROJ-14654` in email thread → linked into ticket's cluster |


---

## People Extraction

Authors parsed from all three sources:

```
Jira author field: "Gahr, Alexander"           → Gahr_Alexander
Email author field: "Rigo, Peter; Gahr, Alexander" → Rigo_Peter + Gahr_Alexander  
Teams author field: "Manju, Manju"              → Manju_Manju
```

Bot/system accounts filtered: any author matching `T_[A-Z]+|.*\[bot\]|.*serviceuser|noreply.*|.*DEVOPS|.*AppOps`.

A person note is only created if they appear in **≥2 messages** (one-time noise filtered out).

---

## Acceptance Criteria

- [x] `npm run build` — zero TypeScript errors
- [x] `POST /api/vault/export` writes topic summaries + `people/` + `clusters/` folders
- [x] Obsidian graph view shows wikilink connections between topics, people, clusters
- [x] People notes list all tickets, threads, and action items per person
- [x] Cluster notes group ≥3 related messages under a meaningful heading
- [x] Bot authors not present in `people/` folder
- [x] My Notes tab — annotation saved → persists on refresh → appears in chat response
- [x] Auto-export fires on sync when `OBSIDIAN_VAULT_PATH` is set
- [x] `GET /api/vault/status` returns `{ configured: true, noteCount: N }` when vault is set
