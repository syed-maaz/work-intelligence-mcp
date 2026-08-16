---
id: ep67-claude-code-research-engine
title: EP-67 — Claude Code Research Engine
---

# EP-67: Claude Code Research Engine with Self-Evolving Prompts

| Field | Value |
|-------|-------|
| Sprint | Sprint 18 |
| Status | ✅ Done |
| ADR | [ADR-021](../adr/adr-021-claude-code-research-engine) |
| Schema | v43 (`claude_code_research`, `prompt_templates`, `prompt_outcomes`, `research_exemplars`) |
| Depends On | EP-65 ✅ (Agent Architecture), EP-56 ✅ (Self-Learning Brain) |
| Effort | 4 waves, ~5-6 days |
| New Dependencies | None (Claude CLI installed, p-queue in deps) |

---

## Problem

The current analysis pipeline can only grep for code — it cannot reason about why code exists, trace semantic call chains, or understand architectural intent across file boundaries. When a Jira ticket references "the login flow" or a chat question asks "how does auth work?", the system returns filenames from grep but cannot explain the interaction patterns, blast radius, or design rationale.

**Impact**: Investigation quality plateaus. The InvestigationOrchestrator's 9-tool ReAct loop hits diminishing returns after 5 iterations because each tool (grep, read_file, git_log) operates on isolated file fragments rather than understanding the codebase as a connected system.

**Scale**: ~40% of Jira tickets and ~60% of chat questions that trigger code search would benefit from deeper analysis than grep can provide.

---

## Solution

Spawn Claude Code CLI as a subprocess with dynamically generated, self-evolving prompts. Claude Code brings IDE-level AST parsing, semantic search, and cross-file reasoning. Results feed back as `ContextItem[]` into the existing analyzer pipeline.

The prompts evolve automatically using three patterns from prompt optimization research:
1. **OPRO** (Optimization by PROmpting) — Claude proposes better prompts based on scored history
2. **TextGrad** — targeted repairs for individual failures
3. **A/B Gating** — statistical validation before promoting new versions

### Universal Integration

```
POST /api/jira/analyze  ──┐
POST /api/chat           ──┼── CostGate ──→ PromptEvolver ──→ ClaudeCodeRunner
POST /api/jira/investigate─┤                                       │
OrchestratorAgent         ─┤                                       ▼
CorrelationAgent          ─┘                              ResultAdapter → ContextItem[]
                                                                   │
                                                                   ▼
                                                          QualityScorer (Haiku)
                                                                   │
                                                          ┌────────┴────────┐
                                                          ▼                 ▼
                                                    OPRO (weekly)    TextGrad (per-failure)
                                                          │                 │
                                                          ▼                 ▼
                                                    A/B Gate ──→ Promote or Revert
```

### CLI Invocation

```bash
claude --print \
  --output-format json \
  --json-schema '{"type":"object","properties":{"findings":{"type":"array"},...}}' \
  --model sonnet \
  --max-budget-usd 0.50 \
  --bare \
  --dangerously-skip-permissions \
  --add-dir ./repos/example-service \
  --add-dir ./repos/operations \
  --add-dir . \
  --system-prompt "<evolved-prompt>" \
  "Research question here"
```

---

## Self-Evolving Prompt System

### How Prompts Improve Over Time

```
┌─────────────────────────────────────────────────────────┐
│                   EVOLUTION CYCLE                        │
│                                                         │
│  Invoke Claude Code with template v(N)                  │
│       ↓                                                 │
│  Auto-score output (Haiku: relevance, depth, action)    │
│       ↓                                                 │
│  Record outcome in prompt_outcomes                      │
│       ↓                                                 │
│  After 20 invocations:                                  │
│    • avg < 0.4 → OPRO generates v(N+1) candidates      │
│    • avg > 0.7 → mark as stable base                   │
│       ↓                                                 │
│  On individual failure (< 0.3):                         │
│    • TextGrad identifies missing instruction            │
│    • Adds to known_dead_ends for all future prompts     │
│       ↓                                                 │
│  Before promoting v(N+1):                               │
│    • A/B test: 30 pairs, Haiku judges                   │
│    • Win rate > 60% → promote                           │
│    • Otherwise → discard, keep v(N)                     │
│       ↓                                                 │
│  On high-quality output (> 0.8):                        │
│    • Add to research_exemplars library                  │
│    • Future prompts inject similar examples             │
└─────────────────────────────────────────────────────────┘
```

### What Evolves in the Prompt

| Section | How it evolves | Source |
|---------|---------------|--------|
| `dynamic_instructions` | New instructions added when OPRO identifies patterns | OPRO meta-optimization |
| `known_dead_ends` | Grows when TextGrad identifies failure modes | TextGrad repairs |
| `high_signal_paths` | File paths that consistently appear in high-scoring outputs | prompt_outcomes analysis |
| `few_shot_examples` | Best outputs injected as "here's what good looks like" | research_exemplars table |

### Seed Templates (v1)

Four templates, one per trigger type — manually crafted, then improved by the system:

**jira_analyze**: `"Given Jira ticket {key} ({title}), trace the code paths affected. Focus on: what would a developer need to understand to fix/implement this?"`

**chat**: `"A developer asks: {message}. Research the codebase to provide a precise, evidence-based answer with file paths and line numbers."`

**investigate**: `"Hypothesis: {hypothesis}. Verify or refute this against the codebase. Check {suggested_repos} for evidence."`

**alert**: `"An alert fired: {alert_summary}. What changed in the codebase that could explain this? Check recent commits and config changes."`

---

## Caching Strategy

```sql
CREATE TABLE claude_code_research (
  id INTEGER PRIMARY KEY,
  input_hash TEXT NOT NULL UNIQUE,   -- SHA-256(question + repos)
  trigger_type TEXT NOT NULL,
  question TEXT NOT NULL,
  repos TEXT NOT NULL,                -- JSON array
  template_id INTEGER,
  result TEXT NOT NULL,               -- JSON ClaudeCodeResult
  confidence REAL,
  quality_score REAL,
  tokens_used INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  model TEXT,
  expires_at TEXT NOT NULL,           -- TTL-based
  created_at TEXT DEFAULT (datetime('now'))
);
```

| Scenario | TTL |
|----------|-----|
| High-confidence result (> 0.8) | 48h |
| Normal result | 24h |
| Low-confidence result (< 0.4) | 4h (retry sooner) |
| Failed/timed out | 1h |

---

## Cost Control

| Mechanism | How |
|-----------|-----|
| CostGate classifier | Haiku rejects trivial/low-value questions ($0.003 per gate check) |
| Budget cap | `--max-budget-usd 0.50` per invocation |
| Concurrency limit | p-queue max 2 parallel instances |
| Cache | 24h TTL prevents re-running identical questions |
| Daily budget | ENV `CLAUDE_CODE_DAILY_BUDGET_USD` (default: $10) |
| Model selection | Sonnet default; Haiku for simple, Opus for deep (configurable per trigger type) |

**Expected costs**:
- Per invocation: $0.30-0.50 (Claude Code) + $0.003 (quality scoring)
- Per A/B test: $0.09 (30 pairs × $0.003)
- Per OPRO run: $0.01 (single Haiku meta-prompt call)
- Daily steady state: $3-5 (assuming 10-15 approved invocations/day)

---

## Wave Plan

### Wave 1: Core Runner + Schema (Day 1)

| File | Action | Lines | Purpose |
|------|--------|-------|---------|
| `src/services/claude-code-runner.ts` | NEW | ~150 | Spawn CLI, parse JSON, timeout, p-queue |
| `src/db/queries/claude-code-research.ts` | NEW | ~120 | Cache CRUD, template CRUD, outcome recording |
| `src/db/schema.ts` | EDIT | +60 | Migration v43: 4 tables + indexes |

**Verification**: `npm run build` + subprocess smoke test

### Wave 2: Prompt Evolution Engine (Day 2-3)

| File | Action | Lines | Purpose |
|------|--------|-------|---------|
| `src/intelligence/prompt-evolver.ts` | NEW | ~250 | Template selection, variable injection, A/B routing, OPRO trigger, TextGrad repair |
| `src/intelligence/cost-gate.ts` | NEW | ~80 | Haiku classifier with configurable thresholds |

**Verification**: Unit tests with mock outcomes, A/B routing logic

### Wave 3: Universal Integration (Day 3-4)

| File | Action | Lines | Purpose |
|------|--------|-------|---------|
| `web-server.js` | EDIT | +40 | Inject into /api/jira/analyze, /api/chat, /api/jira/investigate |
| `src/intelligence/investigation-orchestrator.ts` | EDIT | +25 | Add `call_claude_code` tool |
| `src/services/orchestrator-agent.ts` | EDIT | +15 | Add as proactive research tool |

**Verification**: Restart bridge, POST /api/jira/analyze on PROJ-15257, verify enriched response

### Wave 4: Feedback Loop + UI (Day 5-6)

| File | Action | Lines | Purpose |
|------|--------|-------|---------|
| `web/src/components/research/ResearchInsightCard.tsx` | NEW | ~100 | Display findings with thumbs up/down |
| `src/intelligence/prompt-refinement-job.ts` | NEW | ~150 | Nightly OPRO + TextGrad + A/B gate |
| `web-server.js` | EDIT | +30 | POST /api/research/feedback, GET /api/research/stats, GET /api/research/evolution |

**Verification**: Click thumbs-up, verify outcome recorded, trigger manual refinement

---

## Type Definitions

```typescript
export interface ClaudeCodeRequest {
  prompt: string;
  repos: string[];
  model?: string;
  maxBudget?: number;
  timeoutMs?: number;
  allowedTools?: string[];
  jsonSchema?: object;
  systemPrompt?: string;
}

export interface ClaudeCodeResult {
  findings: ResearchFinding[];
  filesExamined: string[];
  confidence: number;
  model: string;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
}

export interface ResearchFinding {
  title: string;
  explanation: string;
  relevantFiles: string[];
  codeSnippets?: CodeSnippet[];
  blastRadius?: string[];
  confidence: number;
}

export interface CodeSnippet {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
  language: string;
}

export type TriggerType = 'jira_analyze' | 'chat' | 'investigate' | 'alert';

export interface PromptTemplate {
  id: number;
  triggerType: TriggerType;
  version: number;
  template: string;
  systemContext?: string;
  effectivenessScore: number;
  invocationCount: number;
  isActive: boolean;
  abWeight: number;
  evolutionSource: 'manual' | 'opro' | 'textgrad' | 'promptbreeder';
  parentVersion?: number;
  knownDeadEnds: string[];
  highSignalPaths: string[];
}

export interface QualityScore {
  relevance: number;
  depth: number;
  actionability: number;
  combined: number;
}

export interface CostGateResult {
  approved: boolean;
  reason: string;
  estimatedValue: number;
}

export interface PromptEvolutionConfig {
  refinementThreshold: number;
  repairThreshold: number;
  promotionThreshold: number;
  exemplarThreshold: number;
  abTestTrafficSplit: number;
  abTestMinPairs: number;
  abTestWinRate: number;
  minInvocationsForEval: number;
  maxTemplateVersions: number;
  oproInterval: number;
}
```

---

## Acceptance Criteria

### Wave 1: Core
- [ ] AC-1: `ClaudeCodeRunner.execute()` spawns `claude --print --output-format json --json-schema` and returns parsed results within 120s timeout
- [ ] AC-2: Results are adapted to `ContextItem[]` with `source: 'claude-code'`
- [ ] AC-3: Research results cached in `claude_code_research` table with 24h TTL
- [ ] AC-12: Max 2 concurrent Claude Code instances (p-queue)
- [ ] AC-13: Budget cap per invocation ($0.50 default, configurable via env)

### Wave 2: Prompt Evolution
- [ ] AC-4: CostGateClassifier prevents invocation for simple/low-value questions (more than 60% rejection rate for trivial queries)
- [ ] AC-5: Prompt templates stored in DB with version tracking
- [ ] AC-6: A/B routing sends 20% traffic to new template versions
- [ ] AC-7: After 20 invocations, low-scoring templates trigger automatic refinement via OPRO
- [ ] AC-8: Refined templates include learned `known_dead_ends` and `high_signal_paths`
- [ ] AC-16: Every output auto-scored by Haiku on 3 dimensions (relevance, depth, actionability)

### Wave 3: Integration
- [ ] AC-9: POST /api/jira/analyze uses Claude Code research when CostGate approves
- [ ] AC-10: POST /api/chat uses Claude Code for deep code questions
- [ ] AC-11: InvestigationOrchestrator has `call_claude_code` tool available

### Wave 4: Feedback + Evolution
- [ ] AC-14: UI shows research findings with quality feedback buttons (thumbs up/down)
- [ ] AC-15: Nightly refinement job produces new template version when avg score below 0.4
- [ ] AC-17: OPRO meta-optimization generates candidate prompts from top-5/bottom-5 outcomes
- [ ] AC-18: TextGrad repair triggered on individual failures (score below 0.3)
- [ ] AC-19: A/B gate requires 30-pair comparison before promoting any new template
- [ ] AC-20: Few-shot exemplar library populated from outputs scoring above 0.8
- [ ] AC-21: Dynamic example injection selects exemplars by repo + area similarity
- [ ] AC-22: Prompt evolution stats visible at GET /api/research/evolution

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_CODE_MODEL` | `sonnet` | Model for research subprocess |
| `CLAUDE_CODE_BUDGET_PER_CALL` | `0.50` | Max USD per invocation |
| `CLAUDE_CODE_DAILY_BUDGET_USD` | `10` | Daily budget cap |
| `CLAUDE_CODE_TIMEOUT_MS` | `120000` | Subprocess timeout |
| `CLAUDE_CODE_CONCURRENCY` | `2` | Max parallel instances |
| `CLAUDE_CODE_CACHE_TTL_HOURS` | `24` | Default cache TTL |
| `PROMPT_OPRO_INTERVAL` | `20` | Invocations between OPRO runs |
| `PROMPT_AB_MIN_PAIRS` | `30` | Minimum pairs for A/B test |
| `PROMPT_REFINEMENT_THRESHOLD` | `0.4` | Score triggering OPRO |
| `PROMPT_REPAIR_THRESHOLD` | `0.3` | Score triggering TextGrad |
