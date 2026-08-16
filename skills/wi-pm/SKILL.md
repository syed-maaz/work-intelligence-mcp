---
name: wi-pm
description: PM Orchestration for WI board (ADR-043). Capture, prioritize, rank, and query the backlog. Use when the user says "add to backlog", "what's next", "prioritize X", "backlog", or references what to work on.
version: 1.0.0
author: Maaz
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [PM, Backlog, Board, ADR-043, WI]
    related_skills: [wi-status, wi-save-to-ticket]
triggers:
- backlog
- what's next
- what should I do first
- prioritize
- add to backlog
- what do I do next
---

# wi-pm — PM Orchestration Skill (ADR-043 Phase 2)

Turn conversation into a **prioritized, queryable backlog** on the WI kanban board (ADR-040). Files real tickets — never `.claude/plans/*.md`. Ranks with explicit contribution breakdown. Answers "what's next".

## Prerequisites

- WI bridge running on port 3132
- `OUTCOME_HONEST_KANBAN_ENABLED=1` (board substrate)
- `PM_ORCHESTRATION_ENABLED=1` (this skill's endpoints)
- Migration v99+ applied (`priority`, `effort_points`, `intent` columns on `tasks`)

## Verify readiness

```bash
BRIDGE=${WI_BRIDGE:-http://localhost:3132}
# GET /api/board/backlog should return 200 with { top_task_id, backlog: [] }.
# 404 = flag off or bridge stale — restart with both env flags set.
curl -fsS "$BRIDGE/api/board/backlog" | jq '.top_task_id, (.backlog | length)'
```

## Commands

### `capture` — file a new card

Turn the user's text into a card. Extract `title` (≤120 chars), propose `intent` + `priority` + `effort_points`, show the user the proposal inline, then POST after confirmation.

**Intent classification (LLM decides, user overrides):**
- `brainstorm` — vague idea, no clear delivery ("we should probably rethink X", "what about a plugin for Y")
- `plan` — needs planning before build ("figure out how to migrate X", "spike the Y approach")
- `execute` — buildable now ("add rate limiting to search-provider proxy", "fix JIRA-15702")
- `decide` — an unresolved decision ("do we use library X or Y", "pick between approaches A/B/C")

**Priority proposal heuristic:**
- Explicit bug / regression / broken flow → 80-95
- Feature/improvement with clear value → 55-75
- Nice-to-have, exploratory → 30-50
- Brainstorm/idea → 20-40

**Effort proposal heuristic (Fibonacci 1,2,3,5,8,13):**
- One file change or config tweak → 1
- Small isolated change → 2
- Contained feature, single subsystem → 3
- Spans two subsystems → 5
- Multi-subsystem or unclear scope → 8
- Multi-week / very unclear → 13
- Truly uncertain → leave null

**Flow:**

```bash
# Propose inline like:
#   Filed as card #NN (ready)
#   • title:   "add rate limiting to search-provider proxy"
#   • intent:  execute      (buildable now)
#   • priority: 75          (feature w/ clear value)
#   • effort:  3            (contained, single subsystem)
# User can override any before or after with:
#   /pm prioritize task_XXX 90   or   /pm effort task_XXX 5

BRIDGE=${WI_BRIDGE:-http://localhost:3132}
curl -fsS -X POST "$BRIDGE/api/board/tasks" \
  -H 'Content-Type: application/json' \
  -d '{
    "title":         "<title>",
    "goal_text":     "<one-line goal>",
    "acceptance_text": "<how we know it is done (optional)>",
    "intent":        "execute",
    "priority":      75,
    "effort_points": 3
  }' | jq '.task | {id, card_number, title, intent, priority, effort_points, kanban_column}'
```

### `next` — the single top card + full reason breakdown

```bash
BRIDGE=${WI_BRIDGE:-http://localhost:3132}
curl -fsS "$BRIDGE/api/board/backlog?limit=1" | jq '
  {
    top: .backlog[0] | {
      id, card_number, title, intent, priority, effort_points,
      rank_score,
      why: (.reasons | map(select(.contribution != 0)))
    }
  }'
```

Present in this shape (user reads the `why` — it's the "serving its purpose" bar):

```
🥇 Card #47 — "add rate limiting to search-provider proxy"
    intent: execute • priority: 75 • effort: 3
    rank_score: 76.5
    why:
      + priority       (contribution: +75.0)
      + age_bonus      (contribution:  +3.0)  # 3 days in ready
      - effort_penalty (contribution:  -1.5)  # effort=3 × 0.5
```

### `backlog` — the top N cards

```bash
BRIDGE=${WI_BRIDGE:-http://localhost:3132}
LIMIT=${1:-10}
curl -fsS "$BRIDGE/api/board/backlog?limit=$LIMIT" | jq '
  .backlog[] | {
    card: .card_number,
    id: .id,
    title,
    intent,
    prio: .priority,
    effort: .effort_points,
    score: (.rank_score | . * 10 | round / 10),
    col: .kanban_column
  }'
```

Add `?intent=all&scope=open` to include brainstorm/plan/decide + in-flight columns.

### `prioritize` / `bump` — change priority

```bash
BRIDGE=${WI_BRIDGE:-http://localhost:3132}
TASK_ID=$1     # e.g. task_abc123
NEW_PRIO=$2    # 0..100
curl -fsS -X PATCH "$BRIDGE/api/board/tasks/$TASK_ID" \
  -H 'Content-Type: application/json' \
  -d "{\"priority\": $NEW_PRIO}"
# Bump = alias for prioritize <id> 100
```

### `effort` — set/adjust effort_points

```bash
BRIDGE=${WI_BRIDGE:-http://localhost:3132}
TASK_ID=$1
NEW_EFFORT=$2  # 1|2|3|5|8|13, or null
curl -fsS -X PATCH "$BRIDGE/api/board/tasks/$TASK_ID" \
  -H 'Content-Type: application/json' \
  -d "{\"effort_points\": $NEW_EFFORT}"
```

## Decision framework — when to call each command

| User says | Command |
|---|---|
| "add this to the backlog", "capture this", "remember to X" | `capture` |
| "what should I do next", "what's next", "what should I work on" | `next` |
| "show the backlog", "what's in the backlog", "what's needed" | `backlog` |
| "bump X to top", "make X top priority", "prioritize X" | `prioritize` (or `bump`) |
| "how big is X", "set effort for X" | `effort` |

## Pitfalls

- **`priority` vs `kanban_order`**: these are different. `priority` (0-100) is the cross-column business rank the ranker consumes. `kanban_order` is manual UI within-column drag position. Never use `kanban_order` to influence "what's next".
- **`intent='execute'` is the pickup gate**: brainstorm/plan/decide cards sit forever in `ready` — that's correct. Only user promotion (change intent → `execute`, or `/pm bump` after intent change) surfaces them to `BoardWorkerAgent`.
- **The DoD trigger still fires**: moving a card to `done` still requires `verified_via='user_observed'` evidence (ADR-040 §2.4). `/pm` doesn't bypass it — it only moves cards up to `e2e`.
- **`priority=100` is not "urgent, do immediately"** — it's the top-of-backlog anchor. If everything drifts to 100, ranking collapses. Reserve 90+ for genuine top-2 items.
- **NULL effort is legal and doesn't sink cards**: cards with `effort_points=null` get `effort_penalty=0`. It's fine to skip effort during quick captures.

## Related

- `wi-status`: read-only Cypher PM lens (older, session-oriented). Complementary — `wi-status` shows sessions; `/pm` shows cards.
- `wi-save-to-ticket`: save investigation findings TO an existing ticket (Jira). Different flow — `/pm` creates board cards; `wi-save-to-ticket` decorates external tickets.
- ADR-043 (canonical spec): `docs/docs/adr/adr-043-pm-orchestration-layer.md`
