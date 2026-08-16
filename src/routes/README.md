# `src/routes/` — extracted route modules

> Phase 1 of REFACTOR-001 (web-server.js modularization).
> This directory holds route handlers extracted from `web-server.js` (6.4 k LOC monolith).
> The bridge stays the canonical entry; this directory contains pure handler logic so we
> can shrink `web-server.js` incrementally without changing dispatch semantics.

## Status

| Family | File | Routes extracted | LOC moved | Status |
|---|---|---|---|---|
| brain (partial) | `brain.ts` | `/api/brain/{learn,verify,recall,decisions}` | ~180 | ✅ 2026-05-21 (+ GAP-004 decisions history) |
| action-items | `action-items.ts` | `/api/action-items`, `/api/action-items/pending-review` | ~50 | ✅ 2026-05-21 (Sprint A.2) |
| topics (partial) | `topics.ts` | `/api/topics`, `/api/topics/health` | ~15 | ✅ 2026-05-21 (Sprint A.3) |
| digest (partial) | `digest.ts` | `/api/daily-summary`, `/api/digests` | ~40 | ✅ 2026-05-21 (Sprint A.4) |
| **pr** | **`pr.ts`** | **all 10 routes: `/api/pr/{list,review,enrich,create,post-review,commits,watch[GET/POST/DELETE],watched-summary}`** | **~580** | **✅ 2026-05-21 (Sprint A.1 followup)** |
| brain (rest) | `brain.ts` (TODO) | `/api/brain/{context,decide,decide/stream}` | ~280 | ⏳ has `brainContextCache` + past-outcome enrichment — extract carefully (Sprint C) |
| action-items (rest) | `action-items.ts` (TODO) | dynamic `/api/action-items/:id/{confirm,dismiss}` | ~20 | ⏳ needs path-pattern matching in dispatcher |
| topics (rest) | `topics.ts` (TODO) | `/api/topic-expert`, `/api/configure-topic` | ~400 | ⏳ needs `browserSession` in ctx |
| digest (rest) | `digest.ts` (TODO) | `/api/digest`, `/api/morning-brief`, `/api/weekly-report` | ~270 | ⏳ depends on `withStaleFallback` helper extraction |
| jira | `jira.ts` (TODO) | `/api/jira/*` | ~1100 | ⏳ Sprint C — has `sprintMeta` cache |
| teams | `teams.ts` (TODO) | `/api/teams*` | ~400 | ⏳ Sprint D |
| calendar | `calendar.ts` (TODO) | `/api/calendar/*` | ~250 | ⏳ Sprint D |
| teammates | `teammates.ts` (TODO) | `/api/teammates*` | ~150 | ⏳ Sprint D |
| code-graph | `code-graph.ts` (TODO) | `/api/code-graph/*` | ~300 | ⏳ Sprint D |
| sync | `sync.ts` (TODO) | `/api/sync/*` | ~200 | ⏳ Sprint D — long-lived, careful |
| notebooks / search / misc | various (TODO) | ~1000 | ⏳ Sprint D long tail |

**Currently extracted:** 20 routes, ~865 LOC (4 brain + 2 action-items + 2 topics + 2 digest + 10 pr).
**Remaining in `web-server.js`:** ~5800 LOC. Target after full REFACTOR-001: < 500 LOC (entry + middleware only).

**Smoke coverage:** every extracted route has at least one assertion in `scripts/smoke-bridge.sh`. The bridge smoke now has **27 checks** (was 13 before REFACTOR-001 started).

## Latent bugs surfaced during PR extraction

TypeScript caught three issues the JS happily tolerated. All were verbatim-preserved at runtime (so behaviour matches), but documented for follow-up:

1. **`/api/pr/list` `state` param** — JS allowed any string; TS sig requires `'open' | 'closed' | 'all'`. Port coerces unknown values to `'open'` (same effective behavior).
2. **`/api/pr/review` `meta.head.sha` access** — `GithubPRMcp.head` is typed as `{ ref: string }` with no `sha` field. JS read it via dynamic access and got `undefined`. Cast preserves the read; **either the upstream type should be widened OR the MCP path's cache key is always empty (and only the gh-CLI fallback path actually populates it)**.
3. **`/api/pr/review` `researchContext` passed to `analyzer.reviewPR()`** — `PRReviewInput` has no `researchContext` field. The analyzer body never reads the symbol. The field was always dropped at runtime. Port simply doesn't pass it; behaviour identical. **If we want PR research to actually influence the review, that's a real follow-up: add the field to `PRReviewInput` and use it inside `reviewPR()`.**

## Shared helpers extracted alongside

- `src/intelligence/knowledge-enrichment.ts` — `enrichKnowledgeFromResearch` was inlined in `web-server.js` with 3 call sites. Moved to a proper TS module so both the legacy bridge and `pr.ts` share one source. Behaviour unchanged.

## Pattern

Each route family exports a `RouteHandler[]` consumed by the dispatcher near the top of
`web-server.js`'s request handler. The dispatcher walks `EXTRACTED_ROUTES` and the first
exact match wins; unmatched requests fall through to the legacy `if (path === ...)` chain.

### File template

```ts
// src/routes/<family>.ts
import { json, readBody } from './_util.js';
import type { RouteHandler } from './_types.js';

const someRoute: RouteHandler = {
  method: 'POST',
  path: '/api/<family>/<endpoint>',
  async handle(req, res, ctx) {
    // ctx.db is always available. ctx.palaceClient / ctx.memoryEnricher may be undefined.
    // Always end the response with json(res, ...) or res.end().
  },
};

export const <family>Routes: RouteHandler[] = [someRoute /*, ... */];
```

### Wiring into the bridge

1. **Import** in `web-server.js` near the other route imports:
   ```js
   import { <family>Routes } from './dist/routes/<family>.js';
   ```
2. **Register** in the `EXTRACTED_ROUTES` array (also at module top):
   ```js
   const EXTRACTED_ROUTES = [
     ...brainRoutes,
     ...<family>Routes,
   ];
   ```
3. **Delete** the original `if (path === ...)` blocks for those routes inside
   `setupHandlers()`. Replace with a one-line marker comment pointing at the
   new file so a grep for the path still leads somewhere useful.

## Extracting a new family — checklist

1. **Read the existing blocks** end-to-end. Note any closure captures (caches, helpers).
2. **Port closure state** into one of:
   - Module-level state inside the new `routes/<family>.ts` file (if the cache is per-family).
   - A new field on `RouteContext` in `_types.ts` (if it crosses families).
3. **Helpers** — anything in `web-server.js` scope (`parseBody`, etc.) needs either a
   TS equivalent in `_util.ts` or to be passed via `ctx`. Don't reach into the
   bridge's module scope from a route module — that's the whole point of the refactor.
4. **Verbatim port**: same response shapes, same error codes, same headers.
5. **Add a smoke assertion** in `scripts/smoke-bridge.sh` for at least one canonical
   request per extracted route. The smoke suite is the contract.
6. **Run** `npm run typecheck && npm run build && npm run smoke:bridge`. Must be 100% green.
7. **Delete** the original blocks. Leave a one-line marker comment with the date and
   destination file so the path still resolves a grep.
8. **Update** the status table at the top of this README.

## What stays in `web-server.js`

Even after the full refactor, some things should NOT be extracted:

- **Server entry + middleware** (CORS, auth, route dispatch loop, OPTIONS preflight)
- **`json` / `readBody` helpers** stay there for the legacy if-chain; the TS twins in
  `_util.ts` exist for the extracted modules
- **Boot block** (agent registration, watchers) — orchestration of long-lived background
  state, not request handling
- **Top-level imports** that the boot block uses

## Why this approach (not a full Hono/Express rewrite)

ADR-002 set the precedent: extractable later. The dispatcher loop is the smallest possible
abstraction that lets us pull handlers out one family at a time, with smoke catching any
behaviour drift. A framework swap (Hono / Express / fastify) would be the next step
**after** the file is small enough for one person to hold in their head.
