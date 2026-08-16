---
sidebar_label: "wi-jira-analyze"
---

# /wi-jira-analyze

Run the 5-parallel AI analysis pipeline on a Jira ticket: classify, effort estimate, plain-English explanation, solution proposal (with learnings injection), and code impact.

## Usage

```
/wi-jira-analyze <TICKET-KEY>
```

**Example:**
```
/wi-jira-analyze PROJ-15257
```

## What It Does

Calls `POST /api/jira/analyze` which runs 5 AI checks in parallel using Claude Haiku (fast checks) and Claude Sonnet (solution proposal).

### Five Analysis Checks

| Check | Model | Output |
|-------|-------|--------|
| **Classification** | Haiku | Issue type, component, severity, affected layers |
| **Effort Estimate** | Haiku | S / M / L / XL with reasoning |
| **Plain-English Explanation** | Haiku | Stakeholder-friendly summary |
| **Solution Proposal** | Sonnet | Step-by-step fix with file/function pointers |
| **Code Impact** | Haiku | Files affected, owners, blast radius (gated at 15+ file matches) |

### Learnings Injection

The solution proposal automatically injects up to 3 similar past investigations from the same epic or component — so Claude knows what worked before.

### Link-Aware Analysis (EP-66)

Extracts up to 5 URLs or Jira keys from the ticket description and comments, fetches their content via MCP-first routing (Jira → GitHub → HTTP), and includes them as context in the solution.

## Output

```
## Analysis: PROJ-15257

### Classification
Type: Bug | Component: Recommendations | Severity: High | Layers: UI + API

### Effort Estimate
**M (3–5 days)**
Reason: Known codepath, feature flag rollback + config fix. Low risk.

### Plain-English Explanation
The "Recommended Links" section stopped showing in the Knowledge Migration wizard.
This started on April 17th after a configuration change in the deployment system.

### Solution Proposal
1. Roll back feature flag FF_RM_11372 in operations/config/flags.yaml
2. Verify SMRDP compatibility with the new recommendation engine
3. Re-enable flag with compatibility fix in place

Past similar fix: PROJ-14821 (same flags.yaml file, similar rollback — took 1 day).

### Code Impact
Files affected: 3
- src/recommendations/engine.ts (owner: Alice Chen)
- config/flags.yaml (owner: DevOps)
- src/ui/knowledge-migration/RecommendedLinks.tsx (owner: Bob Smith)
Blast radius: LOW

### Linked Sources
- operations PR #6107: "promote FF_RM_11372" — fetched and summarized
```

## Cost Control

The skill uses a **Cost Gate classifier** (Haiku, ~$0.003) before triggering expensive Claude Code research. Trivial or duplicate queries are short-circuited — results served from the 24h cache.

## Prerequisites

- Bridge running: `npm run web:bridge`
- Jira MCP token valid (check with `/wi-health`)

## Related

- [`/wi-investigate`](./wi-investigate) — Deep ReAct investigation for root cause
- [`/wi-ticket-links`](./wi-ticket-links) — Detailed view of all linked content
- [`/wi-save-to-ticket`](./wi-save-to-ticket) — Save findings back to Jira
- [ADR-008: EP-48 Implementation Decisions](../adr/adr-008-ep48-implementation-decisions.md)
- [ADR-019: Link-Aware Ticket Analysis](../adr/adr-019-link-aware-ticket-analysis.md)
