---
sidebar_label: "ADR-021: Claude Code Research Engine"
sidebar_position: 21
format: md
---

# ADR-021: Claude Code Research Engine — Self-Evolving Deep Codebase Intelligence

**Status**: Implemented (All Waves ✅ Done)  
**Date**: 2026-05-05  
**Last Verified**: 2026-05-06 — TypeScript compiles clean, all Wave 1–4 components confirmed in code  
**Deciders**: syedmaaz  
**Depends On**: ADR-017 (Always-On Agent Architecture), ADR-014 (Self-Learning Investigation Brain)

---

## Implementation Status

| Wave | Component | Location | Status | Notes |
|------|-----------|----------|--------|-------|
| 1 | `ClaudeCodeRunner` class | `src/services/claude-code-runner.ts` (188 lines) | ✅ Done | `execFile('claude', [...])`, p-queue concurrency 2, 120s timeout, structured JSON output |
| 1 | `adaptToContextItems()` adapter | `src/services/claude-code-runner.ts:170` | ✅ Done | Converts `ClaudeCodeResult` → `ContextItem[]` with `source: 'claude-code'` |
| 1 | `computeInputHash()` cache key | `src/services/claude-code-runner.ts:185` | ✅ Done | SHA-256 of question + repo list |
| 1 | Schema v43 (research cache) | `src/db/schema.ts:1118-1189` | ✅ Done | 4 tables: `claude_code_research`, `prompt_templates`, `prompt_outcomes`, `research_exemplars` |
| 1 | Research cache query layer | `src/db/queries/research-cache.ts` (229 lines) | ✅ Done | `getCachedResearch`, `upsertResearch`, `pruneExpiredResearch`, `getResearchStats`, `getResearchByQuestion`, `updateOutcomeFeedback` |
| 2 | `CostGateClassifier` | `src/intelligence/cost-gate.ts` (92 lines) | ✅ Done | Claude Haiku evaluates whether to spend $0.30-0.50; 4 trigger types |
| 2 | `PromptEvolver` | `src/intelligence/prompt-evolver.ts` (104 lines) | ✅ Done | Template selection (active + A/B candidates), `buildPrompt()` with context injection, exemplar injection |
| 2 | Prompt seed templates | `src/intelligence/prompt-seeds.ts` (149 lines) | ✅ Done | `seedTemplatesIfEmpty()` — bootstraps v1 templates for each trigger type on first run |
| 2 | `QualityScorer` | `src/intelligence/quality-scorer.ts` (144 lines) | ✅ Done | Claude Haiku scores relevance/depth/actionability → fires OPRO/TextGrad/A-B based on thresholds |
| 2 | Prompt evolution jobs (OPRO + TextGrad + A/B) | `src/intelligence/prompt-evolution-jobs.ts` (197 lines) | ✅ Done | `runOPRO()`, `runTextGradRepair()`, `checkABPromotion()` — all functions implemented |
| 3 | Jira analyze integration | `web-server.js:3520-3565` | ✅ Done | CostGate → PromptEvolver → Runner → adapt → merge into allContext; quality scoring async |
| 3 | Chat integration | `web-server.js:4057-4093` | ✅ Done | Fires when `needsCodeSearch && codeItems.length === 0`; CostGate → Runner → merge |
| 3 | Investigation engine tool | `investigation-orchestrator.ts:205,679-700` | ✅ Done | `call_claude_code` as 10th tool option with dynamic import + focused repos |
| 3 | Research API endpoints | `web-server.js:5198-5260` | ✅ Done | `GET /api/research/stats`, `GET /api/research/evolution`, `POST /api/research/feedback`, `GET /api/research/findings` |
| 4 | `ResearchInsightCard` UI | `web/src/components/jira/ResearchInsightCard.tsx` | ✅ Done | Expandable card with findings, confidence badge, thumbs up/down feedback |
| 4 | ResearchInsightCard wired to page | `web/src/pages/JiraReportPage.tsx:4,687` | ✅ Done | Rendered below analysis with findings + researchId props |
| 4 | Feedback endpoint (`POST /api/research/feedback`) | `web-server.js:5228-5245` | ✅ Done | Writes `user_feedback` to `prompt_outcomes` via `updateOutcomeFeedback()` |
| 4 | Nightly prompt refinement job | `web-server.js` (watchers block) | ✅ Done | 6-hour interval runs `runOPRO()` + `checkABPromotion()` for all 3 trigger types |
| 4 | Research stats UI page | `web/src/pages/DigestPage.tsx` | ✅ Done | `ResearchStatsWidget` — invocations, avg quality, cache hits, total cost from `/api/research/stats` |
| — | Web-server bootstrap | `web-server.js:96-100` | ✅ Done | All 4 services instantiated at startup: `ClaudeCodeRunner(2)`, `CostGateClassifier`, `PromptEvolver`, `QualityScorer` + `seedTemplatesIfEmpty(db)` |

### What was built (EP-67, Sprint 18)

**ClaudeCodeRunner** (`src/services/claude-code-runner.ts`, 188 lines):
- `execute(request: ClaudeCodeRequest)` — spawns `claude --print --output-format json --bare --dangerously-skip-permissions`
- `--add-dir` for multi-repo access, `--max-budget-usd 0.50` cost cap
- p-queue with concurrency 2, 120s timeout per invocation
- Returns `ClaudeCodeResult` with findings, confidence, cost, tokens, duration

**CostGateClassifier** (`src/intelligence/cost-gate.ts`, 92 lines):
- Claude Haiku decides if a question is worth $0.30-0.50 of research
- 4 trigger types: `jira_analyze`, `chat`, `investigate`, `alert`
- Rejects trivial lookups, already-answered questions, low-complexity queries

**PromptEvolver** (`src/intelligence/prompt-evolver.ts`, 104 lines):
- `selectTemplate(triggerType)` — picks active template or A/B candidate by weight
- `buildPrompt(triggerType, context)` — injects trigger context, exemplars, dead ends, high-signal paths
- Template versioning with `evolution_source`: manual / opro / textgrad / promptbreeder

**QualityScorer** (`src/intelligence/quality-scorer.ts`, 144 lines):
- Haiku scores each output: relevance (0.4), depth (0.3), actionability (0.3)
- Score > 0.8 → insert exemplar
- Score < 0.3 → trigger TextGrad repair
- Every 20 invocations → trigger OPRO + A/B check

**Prompt Evolution Jobs** (`src/intelligence/prompt-evolution-jobs.ts`, 197 lines):
- `runOPRO()` — meta-prompt generates v(N+1) candidates from best/worst outcomes
- `runTextGradRepair()` — per-failure prompt patch from Haiku criticism
- `checkABPromotion()` — binomial sign test: new wins 60%+ of 30 pairs → promote

### What's Left (carried to v1.1)

1. **A/B testing validation** — The full 30-pair head-to-head comparison pipeline (`checkABPromotion`) has never been validated with real traffic. Needs at least 20+ invocations per trigger type to produce meaningful data.
2. **`alert` trigger type integration** — Type defined in CostGate but no alert path invokes Claude Code research yet.

### Deviations from ADR Spec

| ADR Specifies | Implementation | Reason |
|--------------|----------------|--------|
| `--json-schema` flag for output validation | Not used — parser handles JSON directly | Claude Code `--output-format json` suffices; `--json-schema` adds constraint complexity for marginal benefit |
| `--system-prompt` flag for evolved prompts | Prompt passed as main argument, not system prompt | Simpler invocation; system prompt requires escaping in shell args |
| Monthly PromptBreeder sprint (10 mutations) | Not implemented | OPRO + TextGrad provide sufficient evolution without the additional complexity |
| `alert` trigger type integration | Type defined in CostGate but no alert path invokes it | Alerts pipeline (OrchestratorAgent) doesn't yet call Claude Code research |

---

## Context

### The Problem

The current investigation and analysis pipelines use a hand-rolled 9-tool ReAct loop (`grep_code`, `read_file`, `git_log_window`, etc.) with shallow code understanding. When a Jira ticket is analyzed, a chat question needs code context, or an investigation runs, the system can only grep files — it cannot reason about architecture, trace call graphs semantically, or understand intent across file boundaries.

**Limitations of the current approach:**

| Capability | Current (grep-based) | Needed |
|-----------|---------------------|--------|
| Cross-file reasoning | Manual trace via `traceCallGraph` | Semantic understanding |
| Architecture questions | `codebase_knowledge` table (stale) | Live analysis |
| Intent understanding | Pattern matching on filenames | Full AST + context |
| Multi-repo correlation | Sequential grep per repo | Unified reasoning |
| Blast radius analysis | Import graph only | Full dependency chain |

### What Exists Today

1. **InvestigationOrchestrator** (`src/intelligence/investigation-orchestrator.ts`) — 8-iteration ReAct loop, 9 tools, 45s timeout per Claude call, dispatches against `./repos/example-service` and `./repos/operations`
2. **ResearchEngine** — 3-tier system (Quick ReAct, Plan-then-Execute, Subagent Decomposition) with 19 tools
3. **OrchestratorAgent** — Event scoring via tool_use agentic loop (Haiku, max 3 turns)
4. **POST /api/jira/analyze** — Fetches ticket, builds context, 3-parallel analysis calls
5. **POST /api/chat** — Entity extraction → FTS5 → Palace KG → grep → chatWithContext

All of these hit a ceiling when questions require understanding **why** code exists, not just **where** it is.

### The Opportunity

Claude Code CLI is installed on this machine. It has:
- Full IDE-level AST parsing and semantic search
- Cross-file reasoning without manual tool dispatch
- `--print` mode for non-interactive subprocess invocation
- `--output-format json` + `--json-schema` for structured output
- `--max-budget-usd` for cost control
- `--add-dir` for multi-repo access in a single session

This gives us a **senior engineer on demand** — we generate a research prompt, spawn Claude Code, and get back structured findings that dramatically enrich our analysis.

### The Missing Piece: Prompt Quality

A static prompt produces static-quality results. The prompts sent to Claude Code must **self-evolve** — learning from result quality, user feedback, and investigation outcomes. This mirrors ADR-014's self-learning pattern (tool effectiveness tracking) but applied to prompt engineering.

---

## Decision

### Decision 1: Claude Code CLI as Research Subprocess

Invoke Claude Code via `execFile('claude', [...args])` with:
- `--print` — non-interactive, output to stdout
- `--output-format json` — structured response
- `--json-schema <schema>` — validated output shape
- `--bare` — skip hooks/memory/CLAUDE.md for clean research context
- `--dangerously-skip-permissions` — no interactive permission prompts
- `--model sonnet` — default model (configurable)
- `--max-budget-usd 0.50` — cost cap per invocation
- `--add-dir` — multi-repo access (example-service, operations, work-intelligence-mcp)
- `--system-prompt` — injected from PromptEvolver with evolved template

**Why CLI, not SDK**: The Claude Code CLI is stable, installed, requires no new dependency. An Agent SDK may exist in the future but adds coupling to an unstable interface.

### Decision 2: Self-Evolving Prompt Templates via OPRO + TextGrad + A/B Gating

Three complementary optimization patterns, all API-only (no GPU):

#### OPRO (Optimization by PROmpting) — Primary Evolution

A meta-prompt shows Claude previous prompt versions with their scores, plus best/worst output examples, and asks it to propose better variants. Runs weekly or after 20 invocations of the active template.

```
META-PROMPT:
---
You are optimizing a research prompt template for a code research system.

Previous versions with effectiveness scores (0.0-1.0):
{{version_history_with_scores}}

Top 3 highest-scoring outputs:
{{best_outputs_with_context}}

Bottom 3 lowest-scoring outputs:
{{worst_outputs_with_context}}

Patterns I observe in successful prompts:
{{auto_extracted_patterns}}

Propose 2 new prompt variants that should score higher than {{current_best}}.
Each variant should address a specific failure mode from the worst outputs.
---
```

#### TextGrad — Per-Failure Repair

When a single invocation scores below 0.3, Claude Haiku critiques the output, then proposes a prompt modification to avoid that specific failure:

```
REPAIR-PROMPT:
---
This research prompt produced a poor result (score: {{score}}).

Prompt: "{{prompt_used}}"
Output: "{{poor_output}}"
Criticism: "{{haiku_criticism}}"

What single instruction, added to the prompt, would have prevented this failure?
---
```

TextGrad repairs are accumulated as `known_dead_ends` entries injected into all future prompts.

#### A/B Gate — Statistical Validation Before Promotion

No template version is promoted without evidence:
- 30 paired comparisons on the same inputs
- Haiku judges which output is better per pair
- Binomial sign test: new wins 60%+ of pairs → promote
- Cost: $0.09 per A/B test (30 × $0.003 Haiku calls)

### Decision 3: Universal Trigger with Cost Gate

Any analysis path can invoke Claude Code research, but a lightweight Haiku classifier (CostGate) decides if it's worth $0.30-0.50:

```
COST-GATE-PROMPT:
---
A code research request has been triggered. Should we spend $0.30-0.50 on
deep codebase analysis?

Trigger: {{trigger_type}}
Question: "{{question}}"
Existing context items: {{context_count}} (sources: {{source_list}})
Complexity indicators: {{complexity_signals}}

Answer YES only if:
- The question requires cross-file reasoning or architecture understanding
- Existing context is insufficient (fewer than 3 relevant code items)
- The question is specific enough to produce actionable research

Answer: YES or NO (with one-sentence reason)
---
```

**Expected rejection rate**: >60% for trivial queries (simple lookups, already-answered questions).

### Decision 4: Result Caching with 24h TTL

Identical research questions (by content hash) are served from cache within 24 hours. The `claude_code_research` table stores:
- Input hash (question + repo list)
- Full structured result
- Quality scores
- Template version used
- Cost and latency metrics

### Decision 5: Concurrency Limit of 2

Via p-queue (already installed), maximum 2 concurrent Claude Code instances. This prevents:
- API rate limiting
- Machine resource exhaustion
- Budget overruns

### Decision 6: Quality Auto-Scoring via Haiku

Every Claude Code output is scored by Haiku ($0.003/invocation) on three dimensions:

| Dimension | Weight | What it measures |
|-----------|--------|------------------|
| Relevance | 0.4 | Does output address the question? |
| Depth | 0.3 | Goes beyond grep (traces chains, explains WHY)? |
| Actionability | 0.3 | Could a developer act immediately? |

Combined score drives template evolution: scores < 0.4 trigger OPRO refinement; scores > 0.8 populate the few-shot exemplar library.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TRIGGER SOURCES                           │
│  POST /api/jira/analyze  │  POST /api/chat  │  investigate  │
│  OrchestratorAgent       │  CorrelationAgent │  alerts       │
└────────────┬─────────────┴────────┬──────────┴──────────────┘
             │                      │
             ▼                      ▼
┌─────────────────────────────────────────────────────────────┐
│              CostGateClassifier (Haiku)                      │
│  "Is this worth $0.30-0.50?"                                │
│  Rejects: simple lookups, already-answered, low-complexity  │
└────────────────────────┬────────────────────────────────────┘
                         │ YES
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              PromptEvolver.buildPrompt()                     │
│  1. Select active template (or A/B candidate)               │
│  2. Inject trigger context variables                        │
│  3. Inject few-shot exemplars (by repo+area similarity)     │
│  4. Inject known_dead_ends (from TextGrad repairs)          │
│  5. Inject high_signal_paths (from past successes)          │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              ClaudeCodeRunner.execute()                      │
│  spawn('claude', ['--print', '--output-format', 'json',     │
│    '--json-schema', schema, '--bare', '--model', 'sonnet',  │
│    '--max-budget-usd', '0.50', '--add-dir', repo1,          │
│    '--add-dir', repo2, '--system-prompt', evolved_prompt,   │
│    prompt])                                                  │
│  Timeout: 120s │ Concurrency: 2 (p-queue)                   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              ResultAdapter → ContextItem[]                   │
│  source: 'claude-code'                                      │
│  title: finding.title                                       │
│  content: finding.explanation (truncated to 500 chars)      │
│  metadata: { files, confidence, cost, templateVersion }     │
└────────────────────────┬────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
┌──────────────────────┐  ┌────────────────────────────────┐
│  Merge into pipeline │  │  QualityScorer (Haiku)         │
│  (chatWithContext,   │  │  → prompt_outcomes row          │
│   answerQuestion,    │  │  → exemplar if score > 0.8     │
│   investigation)     │  │  → TextGrad if score < 0.3     │
└──────────────────────┘  └────────────────────────────────┘
                                     │
                          ┌──────────┴──────────┐
                          ▼                     ▼
               ┌─────────────────┐   ┌─────────────────────┐
               │ OPRO (weekly)   │   │ A/B Gate (30 pairs) │
               │ Generate v(N+1) │   │ before promotion    │
               └─────────────────┘   └─────────────────────┘
```

---

## Prompt Template Structure (v1 Seed)

```
You are a senior engineer researching a codebase to answer a specific question.

## Context
{{trigger_context}}

## Research Question
{{research_question}}

## Available Repos
{{repo_list_with_descriptions}}

## What Makes a Great Answer
- Trace the FULL path: entry point → middleware → handler → DB query → response
- Show blast radius: what else breaks if this changes?
- Identify the WHY, not just the WHERE
- Include specific file paths and line numbers
- If config/feature flags are involved, show the flag name and current status
{{dynamic_instructions}}

## Known Shortcuts (from past research)
{{few_shot_examples}}

## Avoid These Dead Ends
{{known_dead_ends}}

## Priority Paths (historically high-signal)
{{high_signal_paths}}

## Output Format
Return findings as structured JSON matching the provided schema.
Focus on the 3 most important findings. Quality over quantity.
```

### Template Variables by Trigger Type:

| Variable | jira_analyze | chat | investigate | alert |
|----------|-------------|------|-------------|-------|
| `trigger_context` | Ticket key, title, description, comments | Chat message + history | Issue key, hypothesis, trace so far | Event payload |
| `research_question` | "What code paths are affected by this ticket?" | User's question | "Verify this hypothesis against the code" | "What changed that could cause this alert?" |
| `repo_list` | example-service + operations | All 3 | example-service + operations | Dynamic based on alert source |
| `dynamic_instructions` | "Focus on the component mentioned in the ticket" | Based on entity extraction | "Check feature flag status in operations" | "Compare to last known good state" |

---

## Interfaces

```typescript
// src/services/claude-code-runner.ts

export interface ClaudeCodeRequest {
  prompt: string;
  repos: string[];
  model?: string;               // Default: 'sonnet'
  maxBudget?: number;           // Default: 0.50
  timeoutMs?: number;           // Default: 120_000
  allowedTools?: string[];      // Default: ['Read', 'Bash(grep *)', 'Bash(find *)', 'Bash(git log *)']
  jsonSchema?: object;
  systemPrompt?: string;        // Injected by PromptEvolver
}

export interface ClaudeCodeResult {
  findings: ResearchFinding[];
  filesExamined: string[];
  confidence: number;           // 0.0-1.0
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

// src/intelligence/prompt-evolver.ts

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
}

export type TriggerType = 'jira_analyze' | 'chat' | 'investigate' | 'alert';

export interface PromptEvolutionConfig {
  refinementThreshold: number;     // 0.4 — triggers OPRO
  repairThreshold: number;         // 0.3 — triggers TextGrad
  promotionThreshold: number;      // 0.7 — marks as stable
  exemplarThreshold: number;       // 0.8 — adds to few-shot library
  abTestTrafficSplit: number;      // 0.2 — new version gets 20%
  abTestMinPairs: number;          // 30 — minimum for sign test
  abTestWinRate: number;           // 0.6 — 60% to promote
  minInvocationsForEval: number;   // 20 — before judging
  maxTemplateVersions: number;     // 5 — keep last N
  oproInterval: number;            // 20 — invocations between OPRO runs
}

export interface QualityScore {
  relevance: number;    // 0.0-1.0
  depth: number;        // 0.0-1.0
  actionability: number; // 0.0-1.0
  combined: number;     // weighted average
}

// src/intelligence/cost-gate.ts

export interface CostGateInput {
  triggerType: TriggerType;
  question: string;
  existingContextCount: number;
  existingCodeItems: number;
  complexitySignals: string[];
}

export interface CostGateResult {
  approved: boolean;
  reason: string;
  estimatedValue: number;  // 0.0-1.0
}
```

---

## Schema v43

```sql
-- Research result cache
CREATE TABLE IF NOT EXISTS claude_code_research (
  id INTEGER PRIMARY KEY,
  input_hash TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  question TEXT NOT NULL,
  repos TEXT NOT NULL,               -- JSON array of repo paths
  template_id INTEGER REFERENCES prompt_templates(id),
  result TEXT NOT NULL,              -- JSON ClaudeCodeResult
  confidence REAL,
  quality_score REAL,
  tokens_used INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  model TEXT,
  expires_at TEXT NOT NULL,          -- cache TTL
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(input_hash)
);

-- Prompt templates with versioning and evolution tracking
CREATE TABLE IF NOT EXISTS prompt_templates (
  id INTEGER PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  template TEXT NOT NULL,
  system_context TEXT,
  effectiveness_score REAL DEFAULT 0.5,
  invocation_count INTEGER DEFAULT 0,
  avg_quality_score REAL,
  is_active INTEGER DEFAULT 0,
  ab_weight REAL DEFAULT 0.0,
  promoted_at TEXT,
  deprecated_at TEXT,
  evolution_source TEXT DEFAULT 'manual',
  parent_version INTEGER,
  known_dead_ends TEXT,              -- JSON array (accumulated TextGrad repairs)
  high_signal_paths TEXT,            -- JSON array (from successful outcomes)
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(trigger_type, version)
);

-- Per-invocation quality tracking
CREATE TABLE IF NOT EXISTS prompt_outcomes (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES prompt_templates(id),
  research_id INTEGER REFERENCES claude_code_research(id),
  trigger_input TEXT NOT NULL,
  quality_score REAL,
  relevance_score REAL,
  depth_score REAL,
  actionability_score REAL,
  user_feedback INTEGER,
  context_was_used INTEGER,
  tokens_used INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Few-shot example library
CREATE TABLE IF NOT EXISTS research_exemplars (
  id INTEGER PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  repo TEXT NOT NULL,
  area TEXT,
  input_summary TEXT NOT NULL,
  output_summary TEXT NOT NULL,
  quality_score REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_research_hash ON claude_code_research(input_hash);
CREATE INDEX IF NOT EXISTS idx_research_expires ON claude_code_research(expires_at);
CREATE INDEX IF NOT EXISTS idx_templates_active ON prompt_templates(trigger_type, is_active);
CREATE INDEX IF NOT EXISTS idx_outcomes_template ON prompt_outcomes(template_id, created_at);
CREATE INDEX IF NOT EXISTS idx_exemplars_type ON research_exemplars(trigger_type, repo, quality_score);
```

---

## Integration Points

### POST /api/jira/analyze (web-server.js ~line 3223)

After ticket context is built, before the 3-parallel analysis calls:

```typescript
// After building ticketContext...
let claudeCodeContext: ContextItem[] = [];
if (await costGate.evaluate({ triggerType: 'jira_analyze', question: title, ... })) {
  const prompt = await promptEvolver.buildPrompt('jira_analyze', { key, title, description });
  const result = await claudeCodeRunner.execute({ prompt, repos: ALL_REPOS });
  claudeCodeContext = resultAdapter.toContextItems(result);
  // Score async (fire-and-forget)
  qualityScorer.score(result, prompt).catch(() => {});
}
// Merge into allContext before analysis calls
const allContext = [...ticketContext, ...linkedContext, ...claudeCodeContext];
```

### POST /api/chat (web-server.js ~line 3586)

After FTS5 + Palace lookup, when code context is needed:

```typescript
// After grep returns 0 results OR complexity is high
if (codeItems.length === 0 || isComplexCodeQuestion(message)) {
  if (await costGate.evaluate({ triggerType: 'chat', question: message, ... })) {
    const prompt = await promptEvolver.buildPrompt('chat', { message, entities });
    const result = await claudeCodeRunner.execute({ prompt, repos: ALL_REPOS });
    codeItems.push(...resultAdapter.toContextItems(result));
  }
}
```

### InvestigationOrchestrator (dispatchTool)

Add `call_claude_code` as a 10th tool option:

```typescript
case 'call_claude_code': {
  const { question, focus_repo } = input as { question: string; focus_repo?: string };
  const repos = focus_repo ? [this.searchPaths[focus_repo]] : Object.values(this.searchPaths);
  const prompt = await this.promptEvolver.buildPrompt('investigate', { question, issueKey });
  const result = await this.claudeCodeRunner.execute({ prompt, repos, maxBudget: 0.30 });
  return JSON.stringify(result.findings.slice(0, 3));
}
```

---

## Evolution Lifecycle

```
Phase 1 (Week 1-2): Bootstrap
├── Manual seed prompts (v1) for each trigger type
├── Auto-score every output with Haiku ($0.003/run)
└── Accumulate 20+ outcomes per trigger type

Phase 2 (Week 3-4): First Evolution Cycle
├── OPRO generates v2 candidates from top-5/bottom-5 outcomes
├── TextGrad repairs individual failures (score < 0.3)
├── A/B gate: v2 at 20% traffic
└── If v2 wins 60%+ of 30 pairs → promote

Phase 3 (Week 5+): Continuous Improvement
├── Few-shot library populated from outputs scoring > 0.8
├── Dynamic example injection based on repo + area similarity
├── known_dead_ends growing from TextGrad repairs
├── high_signal_paths growing from successful outcomes
└── Monthly PromptBreeder sprint: 10 mutations, keep winner

Steady State: Each template evolves independently per trigger type.
jira_analyze prompts optimize for ticket-specific patterns.
chat prompts optimize for conversational code questions.
investigate prompts optimize for hypothesis verification.
```

---

## Alternatives Considered

### 1. Direct Anthropic SDK with Custom Tools

Build another ReAct loop using `@anthropic-ai/sdk` directly with file-reading tools.

**Rejected because**: This is what we already have (InvestigationOrchestrator). The whole point is to leverage Claude Code's superior code understanding — its built-in AST parsing, semantic search, and cross-file reasoning exceed what a custom tool dispatch loop can achieve.

### 2. Agent SDK (@anthropic-ai/agent-sdk)

Use the programmatic Agent SDK for structured agent spawning.

**Rejected because**: Not yet stable, adds a dependency, and the CLI `--print` mode gives us everything we need (structured JSON output, schema validation, budget control). Design is future-compatible — swapping CLI for SDK requires changing only `ClaudeCodeRunner.execute()`.

### 3. Static Prompts with Manual Tuning

Hand-craft prompts and tune them manually based on observation.

**Rejected because**: Doesn't scale. With 4 trigger types × multiple repos × evolving codebase, manual tuning can't keep up. The self-evolving system handles this automatically with measurable improvement.

### 4. Fine-tuned Model

Train a model specifically for our codebase research patterns.

**Rejected because**: Requires training infrastructure, data collection pipeline, and model hosting. Overkill when prompt optimization achieves similar results at zero infrastructure cost.

---

## Consequences

### Positive

- Analysis quality jumps dramatically — Claude Code reasons about code at a level grep cannot
- Prompts improve monotonically — each invocation leaves evidence for the next
- Universal integration — any analysis path benefits, not just investigations
- Cost-controlled — CostGate rejects low-value requests, budget cap prevents overruns
- Observable — every invocation scored, every template version tracked
- Zero new infrastructure — CLI already installed, p-queue already in deps, SQLite storage

### Negative

- Latency: 30-120s per Claude Code invocation (mitigated by async + cache)
- Cost: $0.30-0.50 per invocation + $0.003 scoring (mitigated by CostGate + caching)
- Cold start: First 20 invocations have no evolution signal
- CLI stability: `claude --print` interface could change between versions

### Neutral

- Template versions accumulate (capped at 5 per trigger type)
- A/B testing requires 30 invocations before promoting — deliberate slowness is a feature
- Prompt evolution is asynchronous to the user experience — they see improvement over days, not instantly

---

## Implementation Plan

| Wave | Files | Effort | Deliverable |
|------|-------|--------|-------------|
| 1 | 3 files (2 new, 1 edit) | 1 day | Core runner + schema + cache |
| 2 | 2 files (new) | 1.5 days | Prompt evolver + cost gate |
| 3 | 3 files (edits) | 1.5 days | Universal integration |
| 4 | 3 files (2 new, 1 edit) | 1.5 days | Feedback loop + UI + refinement job |

**Total**: ~5-6 days across 4 waves.

---

## Verification

### Functional Tests

1. Spawn `claude --print -p "list files in src/" --output-format json` → verify JSON response
2. CostGate rejects "what time is it?" with reason "not a code question"
3. CostGate approves "trace the login flow from entry to DB" with reason "requires cross-file reasoning"
4. PromptEvolver returns v1 seed for fresh system (no prior outcomes)
5. After 20 invocations with mock scores, OPRO proposes v2 candidate
6. A/B gate promotes v2 after simulated 60% win rate
7. TextGrad generates repair instruction for score-0.2 failure
8. Few-shot library rejects score-0.6 output, accepts score-0.85 output

### Integration Tests

9. POST /api/jira/analyze on real ticket → response includes Claude Code findings
10. POST /api/chat with "how does auth work in example-service?" → triggers Claude Code research
11. Investigation with `call_claude_code` tool → returns structured findings
12. Thumbs-up on research finding → prompt_outcomes row written with user_feedback=1

### Technical Checks

13. `npm run build` passes with all new TypeScript files
14. p-queue limits concurrent invocations to 2
15. Cache hit returns result without spawning process
16. 120s timeout kills hung Claude Code process cleanly
17. Budget cap prevents $5 responses (max-budget-usd enforced)
