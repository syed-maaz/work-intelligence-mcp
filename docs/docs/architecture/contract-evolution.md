---
sidebar_position: 21
title: Contract Evolution — `result_meta.outcome`
---

# Contract Evolution — `result_meta.outcome`

> **Single source of truth** for the values-history of Contract B (`result_meta.outcome`), the external dispatch-return enum every Hermes / n8n / MCP consumer parses.
>
> **Last verified:** 2026-06-19 · **Status:** Closed-additive (six values frozen at v2.0 launch) · **Source decision:** [ADR-037 D19](../adr/adr-037-cypher-tool-use-loop.md#d19--outcome-contract-evolution-open-verdict-closed-additive-outcome) · [Design log Q-1.3](../../../.planning/cypher/12-V2-V2.5-DESIGN-DISCUSSION.md)

---

## 1. Why this file exists

Cypher's outcome model has two enums with **different evolution policies**:

| Contract | Where | Policy | Reader |
|---|---|---|---|
| **A — `cypher_outcomes.verdict`** | Internal Cypher ledger (SQLite) | **Open enum.** Cypher writes whatever values the loop needs. No history table. | Cypher itself. |
| **B — `result_meta.outcome`** | External `wi_dispatch` response wrapper | **Closed at v2.0 launch + additive-only post-launch.** Removals never allowed. | Every Hermes, n8n, MCP, and Web UI consumer. |

This file owns Contract B's history. **Every PR that adds a Contract B value MUST update the values-history table below in the same PR.** That requirement is the closing-the-loop discipline that turns "additive-only" from a slogan into a contract.

The verdict→outcome translation map in `wi_dispatch` (see [ADR-037 D14 / D19](../adr/adr-037-cypher-tool-use-loop.md#d19--outcome-contract-evolution-open-verdict-closed-additive-outcome)) is the boundary that isolates Contract A churn from Contract B stability. Internal verdicts get added freely; each adds one row to the translation map; Contract B stays at six values until a deliberate addition lands here.

---

## 2. Values-history table (Contract B)

| Value | Added | Source | Rationale | Consumer impact |
|---|---|---|---|---|
| `success` | v1.0 | original (D14) | normal completion | baseline |
| `partial` | v1.0 | original (D14) | some steps succeeded, some didn't | dashboards show as "yellow" |
| `blocked` | v1.0 | original (D14) | external dependency missing | alerts route to "blocked" channel |
| `needs_user_input` | v1.0 | original (D14) | dispatch needs human reply | UI prompts user |
| `budget_exhausted` | v1.0 | original (D14) | hit dispatch token / iteration / wallclock cap | UI shows budget-warning |
| `error` | v1.0 | original (D14) | unhandled exception | alerts route to "error" channel |

Six values. Frozen at v2.0 launch. The new internal verdicts from Q-1.11/Q-1.12/Q-1.13 (`halted`, `abandoned`, `rejected_non_interactive`) do **not** propagate to Contract B — they map to existing values via the D14 translation table.

---

## 3. Addition protocol (Flavor A — developer-mediated)

This is the **v2.0 mechanism** for adding a Contract B value. Flavor B (Cypher-proposed runtime extension) is deferred to v2.5 and rides the same promotion gate as ADR-037 D21.

1. **Telemetry surfaces a real gap.** Cypher routinely encounters a situation that doesn't map cleanly to any existing Contract B value (e.g. it hits an upstream rate-limit and has to record `outcome='error', unmapped=true, raw_signal='rate_limited'` repeatedly).
2. **Developer reviews the gap.** Someone reads the `unmapped=true` rows, decides whether the gap is real (a missing semantic) or noise (a translation-map row would suffice).
3. **Developer opens a PR adding the value.** The PR must:
   - Add the value to the enum in code.
   - Add a row to the [§ 2 values-history table](#2-values-history-table-contract-b) above with rationale and consumer-impact analysis.
   - Update the verdict→outcome translation map in `wi_dispatch` if a new internal verdict triggered the addition.
4. **Reviewers approve.** Reviewers confirm the rationale and consumer-impact analysis are accurate before merge.
5. **Existing consumers continue to work.** Additive-only means today's parsers don't break; new consumers can pattern-match the new value.

The PR-mediated discipline is the whole point: every Contract B addition is a deliberate, reviewed change with a written rationale, not a silent enum drift.

---

## 4. Removals — never allowed

Once a Contract B value ships, it is permanent. Removing a value would break every downstream parser that expects to see it; repurposing a value (changing its semantics) is worse because it breaks parsers silently.

If a value becomes obsolete, it stays in the enum and stays in this table. Mark it deprecated in the rationale column if needed; do not delete the row.

---

## 5. Consumer contract

Every Contract B consumer **MUST** default-case unknown `outcome` values:

```ts
switch (result_meta.outcome) {
  case 'success': /* ... */ break;
  case 'partial': /* ... */ break;
  case 'blocked': /* ... */ break;
  case 'needs_user_input': /* ... */ break;
  case 'budget_exhausted': /* ... */ break;
  case 'error': /* ... */ break;
  default:
    // Treat as 'error' with logging — surfaces drift early.
    log.warn(`unknown wi_dispatch outcome: ${result_meta.outcome}`);
    handleAsError(result_meta);
}
```

Consumers that fail loud on unknowns surface drift early — encouraged but not required. Consumers that silently drop unknowns will miss new semantics until they're updated.

---

## 6. Cross-references

- [ADR-037 D19 — Outcome contract evolution](../adr/adr-037-cypher-tool-use-loop.md#d19--outcome-contract-evolution-open-verdict-closed-additive-outcome) — the source decision.
- [ADR-037 D14 — verdict→outcome translation map](../adr/adr-037-cypher-tool-use-loop.md) — the boundary between Contract A and Contract B.
- [Cypher v2.0 PRD § 4.x](../prd/cypher-v2.0.md) — outcome contract evolution + Pass-2 substrate scope.
- [Cypher v2.5 PRD § Flavor B](../prd/cypher-v2.5.md) — runtime self-extension via Phase 1 propose-confirm (v2.5 design question).
- [Design discussion log Q-1.3](../../../.planning/cypher/12-V2-V2.5-DESIGN-DISCUSSION.md) — full discussion that locked the policy on 2026-06-18.
