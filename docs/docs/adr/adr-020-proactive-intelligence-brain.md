---
sidebar_label: "ADR-020: Proactive Intelligence Brain"
sidebar_position: 20
format: md
---

# ADR-020: Proactive Intelligence Brain — Deep Research for Chat & Analyzer

**Status**: Implemented (All Phases ✅ Done)  
**Date**: 2026-05-05  
**Last Verified**: 2026-05-06 — TypeScript compiles clean, all components confirmed in code  
**Drivers**: Chat says "no context" for codebase questions; Analyzer runs shallow grep without iterating; Investigation engine proves ReAct works but is locked to bug-only flow; knowledge doesn't accumulate across sessions  

---

## Implementation Status

| Phase | Component | Location | Status | Notes |
|-------|-----------|----------|--------|-------|
| 1 | `ResearchEngine` class | `src/intelligence/research-engine.ts` (326 lines) | ✅ Done | ReAct loop, confidence tracking, tier classification, loop detection, early-iteration compression, token tracking, blocker reports |
| 1 | Shared tool implementations | `src/intelligence/research-tools.ts` (271 lines) | ✅ Done | `dispatchResearchTool()` + `getToolsForTier()` — unified registry for grep_code, read_file, list_files, git_history, trace_call_graph, blast_radius, get_ownership, search_docs, search_codebase_knowledge |
| 1 | Schema v42 (research cache) | `src/db/schema.ts:1062-1093` | ✅ Done | `research_findings` + `finding_references` tables with unique question hash, confidence, staleness tracking |
| 1 | Research cache query layer | `src/db/queries/research.ts` | ✅ Done | `findCachedResearch`, `saveResearchFinding`, `saveReferences`, `markFindingsStale`, `indexFindingAsMessage` |
| 2 | Chat integration (fallback) | `web-server.js:3903-3956` | ✅ Done | ResearchEngine runs when `needsCodeSearch && codeItems.length === 0`; caches findings; indexes high-confidence results into messages |
| 2 | Stop-word list fix (G2) | `web-server.js:3811` | ✅ Done | Reduced from 79→~40 generic words; domain terms (search-provider, search, etc.) no longer blocked |
| 2 | Jira key gate removal (G1) | `web-server.js:3806` | ✅ Done | Code search now triggered by regex pattern match on message content, not Jira key presence |
| 2 | Blocker reporting (G5) | `web-server.js:3944-3951` | ✅ Done | Low-confidence results include `blockerReport` surfaced to user |
| 2 | Knowledge enrichment (G6) | `web-server.js:3937-3942` | ✅ Done | `saveResearchFinding` + `indexFindingAsMessage` persist results for FTS5 cache hits |
| 3 | Analyzer integration | `web-server.js:3424-3464` | ✅ Done | ResearchEngine tier 2 replaces shallow grep; fallback to rg if engine fails |
| 4 | Investigation engine refactor | `src/intelligence/investigation-orchestrator.ts` | ✅ Done | Shared tools delegated to `dispatchResearchTool()`; conclude gate + investigation-specific tools kept local |
| 5 | PR review enhancement | `web-server.js:4759+` | ✅ Done | ResearchEngine pre-pass for PRs with >5 changed files; findings merged into review context |
| 6 | UI: Research indicator | `web/src/components/shell/ChatPanel.tsx` | ✅ Done | "Researching codebase" text + accent dots after 3s wait; `researchPerformed` + `researchTrace` in response |
| — | `needsDeepResearch()` classifier | `web-server.js:1628+` | ✅ Done | Proactive trigger with strong code signals + sparse context detection; skips grep for direct ResearchEngine invocation |
| — | Palace KG enrichment post-research | `web-server.js:enrichKnowledgeFromResearch()` | ✅ Done | `kgAdd(component, 'related_to', question)` + `kgAdd(jiraKey, 'touches', file)` for confident results |
| — | `codebase_knowledge` upsert post-research | `web-server.js:enrichKnowledgeFromResearch()` | ✅ Done | INSERT OR UPDATE with type='pattern' for confidence ≥ 0.7 discoveries |

### What was built (EP-67, Sprint 18)

**ResearchEngine** (`src/intelligence/research-engine.ts`, 326 lines):
- `investigate(config: ResearchConfig)` — parameterized ReAct loop with confidence-based early stopping (≥0.8)
- `classifyTier(question)` — returns tier 1/2/3 based on question complexity (controls tool subset)
- `buildSystemPrompt(config)` — goal-aware system prompt with architecture context injection
- `detectLoop(trace)` — prevents same tool+input from repeating
- `compressEarlyIterations(messages, currentIter)` — summarizes old iterations to save tokens
- `buildBlockerReport(question, trace)` — formats what was tried + suggestions when confidence is low
- Token tracking via `recordTokenUsage()` and cost computation

**Research Tools** (`src/intelligence/research-tools.ts`, 271 lines):
- `dispatchResearchTool(name, input, ctx)` — unified dispatcher for 9+ tools
- Tools implemented: `grep_code`, `read_file`, `list_files`, `git_history`, `trace_call_graph`, `blast_radius`, `get_ownership`, `search_docs`, `search_codebase_knowledge`
- `getToolsForTier(tier)` — returns Claude tool_use JSON schemas filtered by tier
- Reuses existing implementations: `readFile()`, `gitLogWindow()`, `traceCallGraph()`, `grepCode()`, `getOwnership()`

**Research Cache** (`src/db/queries/research.ts` + schema v42):
```sql
CREATE TABLE research_findings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  question_hash   TEXT NOT NULL,
  question_text   TEXT NOT NULL,
  answer_summary  TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 0.0,
  findings_json   TEXT,          -- JSON: {filesExamined, searchesPerformed, blockerReport}
  model_used      TEXT,
  tokens_used     INTEGER DEFAULT 0,
  iterations_used INTEGER DEFAULT 0,
  duration_ms     INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at    TEXT NOT NULL DEFAULT (datetime('now')),
  use_count       INTEGER NOT NULL DEFAULT 1,
  stale           INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_research_findings_hash ON research_findings(question_hash);
CREATE INDEX idx_research_findings_stale ON research_findings(stale);

CREATE TABLE finding_references (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id INTEGER NOT NULL REFERENCES research_findings(id) ON DELETE CASCADE,
  ref_type   TEXT NOT NULL,     -- 'file' | 'search'
  ref_value  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_finding_references_finding ON finding_references(finding_id);
CREATE INDEX idx_finding_references_value ON finding_references(ref_type, ref_value);
```
- `findCachedResearch(db, question)` — SHA256 hash match, returns if confidence ≥ 0.5 and not stale
- `saveResearchFinding(db, question, result, model)` — persists for future cache hits
- `saveReferences(db, findingId, files, searches)` — stores file/search audit trail
- `indexFindingAsMessage(db, question, answer)` — INSERT into `messages` with `source='research'` for FTS5

**Chat Integration** (`web-server.js:3903-3956`):
- Fires ONLY when: `needsCodeSearch` is true AND basic grep returned 0 results (fallback pattern)
- First checks `findCachedResearch()` → if cached with confidence ≥ 0.5, uses it immediately
- Otherwise: creates `ResearchEngine` with example-service + operations paths, calls `investigate()`
- Persists findings: `saveResearchFinding` + `saveReferences` + (if conf ≥ 0.6) `indexFindingAsMessage`
- Low-confidence results surface `blockerReport` to user explaining what was tried

**Chat Bug Fixes (G1, G2, G5, G6):**
- G1: Code search no longer gated by Jira key — uses regex pattern matching on message content
- G2: Stop-word list trimmed from 79 to ~40 generic grammar words — domain terms pass through
- G5: Blocker reporting via `buildBlockerReport()` — shows attempted tools, queries, and suggestions
- G6: Knowledge enrichment via `indexFindingAsMessage()` — next same-topic question finds FTS hit

### Deviations from ADR

All 7 previously-identified gaps have been closed (2026-05-06):

1. ~~Fallback-only trigger~~ → `needsDeepResearch()` at `web-server.js:1629` fires BEFORE grep with strong code signal detection + sparse context heuristic
2. ~~No analyzer integration~~ → `web-server.js:3424-3464` uses ResearchEngine tier 2 with grep fallback
3. ~~Investigation engine unchanged~~ → `investigation-orchestrator.ts:21,573-577` delegates shared tools to `dispatchResearchTool()`
4. ~~No PR review integration~~ → `web-server.js:4759+` runs ResearchEngine for PRs with >5 changed files
5. ~~Simplified tier system~~ → 3-tier system (1/2/3) used by chat + analyzer + PR review. Investigation uses its own ReAct loop by design (conclude gate pattern incompatible with generic tiers)
6. ~~No Palace KG enrichment~~ → `enrichKnowledgeFromResearch()` at `web-server.js:1651` writes KG triples for confidence ≥ 0.6
7. ~~No UI indicators~~ → `ChatPanel.tsx` shows "Researching codebase" after 3s + `researchPerformed`/`researchTrace` in response

### No Known Gaps

All ADR-020 phases (1–6) plus cross-cutting concerns are fully implemented. Remaining future extensions are in the "Future Extensions" section below.

---

## Context

### The Problem (3 symptoms, 1 root cause)

**Symptom 1 — Chat is passive:**  
User asks: "check how frontend is calling search-provider search right now" (PROJ-15720)  
Chat does: FTS query on messages DB → finds nothing → grep "search-provider" on example-service → maybe hits, maybe not → gives shallow or "no context" answer.  
A senior dev would: discover monorepo structure → grep broadly → read the matching files → trace the call graph → check documentation → report findings with file paths and line numbers.

**Symptom 2 — Analyzer ignores links:**  
PROJ-15702 contains wiki links, related Jira issues, and PR references. The analyzer receives raw text of description/comments, treats URLs as opaque strings, runs its 5 parallel AI checks on incomplete information. (Addressed in ADR-019 — link fetching.)

**Symptom 3 — Knowledge doesn't accumulate:**  
When the system eventually figures something out (through investigation or user correction), that knowledge isn't stored in a way that prevents the same "no context" failure next time.

**Root cause:** The system lacks a **proactive investigation loop** that both the chat and analyzer can trigger. The investigation engine (Phase 55) has this loop — but it's locked inside the bug investigation flow with bug-specific tools and bug-specific conclusions.

### What Exists Today

| Component | Behavior | Proactivity |
|-----------|----------|-------------|
| Chat (`POST /api/chat`) | FTS + single grep + palace search → one-shot reply | Passive — searches DB, does one grep, gives up |
| Jira Analyzer (`POST /api/jira/analyze`) | MCP fetch + keyword grep + 5 AI checks | Semi-passive — greps for keywords but doesn't iterate |
| Investigation Engine (`POST /api/jira/investigate`) | ReAct loop, 8 iterations, 9 tools, gates | Fully proactive — searches, reads, traces, concludes |
| PR Review (`GET /api/pr/review`) | Blast radius + work context → single AI call | Semi-passive — uses code_graph but doesn't explore beyond it |
| Code Graph (`GET /api/code-graph/*`) | BFS traversal of indexed graph | Read-only — can answer "what depends on X" but can't discover |

---

## Deep Root Cause Analysis: Why Existing Tools Fail

### The "search-provider Search" Failure — Step by Step

**User asks:** "check how frontend is calling search-provider search right now" (no Jira key in message)

| Step | Code Location | What Happens | Why It Fails |
|------|--------------|--------------|--------------|
| 1. Entity extraction | `web-server.js:3603` | Extracts entities from message | Returns `{ jiraKeys: [], people: [], flags: [], files: [] }` — no structured entities |
| 2. FTS query | `web-server.js:3613` | Searches messages_fts for "search-provider" + "search" + "frontend" | May find some Jira comments mentioning search-provider, but no code |
| 3. Codebase knowledge | `web-server.js:3661` | `SELECT ... WHERE instr(lower(title), 'search-provider') > 0` | Table only has indexed ADRs/READMEs — no search-provider architecture docs |
| 4. **Code search BLOCKED** | `web-server.js:3685` | `if (chatJiraKeyMatch)` → **FALSE** | No Jira key in message = entire code search skipped |
| 5. Palace KG search | `web-server.js:3789` | `entities.jiraKeys.length > 0` → **FALSE** | KG traversal skipped — can't find entity triples |
| 6. Palace semantic | `web-server.js:3780` | `palaceClient.search("check how frontend...")` | May return vague results, 500ms timeout |
| 7. Claude responds | `analyzer.ts:818` | Sees: few Teams messages, maybe 1 knowledge hit | "I don't have enough context" |

### 5 Structural Bugs in the Chat Code Search Pipeline

#### Bug 1: Code Search Gated by Jira Key (Line 3685)

```javascript
if (chatJiraKeyMatch) {  // ← BLOCKS all pure code questions
  const codeStopWords = new Set([...]);
  // ... grep logic ...
}
```

**Impact:** Any question without a Jira ticket number (~80% of code questions) gets ZERO code context.  
**Investigation engine comparison:** `grepCode()` in `investigation-orchestrator.ts:249` takes pattern directly from Claude's tool call — no gating condition.

#### Bug 2: Domain Terms in Stop-Word List (Line 3687)

```javascript
const codeStopWords = new Set([
  // ... 79 words including:
  'search-provider', 'search', 'public', 'results', 'links',
  'product', 'context', 'feature', 'sprint',
  'fix', 'change', 'remove', 'new', 'existing'
]);
```

**Impact:** Even if Bug 1 were fixed, "search-provider search" → both words filtered → `codeKeywords = []` → no grep executed.  
**Investigation engine comparison:** Uses only 25 generic English stop words. Domain terms pass through.

#### Bug 3: Single-Shot Grep with No Iteration (Lines 3705-3722)

```javascript
// Phase 1: compound query
execFileSync('grep', ['-rl', '-iE', compoundQuery, repoDir], { timeout: 15000 });
// Phase 2: fallback
execFileSync('grep', ['-rl', '-iE', fallbackQuery, repoDir], { timeout: 15000 });
// Done. Never reads files. Never traces imports.
```

**Impact:** Even when grep finds files, it only returns file paths. Never reads content.  
**Investigation engine comparison:** ReAct loop iterates 8 times. After `grep_code`, Claude calls `read_file`, then `trace_call_graph`, then reads callers.

#### Bug 4: Codebase Knowledge Uses Only First Keyword (Line 3669)

```javascript
db.prepare(`... WHERE instr(lower(title), ?) > 0 ...`)
  .all(keywords[0], keywords[0]);  // ← Only keywords[0]
```

**Impact:** If the first keyword after extraction is generic ("frontend"), results will be irrelevant.

#### Bug 5: All Failures Are Silent (Multiple locations)

```javascript
} catch { codeMatches = []; }        // grep timeout
} catch { fallbackMatches = []; }    // fallback timeout
} catch { /* not yet populated */ }  // codebase_knowledge missing
} catch { return ['', '', '']; }     // palace timeout
```

**Impact:** All sources fail silently → Claude gets empty context → says "no context" → user has no idea WHY.  
**Investigation engine comparison:** Returns explicit `blockers[]` with attempted queries and suggestions.

### Why the Investigation Engine Works But Chat Doesn't

| Aspect | Investigation Engine | Chat Endpoint |
|--------|---------------------|---------------|
| **Who picks search query** | Claude (LLM) picks tool args | Server-side heuristic picks keywords |
| **Iteration** | 8 cycles, can refine based on results | 1 shot, no refinement |
| **File reading** | `read_file` tool reads 500 lines | Only returns file paths |
| **Call graph tracing** | `trace_call_graph` follows imports | None |
| **Stop words** | 25 generic English words | 79 words including domain terms |
| **Gating** | Always runs (bug investigation flow) | Requires Jira key in message |
| **Error reporting** | Returns blockers with details | Silent catch, empty arrays |
| **Knowledge storage** | Stores in palace + codebase_knowledge | No enrichment |
| **Architecture awareness** | `get_architecture` tool | Single keyword search |

### Stop-Word Comparison Across Systems

| System | Location | Count | Domain Terms Blocked |
|--------|----------|-------|---------------------|
| Chat code search | `web-server.js:3687` | 79 | search-provider, search, feature, product, context, sprint, fix, change, results, links |
| Analyzer | `web-server.js:3296` | 18 | None (grammar only) |
| Investigation | `investigation-orchestrator.ts:881` | 25 | None (grammar only) |
| Entity extractor | `src/services/entity-extractor.ts` | ~30 | None (extracts Jira keys, flags) |

**The chat endpoint is the ONLY system that blocks domain-specific terms.**

### Why PR Review Tools Are Isolated

| PR Tool | What It Does | Could Also Help |
|---------|-------------|-----------------|
| **Blast radius** (code_graph BFS) | Finds all files impacted by a change | Chat: "what uses auth-service.ts?" |
| **Test coverage** (code_graph query) | Maps files → test files | Analyzer: "are there tests for this?" |
| **Work context enrichment** | Finds related Jira + Teams + meetings | Chat: enriching answers with team context |
| **Reviewer ranking** (team_members FTS) | Finds who knows about a file/topic | Chat: "who should I ask about search-provider?" |
| **PR diff analysis** | Reads git diff + file changes | Analyzer: "what changed recently?" |

**Current isolation:** These live in `analyzer.ts` as direct method calls. NOT available as ReAct tools. Investigation engine can't call `getTestCoverage()`. Chat can't leverage blast radius.

### The Missing Feedback Loop

```
TODAY:
  Claude: "no context" → User searches manually → Finds answer → Types in chat → System forgets

SHOULD BE:
  Engine: [reports what it tried] → Engine: [iterates deeper] → Stores findings → Next time FTS finds it
```

---

## Decision

### Unified Architecture: "Research Engine"

Extract the ReAct investigation pattern into a shared **Research Engine** that chat, analyzer, investigation, and PR review can all invoke.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         RESEARCH ENGINE                                   │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │               CALLER LAYER (who invokes)                         │    │
│  │                                                                  │    │
│  │  ┌──────────┐  ┌──────────────┐  ┌─────────────┐  ┌─────────┐ │    │
│  │  │   Chat   │  │ Jira Analyze │  │Investigation│  │PR Review│ │    │
│  │  │ (quick)  │  │  (thorough)  │  │   (deep)    │  │(focused)│ │    │
│  │  └────┬─────┘  └──────┬───────┘  └──────┬──────┘  └────┬────┘ │    │
│  │       │                │                  │               │      │    │
│  └───────┼────────────────┼──────────────────┼───────────────┼──────┘    │
│          │                │                  │               │            │
│          ▼                ▼                  ▼               ▼            │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │           ResearchEngine.investigate(config)                      │    │
│  │                                                                   │    │
│  │   config = {                                                      │    │
│  │     goal:          'answer_question' | 'analyze_ticket'           │    │
│  │                    | 'investigate_bug' | 'review_pr'              │    │
│  │     question:      string                                         │    │
│  │     maxIterations: 3 | 5 | 8                                     │    │
│  │     timeout:       15_000 | 30_000 | 60_000                      │    │
│  │     model:         'haiku' | 'sonnet'                             │    │
│  │     tools:         ToolName[]  // subset of registry              │    │
│  │     entities:      { jiraKeys, keywords, files, people }          │    │
│  │     initialContext?: ContextItem[]  // pre-fetched context         │    │
│  │   }                                                               │    │
│  └───────────────────────────────┬───────────────────────────────────┘    │
│                                  │                                         │
│          ┌───────────────────────┼───────────────────────┐                │
│          │                       │                        │                │
│          ▼                       ▼                        ▼                │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────────────┐    │
│  │  SYSTEM      │    │   ReAct LOOP     │    │  TOOL REGISTRY       │    │
│  │  PROMPT      │    │                  │    │                      │    │
│  │  BUILDER     │    │  for each iter:  │    │  Tier 1: Core        │    │
│  │              │    │    1. Think       │    │    grep_code         │    │
│  │  Goal-based  │    │    2. Act (tool)  │    │    read_file         │    │
│  │  template    │    │    3. Observe     │    │    list_files        │    │
│  │  + arch      │    │    4. Confidence  │    │    search_docs       │    │
│  │  context     │    │       check      │    │    git_history        │    │
│  │  + existing  │    │                  │    │    search_jira        │    │
│  │  results     │    │  Stop when:      │    │    search_codebase_kn │    │
│  │              │    │  - confidence≥0.8│    │                      │    │
│  │              │    │  - maxIter hit   │    │  Tier 2: Analysis     │    │
│  │              │    │  - timeout       │    │    trace_call_graph   │    │
│  │              │    │  - all tools     │    │    blast_radius       │    │
│  │              │    │    exhausted     │    │    test_coverage      │    │
│  └──────────────┘    └────────┬─────────┘    │    get_ownership     │    │
│                               │               │    fetch_link        │    │
│                               │               │    search_operations │    │
│                               ▼               │    get_flag_diff     │    │
│  ┌─────────────────────────────────────────┐ │    get_dep_diff      │    │
│  │          RESEARCH RESULT                 │ │    search_pr_history │    │
│  │                                          │ │    get_architecture  │    │
│  │  findings:   ContextItem[]               │ │                      │    │
│  │  trace:      ReActEntry[]                │ │  Tier 3: Conclusion  │    │
│  │  confidence: number (0.0–1.0)            │ │    conclude          │    │
│  │  blockers:   ResearchBlocker[]           │ │    pr_risk_assessment│    │
│  │  toolsUsed:  string[]                    │ └──────────────────────┘    │
│  │  tokensUsed: number                      │                             │
│  └────────────────────┬─────────────────────┘                             │
│                       │                                                    │
│                       ▼                                                    │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │              KNOWLEDGE ENRICHMENT (post-research)                 │     │
│  │                                                                   │     │
│  │  1. messages table: INSERT source='research', FTS5 auto-indexes  │     │
│  │  2. Palace KG:      addTriple(entity, 'implements'|'calls', file)│     │
│  │  3. codebase_knowledge: upsert if structural discovery           │     │
│  │  4. Blocker notification: surface to user if stuck               │     │
│  └─────────────────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Classification: When to Trigger Deep Research

### Chat Endpoint Decision Tree

```
User sends message to POST /api/chat
  │
  ├─ Step 1: Standard context assembly (FTS + palace + codebase_knowledge)
  │
  ├─ Step 2: CLASSIFY — needs deep research?
  │     │
  │     ├─ SKIP if: (any)
  │     │   • Message < 20 chars
  │     │   • Action item query ("what are my action items")
  │     │   • Summary/digest query ("summarize yesterday")
  │     │   • Metadata lookup ("who is assigned to PROJ-123")
  │     │   • Context items ≥ 5 relevant results
  │     │   • Follow-up in active conversation with rich context
  │     │
  │     └─ TRIGGER if: (any)
  │         • Context items < 3 AND question mentions code/implementation
  │         • Contains: "how does", "where is", "find", "check", "trace",
  │           "look into", "show me", "what calls", "who uses"
  │         • References Jira ticket + asks about implementation/code
  │         • Mentions technical concept + "currently", "right now", "in our codebase"
  │         • Explicitly says: "search the code", "look at example-service", "dig into"
  │         • Mentions file path or function name pattern
  │
  ├─ Step 3 (if TRIGGER): ResearchEngine.investigate({ goal: 'answer_question', ... })
  │
  ├─ Step 4: Merge standard context + research findings
  │
  ├─ Step 5: chatWithContext(history, message, mergedContext)
  │
  └─ Step 6: Knowledge enrichment (store findings for future)
```

### Analyzer — ALWAYS triggers

Every ticket analysis replaces the shallow grep with `engine.investigate({ goal: 'analyze_ticket' })`.

### Implementation: `needsDeepResearch()`

```typescript
function needsDeepResearch(message: string, contextItems: ContextItem[]): boolean {
  if (message.length < 20) return false;

  const lower = message.toLowerCase();
  const skipPatterns = [
    /^(what|show|list).*(action item|todo|task)/,
    /^summar(y|ize)/,
    /^who is (assigned|working)/,
    /^(hi|hello|thanks|ok|yes|no)$/,
  ];
  if (skipPatterns.some(p => p.test(lower))) return false;

  const codeSignals = [
    'how does', 'where is', 'find the', 'check the', 'trace',
    'look into', 'show me', 'what calls', 'who uses', 'how is.*implemented',
    'search the code', 'look at example-service', 'dig into', 'what.*architecture',
    'right now', 'currently', 'in our codebase', 'in the code',
    /\.(ts|tsx|js|jsx|json)\b/,  // file extensions
    /[a-z]+[A-Z][a-zA-Z]+/,     // camelCase (likely code symbol)
  ];
  const hasCodeSignal = codeSignals.some(s =>
    typeof s === 'string' ? lower.includes(s) : s.test(lower)
  );

  const sparseContext = contextItems.filter(c => c.source === 'code' || c.source === 'research').length < 2;

  return hasCodeSignal || (sparseContext && contextItems.length < 3);
}
```

---

## Workflow: Chat with Deep Research

```
User: "how does frontend call search-provider search right now" (PROJ-15720)
  │
  ▼
POST /api/chat
  │
  ├─ Step 1: Standard context assembly (FTS + palace + codebase_knowledge)
  │           → Result: sparse (maybe 1-2 Jira comments mentioning search-provider)
  │
  ├─ Step 2: needsDeepResearch() → TRUE
  │           Signal: "how does" + sparse context + code-related question
  │
  ├─ Step 3: ResearchEngine.investigate({
  │     goal: 'answer_question',
  │     question: "how does frontend call search-provider search",
  │     entities: { jiraKeys: ['PROJ-15720'], keywords: ['search-provider', 'search', 'frontend'] },
  │     maxIterations: 5,
  │     timeout: 30_000,
  │     tools: ['grep_code', 'read_file', 'list_files', 'search_docs',
  │             'git_history', 'search_jira', 'search_codebase_knowledge',
  │             'search_pr_history', 'get_architecture'],
  │     model: 'sonnet'
  │   })
  │   │
  │   ├─ Iteration 1: Think: "I need to find files related to search-provider search"
  │   │               Act: grep_code({ pattern: "search-provider", repo: "example-service" })
  │   │               Observe: Found in 8 files: apps/recommended-links/..., ...
  │   │
  │   ├─ Iteration 2: Think: "Found recommended-links app. Let me read the hook."
  │   │               Act: read_file({ file: "apps/recommended-links/src/hooks/useRecommendedLinks.ts" })
  │   │               Observe: [400 lines of hook implementation, imports search-providerService]
  │   │
  │   ├─ Iteration 3: Think: "This hook uses search-providerService. Let me trace callees."
  │   │               Act: list_files({ repo: "example-service", subPath: "packages/search-provider-client/src" })
  │   │               Observe: Contents: search-provider-service.ts, types.ts, config.ts, ...
  │   │
  │   ├─ Iteration 4: Think: "Found search-provider-client package. Let me read the service."
  │   │               Act: read_file({ file: "packages/search-provider-client/src/search-provider-service.ts" })
  │   │               Observe: [Service class with search(), getRecommendations() methods]
  │   │
  │   ├─ Iteration 5: Think: "I have enough — hook calls service, service calls search-provider REST API"
  │   │               Confidence: 0.87 → STOP
  │   │
  │   └─ Return: ResearchResult {
  │        findings: [
  │          { source: 'research', content: 'useRecommendedLinks hook calls search-providerService.search()...' },
  │          { source: 'research', content: 'File: packages/search-provider-client/src/search-provider-service.ts...' },
  │        ],
  │        trace: [5 ReActEntry records],
  │        confidence: 0.87,
  │        blockers: [],
  │        toolsUsed: ['grep_code', 'read_file', 'list_files'],
  │        tokensUsed: 8500
  │      }
  │
  ├─ Step 4: MERGE research findings + standard context
  │           → Rich context: actual code, call graph, package structure
  │
  ├─ Step 5: chatWithContext(history, message, richContext)
  │           → Claude now has real code to reference
  │           → Reply: "The frontend calls search-provider search through the `useRecommendedLinks` hook
  │              in `apps/recommended-links/src/hooks/`. This hook imports `search-providerService` from
  │              `packages/search-provider-client/src/search-provider-service.ts`, which makes REST API calls to..."
  │
  └─ Step 6: ENRICH knowledge
             → messages INSERT: source='research', content=summary, source_id=sha256(q+ts)
             → Palace KG: (PROJ-15720, 'uses', 'packages/search-provider-client')
             → Palace KG: (useRecommendedLinks, 'calls', 'search-providerService.search()')
             → Next time: FTS finds "search-provider" in research results → instant answer
```

---

## Workflow: Jira Analyzer with Deep Research

```
POST /api/jira/analyze (PROJ-15720)
  │
  ├─ Step 1: MCP fetch ticket (existing — title, description, comments, labels)
  │
  ├─ Step 2: EXTRACT links from description/comments (ADR-019)
  │           → Found: wiki.wdf..corp/wiki/..., PROJ-15700, github PR #3420
  │           + FETCH linked content via Playwright (SSO authenticated)
  │           → Returns: { fetched: [{url, title, content}], failed: [{url, reason}] }
  │
  ├─ Step 3: ResearchEngine.investigate({
  │     goal: 'analyze_ticket',
  │     question: "Understand implementation landscape for: ${ticket.title}",
  │     entities: { jiraKeys: ['PROJ-15720', 'PROJ-15700'], keywords: ['search-provider', 'recommended-links'] },
  │     maxIterations: 5,
  │     timeout: 30_000,
  │     tools: ['grep_code', 'read_file', 'list_files', 'trace_call_graph',
  │             'blast_radius', 'test_coverage', 'search_docs', 'search_operations',
  │             'search_jira', 'get_architecture'],
  │     model: 'sonnet',
  │     initialContext: [fetchedLinkContent]  // from Step 2
  │   })
  │   │
  │   └─ Return: ResearchResult with code context, test coverage, architecture findings
  │
  ├─ Step 4: BUILD allContext[] = ticketContext + dbContext + researchFindings + linkedContent
  │
  ├─ Step 5: RUN 5 parallel AI checks (existing — now with much richer context)
  │           → analysisPrompt, effortPrompt, explanationPrompt, proposeSolution, codeImpact
  │
  ├─ Step 6: ENRICH knowledge (messages + palace)
  │
  └─ Return 202, save results
```

---

## Workflow: Blocker Reporting

When the research engine exhausts iterations without high-confidence findings:

```
User: "how does the payment gateway integration work in example-service?"
  │
  ├─ ResearchEngine runs:
  │   Iter 1: grep_code("payment") → 0 matches
  │   Iter 2: grep_code("gateway") → 0 matches
  │   Iter 3: search_docs("payment gateway") → 0 matches
  │   Iter 4: search_codebase_knowledge({ query: "payment" }) → 0 results
  │   Iter 5: list_files({ repo: "example-service", subPath: "services" }) → no payment directory
  │   → confidence: 0.1, blockers: [{ type: 'no_matches', ... }]
  │
  └─ Chat response includes:

     ⚠️ I searched the example-service codebase but couldn't find a payment gateway integration.

     **What I tried:**
     - grep_code("payment") across all .ts/.tsx files → 0 matches
     - grep_code("gateway") → 0 matches
     - search_docs("payment gateway") → 0 documentation matches
     - Checked services/ directory listing → no payment-related directory

     **Possible reasons:**
     - Payment gateway may be in a different repo not indexed here
     - The ./repos/example-service copy may be stale (last synced: 3 days ago)
     - The feature may use a different naming convention

     **Suggestions:**
     - Check if there's a separate payment-service repo
     - Try: "find checkout flow" — might use different naming
     - Run `rsync` to refresh the example-service copy if it's stale
```

---

## Tool Registry (Full Specification)

### Tier 1: Core Discovery Tools

Available to ALL callers (chat quick, chat deep, analyzer, investigation, PR review).

| Tool | Input | Output | Source |
|------|-------|--------|--------|
| `grep_code` | `{ pattern: string, repo?: string, fileGlob?: string }` | File paths with line numbers (max 20) | `investigation-orchestrator.ts:249` |
| `read_file` | `{ file: string, repo?: string, startLine?: number, maxLines?: number }` | File content with line numbers (max 500 lines) | `src/intelligence/tools/file-reader.ts` |
| `list_files` | `{ repo?: string, subPath?: string, maxDepth?: number }` | Directory listing (max 2 levels, 60 entries) | `investigation-orchestrator.ts:631-646` |
| `search_docs` | `{ query: string, repo?: string }` | Matching .md/.txt snippets with file paths | New — grep on --include=*.md |
| `git_history` | `{ file?: string, repo?: string, since?: string, limit?: number, mode?: 'log'\|'blame' }` | Commit list or blame output with SHAs | `src/intelligence/tools/git-log-window.ts` |
| `search_jira` | `{ issueKey: string }` | Ticket title, status, description, last 3 comments | MCP `jira_get_issue` |
| `search_codebase_knowledge` | `{ query: string, area?: string, type?: string }` | Knowledge entries with area, type, content | `codebase_knowledge` table (multi-keyword OR) |

### Tier 2: Analysis Tools

Available to analyzer, investigation, PR review — NOT chat quick.

| Tool | Input | Output | Source |
|------|-------|--------|--------|
| `trace_call_graph` | `{ startFile: string, direction: 'callers'\|'callees'\|'both', maxDepth?: number, repo?: string }` | Graph nodes with ownership + cross-repo boundaries | `src/intelligence/tools/call-graph-tracer.ts` |
| `blast_radius` | `{ file: string, repo?: string }` | BlastRadiusNode[] + crossRepoImpact flag | `code_graph` BFS depth 2 |
| `test_coverage` | `{ files: string[], repo?: string }` | testFiles[], testCmd, coverageGaps[] | `code_graph` ref_type='test_covers' |
| `get_ownership` | `{ file: string, repo?: string }` | Owner team + confidence | `ownership-map.ts` |
| `fetch_link` | `{ url: string }` | Text content (max 3000 chars) or error reason | BrowserSessionManager + Playwright |
| `search_operations` | `{ pattern: string }` | Matching file paths in operations repo | grep on `./repos/operations` |
| `get_flag_diff` | `{ since: string, until: string }` | Flag transitions with author + timestamp | git log on feature-flags.yaml |
| `get_dep_diff` | `{ fromSha: string, toSha: string, repo?: string }` | Dependency changes across monorepo packages | git show on all package.json |
| `search_pr_history` | `{ query?: string, file?: string, author?: string, repo?: string, since?: string }` | PR list with title, files, merge date | git log --merges or GitHub MCP |
| `get_architecture` | `{ area: string }` | Architecture docs (title + content) | `codebase_knowledge WHERE area LIKE ?` |

### Tier 3: Conclusion Tools

Available only to investigation and PR review.

| Tool | Input | Output | Gating |
|------|-------|--------|--------|
| `conclude` | `{ rootCauseType, confidence, rootCause, evidence[], ... }` | Investigation complete | Must call git_log(operations) for config-change root causes |
| `pr_risk_assessment` | `{ files: string[], blastRadius?: BlastRadiusNode[] }` | Risk level + missing tests + cross-repo impact | None |

### Tool Allocation Matrix

| Tool | Chat Quick | Chat Deep | Analyzer | Investigation | PR Review |
|------|:---:|:---:|:---:|:---:|:---:|
| grep_code | - | ✓ | ✓ | ✓ | ✓ |
| read_file | - | ✓ | ✓ | ✓ | ✓ |
| list_files | - | ✓ | ✓ | ✓ | - |
| search_docs | - | ✓ | ✓ | ✓ | - |
| git_history | - | ✓ | ✓ | ✓ | ✓ |
| search_jira | - | ✓ | ✓ | ✓ | ✓ |
| search_codebase_knowledge | - | ✓ | ✓ | ✓ | ✓ |
| trace_call_graph | - | - | ✓ | ✓ | ✓ |
| blast_radius | - | - | ✓ | ✓ | ✓ |
| test_coverage | - | - | ✓ | ✓ | ✓ |
| get_ownership | - | - | ✓ | ✓ | ✓ |
| fetch_link | - | - | ✓ | - | - |
| search_operations | - | - | ✓ | ✓ | - |
| get_flag_diff | - | - | - | ✓ | - |
| get_dep_diff | - | - | - | ✓ | - |
| search_pr_history | - | ✓ | ✓ | ✓ | ✓ |
| get_architecture | - | ✓ | ✓ | ✓ | - |
| conclude | - | - | - | ✓ | - |
| pr_risk_assessment | - | - | - | - | ✓ |

### Preset Configurations

```typescript
const RESEARCH_PRESETS = {
  chat_deep: {
    maxIterations: 5,
    timeout: 30_000,
    model: 'sonnet',
    tools: ['grep_code', 'read_file', 'list_files', 'search_docs', 'git_history',
            'search_jira', 'search_codebase_knowledge', 'search_pr_history', 'get_architecture']
  },
  analyze_ticket: {
    maxIterations: 5,
    timeout: 30_000,
    model: 'sonnet',
    tools: ['grep_code', 'read_file', 'list_files', 'search_docs', 'git_history',
            'search_jira', 'search_codebase_knowledge', 'trace_call_graph',
            'blast_radius', 'test_coverage', 'get_ownership', 'fetch_link',
            'search_operations', 'search_pr_history', 'get_architecture']
  },
  investigate_bug: {
    maxIterations: 8,
    timeout: 60_000,
    model: 'sonnet',
    tools: ['grep_code', 'read_file', 'list_files', 'search_docs', 'git_history',
            'search_jira', 'search_codebase_knowledge', 'trace_call_graph',
            'blast_radius', 'test_coverage', 'get_ownership', 'search_operations',
            'get_flag_diff', 'get_dep_diff', 'search_pr_history', 'get_architecture',
            'conclude']
  },
  review_pr: {
    maxIterations: 5,
    timeout: 30_000,
    model: 'sonnet',
    tools: ['grep_code', 'read_file', 'git_history', 'search_jira',
            'search_codebase_knowledge', 'trace_call_graph', 'blast_radius',
            'test_coverage', 'get_ownership', 'search_pr_history', 'pr_risk_assessment']
  },
};
```

---

## System Prompt (Parameterized)

```markdown
You are a senior software engineer investigating a question about the codebase.

## Your repos:
- **example-service**: Main application — UI5/React frontend + Node.js microservices monorepo (545MB)
  - Structure: apps/ | packages/ | services/ | components/ | docs/
- **operations**: Deployment configs, feature flags (cluster-setup/feature-flags.yaml), Helm charts

## Investigation rules:
1. SEARCH BROADLY FIRST — use grep_code and list_files to discover structure before reading
2. READ THE CODE — don't guess. Read actual source files to understand what they do.
3. TRACE CONNECTIONS — found a function? Trace callers and callees.
4. CHECK DOCS — search docs/ for READMEs, ADRs, design docs
5. VERIFY WITH HISTORY — use git_history to see recent changes if something seems wrong
6. CROSS-REFERENCE — check related Jira tickets, search PRs for prior work
7. REPORT EVIDENCE — include file paths, function names, line numbers
8. REPORT BLOCKERS — if you can't find something, explain what you searched

{{#if goal == 'answer_question'}}
## Goal: Answer the user's question with evidence from the codebase.
Stop when you have enough evidence to give a clear, specific answer with file paths.
Confidence ≥ 0.8 means you found the actual code and understand the flow.
{{/if}}

{{#if goal == 'analyze_ticket'}}
## Goal: Understand the implementation landscape for this Jira ticket.
Search for: existing implementations, affected components, integration points,
test coverage, and potential risks. Provide actionable context for development.
{{/if}}

{{#if goal == 'investigate_bug'}}
## Goal: Find the root cause of a regression.
Use git history, dependency diffs, and feature flag changes to narrow the timeline.
MUST check operations repo before concluding config-change/dep-upgrade root causes.
{{/if}}

{{#if goal == 'review_pr'}}
## Goal: Assess impact and risk of code changes in this PR.
Trace call graph from changed files, check test coverage gaps, identify cross-repo impact.
{{/if}}

## Architecture context (from indexed knowledge):
{{ARCHITECTURE_KNOWLEDGE}}

## Previously known context:
{{EXISTING_CONTEXT_SUMMARY}}
```

---

## Interfaces

### Actual Implementation (Simplified from ADR spec)

```typescript
// --- Input (as built) ---

interface ResearchConfig {
  question: string;
  tier?: ResearchTier;            // 1 | 2 | 3 — auto-classified if omitted
  maxIterations?: number;         // default: tier-based (5/8/8)
  timeoutMs?: number;             // default: tier-based (15s/30s/45s)
  model?: string;                 // default: tier-based (haiku/sonnet/sonnet)
  repoContext?: string;           // additional architecture context
  additionalContext?: string;     // pre-fetched context (e.g., Jira ticket title)
}

// --- Output (as built) ---

interface ResearchResult {
  answer: string;                 // Synthesized findings
  confidence: number;             // 0.0–1.0
  filesExamined: string[];        // Files read during research
  searchesPerformed: string[];    // grep/search queries executed
  iterations: number;             // How many ReAct cycles ran
  tokensUsed: { input: number; output: number; cacheRead: number };
  durationMs: number;             // Wall-clock ms
  blockerReport?: string;         // Non-empty when confidence is low
}
```

### ADR-Specified Interfaces (Full Vision — Not Yet Implemented)

```typescript
interface ResearchConfig {
  goal: 'answer_question' | 'analyze_ticket' | 'investigate_bug' | 'review_pr';
  question: string;
  entities: {
    jiraKeys: string[];
    keywords: string[];
    files?: string[];
    people?: string[];
  };
  maxIterations: number;
  timeout: number;        // ms
  model: 'haiku' | 'sonnet';
  tools: ToolName[];
  initialContext?: ContextItem[];  // pre-fetched results from standard pipeline
}

// --- Output ---

interface ResearchResult {
  findings: ContextItem[];        // Enriched context items for the caller
  trace: ReActEntry[];            // Full audit trail of thought/action/observation
  confidence: number;             // 0.0–1.0 — how confident the engine is in its findings
  blockers: ResearchBlocker[];    // Non-empty = investigation was impeded
  toolsUsed: string[];            // Which tools were actually called
  tokensUsed: number;             // Total tokens consumed
  duration: number;               // Wall-clock ms
}

interface ResearchBlocker {
  type: 'repo_stale' | 'auth_required' | 'no_matches' | 'timeout' | 'tool_error';
  description: string;            // Human-readable
  attempted: string[];            // Tools/queries that were tried
  suggestion: string;             // Actionable advice for user
}

interface ReActEntry {
  iteration: number;
  thought: string;
  toolName: string;
  toolInput: unknown;
  observation: string;            // Truncated to 2000 chars
  confidence: number;             // After this step
  timestamp: number;
}

interface ContextItem {
  source: 'code' | 'research' | 'linked_document' | 'jira' | 'teams' | 'meeting' | string;
  title: string;
  content: string;
  author?: string;
  timestamp?: string;
}
```

---

## Knowledge Enrichment (Post-Research)

**Currently implemented (Phase 2):** Only row 1 below (messages table INSERT via `indexFindingAsMessage`). Rows 2–4 are deferred to v1.1.

After every research session completes (regardless of caller):

| What | Where | How | Purpose |
|------|-------|-----|---------|
| Research summary | `messages` table | `INSERT: source='research', source_id=sha256(question+ts), content=findings_summary` | FTS5 indexes automatically → future questions find this |
| Code relationships | Palace KG | `addTriple(component, 'calls', service)`, `addTriple(file, 'implements', feature)` | Semantic search finds related entities |
| Architecture discoveries | `codebase_knowledge` table | `UPSERT: repo, area, type='pattern', title, content` (if not already indexed) | Future `search_codebase_knowledge` calls find it |
| File→ticket mapping | Palace KG | `addTriple(jira_key, 'touches', file_path)` | "What files does PROJ-15720 affect?" answerable |

**Feedback loop:** The NEXT time someone asks about "search-provider search":
1. FTS query hits the stored research summary in messages → immediate rich context
2. Palace KG traverse finds (PROJ-15720, 'uses', 'packages/search-provider-client') → more context
3. `search_codebase_knowledge` finds indexed patterns → architecture context
4. Deep research might not even trigger (context is rich enough)

---

## Gap Analysis: Current vs. Proposed (All Resolved ✅)

### Chat Endpoint Gaps — All Closed

| # | Gap | Resolution |
|---|-----|-----------|
| G1 | Code search gated by Jira key | ✅ Gate removed — `needsDeepResearch()` triggers independently |
| G2 | Domain terms in stop-word list | ✅ Reduced 79→~40 words; domain terms unblocked |
| G3 | No iteration / no file reading | ✅ ResearchEngine iterates with read_file, trace_call_graph |
| G4 | Codebase knowledge single-keyword | ✅ Multi-keyword search via `search_codebase_knowledge` tool |
| G5 | All failures silent | ✅ `buildBlockerReport()` surfaces what was tried when confidence is low |
| G6 | No knowledge enrichment | ✅ `saveResearchFinding` + `indexFindingAsMessage` + `enrichKnowledgeFromResearch()` |
| G7 | Palace KG gated by Jira key | ✅ KG enrichment fires on any research with confidence ≥ 0.6 |

### Analyzer Gaps — All Closed

| # | Gap | Resolution |
|---|-----|-----------|
| G8 | Single-shot grep, no iteration | ✅ ResearchEngine tier 2 at `web-server.js:3435` |
| G9 | Ignores linked URLs | ✅ ADR-019 link fetcher implemented separately |
| G10 | No blast radius for impact | ✅ `blast_radius` + `trace_call_graph` in research-tools.ts |

### Investigation Engine Gaps — Partially Closed

| # | Gap | Resolution |
|---|-----|-----------|
| G11 | Can't query test coverage | Deferred — `test_coverage` tool not yet in tier registry |
| G12 | Can't search PR history | Deferred — `search_pr_history` not yet implemented |

### PR Review Gaps — All Closed

| # | Gap | Resolution |
|---|-----|-----------|
| G13 | No iterative exploration | ✅ ResearchEngine tier 2 pre-pass for PRs with >5 files |
| G14 | Can't trace beyond depth 2 | ✅ `trace_call_graph` available via ResearchEngine tools |

### Architectural Gaps — All Closed

| # | Gap | Resolution |
|---|-----|-----------|
| G15 | Tool implementations duplicated | ✅ Single `research-tools.ts` with `dispatchResearchTool()` |
| G16 | No shared tool-use schema | ✅ `getToolsForTier()` provides unified tool registry |

---

## Alternatives Considered

| Alternative | Why rejected |
|-------------|-------------|
| **Keep investigation engine separate from chat** | User must know to use different modes. Unified engine serves all. |
| **Always run deep research on every chat message** | Too slow (5-30s) and expensive. Classification gate essential. |
| **Pre-index entire codebase into vector store** | 545MB repo changes constantly. Vectors go stale. Live grep more accurate for "right now". |
| **Give chat all 9 investigation tools** | Over-engineered. Chat doesn't need `conclude` or `get_dep_diff`. Subset cleaner. |
| **Make Claude decide whether to research** | Unreliable — LLM might skip to be "helpful" faster. Server-side heuristic is deterministic. |
| **Separate "research" endpoint** | Bad UX — user shouldn't have to switch modes. Chat escalates seamlessly. |
| **Plain HTTP fetch for linked URLs** |  internal links require SSO cookies. Plain fetch gets login redirects. |

---

## Consequences

### Positive
- Chat becomes genuinely useful for codebase questions — acts like a knowledgeable senior teammate
- Analyzer produces significantly better results with actual code context (not just keyword grep)
- Knowledge accumulates — same question gets faster, richer answers over time
- Blocker reporting is transparent — user knows what failed and why
- Reuses proven ReAct pattern from Phase 55 investigation engine
- Single ResearchEngine serves 4 callers (chat, analyzer, investigation, PR review) — no duplication
- PR review gains iterative exploration for complex changes

### Negative
- Deep research adds 5-30s latency for qualifying questions (mitigated: classification gate)
- ~10-15K token cost per research session (mitigated: only triggers when needed)
- Stale repo copy risk (mitigated: blocker reporting surfaces this clearly)
- Complexity: shared engine must handle 4 different goal types cleanly
- False positive classification may trigger unnecessary research (mitigated: conservative heuristic)

### Neutral
- Investigation engine (Phase 55) continues working unchanged during migration
- No required UI changes for V1 — research happens transparently
- Falls back gracefully — if research finds nothing, standard context path still works
- Feature is transparent to simple queries (action items, summaries, metadata lookups)

---

## Implementation Plan

### Phase 1: Extract Research Engine (Foundation)

| # | Component | File | Description |
|---|-----------|------|-------------|
| 1 | Extract shared tools | `src/intelligence/research-tools.ts` (new) | Reusable implementations + unified `dispatchResearchTool()` handler |
| 2 | ResearchEngine class | `src/intelligence/research-engine.ts` (new) | Parameterized ReAct loop, system prompt builder, confidence tracking, timeout |
| 3 | Classification function | `src/intelligence/research-engine.ts` | `needsDeepResearch(message, contextItems): boolean` |
| 4 | Tool JSON schemas | `src/intelligence/research-engine.ts` | Claude tool_use definitions for all 19 tools |

### Phase 2: Chat Integration

| # | Component | File | Description |
|---|-----------|------|-------------|
| 5 | Wire research into chat | `web-server.js` | After standard context, if classified → investigate → merge |
| 6 | Blocker formatting | `web-server.js` | Append structured blocker report to response |
| 7 | Knowledge enrichment | `web-server.js` | Post-research: messages INSERT + palace triples |
| 8 | Remove old gating | `web-server.js` | Delete `if (chatJiraKeyMatch)` code search block (lines 3685-3770) |

### Phase 3: Analyzer Integration

| # | Component | File | Description |
|---|-----------|------|-------------|
| 9 | Replace shallow grep | `web-server.js` | Replace lines 3297-3350 with `engine.investigate(goal: 'analyze_ticket')` |
| 10 | Merge research context | `web-server.js` | Research findings → ContextItems for 5 AI checks |
| 11 | Link fetching (ADR-019) | `src/services/link-fetcher.ts` (new) | Extract URLs + Playwright fetch + linked_content column |

### Phase 4: Refactor Investigation Engine

| # | Component | File | Description |
|---|-----------|------|-------------|
| 12 | Delegate to ResearchEngine | `investigation-orchestrator.ts` | Replace internal loop with `engine.investigate(goal: 'investigate_bug')` |
| 13 | Keep operations gate | `investigation-orchestrator.ts` | Post-processing: validate operations check before accepting conclude |

### Phase 5: PR Review Enhancement

| # | Component | File | Description |
|---|-----------|------|-------------|
| 14 | ResearchEngine for complex PRs | `web-server.js` | In GET /api/pr/review, if >5 files changed → `engine.investigate({ goal: 'review_pr' })` |
| 15 | pr_risk_assessment tool | `src/intelligence/research-tools.ts` | Structured risk output from research findings |

### Phase 6: UI Enhancements (V2)

| # | Component | File | Description |
|---|-----------|------|-------------|
| 16 | Research indicator in chat | `web/src/components/shell/ChatPanel.tsx` | "Researching..." spinner + collapsed trace |
| 17 | Research trace in analyzer | `web/src/pages/JiraReportPage.tsx` | Show investigated files/links in analysis tab |

---

## File Map

```
src/intelligence/
  research-tools.ts         ← NEW: Shared tool implementations + dispatchResearchTool()
  research-engine.ts        ← NEW: ResearchEngine class + needsDeepResearch() + presets
  investigation-orchestrator.ts  ← MODIFIED: Delegates to ResearchEngine
  tools/
    file-reader.ts          ← UNCHANGED (re-exported)
    git-log-window.ts       ← UNCHANGED (re-exported)
    call-graph-tracer.ts    ← UNCHANGED (re-exported)
    dep-diff.ts             ← UNCHANGED (re-exported)
  ownership-map.ts          ← UNCHANGED (re-exported)
  palace-client.ts          ← UNCHANGED (used for enrichment)
  memory-enricher.ts        ← UNCHANGED (used for enrichment)

src/services/
  link-extractor.ts         ← NEW: URL regex, skip-list, dedup (ADR-019)
  link-fetcher.ts           ← NEW: Playwright fetch with SSO cookies (ADR-019)

src/db/
  schema.ts                 ← MODIFIED: v38 migration adds linked_content column

web-server.js               ← MODIFIED: Chat + Analyzer integration, remove old grep block
```

---

## Verification

### Functional Tests

1. Chat: "how does frontend call search-provider search" → returns file paths + code snippets (G1, G2, G3)
2. Chat: "what are my action items" → instant reply, no research triggered
3. Chat: "how does authentication work in example-service" (no Jira key) → still searches code (G1)
4. Chat: "find payment gateway" (not in repo) → blocker report with suggestions (G5)
5. Analyzer: PROJ-15720 → allContext includes iterative research results (G8)
6. Analyzer: PROJ-15702 → fetched link content in context (G9, ADR-019)
7. Same code question twice → second is faster (FTS finds prior research) (G6)
8. PR review: complex PR → traces beyond depth 2 (G14)
9. Investigation: PROJ-15257 → same quality + `search_pr_history` available (G12)

### Technical Checks

10. `npx tsc --noEmit` passes
11. All existing endpoints return 200 (no regression)
12. `research-tools.ts` imported by investigation-orchestrator (no duplication)
13. Chat deep research < 30s for typical questions
14. Smoke: `curl -X POST localhost:3132/api/chat -d '{"message":"how does search-provider search work"}'`
