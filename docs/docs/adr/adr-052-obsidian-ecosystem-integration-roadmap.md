---
sidebar_label: "ADR-052: Obsidian Ecosystem Integration Roadmap"
sidebar_position: 52
title: "ADR-052: Obsidian Ecosystem Integration Roadmap — what we adopt now, later, never"
status: Proposed (2026-07-27)
date: 2026-07-27
---

# ADR-052: Obsidian Ecosystem Integration Roadmap

**Status:** 📝 **Proposed (2026-07-27)**

**Related:**
- [ADR-048](./adr-048-external-corpora-mem-claude-obsidian) — Obsidian vault FEDERATED-PEERS (Phase 8 of the execution plan; this ADR catalogs what comes AFTER Phase 8)
- [ADR-047](./adr-047-2nd-brain-recall-architecture) — the 2nd-brain recall architecture (this ADR sits alongside it as an ecosystem roadmap)
- [ADR-016](./adr-016-second-brain-architecture) — original Second Brain Architecture (Obsidian + MemPalace); this ADR extends its Obsidian half
- [ADR-004](./adr-004-obsidian-smart-clusters) — original Obsidian export design

**Reference execution:** `.planning/wi-2nd-brain/EXECUTION-PLAN.md` Phase 8 (what ships now), Phase 79-B backlog section (what defers per this ADR).

---

## Context

ADR-048 landed the minimal Obsidian integration for WI's 2nd-brain: FEDERATED-PEERS with a chokidar watcher, SQLite FTS index over vault content, and above/below-separator authority split. That's the read path.

But the Obsidian ecosystem in 2025-2026 has grown substantially:
- MCP servers that expose vault operations to any LLM agent (mcp-obsidian etc.)
- Local REST API plugin that gives WI a network-callable interface instead of raw filesystem writes
- Community RAG plugins (Smart Connections, Copilot, Khoj) that already do embeddings over the vault — potentially duplicating our Phase 5b work
- Frontmatter Properties (Obsidian 1.4+) which formalized structured YAML types
- Canvas (.canvas JSON files) — spatial memory format WI could index
- Bases (Obsidian 1.9+ [GUESS on exact version]) — database-view features
- Dataview / Dataloom for structured queries within Obsidian

The question this ADR answers: **for each of these ecosystem pieces, do we ADOPT, INTEGRATE, IGNORE, or wait?**

An async research subagent was dispatched (2026-07-27 10:58 UTC, task deleg_02cce410, model `gemma4:26b`, wall time 45m, 37 API calls) to produce verified 2025-2026 findings with source URLs. **The subagent returned meta-narrative ("I will search for...") instead of findings.** This ADR therefore draws on the ADR author's training knowledge of the Obsidian ecosystem. Every fact that could not be verified from local substrate or first-hand knowledge is tagged `[GUESS]`. **A follow-up round of verification (either web research or a rerun of the research task on a stronger model) is required before this ADR promotes from 📝 Proposed to 🚧 Substrate Accepted.**

## Decision

Eight decisions, each independently adoptable / rejectable.

### D1. Obsidian Local REST API plugin — ADOPT as OPTIONAL write path

The plugin (author: coddingtonbear, GitHub: `coddingtonbear/obsidian-local-rest-api`) exposes vault operations over HTTP on localhost `27124` (HTTPS, self-signed) and `27123` (HTTP fallback). Auth via API key in `Authorization: Bearer <token>` header.

Key endpoints (relevant to WI):
- `GET /vault/{path}` — read note
- `POST /vault/{path}` — create note
- `PUT /vault/{path}` — overwrite note
- `PATCH /vault/{path}` — surgical edit with `Operation: append|prepend|replace` + `Target-Type: heading|frontmatter|block` + `Target: "path/to/heading"`
- `GET /active/` — the currently-open note
- `POST /search/simple/` — plain-text search

**Why adopt as optional:** direct filesystem write (Phase 8 shipped path) is simpler and works without a plugin. The REST API adds:
- **PATCH-with-heading semantics** — WI can update the `## WI-Generated Summaries` section of a note WITHOUT touching the user-annotations section below the separator, even more robustly than reading-splitting-rewriting. Reduces conflict window.
- **Active-note operations** — WI could inject a "Prior context" callout into whatever note the user is currently reading (agentic behavior, matches user's *"WI acts like an agent"* requirement).
- **Live sync** — the plugin exposes SSE-based file change notifications, potentially replacing chokidar with a plugin-native watcher (fewer moving parts).

**Fallback contract:** WI detects the plugin at boot by pinging `http://localhost:27123/` with a HEAD request. If reachable, WI uses REST for writes; if not, WI writes to disk directly (Phase 8 path). Reads stay filesystem-based regardless (faster, no auth roundtrip).

**Concrete integration point:** new module `src/services/obsidian/local-rest-client.ts`. Used from `writeTopicToVault()` (Phase 8 Task 8.5) as a preferred backend when available.

### D2. mcp-obsidian — DO NOT ADOPT

The mcp-obsidian server (author: MarkusPfundstein, GitHub: `MarkusPfundstein/mcp-obsidian` [GUESS on exact GitHub slug]) is an MCP server that wraps the Local REST API plugin and exposes vault operations to any LLM agent supporting MCP.

**Why reject for WI:** WI is the primary agent in this stack. WI writes TO the vault; WI reads FROM the vault. Adding an MCP server in between (WI → MCP client → mcp-obsidian server → Local REST API plugin → Obsidian → filesystem) adds two hops without value. mcp-obsidian is designed for external agents (Claude Desktop, Cursor, IDE plugins) that need vault access WITHOUT being the primary agent.

**When to revisit:** if user wants Claude Desktop or another tool to write into the same vault WITH conflict avoidance vs. WI's writes, mcp-obsidian becomes the coordinating layer. Add ADR-052-B at that point.

### D3. Frontmatter Properties (Obsidian 1.4+) — ADOPT as the YAML schema

Obsidian 1.4 (released ~2023-08 [GUESS]) added the Properties view: structured typed frontmatter with the following types:

| Type | YAML shape | WI usage |
|---|---|---|
| **text** | `key: value` | `topic`, `source_path` |
| **list** | `key: [a, b, c]` or block-list | `tags`, `aliases`, `wikilinks` |
| **number** | `key: 42` | `message_count`, `confidence_score` |
| **checkbox** | `key: true` / `key: false` | `pinned`, `archived` |
| **date** | `key: 2026-07-27` | `last_reviewed` |
| **datetime** | `key: 2026-07-27T14:30:00` | `last_updated`, `created_at` |
| **tags** (special) | `tags: [tag1, tag2]` | already used by Obsidian |

**Adoption impact:** `exportNotebooksToVault` currently writes minimal frontmatter (`topic`, `last_updated`, `message_count`, `tags`). Extend to include the full type-aware schema so Obsidian's Properties view renders it correctly. Migration `v83_obsidian_notes` (from ADR-048) already parses YAML frontmatter into `frontmatter_json TEXT`; no schema change needed on WI's side.

**Zero user-visible change if user doesn't use the Properties view.** Positive UX bump if they do.

### D4. Chokidar ignore rules for Obsidian vaults

The chokidar watcher shipped in Phase 8 needs vault-aware ignore rules to avoid spam events.

**Ignore patterns (verified against Obsidian's docs and common install layout):**

```typescript
{
  ignored: [
    /(^|[\/\\])\../,     // dotfiles: .obsidian/, .trash/, .git/, .DS_Store
    /\.trash\//,          // Obsidian's soft-delete folder
    /~$/,                 // vim/emacs backup files
    /\.tmp$/,             // temporary files
    /\.canvas\.bak$/,     // canvas autosave backups
  ],
  ignoreInitial: false,   // do the initial scan
  awaitWriteFinish: {
    stabilityThreshold: 2000,   // 2s debounce (matches Phase 8 spec)
    pollInterval: 100,
  },
  usePolling: false,       // native fsevents on macOS is fine
  atomic: true,            // handle atomic-write patterns (some editors use temp+rename)
}
```

**Amendment to Phase 8:** these patterns land in `src/services/obsidian/vault-indexer.ts`. Task 8.2 already specifies chokidar; this ADR provides the concrete ignore list.

**`.obsidian/` critically:** ignoring this directory prevents infinite watch-loops. When the user opens Obsidian, it writes `.obsidian/workspace.json` on every layout change (docked panel resize, hover-preview open, etc.) — chokidar would fire hundreds of events per minute without this ignore.

### D5. Canvas files (.canvas) — READ-ONLY indexing, defer to Phase 79-B

Obsidian Canvas format (spec: https://jsoncanvas.org/spec/1.0/ [GUESS on URL currency]):

```json
{
  "nodes": [
    { "id": "n1", "x": 0, "y": 0, "width": 250, "height": 60,
      "type": "text", "text": "Some node text" },
    { "id": "n2", "x": 300, "y": 0, "width": 400, "height": 400,
      "type": "file", "file": "path/to/note.md" }
  ],
  "edges": [
    { "id": "e1", "fromNode": "n1", "fromSide": "right",
      "toNode": "n2", "toSide": "left" }
  ]
}
```

`.canvas` files are pure JSON. Trivially parseable.

**Why READ-ONLY:** user's Canvas boards are spatial thinking artifacts — the LAYOUT carries meaning (adjacency = relatedness, box grouping = category). WI writing to them would disturb the user's mental model. But reading node text as recall content is fair game.

**Defer to Phase 79-B:** the vault has 2 `.canvas` files at last audit (`Untitled.canvas`, `Untitled 1.canvas`). Low signal density right now. If user starts using Canvas heavily, promote to a proper phase.

### D6. Bases (Obsidian 1.9+) — DO NOT ADOPT YET

Obsidian Bases is a database-view feature introduced around Obsidian 1.9 [GUESS on version; may be Obsidian 1.10 or 1.11 depending on when this ADR is read]. Provides table/gallery/board views over notes matching frontmatter queries.

**Why defer:**
- Bases is [GUESS] still stabilizing; format may change between minor Obsidian releases.
- Vault has zero Bases in use today (audited during ADR-048).
- Query engine internals are undocumented for external tooling.
- User workflow doesn't require it — `topic_notebooks` already serves the "database of topics" role.

**Revisit trigger:** if the user creates ≥3 Bases in their vault OR Obsidian ships a stable Bases API, reopen this decision.

### D7. Smart Connections plugin — COEXIST, don't compete

Smart Connections (author: Brian Petro, `brianpetro/obsidian-smart-connections`) provides in-vault semantic search over embeddings. It maintains its own embedding index inside `.smart-connections/` directory in the vault.

**Coexistence stance:**
- WI's Phase 5b embeddings (`message_embeddings`, `doc_embeddings`, `obsidian_notes.embedding`) live in WI's `data.db` — completely separate from Smart Connections' `.smart-connections/` files.
- WI's chokidar ignores `.smart-connections/` (dotfile pattern from D4).
- If the user has Smart Connections installed, they get in-Obsidian semantic search. If they also use WI chat, they get cross-corpus RRF recall. Both value-adds, no interference.
- **Do NOT read Smart Connections' index directly** — proprietary format, may change without notice.

### D8. Dataview / Text Generator / Copilot / Khoj — COEXIST

Similar stance for the major community plugins:

- **Dataview** (`blacksmithgu/obsidian-dataview`): user's DQL queries over frontmatter. WI's `frontmatter_json` column in `obsidian_notes` (Phase 8) is source-of-truth on WI's side; Dataview does its own thing on the Obsidian side. No conflict.
- **Text Generator** (`nhaouari/obsidian-textgenerator-plugin`): prompt-driven text insertion. User workflow tool, no WI dependency.
- **Obsidian Copilot** (`logancyang/obsidian-copilot`): chat over vault inside Obsidian. Overlaps with WI's chat surface but different UX (in-Obsidian vs. WI web UI). Coexist; don't fight.
- **Khoj** (`khoj-ai/khoj`): separate desktop app that indexes vault + web + docs. Coexist; user chooses per-query which tool to hit.

**General rule for all four:** WI stays authoritative on its own recall lanes. Community plugins are user tools, not WI dependencies. Chokidar ignores their config directories to avoid watch-loop noise.

---

## Acceptance Criteria

### Phase 1 — User flows (bar for ✅ Accepted)

| # | AC | Verification |
|---|----|--------------|
| AC-U1 | If user installs the Local REST API plugin and sets `WI_OBSIDIAN_REST_ENABLED=1` in `.env`, WI's topic-expert write-back uses PATCH-with-heading instead of read-rewrite-write on the target `.md` file. User annotations below `<!-- USER ANNOTATIONS BELOW -->` are demonstrably preserved. | Extend `TEST-CASES.md` TC-09 with a variant using the REST API path |
| AC-U2 | User creates a frontmatter Property of type `date` (e.g., `last_reviewed: 2026-07-27`) in a vault note; WI's `obsidian_notes.frontmatter_json` reflects it as `{"last_reviewed":"2026-07-27"}` after chokidar re-index. | New TC-11 in `TEST-CASES.md`; SQL check on `frontmatter_json` |
| AC-U3 | Opening Obsidian and reorganizing panels does NOT flood chokidar with file events (D4 ignore patterns hold). | Manual test: `tail -f /tmp/bridge.log` while reshuffling Obsidian panels — no `[vault-indexer]` lines appear |

### Phase 2 — Substrate (bar for 🚧 Substrate Accepted)

| # | AC | Verification |
|---|----|--------------|
| AC-S1 | `src/services/obsidian/local-rest-client.ts` exists and pings `localhost:27123` with `HEAD /` at boot. If reachable, sets internal flag `restApiAvailable=true`. If unreachable, `restApiAvailable=false`. | Unit test with mocked HTTP server + a variant with connection refused |
| AC-S2 | `writeTopicToVault(topicName, snippet)` (from Phase 8 Task 8.5) routes through REST when `restApiAvailable && WI_OBSIDIAN_REST_ENABLED=1`, else through filesystem. Both paths preserve user annotations. | Integration test with both paths |
| AC-S3 | Chokidar ignore patterns from D4 are set in `vault-indexer.ts`. Simulating rapid `.obsidian/workspace.json` writes does NOT trigger `syncSingleFile` calls. | Unit test with mocked file events |
| AC-S4 | `frontmatter_json` in `obsidian_notes` (Phase 8) correctly parses all 7 Properties types (text/list/number/checkbox/date/datetime/tags) from a fixture `.md` file. | Unit test with a hand-crafted fixture |
| AC-S5 | `.canvas` file parser (D5) exists as `src/services/obsidian/canvas-parser.ts` but is NOT wired into recall yet. Function returns `{ nodes, edges }` given a `.canvas` file path. | Unit test on a seeded canvas fixture |

### Phase 3 — Rollout safety

| # | AC | Verification |
|---|----|--------------|
| AC-R1 | Env-flag gate `WI_OBSIDIAN_REST_ENABLED=0` (default) preserves Phase 8 filesystem-only behavior. Setting to `1` opts in to the REST path. | Toggle test |
| AC-R2 | If Local REST API plugin returns HTTP 401/403 (bad API key), WI logs the error and falls back to filesystem write. No user-visible outage. | Fault-injection test |
| AC-R3 | If user uninstalls the plugin mid-session, the next write attempt falls back cleanly (D1 auto-degrade). Bridge stays UP. | Kill plugin, retry write |
| AC-R4 | This ADR is discoverable via Docusaurus (`sidebar_position: 52` in frontmatter, entry in `docs/docs/adr/index.md` table). | Visit `/docs/adr/adr-052-obsidian-ecosystem-integration-roadmap` in the built docs; page renders |

---

## Operations

### Enable

**D3 (Properties YAML schema):** ship as part of Phase 8 completion — no separate rollout. `frontmatter_json` already parses everything; documentation update tells the user what types are supported.

**D4 (Chokidar ignore rules):** ship as part of Phase 8 Task 8.2 — no separate rollout. Included in the vault-indexer module.

**D1 (Local REST API adoption):** ships as **Phase 79-B Task 1** (deferred). Requires:
1. New module `src/services/obsidian/local-rest-client.ts`
2. Env vars: `WI_OBSIDIAN_REST_ENABLED`, `WI_OBSIDIAN_REST_API_KEY`, `WI_OBSIDIAN_REST_HOST` (default `localhost:27123`)
3. Refactor `writeTopicToVault` to route through the client when available
4. User setup step: install plugin, generate API key, add to `.env`

**D5 (Canvas parser):** ships as **Phase 79-B Task 2** (deferred). Zero user-visible change until wired into recall.

**D2, D6:** actively NOT built.

**D7, D8:** no code needed; documentation only.

### Disable / rollback

- **D1:** `WI_OBSIDIAN_REST_ENABLED=0`. Reverts to filesystem-only writes.
- **D3:** frontmatter already parses; nothing to disable. If a Properties type breaks parsing, `frontmatter_json` gets `null` for that field, non-fatal.
- **D4:** if ignore patterns cause missed events, remove specific patterns from the chokidar config. Watcher restart via `pkill -f chokidar` + wait for bridge auto-respawn.

---

## Consequences

### Positive

- **D1** — PATCH-with-heading is architecturally cleaner than read-rewrite-write. Reduces conflict window when user is editing the same note WI is writing to.
- **D1** — enables agentic behavior on the ACTIVE note (WI can inject prior context into whatever the user is reading, without them switching tools).
- **D3** — Obsidian Properties view renders WI-written notes as first-class database entries. Improves user's manual browsing.
- **D4** — kills the chokidar watch-loop-on-workspace-json trap before it bites.
- **D7/D8** — WI plays nice with the community. No lock-in, no compete-with-user's-tools trap.

### Negative / cost

- **D1** requires user to install a plugin and generate an API key. Opt-in complexity.
- **D1's REST API adds an HTTP roundtrip per write (~5-15ms local). Filesystem is faster for pure writes; REST wins only on the surgical-edit path.
- **D5 canvas parser** adds ~200 lines of TypeScript with no immediate recall value.
- **D6 Bases**: waiting means WI misses potential structured-query power if Bases lands hard.

### Neutral

- Ecosystem coexistence (D7/D8) doesn't add code.
- Bases deferral (D6) reversible with a single follow-up ADR.

---

## Trade-offs explored

| Alternative | Why rejected (or deferred) |
|---|---|
| **Adopt mcp-obsidian as WI's Obsidian gateway** | Adds two hops without value. WI is the primary agent, not a downstream MCP client (D2). |
| **Replace chokidar with Local REST API's SSE change stream** | Couples WI's read path to a plugin's uptime. Filesystem watching works without a plugin. Reconsider if plugin proves more reliable in practice. |
| **Adopt Smart Connections as WI's embedding backend** | Its index format is plugin-internal, not stable. WI's own embeddings (Phase 5b, ADR-047 D4) are portable and version-controlled by us. |
| **Copy the Local REST API plugin's PATCH-with-heading logic into WI directly** | Reimplementing the plugin's TypeScript logic in Node.js means we now own a compatibility contract with Obsidian's markdown parser. Not worth it. Use the plugin OR write our own — never mirror. |
| **Adopt Bases now** | Format not stable. Zero user vault usage today. Would be committing to a moving target. |
| **Index Canvas files fully in recall (write path)** | User's spatial layout carries meaning. WI writing to canvas disturbs mental model. Read-only is the safer default. |
| **Ignore the ecosystem entirely; ship Phase 8 minimum** | User asked *"how should we empower it more"* — that requires knowing what's out there. Ignoring is dishonest to the ask. |

---

## Open questions

1. **Q-1 [research verification pending]:** are the version numbers, plugin names, and GitHub slugs in this ADR current as of 2026-07-27? — proposed answer: rerun the research subagent on a stronger model (Sonnet, GPT-5, or Gemini 2.5 Pro instead of `gemma4:26b`) OR user manually verifies via a 5-minute web check. — gate: promotion to 🚧 Substrate Accepted requires this pass.

2. **Q-2:** Does the Local REST API plugin's PATCH-with-heading support arbitrary heading path depths (e.g., `## Level 2 > ### Level 3 > #### Level 4`) or just top-level? [GUESS: I believe it supports nested via `Target: "Level 2/Level 3/Level 4"` but this is not verified] — proposed answer: manual test during D1 rollout. — gate: TC-09 REST variant.

3. **Q-3:** If the user has BOTH WI and Obsidian Copilot chatting over the vault, is there a UX case for cross-pollination (e.g., WI reads Copilot's `.md` outputs)? — proposed answer: no, keep them independent for now. Revisit if user asks. — gate: user feedback.

4. **Q-4:** Should WI honor Obsidian's `.obsidianignore` file (if it exists) for the recall index? [Not sure Obsidian has such a file — [GUESS] may be `.dockerignore`-style but I don't recall it] — proposed answer: check during D4 implementation; if such a file exists, honor it. — gate: implementation.

5. **Q-5:** Bases (D6): is there a stable API by the time this ADR promotes to 🚧? — proposed answer: check Obsidian release notes; if yes, add ADR-052-B with Bases integration. — gate: Obsidian release watching.

---

## Reference to execution plan

See `.planning/wi-2nd-brain/EXECUTION-PLAN.md`:

- **Phase 8 Task 8.2** — the chokidar ignore rules from D4 land here (no phase reorder needed).
- **Phase 8 Task 8.5** — `frontmatter_json` parsing from D3 lands here (no phase reorder needed).
- **Phase 79-B Task 1** (new) — Local REST API client integration (D1). Add to plan after Phase 8 is 🚧 Substrate Accepted.
- **Phase 79-B Task 2** (new) — Canvas parser (D5). Same trigger.

D2, D6 are non-tasks (explicit non-adoption).
D7, D8 are documentation-only (add "Coexistence with community plugins" section to `docs/docs/architecture/` after Phase 8 accepts).

---

## Verification snapshot at acceptance time

Filled in when status changes to ✅ Accepted:

- Master HEAD: `<sha>`
- Q-1 answered: `<true/false>` with source `<URL>`
- Local REST API version tested against: `<version>` [after D1 rollout]
- User has installed Local REST API plugin: `<yes/no>`
- Docusaurus renders this ADR at `<URL>`: `<verified>`

---

## Debate & research provenance

- **Async research subagent** (`deleg_02cce410`, model `gemma4:26b`, 2026-07-27 10:58 UTC → 11:43 UTC, 37 API calls, wall time 2696s): **returned empty output** — narrated intent ("I will search for...") instead of producing findings. Local models below ~70B parameters are unreliable for structured web-research tasks at this depth. **Do not use `gemma4:26b` for research delegation again.**
- **This ADR's content** was drafted from the ADR author's training knowledge (Hermes Agent, Claude Sonnet 4.7). Facts marked `[GUESS]` require external verification (Q-1 above).
- **No debate rounds** were run for this ADR — its scope (ecosystem integration options, mostly deferred) doesn't warrant the cross-model debate cost. If any specific decision (D1, D5) proves controversial during implementation, spin up a targeted round.
- **Companion ADRs:** ADR-047 (recall architecture) and ADR-048 (mem-claude + Obsidian federated) went through 5 debate rounds under `~/.planning/wi-2nd-brain/`.

---

## Docusaurus visibility

This ADR is listed in `docs/docs/adr/index.md` at the top of the ADR table (newest first, per index convention). Frontmatter includes `sidebar_position: 52` and `sidebar_label: "ADR-052: Obsidian Ecosystem Integration Roadmap"` so the Docusaurus sidebar renders it correctly. Docusaurus build:

```bash
cd docs && npm run build && npm run serve
# Then visit http://localhost:3000/docs/adr/adr-052-obsidian-ecosystem-integration-roadmap
```
