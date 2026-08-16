---
sidebar_label: "Research Engine"
sidebar_position: 9
---

# Research Engine — Proactive Intelligence Brain

> **Status**: Research Complete, Implementation Planned  
> **ADR**: [ADR-020: Proactive Intelligence Brain](../adr/adr-020-proactive-intelligence-brain.md)  
> **Sprint**: 19 (planned)  
> **Last Updated**: 2026-05-05

The Research Engine is a unified agentic investigation system that enables the chat, Jira analyzer, and PR review to proactively search codebases, trace call graphs, and accumulate knowledge — replacing the current passive, single-shot context retrieval.

---

## Why This Exists

The system has a critical gap: when asked "how does the frontend call search-provider search?", the chat endpoint returns "no context" because:

1. **Code search is gated by Jira key** — questions without a ticket number get zero code context
2. **Domain terms are in the stop-word list** — "search-provider" and "search" are filtered out before grep
3. **No iteration** — one grep, no file reading, no tracing
4. **Silent failures** — all context lookups fail silently with empty catch blocks
5. **No knowledge accumulation** — answers are ephemeral, never stored for future use

The investigation engine (Phase 55) already proves that a ReAct loop with iterative tools works. But it's locked inside bug investigation. The Research Engine extracts this pattern into a shared service for all callers.

---

## Architecture Decision: Three-Tier Hybrid

After evaluating 10 agentic architectures (ReAct, Plan-and-Execute, Reflexion, Multi-Agent, FLARE, Tree of Thoughts, Hierarchical Decomposition, Self-RAG, SWE-Agent patterns, and Streaming Refinement), the recommended approach is a **three-tier hybrid**:

```
┌──────────────────────────────────────────────────────────────┐
│                    RESEARCH ENGINE                             │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────┐  ┌────────────────┐  ┌──────────────────┐  │
│  │  Tier 1     │  │    Tier 2      │  │     Tier 3       │  │
│  │ Quick ReAct │  │ Plan + Execute │  │ Subagent Decomp  │  │
│  │  (60%)      │  │    (30%)       │  │     (10%)        │  │
│  └──────┬──────┘  └───────┬────────┘  └────────┬─────────┘  │
│         │                  │                     │            │
│         ▼                  ▼                     ▼            │
│  ┌─────────────────────────────────────────────────────┐     │
│  │              Shared Tool Registry (19 tools)         │     │
│  └─────────────────────────────────────────────────────┘     │
│         │                  │                     │            │
│         ▼                  ▼                     ▼            │
│  ┌─────────────────────────────────────────────────────┐     │
│  │           Model Router (Local / Cloud)               │     │
│  │  ┌──────────────┐  ┌─────────────────────────────┐  │     │
│  │  │ Ollama       │  │ Anthropic API               │  │     │
│  │  │ Qwen3-Coder  │  │ Haiku (fast) / Sonnet (deep)│  │     │
│  │  │ 30B-A3B      │  │ with prompt caching         │  │     │
│  │  └──────────────┘  └─────────────────────────────┘  │     │
│  └─────────────────────────────────────────────────────┘     │
│         │                                                     │
│         ▼                                                     │
│  ┌─────────────────────────────────────────────────────┐     │
│  │          Knowledge Enrichment Layer                  │     │
│  │  messages (FTS5) + Palace KG + codebase_knowledge   │     │
│  └─────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

### Why Not Pure ReAct?

Pure ReAct (think → tool → observe → repeat) fails for code investigation because:
- **Gets stuck in loops** — grepping the same term repeatedly
- **No backtracking** — once it follows the wrong import chain, it rarely recovers
- **Flat exploration** — no prioritization of paths
- **Context bloat** — by iteration 6, the window is full of irrelevant file contents

### Why Not Exotic Architectures?

- **LATS / Tree of Thoughts**: 2-3x token cost for marginal gains. Tree search overhead only pays off for extremely hard reasoning, not code navigation.
- **Full Multi-Agent Debate**: Overhead of coordinating arguing agents exceeds benefit. Subagents (Tier 3) capture parallelism without debate.
- **FLARE/Self-RAG**: Retrieval-optimization patterns for RAG, less relevant when the agent has direct file access.

### What Production Systems Actually Use

| System | Architecture | Key Insight |
|--------|-------------|-------------|
| Claude Code | ReAct + subagents | Simple loop + delegation for complex tasks |
| mini-SWE-Agent | Pure ReAct, bash only | 100 lines of Python matches complex systems |
| Aider | Map-then-Edit | Repo map is the killer feature |
| Devin | Plan-and-Execute + checkpoints | Long-running tasks with replanning |
| Cursor | Hybrid retrieval + re-ranking | Function-level indexing, graph-aware context |

---

## The Three Tiers

### Tier 1: Enhanced ReAct (60% of queries)

**Use for**: Simple lookups, "where is X", "read function Y", single-file questions.

**Budget**: Max 5 iterations, 15s timeout.

**Enhancements over basic ReAct**:
1. **Structural pre-flight** — inject repo map before first tool call (Aider's technique)
2. **Early termination** — "If you have enough evidence after iteration 2, conclude immediately"
3. **Dead-end detection** — if same search returns no results twice, force alternative approach
4. **State tracking** — explicit investigation state injected after every tool result

```typescript
// Tier 1 flow
const repoMap = repoMapper.getContextualMap(query, [], 2000);
const result = await engine.investigate({
  goal: 'answer_question',
  question: userMessage,
  preContext: repoMap,
  maxIterations: 5,
  timeout: 15_000,
  tools: CORE_TOOLS,
  model: 'haiku',
  stateTracking: true,
  loopDetection: true,
});
```

### Tier 2: Plan-then-Execute with Reflection (30% of queries)

**Use for**: Bug traces, multi-file analysis, "how does X work end-to-end".

**Budget**: Max 8 iterations (2 for planning + 5 for execution + 1 for reflection), 30s timeout.

**Flow**:
1. **Plan** (1 LLM call): Generate 3-5 investigation steps with hypotheses
2. **Execute** (mini ReAct per step, max 3 iterations each): Execute independently
3. **Reflect** (1 LLM call): "Do findings fully answer the question? What's missing?"
4. **Replan** (optional, max 1): If reflection identifies gaps, generate 1-2 additional steps

```typescript
// Tier 2 flow
const plan = await engine.plan({
  question: userMessage,
  repoMap,
  maxSteps: 5,
});

for (const step of plan.steps) {
  const stepResult = await engine.executeStep(step, { maxIterations: 3 });
  if (stepResult.confidence > 0.8) break;
}

const reflection = await engine.reflect(plan, findings);
if (reflection.gaps.length > 0) {
  const extraSteps = await engine.replan(reflection.gaps);
  // Execute extra steps...
}
```

### Tier 3: Subagent Decomposition (10% of queries)

**Use for**: PR review, full architecture analysis, complex cross-cutting concerns.

**Budget**: 2-4 parallel subagents, each with max 4 iterations, 30s total timeout.

**Flow**:
1. **Decompose** (1 LLM call): Break into 2-4 independent sub-questions
2. **Parallel subagents**: Each gets its own isolated context + restricted tools
3. **Synthesize** (1 LLM call): Merge findings into coherent answer

```typescript
// Tier 3 flow
const subQuestions = await engine.decompose(question);

const results = await Promise.all(
  subQuestions.map(sq => engine.investigate({
    goal: 'answer_question',
    question: sq,
    maxIterations: 4,
    timeout: 15_000,
    tools: CORE_TOOLS,
    isolated: true,  // separate context
  }))
);

const synthesis = await engine.synthesize(results);
```

### Tier Selection (Classification)

Server-side heuristic — deterministic, no LLM call:

```typescript
function classifyTier(message: string, contextRichness: number): 1 | 2 | 3 {
  // Tier 3: PR review, architecture analysis
  if (message.match(/review.*pr|architecture.*analysis|cross.?cutting/i)) return 3;
  
  // Tier 2: Multi-step investigation
  if (message.match(/how does|trace|end.?to.?end|investigate|debug/i)) return 2;
  if (contextRichness < 3 && message.match(/code|implement|function|file/i)) return 2;
  
  // Tier 1: Everything else that needs research
  return 1;
}
```

---

## Model Strategy: Hybrid Local + Cloud

### The Decision Matrix

| Factor | Local (Ollama) | Cloud (Anthropic) |
|--------|---------------|-------------------|
| **Cost** | Free (electricity only) | $0.038/session (Haiku) |
| **Speed** | 20-28 tok/s (Qwen3-Coder 30B-A3B) | 60-80 tok/s (Haiku) |
| **Tool-call reliability** | 95%+ (Qwen3) | 99%+ (Claude) |
| **Latency per iteration** | 4-12s | 1-1.5s |
| **Session time (5 iter)** | 30-90s | 5-8s |
| **Monthly cost (30/day)** | ~$0.36 | ~$34.40 |
| **Context window** | 256K (Qwen3-Coder) | 200K (Haiku) |
| **Prompt caching** | Not supported | 76% savings across iterations |

### Recommended Model: Qwen3-Coder-30B-A3B via Ollama

**Why this specific model**:
- **MoE architecture**: 30.5B total params, only 3.3B active per token → fast inference despite large knowledge
- **256K context window**: Handles full investigation traces
- **Purpose-built for agentic coding**: Optimized for tool calling in code contexts
- **Fits in 36GB RAM at Q4**: ~19GB model + ~17GB for KV cache + OS
- **20-28 tok/s on M3 Pro**: Each iteration completes in 4-12s

### Hybrid Routing Strategy

```
┌────────────────────────────────────────────────┐
│                Model Router                      │
├────────────────────────────────────────────────┤
│                                                 │
│  Simple iterations (grep → read → list):        │
│    → Ollama (Qwen3-Coder-30B-A3B)              │
│    → 4-12s per iteration, free                  │
│                                                 │
│  Complex reasoning (synthesis, root cause):     │
│    → Claude Haiku via Anthropic API             │
│    → 1-1.5s per iteration, $0.038/session       │
│                                                 │
│  Fallback (Ollama unavailable):                 │
│    → Claude Haiku for everything                │
│                                                 │
│  Deep analysis (investigation, PR review):      │
│    → Claude Sonnet for final synthesis          │
│    → $0.15/session, best quality                │
│                                                 │
└────────────────────────────────────────────────┘
```

### SDK Compatibility

Ollama now exposes an **Anthropic-compatible API** at `/v1/messages`:

```typescript
import Anthropic from '@anthropic-ai/sdk';

// Local model
const ollama = new Anthropic({
  baseURL: 'http://localhost:11434',
  apiKey: 'ollama',
});

// Cloud model
const claude = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Same tool_use format works for both!
const response = await ollama.messages.create({
  model: 'qwen3-coder:30b-a3b',
  max_tokens: 1024,
  tools: RESEARCH_TOOLS,
  messages: conversationHistory,
});
```

**Limitations of Ollama's Anthropic compat**:
- `tool_choice` not supported (can't force specific tool)
- `cache_control` not supported (no prompt caching)
- Token counts are approximations

### Environment Configuration

```bash
# .env additions for Research Engine
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen3-coder:30b-a3b
RESEARCH_ENGINE_PROVIDER=hybrid    # hybrid | local | cloud
RESEARCH_ENGINE_TIMEOUT=30000      # ms
RESEARCH_ENGINE_MAX_ITERATIONS=8
```

### Cost Comparison

| Strategy | Per Session | Daily (30) | Monthly |
|----------|-----------|-----------|---------|
| All Sonnet | $0.151 | $4.52 | $135 |
| All Haiku | $0.038 | $1.15 | $34 |
| Hybrid (3 local + 2 Haiku) | $0.016 | $0.49 | $15 |
| All Local | $0.0004 | $0.01 | $0.36 |

**Recommendation**: Start with **All Haiku** (simplest, fast, reliable). Add local model as optimization once the engine is proven. The $34/month cost is trivial compared to developer productivity gains.

---

## Techniques Adopted from Production Systems

### 1. Pre-computed Repo Map (from Aider)

Before the agent starts investigating, inject a structural overview of the monorepo — function/class signatures ranked by relevance to the current query.

**How Aider does it**:
- Tree-sitter parse → extract definitions and references
- Build a MultiDiGraph (nodes = files, edges = cross-file references)
- PageRank with boost multipliers:
  - Files in current focus: **50x boost**
  - Mentioned identifiers: **10x boost**
  - Complex symbol names (8+ chars, camelCase): **10x**
  - Private symbols: **0.1x penalty**
- Binary search for largest subset fitting token budget

**Our adaptation**: We already have `smart_outline` and `smart_search` via the claude-mem MCP. The repo map is pre-computed from the `code_graph` table (already indexed). Inject the top-ranked 2000 tokens as `{architecture_snapshot}` in the system prompt.

### 2. Investigation State Tracking (from SWE-Agent)

After every tool result, inject explicit state:

```
=== INVESTIGATION STATE ===
Iteration 3/8 | Confidence: 0.45
Hypotheses: [ACTIVE] "openui5 bump broke async call" | [REFUTED] "example-service code changed"
Files viewed: package.json, useRecommendedLinks.ts
Searches: "getResourceBundle" (0 hits in example-service)
Dead ends: grep "search-provider" → 0 results (filtered by stop-words)
```

This prevents the model from losing track after 4+ iterations and explicitly prevents re-exploring dead ends.

### 3. Loop Detection and Forced Divergence (from Devin)

```typescript
function detectLoop(trace: ToolCall[]): boolean {
  const last3 = trace.slice(-3).map(t => `${t.tool}:${hash(t.input)}`);
  if (new Set(last3).size === 1) return true;  // Same call 3x
  
  const last6 = trace.slice(-6).map(t => `${t.tool}:${hash(t.input)}`);
  if (last6.length >= 4) {
    const p1 = last6.slice(0, 2).join('|');
    const p2 = last6.slice(2, 4).join('|');
    if (p1 === p2) return true;  // A→B→A→B pattern
  }
  return false;
}
```

When detected, inject: "LOOP DETECTED: You MUST try a completely different approach."

### 4. Viewport-Based File Reading (from SWE-Agent)

Instead of dumping 300 lines, show a 100-line window with navigation:

```
[Viewing src/auth/middleware.ts, lines 45-145 of 312]
 45 | export function validateToken(req: Request) {
 46 |   const token = req.headers.authorization;
...
145 | }
[Use goto(line) or scroll_down/scroll_up to navigate]
```

Forces the model to be precise — read the specific function, not the entire file.

### 5. Structured Tool Output (from SWE-Agent + Claude Code)

Every tool result follows a consistent format with boundary markers:

```
=== GREP_CODE RESULT ===
Found 3 matches for "useRecommendedLinks" in example-service:
  components/ui-react-shell/src/models/recommend-links/useRecommendedLinks.ts:15
  components/ui-react-shell/src/models/recommend-links/index.ts:2
  apps/recommended-links/src/handler.ts:42
=== END GREP_CODE ===
```

### 6. Context Compression for Long Investigations (from Devin)

After iteration 4, compress early iterations into a summary:

```
Iterations 1-3 summary:
- Checked git log: found openui5 bump Apr 16
- Searched example-service for getResourceBundle: 0 hits
- Read smrdp-ui-plugins/Component.js: calls getResourceBundle() synchronously
Hypothesis "openui5 async breaking change" is ACTIVE (confidence: 0.6)
```

Only the last 2 full iterations remain in the message history. This keeps context under budget for 8-iteration investigations.

### 7. Graduated Tool Descriptions (from Claude Code)

Tool descriptions encode investigation strategy, not just syntax:

```typescript
{
  name: 'grep_code',
  description: `Search for a regex pattern across source files. RULES:
- Start broad (module name), then narrow (specific function)
- If 0 results: the codebase may use a different abstraction name
- If >20 results: add a file glob to narrow (e.g., '*.tsx' for React)
- After finding files, ALWAYS call read_file next to understand context`,
}
```

---

## Tool Registry

### Tier 1: Core Discovery (all callers)

| Tool | Description | Source |
|------|-------------|--------|
| `grep_code` | Regex search across repos | investigation-orchestrator.ts:249 |
| `read_file` | Read source with line numbers (100-line viewport) | tools/file-reader.ts |
| `list_files` | Directory structure discovery | investigation-orchestrator.ts:631 |
| `search_docs` | Search README/docs/ADRs | New |
| `git_history` | Recent commits or blame | tools/git-log-window.ts |
| `search_jira` | Fetch Jira ticket via MCP | jira MCP |
| `search_codebase_knowledge` | Indexed architecture docs | codebase_knowledge table |

### Tier 2: Analysis (analyzer, investigation, PR review)

| Tool | Description | Source |
|------|-------------|--------|
| `trace_call_graph` | Follow imports/exports via code_graph | tools/call-graph-tracer.ts |
| `blast_radius` | BFS depth-2 impact analysis | GET /api/code-graph/blast-radius |
| `test_coverage` | Map files → test files | GET /api/code-graph/test-coverage |
| `get_ownership` | Team ownership via CODEOWNERS | ownership-map.ts |
| `fetch_link` | Playwright browser fetch (SSO) | ADR-019 link-fetcher |
| `search_operations` | Grep operations repo | New |
| `get_flag_diff` | Feature flag changes | investigation-orchestrator.ts:666 |
| `get_dep_diff` | Dependency version changes | investigation-orchestrator.ts:576 |
| `search_pr_history` | Recent PRs by keyword/file/author | GitHub MCP |
| `get_architecture` | Architecture docs by area | investigation-orchestrator.ts:656 |

### Tier 3: Conclusion (investigation + PR review only)

| Tool | Description | Source |
|------|-------------|--------|
| `conclude` | Record structured investigation conclusion | investigation-orchestrator.ts:710 |
| `pr_risk_assessment` | Risk level + missing tests | analyzer.ts:1422 |

### Tool Allocation Matrix

| Tool | Chat Quick | Chat Deep | Analyzer | Investigation | PR Review |
|------|:---:|:---:|:---:|:---:|:---:|
| grep_code | - | yes | yes | yes | yes |
| read_file | - | yes | yes | yes | yes |
| list_files | - | yes | yes | yes | - |
| search_docs | - | yes | yes | yes | - |
| git_history | - | yes | yes | yes | yes |
| search_jira | - | yes | yes | yes | yes |
| search_codebase_knowledge | - | yes | yes | yes | yes |
| trace_call_graph | - | - | yes | yes | yes |
| blast_radius | - | - | yes | yes | yes |
| test_coverage | - | - | yes | yes | yes |
| get_ownership | - | - | yes | yes | yes |
| fetch_link | - | - | yes | - | - |
| search_operations | - | - | yes | yes | - |
| get_flag_diff | - | - | - | yes | - |
| get_dep_diff | - | - | - | yes | - |
| search_pr_history | - | yes | yes | yes | yes |
| get_architecture | - | yes | yes | yes | - |
| conclude | - | - | - | yes | - |
| pr_risk_assessment | - | - | - | - | yes |

---

## Implementation: The ReAct Loop

### Why Custom (Not a Framework)

After evaluating Vercel AI SDK, LangChain, and custom approaches:

| Option | Verdict | Reason |
|--------|---------|--------|
| **Custom loop on Anthropic SDK** | **Recommended** | Zero deps, prompt caching works, 150 lines, total control |
| Vercel AI SDK (`generateText`) | Rejected | Hides message array, can't inject state between iterations |
| LangChain/LangGraph | Rejected | Heavy deps (200+ packages), abstractions fight our needs |
| Claude Agent SDK | For Tier 3 only | Good for subagents, overkill for Tier 1/2 |

### Core Loop (150 lines)

```typescript
import Anthropic from '@anthropic-ai/sdk';

interface ResearchConfig {
  goal: 'answer_question' | 'analyze_ticket' | 'investigate_bug' | 'review_pr';
  question: string;
  maxIterations: number;
  timeout: number;
  tools: ToolDefinition[];
  model: string;
  preContext?: string;  // repo map, architecture knowledge
}

interface ResearchResult {
  findings: ContextItem[];
  trace: ReActEntry[];
  confidence: number;
  blockers: ResearchBlocker[];
  tokensUsed: number;
}

async function investigate(config: ResearchConfig): Promise<ResearchResult> {
  const client = selectClient(config);  // Ollama or Anthropic
  const state: InvestigationState = { iteration: 0, filesViewed: [], hypotheses: [], searches: [] };
  
  const messages: Message[] = [];
  let stopReason: string = '';
  
  const systemPrompt = buildSystemPrompt(config);
  
  while (state.iteration < config.maxIterations && stopReason !== 'end_turn') {
    state.iteration++;
    
    const response = await client.messages.create({
      model: config.model,
      max_tokens: 2048,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: config.tools,
      messages,
    });
    
    stopReason = response.stop_reason;
    
    if (stopReason === 'tool_use') {
      // Extract all tool_use blocks (may be parallel)
      const toolBlocks = response.content.filter(b => b.type === 'tool_use');
      
      // Execute tools (parallel if multiple)
      const results = await Promise.all(
        toolBlocks.map(block => dispatchTool(block.name, block.input, state))
      );
      
      // Append assistant message + tool results
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: results.map((r, i) => ({
          type: 'tool_result',
          tool_use_id: toolBlocks[i].id,
          content: formatToolOutput(toolBlocks[i].name, r, state),
        })),
      });
      
      // Loop detection
      if (detectLoop(state.trace)) {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: LOOP_DETECTED_PROMPT }],
        });
      }
      
      // Context compression after iteration 4
      if (state.iteration > 4) {
        messages = compressEarlyIterations(messages, state);
      }
    }
  }
  
  return extractFindings(messages, state);
}
```

### Prompt Caching Across Iterations

The Anthropic API caches system prompt + tool definitions after iteration 1. For a 5-iteration session:

```
Iteration 1: Full cache write (5000 tokens × $1.00/MTok = $0.005)
Iteration 2-5: Cache read (5000 tokens × $0.08/MTok × 4 = $0.0016)
                vs uncached (5000 tokens × $0.80/MTok × 4 = $0.016)
```

**Savings: 76% on the cached portion** across a typical session. The 5-minute TTL easily covers all iterations (sessions complete in 5-30s).

### Parallel Tool Dispatch

When the model returns multiple `tool_use` blocks in one response, execute them concurrently:

```typescript
// Model returns 2 tool calls in one response:
// [{ tool: 'grep_code', input: { pattern: 'search-provider' } },
//  { tool: 'search_docs', input: { query: 'search integration' } }]

const results = await Promise.all(
  toolBlocks.map(block => dispatchTool(block.name, block.input))
);

// Return all results in a single user message with tool_result blocks
```

### Confidence Signaling

The model calls `report_findings` when it has enough evidence:

```typescript
{
  name: 'report_findings',
  description: 'Call this when you have enough evidence to answer the question. Include your confidence level.',
  input_schema: {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      evidence: { type: 'array', items: { type: 'string' } },
      blockers: { type: 'array', items: { type: 'string' } },
    },
    required: ['answer', 'confidence', 'evidence'],
  },
}
```

---

## Knowledge Enrichment

After every research session, findings are persisted for future retrieval:

### Schema: `research_findings` table

```sql
CREATE TABLE research_findings (
  id INTEGER PRIMARY KEY,
  question_hash TEXT NOT NULL,        -- SHA-256 of normalized question
  question_text TEXT NOT NULL,        -- Original question
  answer_summary TEXT NOT NULL,       -- Condensed answer (max 500 chars)
  confidence REAL NOT NULL,           -- 0.0-1.0
  findings_json TEXT NOT NULL,        -- Full ContextItem[] as JSON
  model_used TEXT NOT NULL,           -- 'haiku' | 'sonnet' | 'qwen3-coder'
  tokens_used INTEGER NOT NULL,
  iterations_used INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT DEFAULT (datetime('now')),
  use_count INTEGER DEFAULT 1,
  stale INTEGER DEFAULT 0             -- Set to 1 when cited files change
);

CREATE INDEX idx_research_q_hash ON research_findings(question_hash);
CREATE INDEX idx_research_stale ON research_findings(stale);
```

### Schema: `finding_references` table

```sql
CREATE TABLE finding_references (
  id INTEGER PRIMARY KEY,
  finding_id INTEGER NOT NULL REFERENCES research_findings(id),
  ref_type TEXT NOT NULL,             -- 'file' | 'jira' | 'function' | 'concept'
  ref_value TEXT NOT NULL,            -- file path, Jira key, function name, etc.
  UNIQUE(finding_id, ref_type, ref_value)
);

CREATE INDEX idx_fref_value ON finding_references(ref_value);
```

### Freshness Strategy (Three Layers)

1. **Time decay**: `confidence *= 0.95` per week since `created_at`
2. **Git-change invalidation**: When `git diff` shows a cited file changed, set `stale = 1`
3. **Confirmation strengthening**: When a finding is reused and confirmed, `confidence += 0.1`

### Question Normalization (Dedup)

```typescript
function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')          // strip punctuation
    .split(/\s+/)
    .filter(w => !GRAMMAR_WORDS.has(w))    // remove "how", "does", "the", etc.
    .sort()
    .join(' ');
}
// "How does the frontend call search-provider search?" 
// → "call search-provider frontend search"
// → SHA-256 hash for lookup
```

### Enrichment Flow

```
Research completes with findings
  │
  ├─ Store in research_findings (question_hash → answer)
  │
  ├─ Store references in finding_references
  │     (finding_id, 'file', 'src/auth/middleware.ts')
  │     (finding_id, 'jira', 'PROJ-15720')
  │     (finding_id, 'function', 'useRecommendedLinks')
  │
  ├─ Insert into messages table (source='research', FTS5 indexed)
  │     → Future FTS queries will find this research
  │
  └─ Write Palace KG triples
        (PROJ-15720, 'touches', 'src/plugins/context-links.ts')
        (useRecommendedLinks, 'calls', 'search-provider-service.ts')
```

---

## Integration Points

### Chat Endpoint (`POST /api/chat`)

```
User message arrives
  │
  ├─ Step 1: Standard context assembly (FTS + palace + codebase_knowledge)
  │
  ├─ Step 2: CLASSIFY — needsDeepResearch(message, contextRichness)?
  │           Heuristic: "how does" + code-related + sparse context → YES
  │
  ├─ Step 3: Check research_findings cache (question_hash lookup)
  │           → If fresh cached finding exists, use it directly
  │
  ├─ Step 4: ResearchEngine.investigate({...})
  │           → Iterative tool-use loop (3-8 iterations)
  │
  ├─ Step 5: MERGE research findings + standard context
  │
  ├─ Step 6: chatWithContext(history, message, richContext)
  │           → Claude generates answer with real code evidence
  │
  └─ Step 7: ENRICH knowledge (async, non-blocking)
```

### Jira Analyzer (`POST /api/jira/analyze`)

```
Ticket fetched via MCP
  │
  ├─ Extract links (ADR-019)
  ├─ Fetch linked content
  │
  ├─ ResearchEngine.investigate({
  │     goal: 'analyze_ticket',
  │     tools: [...CORE_TOOLS, ...ANALYSIS_TOOLS],
  │   })
  │
  ├─ Merge: FTS context + research findings + linked content
  │
  └─ Run 5 parallel AI checks (unchanged, but with richer context)
```

### PR Review (`GET /api/pr/review`)

```
PR diff + metadata fetched
  │
  ├─ ResearchEngine.investigate({
  │     goal: 'review_pr',
  │     tools: [...CORE_TOOLS, 'blast_radius', 'test_coverage',
  │             'trace_call_graph', 'get_ownership', 'pr_risk_assessment'],
  │   })
  │
  └─ Generate review with blast radius, test gaps, risk assessment
```

---

## Classification Logic

### `needsDeepResearch(message, contextRichness)`

```typescript
function needsDeepResearch(message: string, contextItems: number): boolean {
  // Never research these
  if (message.length < 20) return false;
  if (message.match(/action items|summarize|digest|assigned to/i)) return false;
  
  // Always research these
  if (message.match(/search the code|look at example-service|dig into/i)) return true;
  
  // Research when context is sparse AND question is code-related
  const isCodeQuestion = /how does|where is|find|check|trace|show me|implement/i.test(message);
  const mentionsTech = /function|file|component|service|api|endpoint|module/i.test(message);
  const hasTechnicalTerm = /search-provider|auth|login|search|cache|deploy|config/i.test(message);
  
  if (contextItems < 3 && (isCodeQuestion || mentionsTech || hasTechnicalTerm)) return true;
  
  // Research when referencing Jira + asking about implementation
  if (message.match(/BDS-\d+/i) && isCodeQuestion) return true;
  
  return false;
}
```

---

## Blocker Reporting

When research fails to find evidence, return structured blockers instead of silently giving up:

```typescript
interface ResearchBlocker {
  type: 'repo_stale' | 'auth_required' | 'no_matches' | 'timeout' | 'tool_error';
  description: string;
  attempted: string[];
  suggestion: string;
}
```

Example in chat response:
```
I searched the example-service codebase but couldn't find direct search-provider references.

What I tried:
- grep_code("search-provider") across all .ts/.tsx files → 0 matches
- search_docs("search-provider") in example-service/docs/ → 0 matches
- search_codebase_knowledge("search integration") → 0 matches

Possible reasons:
- The search-provider integration might use a wrapper/abstraction name
- The ./repos/example-service copy may be stale (last synced: 3 days ago)

Suggestions:
- Try: "search for useRecommendedLinks" — that's the feature using external search
- Run rsync to refresh the repo copy
```

---

## Ollama Setup Guide

### Installation

```bash
# macOS
brew install ollama

# Verify
ollama --version
```

### Pull the Recommended Model

```bash
# Primary: code-specialized MoE (19GB, fast)
ollama pull qwen3-coder:30b-a3b

# Fallback: smaller, faster for simple iterations
ollama pull qwen3:8b
```

### Verify Tool Calling Works

```bash
curl -s http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder:30b-a3b",
    "messages": [{"role": "user", "content": "Find the login function in the auth module"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "grep_code",
        "description": "Search codebase",
        "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}}, "required": ["pattern"]}
      }
    }]
  }' | jq '.choices[0].message.tool_calls'
```

### Daemon Configuration

Ollama auto-starts as a macOS LaunchAgent. Key settings:

```bash
# Environment variables (set in ~/.zshrc or launchd plist)
OLLAMA_HOST=127.0.0.1:11434      # listen address
OLLAMA_NUM_PARALLEL=2             # concurrent requests
OLLAMA_KEEP_ALIVE=5m              # model stays loaded 5 min after last request
```

### Performance on M3 Pro (36GB)

| Model | Quantization | RAM Used | Generation Speed | Per-Iteration Time |
|-------|-------------|----------|-----------------|-------------------|
| qwen3-coder:30b-a3b | Q4 | ~19GB | 20-28 tok/s | 4-12s |
| qwen3:8b | Q4 | ~5GB | 50-80 tok/s | 2-4s |
| qwen3:4b | Q8 | ~4.5GB | 80-120 tok/s | 1.5-2.5s |

---

## Comparison: Before vs After

| Aspect | Current (Broken) | With Research Engine |
|--------|-----------------|---------------------|
| Code search gate | `if (chatJiraKeyMatch)` — blocks 80% of questions | Classification heuristic — any code question triggers research |
| Stop words | 79 words including "search-provider", "search", "feature" | 25 generic grammar words only |
| Iteration | 1 grep, no file reading | 3-8 iterations with file reading and tracing |
| Knowledge | Ephemeral — no accumulation | Stored in research_findings + Palace KG |
| Failure reporting | Silent `catch {}` blocks | Structured blockers with suggestions |
| Model for search | Server-side heuristic picks keywords | LLM picks search queries (Claude/Qwen3) |
| Architecture awareness | Single keyword lookup | Pre-computed repo map with PageRank ranking |
| Loop prevention | None — can repeat same grep forever | Explicit state tracking + loop detection |

---

## References

- [ADR-020: Proactive Intelligence Brain](../adr/adr-020-proactive-intelligence-brain.md) — Full architectural decision with gap analysis
- [ADR-019: Link-Aware Ticket Analysis](../adr/adr-019-link-aware-ticket-analysis.md) — Link fetching for analyzer context
- [Reflexion paper](https://arxiv.org/abs/2303.11366) — Self-correcting agents (91% HumanEval)
- [LATS paper](https://arxiv.org/abs/2310.04406) — Language Agent Tree Search (92.7% HumanEval)
- [Self-RAG paper](https://arxiv.org/abs/2310.11511) — Adaptive retrieval (works at 7B scale)
- [SWE-Agent](https://github.com/SWE-agent/SWE-agent) — State-of-the-art code navigation
- [mini-SWE-Agent](https://github.com/SWE-agent/mini-swe-agent) — 100 lines, 65% SWE-bench
- [Aider repo map](https://aider.chat) — PageRank-based structural maps
- [Qwen3-Coder](https://ollama.com/library/qwen3-coder) — MoE model for agentic coding
- [Ollama Anthropic compat](https://ollama.com/blog/tool-support) — `/v1/messages` endpoint
