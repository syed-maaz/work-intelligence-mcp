# ADR-014: Self-Learning Bug Investigation Brain

**Status:** Implemented (EP-56 ✅, Sprint 12)  
**Date:** 2026-04-21  
**Deciders:** syedmaaz  
**Depends On:** ADR-013 (Intelligent Bug Investigation Engine)

---

## Context

Phase 55 (ADR-013) delivers a 3-layer ReAct investigation engine that can debug regressions with the reasoning of a senior developer. Every investigation starts from identical priors — the same tool weights, the same pattern confidence levels — regardless of how many investigations have completed before it.

After 10–20 investigations, this is wasteful and sub-optimal:
- Some tools (`gitLogWindow`) prove reliable for `dep-upgrade` bugs; others (`traceCallGraph`) rarely fire for that root cause type
- Patterns extracted from PROJ-15257 (SMRDP dep-upgrade, `isExternalDep=true`) are directly reusable for similar future tickets
- Predicted root cause types are testable hypotheses — if they're wrong, the system should know

---

## Decision

Add a feedback layer (Phase 56) that records and applies learning after each investigation concludes.

### Decision 1: Incremental confidence, not full retraining

Pattern confidence is adjusted via small deltas (±0.10/0.15) per feedback event — not via a full ML training pass. This keeps the system deterministic, auditable, and operable without a GPU or model serving infrastructure.

### Decision 2: Tool effectiveness per rootCauseType

Tool effectiveness is tracked as a `(tool_name, root_cause_type)` composite key. A tool that is excellent for `dep-upgrade` bugs may be irrelevant for `code-change` bugs. Composite keying prevents cross-contamination of signal.

### Decision 3: Hypothesis tracking is opt-in for the outcome

The system records predictions at conclusion time (`createHypothesisAccuracy`). The `was_correct` field is only filled when the user explicitly calls `PUT /api/jira/investigation/:key/outcome`. No automated scraping of commit history to infer fix correctness — correctness requires human confirmation.

### Decision 4: Knowledge TTL is soft decay, not hard expiry

Stale entries (older than `KNOWLEDGE_TTL_DAYS=30`) are deleted and re-indexed on next `runFullSync`, not rejected at query time. The risk of an investigation hitting a stale codebase knowledge entry mid-session is preferred over the risk of blocking an active investigation.

### Decision 5: BrainStatsPanel is developer-facing, not user-facing

The `/api/jira/brain/stats` endpoint and `BrainStatsPanel` are diagnostic surfaces for the developer (system owner). They are not surfaced in the main ticket investigation flow. Users see investigation results; developers see the brain's health.

---

## Schema v36

```sql
pattern_feedback     — (pattern_id, session_id, confirmed, contradicted, confidence_delta)
tool_effectiveness   — (tool_name, root_cause_type, invocations, led_to_conclusion, effectiveness_score)
hypothesis_accuracy  — (session_id, issue_key, predicted_root_cause, predicted_fix_owner, actual_root_cause, was_correct)
```

---

## Consequences

**Positive:**
- Investigation quality improves monotonically — each session leaves evidence for the next
- Tool selection adapts to actual signal, reducing iteration count for familiar bug classes
- Hypothesis accuracy history calibrates the orchestrator's confidence threshold adaptively

**Negative:**
- First 10–20 investigations have no learning signal — cold start is identical to Phase 55
- Feedback loop requires user action to close (`PUT /outcome`) — passive correctness cannot be inferred

---

## Rejected Alternatives

- **Embedding-based pattern similarity** — too expensive per-investigation, overkill for structured fields like `rootCauseType`
- **Automatic fix detection via git blame** — fragile, high false-positive rate when bug + fix span multiple PRs
