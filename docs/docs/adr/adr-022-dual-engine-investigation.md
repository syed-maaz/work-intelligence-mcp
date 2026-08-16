---
sidebar_label: "ADR-022: Dual-Engine Investigation"
---

# ADR-022: Dual-Engine Bug Investigation

**Status**: Implemented  
**Date**: 2026-05-17  
**Epics**: EP-55 (Bug Investigation Engine), EP-67 (Claude Code Research Engine)

---

## Context

The existing investigation system (`InvestigationOrchestrator`) runs a TypeScript ReAct loop with 10 deterministic tools (git log, feature flags, dep diffs, call graph, etc.). This gives structured, auditable traces but is constrained to pre-defined tool shapes.

Separately, 22 Claude Code slash commands (`/wi-*`) were built as skills — including `/wi-investigate`, which encodes a human-facing investigation workflow. The skill runs via the Claude CLI (`claude --print --bare`) with full access to the codebase.

The question: how to get the benefit of both without making them redundant?

---

## Decision

Run both engines **in parallel** on every investigation request. After both complete, a **synthesis step** merges the results:

- Whichever engine produces higher confidence → its root cause is used
- Evidence from both engines is merged into one list
- The final conclusion shows both perspectives: `[ReAct] ... [Skill] ...`
- If the skill engine fails for any reason → ReAct result returned unchanged (zero regression)

---

## Architecture

```
POST /api/jira/investigate
        ↓
InvestigationOrchestrator.investigate()
        ↓
  ┌──────────────────────────┬─────────────────────────────┐
  │  TypeScript ReAct Engine  │  wi-investigate Skill (CLI) │
  │  Anthropic SDK direct     │  claude --print --bare      │
  │  8-iteration limit        │  wi-investigate SKILL.md    │
  │  10 structured tools      │    as --system-prompt       │
  │  Conclude gate enforced   │  repos/ passed via --add-dir│
  └──────────────────────────┴─────────────────────────────┘
        ↓ Promise.allSettled — neither blocks the other
  synthesizeReports()
        ↓
  completeInvestigation() → SQLite → UI
```

---

## Implementation

Three changes to `src/intelligence/investigation-orchestrator.ts`:

### 1. `loadSkillPrompt(skillName)` (module-level helper)
Reads `~/.claude/skills/work-intelligence/<name>/SKILL.md`, strips YAML frontmatter, returns body string. Returns `undefined` if file missing — callers treat that as "skill unavailable".

### 2. `runSkillInvestigation(input)` (private method)
- Loads `wi-investigate` skill prompt via `loadSkillPrompt`
- Spawns `ClaudeCodeRunner` with the skill as `systemPrompt`
- Budget: $0.50, timeout: 120s
- Returns `ClaudeCodeResult | null` — null on any failure

### 3. `synthesizeReports(reactReport, skillResult, _input)` (private method)
Merge logic:
```
skillConfidence = skillResult.findings[0].confidence
useSkill = skillConfidence > reactReport.confidence
mergedConfidence = Math.max(reactReport.confidence, skillConfidence)
rootCause = useSkill ? skill finding : react finding
conclusion = "[winning engine] ... \n\n [other engine] ..."
evidence = [...reactReport.evidence, ...skillEvidence]
reportJson.skillFindings = skillResult.findings  (stored for UI)
```

### 4. Splice point in `investigate()`
After the ReAct loop produces `finalReport` (line ~533), before `completeInvestigation()`:
```typescript
const skillResult = await this.runSkillInvestigation(input);
if (skillResult) {
  finalReport = this.synthesizeReports(finalReport, skillResult, input);
}
```

---

## Synthesis Rules

| Scenario | Winner | Behaviour |
|----------|--------|-----------|
| ReAct confidence > Skill | ReAct | Skill findings appended as supporting evidence |
| Skill confidence > ReAct | Skill | ReAct findings appended as supporting evidence |
| Both equal | ReAct | Tie goes to ReAct (structured, auditable) |
| Skill unavailable / fails | ReAct | Returned unchanged, no error surfaced |
| Skill returns 0 findings | ReAct | Returned unchanged |

---

## `call_claude_code` Tool Enhancement

The ReAct engine has a `call_claude_code` tool (one of 10) used for deep code reading mid-loop. This now also injects the `wi-code-research` skill prompt as `systemPrompt`, so the sub-call runs with the full structured research workflow.

Two levels of skill integration:
1. **Top-level**: full `wi-investigate` skill runs as a parallel engine
2. **Mid-loop**: `wi-code-research` skill injected into `call_claude_code` sub-calls

---

## Consequences

**Good**
- Two independent reasoning paths — different tools, different prompts, cross-validates findings
- Skill engine has no iteration limit — can reason more freely
- Zero regression: skill failure is fully silent, ReAct result unchanged
- `reportJson.skillFindings` stored in DB — UI can show both perspectives

**Trade-offs**
- Each investigation now costs up to $0.80 more (skill engine budget: $0.50)
- Total wall-clock time increases by up to 2 minutes (skill runs after ReAct, not truly parallel)
- Skill requires `claude` CLI in PATH and valid `ANTHROPIC_API_KEY`

---

## Related

- [ADR-013: Intelligent Bug Investigation](./adr-013-intelligent-bug-investigation.md)
- [ADR-021: Claude Code Research Engine](./adr-021-claude-code-research-engine.md)
- [Skills: wi-investigate](../skills/wi-investigate.md)
- [Skills: wi-code-research](../skills/wi-code-blast-pr-expert.md)
