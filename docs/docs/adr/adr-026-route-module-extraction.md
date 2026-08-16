---
sidebar_position: 26
title: ADR-026 Route Module Extraction
---

# ADR-026: Route Module Extraction Pattern

| Field | Value |
|-------|-------|
| **Status** | ✅ Accepted — opening pass shipped 2026-05-21 |
| **Date** | 2026-05-21 |
| **Deciders** | Maaz |
| **Drives** | REFACTOR-001 (web-server.js monolith) |
| **Related** | [ADR-002 — Single Server Now, Extractable Later](./adr-002-single-server) |

## Context

`web-server.js` was 6.4 k LOC by mid-May 2026. It served as the HTTP bridge between the web UI / OpenClaw plugin and the brain + connectors. Every new endpoint landed inline, growing the file by ~80 LOC/week. The size produced three concrete pains:

1. **No unit-testable boundaries.** Every route closes over `db`, helper functions (`json`, `readBody`, `parseBody`), and module-level caches (`brainContextCache`, `sprintMeta`, …). You can't test a single handler without booting the whole bridge.
2. **Code-review surface explosion.** A 50-LOC route addition shows up as a diff against a 6.4 k LOC file. The reviewer has to remember the rest of the file's local state to validate it.
3. **TS / JS gap.** `web-server.js` is JavaScript; all the business logic it dispatches to is TypeScript. The route handlers themselves get no type checking — typos in field names compile fine.

ADR-002 ("single server now, extractable later") gave permission to grow. The bill is now due. But a full framework rewrite (Hono / Express / Fastify) is too big a single change — it would touch every endpoint and lose months of incremental smoke confidence.

## Decision

Extract routes **one family at a time** into typed handler modules under `src/routes/<family>.ts`, preserving the existing request-dispatch loop in `web-server.js`. Each extraction is small enough to land in one commit with full smoke coverage.

### The pattern

1. **Each family** (`brain`, `pr`, `jira`, `teams`, …) gets its own TypeScript module that exports a `RouteHandler[]`:

   ```ts
   // src/routes/<family>.ts
   import { json, readBody } from './_util.js';
   import type { RouteHandler } from './_types.js';

   const someRoute: RouteHandler = {
     method: 'POST',
     path: '/api/<family>/<endpoint>',
     async handle(req, res, ctx) {
       // ctx.db is always available
       // ctx.palaceClient / ctx.memoryEnricher may be undefined
       // Handler MUST end the response.
     },
   };

   export const <family>Routes: RouteHandler[] = [someRoute /*, ... */];
   ```

2. **`web-server.js` dispatches** through a shared `EXTRACTED_ROUTES` array before its legacy if-chain:

   ```js
   import { brainRoutes } from './dist/routes/brain.js';
   const EXTRACTED_ROUTES = [...brainRoutes /*, ...prRoutes, ... */];

   // In the request handler:
   for (const route of EXTRACTED_ROUTES) {
     if (route.method === req.method && route.path === path) {
       await route.handle(req, res, ctx, url);
       return;
     }
   }
   // Fall through to legacy if-chain for unmigrated routes…
   ```

3. **Original blocks are deleted** from `web-server.js`, replaced by a one-line marker comment pointing at the new file so `grep` still finds where the route lives.

4. **Each extraction adds a smoke check** to `scripts/smoke-bridge.sh` that exercises the canonical request shape for the moved route. The smoke suite becomes the contract.

### Shared infrastructure

- `src/routes/_types.ts` — `RouteHandler`, `RouteContext`, `HttpMethod` types
- `src/routes/_util.ts` — TS-native `json()` and `readBody()` (parallels the JS twins in `web-server.js`; both work, both compatible with the per-request `res._corsHeaders`)
- `src/routes/README.md` — live status table + 7-step extraction checklist + per-family migration order

### Migration order (low-risk → high-risk)

| Order | Family | Notes |
|---|---|---|
| 1 | `brain` (partial, opening pass) | `learn`, `verify`, `recall` extracted 2026-05-21. `context`, `decide`, `decide/stream` deferred — they hold `brainContextCache` + past_outcome enrichment logic |
| 2 | `pr` | pure SQL, no caches; biggest family after brain |
| 3 | `action-items`, `topics`, `digest` | all small, all simple |
| 4 | `brain` (remainder) | move the cache into the route module's module scope; preserve past_outcome JSON enrichment |
| 5 | `jira` | has `sprintMeta` cache — adds a field to `RouteContext` |
| 6 | `teams`, `calendar`, `teammates`, `code-graph`, `sync` | individually small |

## Why not a full framework rewrite

| Alternative | Rejected because |
|---|---|
| **Hono / Fastify / Express** | Forces a single big-bang change across all 80 endpoints. Loses months of smoke-tested behaviour. Adds a runtime dependency without solving the actual pain (which is the file size, not the dispatch style). |
| **Inline refactor (extract route handlers as JS functions in the same file)** | Doesn't gain type safety. Doesn't shrink the file. Defers the real fix. |
| **Auto-generated routes from a manifest** | We already have a tool manifest (ADR-025). Routes are a different surface — most are not in the manifest because they back the web UI, not Atlas. A separate auto-gen layer would be premature. |

## Consequences

### Positive

- **Each extraction is independently verifiable.** Smoke runs in < 2 s; if it stays green, the extraction landed safely.
- **Type safety per family.** Once a route is in `src/routes/`, it gets `tsc` on every change.
- **Reviewable diffs.** Adding a new route is a 30-LOC change to a per-family file, not a needle in the 6.4 k haystack.
- **No runtime overhead.** The dispatcher loop is O(N) where N is small (the table is iterated once per request and matches early; the legacy if-chain is unchanged). Smoke confirms request latency is unaffected.
- **Reversible per family.** If an extraction misbehaves, revert the file + remove the entry from `EXTRACTED_ROUTES`. The bridge keeps working.

### Negative

- **Two dispatch paths during migration.** `EXTRACTED_ROUTES` runs first, then the legacy if-chain. Slight cognitive overhead until the migration is complete.
- **Eventual framework swap still possible.** Once `web-server.js` is < 500 LOC (entry + middleware + boot block), a Hono/Express swap becomes a one-day project. This ADR doesn't preclude it; it just doesn't pay the cost up front.
- **Modules must not reach into bridge scope.** A common pitfall during extraction is referencing `web-server.js`-scope variables (caches, env-derived constants). Anything cross-family belongs on `RouteContext`; anything family-local belongs in the route module's module scope.

## Implementation Status

| Component | File | Status |
|---|---|---|
| `RouteHandler` / `RouteContext` types | `src/routes/_types.ts` | ✅ shipped 2026-05-21 |
| TS-native helpers (`json`, `readBody`) | `src/routes/_util.ts` | ✅ shipped 2026-05-21 |
| Dispatcher loop | `web-server.js` (~10 LOC at top of request handler) | ✅ shipped 2026-05-21 |
| Migration status doc | `src/routes/README.md` | ✅ shipped 2026-05-21 |
| Brain routes (3 of 6) | `src/routes/brain.ts` — `learn`, `verify`, `recall` | ✅ shipped 2026-05-21 |
| Smoke coverage for extracted routes | `scripts/smoke-bridge.sh` — 3 new checks | ✅ shipped 2026-05-21 |
| Brain routes (remaining 3) | `context`, `decide`, `decide/stream` | 🔲 pending — has local cache + enrichment |
| All other families | `pr`, `jira`, `teams`, `topics`, `digest`, `action-items`, `calendar`, `teammates`, `code-graph`, `sync` | 🔲 pending — see `src/routes/README.md` |

## Alternatives Considered

1. **Full Hono / Express rewrite.** Rejected — too big a single change, no incremental safety net.
2. **Move handlers to JS modules (not TS).** Rejected — same language as the host file, no type-safety win.
3. **Auto-generate routes from `src/tools/manifest.ts`.** Rejected — manifest covers Atlas-shaped tool calls, not the web-UI endpoints. Different surface.
4. **Keep the monolith forever.** Rejected — file grows ~80 LOC/week, will be 8 k LOC by milestone v1.3 at current cadence.

## Related

- [ADR-002 — Single Server Now, Extractable Later](./adr-002-single-server) — the original "we'll deal with this later" decision
- [`/.planning/ADR-REVIEW.md` REFACTOR-001](https://github.com/your-org/work-intelligence-mcp/blob/main/.planning/ADR-REVIEW.md) — the live tracker
- [`src/routes/README.md`](https://github.com/your-org/work-intelligence-mcp/blob/main/src/routes/README.md) — extraction checklist + per-family status
