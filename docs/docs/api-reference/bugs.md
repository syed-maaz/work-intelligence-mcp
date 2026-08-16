# Bugs API — REST reference

**Source:** `src/routes/bugs.ts`
**Schema:** v54 (Phase A: v53 — five tables. Phase B: v54 — `bugs.last_investigation_id` column + `bug-investigator` `model_config` row.)
**Architecture:** [Self-Healing Bug Loop (Phase A + B)](../architecture/self-healing-bug-loop.md)
**Agent:** [BugInvestigatorAgent](../architecture/bug-investigator-agent.md)
**ADR:** [ADR-030](../adr/adr-030-self-healing-bug-loop.md)

The bug-capture loop's REST surface. Five endpoints + an aggregate block on `/api/system-health`.

All endpoints return the standard WI envelope:
- `2xx` → `{ ok: true, ...data }`
- `4xx`/`5xx` → `{ ok: false, error: { code, message } }`

CORS allow-list applies. Denied origins get no CORS headers — verified by smoke § 11f.

---

## `POST /api/bugs/report`

Single capture entry point. Idempotent via single-statement UPSERT keyed on the deterministic 16-char fingerprint.

### Request

```json
{
  "source": "bridge",
  "errorName": "TypeError",
  "message": "Cannot read property 'x' of undefined at line 1234",
  "stack": "TypeError: ...\n    at handler (/src/routes/pr.ts:89:7)",
  "file": "src/routes/pr.ts",
  "line": 89,
  "context": { "req_id": "abc-123", "route": "/api/pr/create" },
  "build": "dev"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `source` | `'bridge' \| 'agent' \| 'web-ui' \| 'sync' \| 'bug-investigator'` | yes | Surface that captured the error. |
| `errorName` | `string` (1–200) | yes | `Error.name` or a synthetic label. |
| `message` | `string` (1–2000) | yes | Raw error message. Server normalizes before fingerprinting. |
| `stack` | `string` (≤ 20000) | optional | Full stack. Server extracts `top_frame` per the wrapper allowlist. |
| `file` | `string` (≤ 500) | optional | Source file (web-UI captures from `window.onerror`). |
| `line` | `number` (≥ 0) | optional | Line number (web-UI). |
| `context` | `Record<string, unknown>` | optional | Free-form context blob. Stored as `context_json TEXT`. |
| `build` | `'dev' \| 'preview' \| 'production'` | optional | Web-UI captures only; ignored server-side if `source !== 'web-ui'`. |

### Response

```json
{
  "ok": true,
  "fingerprint": "ab12cd34ef567890",
  "occurrence_count": 1,
  "is_new": true,
  "severity": "low"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `fingerprint` | `string` (16 hex chars) | sha256-based; `source\|errorName\|normalizedMessage\|topFrame`. |
| `occurrence_count` | `number` | Number of times this fingerprint has been captured. `1` on first call. |
| `is_new` | `boolean` | `true` only when `occurrence_count === 1` (this call inserted the row). |
| `severity` | `'low' \| 'medium' \| 'high'` | Recomputed against `bug_occurrences` on every capture (see [severity rules](../architecture/self-healing-bug-loop.md#severity-recomputation-a-real-query-not-a-guess)). |

### Side effects

- One row appended to `bug_occurrences` (always — regardless of new vs. UPSERT path).
- One stderr line written to bridge:
  ```
  [Bugs] capture: source=bridge name=TypeError fp=ab12cd34ef567890 (new|+5)
  ```
- Severity recomputed; if `severity != 'low'` the row's severity column is updated.

### Error responses

- `400 invalid_body` — Zod validation failed. Message names the offending field.
- `500 capture_failed` — DB write threw. Body contains `error.message`.

### Examples

**First call:**

```bash
$ curl -X POST http://localhost:3132/api/bugs/report \
    -H 'Content-Type: application/json' \
    -d '{"source":"bridge","errorName":"E","message":"x"}'
{"ok":true,"fingerprint":"d26a6e09c40e19d9","occurrence_count":1,"is_new":true,"severity":"low"}
```

**Second call, same fingerprint:**

```bash
$ curl -X POST http://localhost:3132/api/bugs/report \
    -H 'Content-Type: application/json' \
    -d '{"source":"bridge","errorName":"E","message":"x"}'
{"ok":true,"fingerprint":"d26a6e09c40e19d9","occurrence_count":2,"is_new":false,"severity":"low"}
```

---

## `GET /api/bugs`

List bugs. Filters apply at the SQL layer; pagination via `limit` + `offset`.

### Query parameters

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `status` | `'new' \| 'investigating' \| 'proposed' \| 'auto-merged' \| 'resolved' \| 'wont-fix'` | (all) | Filter by status. |
| `source` | (one of the 5 sources) | (all) | Filter by capture surface. |
| `severity` | `'low' \| 'medium' \| 'high'` | (all) | Filter by severity. |
| `limit` | `number` (1–500) | `50` | Max rows. Coerced from string. |
| `offset` | `number` (≥ 0) | `0` | Pagination offset. |

### Response

```json
{
  "ok": true,
  "bugs": [
    {
      "id": 42,
      "fingerprint": "ab12cd34ef567890",
      "source": "bridge",
      "error_name": "TypeError",
      "message": "Cannot read property 'x' of undefined",
      "top_frame": "src/routes/pr.ts:89",
      "first_seen_at": "2026-05-31T14:00:00.000Z",
      "last_seen_at":  "2026-05-31T14:30:00.000Z",
      "occurrence_count": 12,
      "status": "new",
      "severity": "medium",
      "context_json": "{\"route\":\"/api/pr/create\"}",
      "investigation_attempts": 0
    }
  ],
  "total": 42
}
```

`bugs` is ordered by `last_seen_at DESC`. `total` reflects the post-filter count (pre-pagination), so `total > bugs.length` when paginating.

### Error responses

- `400 invalid_query` — Zod validation failed (e.g. `severity=critical` rejected).

### Examples

```bash
# Top 10 unresolved bugs
$ curl 'http://localhost:3132/api/bugs?status=new&limit=10'

# All web-UI captures from the last refresh
$ curl 'http://localhost:3132/api/bugs?source=web-ui&limit=200'

# Triage queue
$ curl 'http://localhost:3132/api/bugs?severity=high&status=new'
```

---

## `GET /api/bugs/:id`

Single bug detail with the last 50 occurrences, the most recent investigation (Phase B), and the most recent resolver attempt (Phase C).

### Path parameter

- `id` — positive integer matching `bugs.id`.

### Response

```json
{
  "ok": true,
  "bug": { ... full BugRow as in /api/bugs ... },
  "recent_occurrences": [
    { "seen_at": "2026-05-31T14:30:00.000Z" },
    { "seen_at": "2026-05-31T14:25:12.000Z" },
    "..."
  ],
  "investigation": null,
  "latest_resolution": null
}
```

Phase A always returns `investigation: null` and `latest_resolution: null`. **Phase B** populates `investigation` from `bug_investigations` when the BugInvestigatorAgent has run on this bug. **Phase C** populates `latest_resolution` from `bug_resolutions` when the user has clicked "Resolve this" at least once. Both stay `null` indefinitely if the corresponding agent never ran on this bug.

The `investigation` shape:

```ts
interface BugInvestigation {
  id: number;
  bug_id: number;
  root_cause: string;          // one-sentence summary from the brain
  files_to_change: string;     // JSON-encoded string[] of file paths
  lines_changed: number;       // estimate from the brain
  confidence: number;          // 0..1
  suggested_patch: string | null;  // unified diff or null when the brain declined
  decided_at: string;          // ISO-8601
  brain_decision_id: number | null;  // FK back to brain_decisions
}
```

The `latest_resolution` shape (Phase C / v56):

```ts
interface BugResolution {
  id: number;
  bug_id: number;
  attempt_at: string;                         // ISO-8601
  outcome: 'auto-resolved' | 'unable-to-resolve';
  cwd: string;                                // WI repo root in Phase 76
  files_changed: string | null;               // JSON-encoded string[] of paths
  commit_sha: string | null;                  // set on success
  failure_reason: string | null;              // set on unable-to-resolve
  brain_decision_id: number | null;           // always NULL in Phase 76
}
```

`bugs.last_investigation_id` (added in v54) lets `/api/bugs/:id` find the latest investigation in O(1) instead of scanning `bug_investigations`. The `latest_resolution` lookup uses the `idx_bug_resolutions_bug_attempt(bug_id, attempt_at DESC)` index added in v56 — single-row scan.

### Error responses

- `400 invalid_id` — `id` not a positive integer.
- `404 not_found` — no bug with that id.

---

## `POST /api/bugs/:id/resolve`

Mark a bug resolved or won't-fix. Updates `status`; everything else is preserved (including `occurrence_count`, so future captures of the same fingerprint will increment but stay in the resolved status until manually reopened).

### Path parameter

- `id` — positive integer matching `bugs.id`.

### Request

```json
{
  "resolution": "resolved",
  "note": "Optional human note (≤ 2000 chars)"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `resolution` | `'resolved' \| 'wont-fix'` | yes | Sets `bugs.status` to this value. |
| `note` | `string` (≤ 2000) | optional | Future: stored alongside the row. Currently a no-op (Phase A doesn't have a notes table). |

### Response

```json
{
  "ok": true,
  "bug": { ... full BugRow with updated status ... }
}
```

### Error responses

- `400 invalid_id` — `id` not a positive integer.
- `400 invalid_body` — Zod validation failed.
- `404 not_found` — no bug with that id (or no row was updated).

---

## `POST /api/bugs/:id/reinvestigate`

**Phase B (75-05).** Reset a bug so the BugInvestigatorAgent picks it up on its next polling tick. Useful when the previous investigation was wrong (low confidence, stale evidence) or when fresh occurrences have arrived since the investigation was decided.

### Path parameter

- `id` — positive integer matching `bugs.id`.

### Request

Empty body. (`POST` with no payload; the route accepts `{}` for parity with the other mutation endpoints.)

### Behaviour

Single `UPDATE` statement, atomic:

```sql
UPDATE bugs
   SET status='new',
       last_investigation_id=NULL,
       investigation_attempts=0
 WHERE id=?
```

The previous `bug_investigations` row is **preserved** (the FK on `last_investigation_id` is `ON DELETE SET NULL`, but we don't delete the row — we just stop pointing at it). The next agent tick (≤ `BUG_INVESTIGATOR_INTERVAL_MS`, default 5 min) will pick the row up, write a new investigation, and update `last_investigation_id` to point at the new row.

### Response

```json
{
  "ok": true,
  "bug": { ... full BugRow with status='new' and investigation_attempts=0 ... }
}
```

### Error responses

- `400 invalid_id` — `id` not a positive integer.
- `404 not_found` — no bug with that id.

### Example

```bash
$ curl -X POST http://localhost:3132/api/bugs/42/reinvestigate
{"ok":true,"bug":{"id":42,"status":"new","investigation_attempts":0,"last_investigation_id":null,...}}
```

UI surface: the Re-investigate button on the `/bugs` Investigation tab side panel (Phase B).

---

## `POST /api/bugs/:id/resolve-attempt`

**Phase C (76).** Triggers the `BugResolverAgent` against a `'proposed'` bug — applies the proposed patch, runs typecheck, commits locally on the current branch. **Never pushes.**

### Path parameter

- `id` — positive integer matching `bugs.id`.

### Request

Empty body. The bug ID + the latest `bug_investigations` row already on disk drive everything; no input shape needed.

### Behaviour

1. Killswitch check — if `BUG_RESOLVER_ENABLED!=1`, returns 400 `resolver_disabled` immediately.
2. Bug must exist and be in `'proposed'` status; otherwise 404 / 400 respectively.
3. Atomic flip via `UPDATE bugs SET status='resolving' WHERE id=? AND status='proposed'`. Concurrent double-clicks land at most one transition (the loser gets 400 `race_lost`).
4. Bug ID is enqueued onto the agent's in-memory queue. The agent's 1-second heartbeat picks it up and runs the apply pipeline (see [bug-resolver-agent.md](../architecture/bug-resolver-agent.md) for the full state machine).

The endpoint returns **immediately** with 202 — the agent runs asynchronously. The `/bugs` UI polls `GET /api/bugs/:id` every 2s while `status='resolving'` to refresh the badge + audit row.

### Response

```json
{
  "ok": true,
  "bug": { ... full BugRow with status='resolving' ... }
}
```

HTTP status: **202 Accepted** (the apply is in flight).

### Error responses

| Status | Code | When |
|---|---|---|
| 400 | `invalid_id` | `id` not a positive integer |
| 400 | `resolver_disabled` | `BUG_RESOLVER_ENABLED!=1` (default) |
| 400 | `invalid_status` | bug isn't in `'proposed'` state |
| 400 | `race_lost` | another request flipped the row first |
| 404 | `not_found` | no bug with that id |

### Example

```bash
$ curl -X POST http://localhost:3132/api/bugs/42/resolve-attempt
{"ok":true,"bug":{"id":42,"status":"resolving",...}}

# Default state (resolver opt-in not flipped):
$ curl -X POST http://localhost:3132/api/bugs/42/resolve-attempt
{"ok":false,"error":{"code":"resolver_disabled","message":"BUG_RESOLVER_ENABLED=0 — set to 1 and restart the bridge to enable"}}
```

UI surface: the **"Resolve this"** button (Wand2 icon, primary variant) in the BugDetailPanel — visible only on `'proposed'` bugs.

Audit row: every attempt writes a `bug_resolutions` row regardless of outcome. The detail GET (`GET /api/bugs/:id`) returns the latest one as `latest_resolution`.

Full agent reference: [bug-resolver-agent.md](../architecture/bug-resolver-agent.md).

---

## `GET /api/system-health` — `bugs` block

Not a new endpoint. The existing `/api/system-health` response gains a `bugs` block in Phase A:

```json
{
  "dataQuality":   { "open": 0, "errors": 0 },
  "actionTriage":  { "pending": 12 },
  "agents":        { "...": "..." },
  "codeGraph":     { "...": "..." },
  "bugs": {
    "total": 42,
    "new": 3,
    "investigating": 0,
    "proposed": 0,
    "resolving": 0,
    "auto_resolved_24h": 0,
    "unable_to_resolve": 0,
    "auto_merged_24h": 0,
    "resolved_24h": 5,
    "top_fingerprints": [
      { "fingerprint": "ab12cd34ef567890", "error_name": "TypeError",
        "occurrence_count": 12, "severity": "medium" }
    ],
    "investigator_status": "ready",
    "resolver_status": "disabled",
    "auto_merge_cooldown_until": null
  },
  "lastSync": "2026-05-31T14:00:00Z"
}
```

| Field | Phase A | Phase B (live) | Phase C (live) | Phase 77 will add |
|-------|---------|----------------|-----------------|-------------------|
| `total` | live count | — | — | — |
| `new`, `investigating`, `proposed` | live counts | — | — | — |
| `resolving` | — | — | live count of bugs being applied | — |
| `auto_resolved_24h` | — | — | live count (24h window) of resolver-committed bugs | — |
| `unable_to_resolve` | — | — | live count (terminal — no time window) | — |
| `auto_merged_24h` | always `0` | — | — | Phase 77 fills in |
| `resolved_24h` | live count of bugs resolved within last day | — | — | — |
| `top_fingerprints[]` | top 5 unresolved by `occurrence_count` | — | excludes terminal `'auto-resolved'` and `'unable-to-resolve'` | — |
| `investigator_status` | always `'not-implemented'` | one of `'ready' \| 'degraded' \| 'crashed' \| 'disabled'` derived from agent health | — | — |
| `resolver_status` | always `'not-implemented'` | — | one of `'ready' \| 'degraded' \| 'crashed' \| 'disabled'` derived from agent health (defaults to `'disabled'` because `BUG_RESOLVER_ENABLED=0` is the default) | — |
| `auto_merge_cooldown_until` | always `null` | — | — | Phase 77 fills in (rate-limit cooldown ISO-8601) |

Source: `buildBugsHealthBlock(db, investigatorStatus, resolverStatus)` exported from `src/routes/bugs.ts`.

---

## Internal-only: `GET /internal/throw-uncaught`

**Dev/test fixture.** Gated behind `NODE_ENV !== 'production'`. Throws via `setImmediate` so the throw escapes the route's try/catch and trips `process.on('uncaughtException')`. Used by manual end-to-end verification and (eventually) the Phase B killswitch smoke harness.

```bash
$ curl 'http://localhost:3132/internal/throw-uncaught?msg=SyntheticUncaught'
{"ok":true,"scheduled":"SyntheticUncaught"}
# Bridge stderr:
# [Bugs] uncaughtException: SyntheticUncaught
# A row appears in /api/bugs?source=bridge with error_name=Error and the synthetic message.
```

In production builds (`NODE_ENV=production`) the endpoint returns `404 not_found`.

---

## Programmatic capture (in-process)

`captureBug(db, payload)` is exported from `src/routes/bugs.ts` for use by code that runs inside the bridge process — primarily the `process.on('uncaughtException')` / `process.on('unhandledRejection')` shims and the `withAgentTick` catch arm in `web-server.js`. Going through the HTTP path is wrong for those callers because the HTTP path may be exactly what just crashed.

```ts
import { captureBug } from './dist/routes/bugs.js';

try {
  // ... risky work ...
} catch (err) {
  try {
    captureBug(db, {
      source: 'bridge',
      errorName: err?.name || 'UnknownError',
      message: String(err?.message || err),
      stack: err?.stack || null,
      context: { phase: 'whatever' },
    });
  } catch { /* swallow — capture failure must not crash the caller */ }
}
```

Always wrap calls in an outer try/catch. The function itself uses a transaction internally, but a DB-level failure (corrupt schema, disk full) will still throw.

---

## Smoke gate (§ 11)

`scripts/smoke-bridge.sh` § 11 — seven assertions on this surface. See [the architecture doc](../architecture/self-healing-bug-loop.md#smoke-gates) for the full list. Run with `npm run smoke:bridge`; bridge must be live on `:3132`.
