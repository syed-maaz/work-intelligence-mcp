# BugResolverAgent — ADR-030 Phase C (Phase 76)

> **Status:** Shipped 2026-06-01
> **Killswitch:** `BUG_RESOLVER_ENABLED=0` (default — opt-in)
> **Source:** `src/intelligence/bug-resolver-agent.ts`
> **Schema:** v56 — adds `bug_resolutions` audit table + widens `bugs.status` enum

The BugResolverAgent is the third stage of the [Self-Healing Bug Loop](./self-healing-bug-loop.md). It picks up bugs that the [BugInvestigatorAgent](./bug-investigator-agent.md) has flagged as `proposed` (root cause + suggested patch already written), and **applies** the patch to **WI's own source code** with a strict safety scope.

This is the first agent in WI that *mutates the working tree* — every code path is gated, every external call is injectable for tests, and `git push` is never invoked.

## Scope (binary, locked)

The resolver classifies every file in a proposed patch into one of two buckets via `src/services/bugs/path-classifier.ts`:

| Bucket | Examples | Action |
|---|---|---|
| **ALLOWED** | `src/routes/bugs.ts`, `web/src/pages/BugsPage.tsx`, `CLAUDE.md` | apply patch + typecheck + commit |
| **BLOCKED** | `repos/example-service/*`, `repos/operations/*`, `~/.claude/**`, anywhere outside WI | reject → `'unable-to-resolve'` |

The classifier resolves symlinks via `realpathSync` so a symlink that points into a sibling repo cannot slip through. Any single BLOCKED path in the patch fails the whole apply.

**Phase 76 never touches the customer repos under `./repos/`.** That's [Phase 77](./self-healing-bug-loop.md#phase-77-customer-repo-fixes) territory — different scope, different safety story (PRs against external repos, separate killswitch).

## State machine

```
                     ┌──────────────┐
                     │ user clicks  │
                     │ "Resolve     │
                     │  this"       │
                     └──────────────┘
                            │ POST /api/bugs/:id/resolve-attempt
                            ▼
                     ┌──────────────┐
                     │ status =     │
                     │ 'resolving'  │
                     └──────────────┘
                            │ enqueued for agent
                            ▼
                     ┌──────────────────────────────────────────┐
                     │ Pre-flight (each → unable-to-resolve)    │
                     │  1. investigation row exists w/ patch    │
                     │  2. patch is non-null, non-empty         │
                     │  3. classifyAllTargets(files_to_change)  │
                     │     → BLOCKED → bail                     │
                     │  4. git apply --check passes             │
                     └──────────────────────────────────────────┘
                            │ all pass
                            ▼
                     ┌──────────────────────────────────────────┐
                     │ Apply (in WI repo root):                  │
                     │  - git apply <patch>                      │
                     │  - npm run typecheck (root + web/ if      │
                     │    web files were touched)                │
                     │     → fail: git checkout -- . to revert   │
                     │       + 'unable-to-resolve'               │
                     │  - git commit -a -m "auto-fix: ..."       │
                     │    (current branch, NEVER push)           │
                     └──────────────────────────────────────────┘
                            │ success            │ failure
                            ▼                    ▼
                     ┌──────────────┐    ┌──────────────────┐
                     │  status =    │    │  status =         │
                     │ 'auto-       │    │ 'unable-to-       │
                     │  resolved'   │    │  resolve'         │
                     └──────────────┘    └──────────────────┘
                            │                    │
                            └────────┬───────────┘
                                     ▼
                     ┌──────────────────────────────────────────┐
                     │ Write bug_resolutions audit row:          │
                     │   outcome, cwd, files_changed, commit_sha,│
                     │   failure_reason (when applicable)        │
                     └──────────────────────────────────────────┘
```

## Hard rules (each tested)

1. **NEVER push** from any branch in the WI repo. The agent only ever calls `git apply`, `git commit`, `git rev-parse HEAD`. There is no code path to `git push`.
2. **NEVER touch `./repos/example-service/*`** — sibling-repo fence in the path classifier.
3. **NEVER touch `./repos/operations/*`** — sibling-repo fence in the path classifier.
4. **NEVER touch anywhere outside the WI repo** — outside-repo fence (`~/.claude`, `~/.openclaw`, `/tmp`, `..` escapes).
5. **NEVER apply a patch that fails `git apply --check`** — pre-flight gate 4.
6. **NEVER ship a change with broken types** — typecheck fail → `git checkout -- .` to revert.
7. **NEVER run when `BUG_RESOLVER_ENABLED=0`** — agent doesn't register at boot; endpoint returns 400 `resolver_disabled`.
8. **NEVER branch-switch.** Resolver commits on whatever the current branch is. Branch hygiene is the user's responsibility before clicking Resolve.

## Trigger surface

The agent has **no polling loop**. It ticks only when work is enqueued:

```
POST /api/bugs/:id/resolve-attempt
  ├── 400 'resolver_disabled' when BUG_RESOLVER_ENABLED!=1
  ├── 400 'invalid_status' when bug isn't 'proposed'
  ├── 400 'race_lost' when a concurrent request flipped first
  └── 202 → flips status 'proposed' → 'resolving' atomically + enqueues
```

The bridge registers the agent with a 1-second heartbeat that drains one queue item per tick. With the queue empty, every tick is a no-op.

## Audit row — `bug_resolutions`

One row per resolve attempt regardless of outcome:

```sql
CREATE TABLE bug_resolutions (
  id INTEGER PRIMARY KEY,
  bug_id INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  attempt_at TEXT NOT NULL,                                    -- ISO-8601
  outcome TEXT NOT NULL CHECK (outcome IN ('auto-resolved','unable-to-resolve')),
  cwd TEXT NOT NULL,                                           -- WI repo root in Phase 76
  files_changed TEXT,                                          -- JSON array of file paths
  commit_sha TEXT,                                             -- NULL when outcome='unable-to-resolve'
  failure_reason TEXT,                                         -- non-null when outcome='unable-to-resolve'
  brain_decision_id INTEGER REFERENCES brain_decisions(id)     -- NULL in Phase 76 (reserved for Phase 77)
);
CREATE INDEX idx_bug_resolutions_bug_attempt ON bug_resolutions(bug_id, attempt_at DESC);
```

The detail panel surfaces the latest row inline via `GET /api/bugs/:id` → `latest_resolution`.

## Dependency injection (testability)

Every external interaction is an injected function dep:

| Dep | Default | What tests do |
|---|---|---|
| `gitApplyCheck(patch, cwd)` | `git apply --check` via `execFileSync` | return true/false to simulate clean / dirty patch |
| `gitApply(patch, cwd)` | `git apply` via `execFileSync` | throw to simulate apply failure |
| `runTypecheck(touchedWeb, cwd)` | `npm run typecheck` (+ `web/ tsc` when needed) | return null = clean / string = error |
| `gitCheckoutHead(cwd)` | `git checkout -- .` | record call count to verify revert path |
| `gitCommit(msg, cwd)` | `git commit -a -m <msg> && git rev-parse HEAD` | return SHA / throw to simulate commit failure |

22 unit cases in `tests/intelligence/bug-resolver-agent.test.ts` cover every pre-flight failure path, the apply-success path, and the revert-on-typecheck-failure path — all without touching disk.

## Observability

| Surface | Field | Values |
|---|---|---|
| `GET /api/agents/health` | `BugResolverAgent.status` | `healthy` \| `degraded` \| `flaky` \| `crashed` (only present when `BUG_RESOLVER_ENABLED=1`) |
| `GET /api/system-health` | `bugs.resolver_status` | `'ready' \| 'degraded' \| 'crashed' \| 'disabled' \| 'not-implemented'` |
| `GET /api/system-health` | `bugs.resolving` | count of bugs currently in `'resolving'` state |
| `GET /api/system-health` | `bugs.auto_resolved_24h` | bugs the resolver locally committed in the last 24h |
| `GET /api/system-health` | `bugs.unable_to_resolve` | bugs the resolver bailed on (terminal) |
| stderr | `[BugResolver] resolved #<id> commit=<sha> files=<n>` | success log |
| stderr | `[BugResolver] unable-to-resolve #<id> reason="..."` | failure log |

## Smoke gates

| Gate | What it verifies |
|---|---|
| `smoke-bridge.sh § 11k` | `bugs.resolver_status` is one of the 5 valid values |
| `smoke-bridge.sh § 11l` | `BUG_RESOLVER_ENABLED` documented in `CLAUDE.md` |
| `smoke-bridge.sh § 11m` | `bug-resolver` bucket present in `/api/model-config` (8 buckets total) |
| `smoke-bridge.sh § 11n` | `POST /api/bugs/:id/resolve-attempt` returns 400 `resolver_disabled` when default |
| `smoke-bug-resolver-killswitch.sh` | Spawns child bridge with `BUG_RESOLVER_ENABLED` unset; asserts boot + stderr disable line + agent absent + endpoint returns 400 |

## Operational tuning

| Knob | Default | When to change |
|---|---|---|
| `BUG_RESOLVER_ENABLED` | `0` | Set to `1` to opt in. Conservative default — the user must explicitly enable. |
| `model_config.bug-resolver.model` | `claude-opus-latest / max / off` | Reserved for Phase 77 brain-escalation; not used by Phase 76's local-apply path. |

## Why this isn't [Phase D — auto-merge](./self-healing-bug-loop.md#phase-d-auto-merge) under another name

| Concern | Phase 76 (this) | Phase 77 / Phase D (out of scope) |
|---|---|---|
| Trigger | User click | Background agent + 7-condition gate |
| Target | WI's own source | Customer repos (example-service, operations) |
| Action | Apply + commit on current branch | Apply + commit + open PR + (gated) merge |
| Push | NEVER | Yes (PR creation requires push to remote) |
| Reach | Local working tree only | Customer repo's CI + production deploys |
| Killswitch default | `BUG_RESOLVER_ENABLED=0` | `BUG_AUTO_MERGE=0` (already documented in Phase 74) |

Phase 76 is **strictly less powerful** than Phase 77 will be. The two killswitches are independent — you can enable Phase 76 (resolve own bugs locally) without ever enabling Phase 77 (auto-PRs against customer repos), and that's the expected default for a long time.

## Refs

- [ADR-030 — Self-Healing Bug Loop](../adr/adr-030-self-healing-bug-loop.md) § Phase C
- [Self-Healing Bug Loop overview](./self-healing-bug-loop.md)
- [BugInvestigatorAgent (Phase B / Phase 75)](./bug-investigator-agent.md) — predecessor
- `src/services/bugs/path-classifier.ts` — pure-function ALLOWED/BLOCKED classifier
- `src/intelligence/bug-resolver-agent.ts` — agent implementation
- `tests/intelligence/bug-resolver-agent.test.ts` — 22 unit cases
- `tests/services/bugs/path-classifier.test.ts` — 21 classifier cases
