# ADR-013: Intelligent Bug Investigation Engine

**Status:** Implemented (EP-55 ✅, Sprint 12)  
**Date:** 2026-04-21  
**Authors:** Architecture Review  
**Supersedes:** None — extends ADR-009 (Jira My Work Cockpit)

---

## Context

The current `/api/jira/analyze` endpoint runs 5 parallel Claude calls against:
1. Ticket description + last 5 comments
2. Code snippets from a keyword `rg` search against example-service

**Root failure case (PROJ-15257 — BIS Recommended Links Regression):**

- Regression started April 17. Root cause: UI5 1.135+ made `getResourceBundle()` async in `smrdp-ui-plugins/Component.js`.
- The system found `useRecommendedLinks.ts` and related example-service files via keyword search.
- It produced a plausible but **wrong** solution — example-service-level fixes to code that was never broken.
- The actual root cause (a dependency bump in `@types/openui5` on April 16, an external plugin's sync API assumption) was invisible to the system.

**Why a senior developer finds this in 10 minutes:**

```
1. Ticket says "stopped working April 17"
   → git log --since=Apr14 --until=Apr18 → finds @types/openui5 1.145→1.146 bump
   → package.json diff → confirms runtime change, not code change

2. Symptom: blank recommended links panel
   → trace from UI: RecommendedLinksPanel → useRecommendedLinks → shouldSkipTheRequest()
   → shouldSkipTheRequest() returns false (backend never called when plugin provides links)
   → plugin-first: contextLinks.length > 0 ? contextLinks : backendLinks
   → example-service is not in the blast radius at all

3. Who provides contextLinks? → smrdp-ui-plugins → getRecommendedLinks() SDK hook
   → smrdp-ui-plugins/Component.js → reads getResourceBundle() synchronously
   → UI5 1.135 changelog: getResourceBundle() now async
   → SMRDP team owns the fix, not Saturn
```

The system cannot do steps 1–3 because it:
- Has no temporal reasoning (no git log, no PR/commit scan by date)
- Has no architecture knowledge (plugin-first priority, who owns what)
- Has no call-graph traversal (starts from keyword match, not symptom trace)
- Has no "I don't own this" signal (never produces "this is in an external dep")

---

## Decision

Build a **3-Layer Investigation Engine** that mirrors how a senior developer thinks:

```
Layer 1: Persistent Knowledge Base    — what we know about the system (built once, used always)
Layer 2: Temporal Investigation       — what changed around the regression date
Layer 3: Symptom-Driven Code Reading  — trace from symptom, not from keyword
```

These layers compose into a **ReAct-style agentic loop** where each tool call informs the next, building evidence until a confident root cause is reached or uncertainty is surfaced.

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    BUG INVESTIGATION ENGINE                          │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  LAYER 1: Knowledge Base (persistent, pre-indexed)           │   │
│  │                                                               │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │   │
│  │  │ArchitectureDB│  │ OwnershipMap │  │  BugPatternStore │  │   │
│  │  │ (ADRs, docs, │  │ (who owns    │  │  (past bugs,     │  │   │
│  │  │  subsystems) │  │  what area)  │  │   root causes)   │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                               │ always loaded into system prompt     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  LAYER 2: Temporal Investigation (run per bug, regression)   │   │
│  │                                                               │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │   │
│  │  │  git log     │  │  PR/commit   │  │  Dep diff        │  │   │
│  │  │  date window │  │  scan        │  │  (package.json)  │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                               │ feeds evidence into Layer 3          │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  LAYER 3: Symptom-Driven Code Reading (targeted, not blind)  │   │
│  │                                                               │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │   │
│  │  │ Call Graph   │  │ Changed File │  │  No-match signal │  │   │
│  │  │ Traversal    │  │ Deep Read    │  │  + external dep  │  │   │
│  │  └──────────────┘  └──────────────┘  │  detection       │  │   │
│  │                                       └──────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                               │                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  ORCHESTRATOR: ReAct Loop (max 8 iterations)                 │   │
│  │  Thought → Tool → Observe → Thought → ... → Conclusion       │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow for a Regression Bug

```
POST /api/jira/investigate
  │
  ├─ [sync] Load Layer 1: architecture snapshot + ownership map
  │         (cached 24h, rebuilt on doc change)
  │
  ├─ [sync] Extract regression date from ticket
  │         → title/description: "after April 17", "since last deploy"
  │         → fallback: ticket created_at - 3 days
  │
  ├─ [async] Layer 2: Temporal scan (parallel)
  │   ├─ git log --since={date-3d} --until={date+1d} --name-status
  │   ├─ package.json diff between closest commits
  │   └─ PR titles/bodies in window (GitHub API or local git)
  │
  ├─ [async] Layer 3: Symptom trace (sequential, tool-driven)
  │   ├─ Identify entry point from ticket description (UI component / API endpoint)
  │   ├─ Traverse call graph from entry point (code_graph table)
  │   ├─ Read changed files from Layer 2 in full (not 140-line windows)
  │   └─ Signal if no owned files in blast radius → "external dep candidate"
  │
  └─ [async] ReAct Orchestrator (Claude Sonnet)
      ├─ Tools: git_log, read_file, grep_code, get_pr, get_dep_diff,
      │         get_architecture, get_ownership, get_bug_history
      ├─ Max 8 iterations
      ├─ Terminates when: confidence ≥ 0.8 OR all tools exhausted
      └─ Produces: InvestigationReport (see schema below)
```

---

## Layer 1: Knowledge Base Schema

### New DB Table: `codebase_knowledge` (schema v35)

```sql
CREATE TABLE IF NOT EXISTS codebase_knowledge (
  id          INTEGER PRIMARY KEY,
  repo        TEXT NOT NULL,          -- 'example-service', 'operations', 'smrdp-ui-plugins'
  area        TEXT NOT NULL,          -- 'recommended-links', 'auth', 'feature-flags'
  type        TEXT NOT NULL,          -- 'architecture', 'ownership', 'pattern', 'dependency'
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,          -- markdown blob
  source_file TEXT,                   -- origin file path (docs/README/ADR)
  indexed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo, area, type, title)
);

CREATE TABLE IF NOT EXISTS subsystem_owners (
  id          INTEGER PRIMARY KEY,
  repo        TEXT NOT NULL,
  path_glob   TEXT NOT NULL,          -- 'src/recommended-links/**', 'apps/plugins/**'
  team        TEXT,                   -- 'Saturn', 'SMRDP', 'Platform'
  owner       TEXT,                   -- primary contact
  notes       TEXT,
  UNIQUE(repo, path_glob)
);

CREATE TABLE IF NOT EXISTS investigation_sessions (
  id              INTEGER PRIMARY KEY,
  issue_key       TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'running',  -- running|done|failed
  regression_date TEXT,
  hypothesis      TEXT,
  conclusion      TEXT,
  confidence      REAL,               -- 0.0–1.0
  owner_team      TEXT,               -- who should fix this
  react_trace     TEXT,               -- JSON array of {thought, tool, observation}
  report_json     TEXT,               -- full InvestigationReport JSON
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);
```

### Ownership Map (static seed, updated manually)

```typescript
// src/intelligence/ownership-map.ts
export const OWNERSHIP_MAP: OwnershipEntry[] = [
  { repo: 'example-service',         glob: 'apps/recommended-links/**',   team: 'Saturn',  contact: 'maaz' },
  { repo: 'example-service',         glob: 'apps/auth/**',                team: 'Saturn',  contact: 'maaz' },
  { repo: 'smrdp-ui-plugins', glob: '**',                          team: 'SMRDP',   contact: 'smrdp-team' },
  { repo: 'example-service',         glob: 'apps/feature-flags/**',       team: 'Platform', contact: 'platform-team' },
  // ...
];
```

---

## Layer 2: Temporal Investigation Tools

### Tool: `git_log_window`

```typescript
interface GitLogWindowInput {
  repo: 'example-service' | 'operations';
  since: string;   // ISO date
  until: string;   // ISO date
}

interface GitLogWindowOutput {
  commits: Array<{
    sha: string;
    date: string;
    author: string;
    message: string;
    filesChanged: string[];   // --name-status, filtered to non-test files
    isDependencyBump: boolean; // any package.json / package-lock.json in filesChanged
  }>;
  dependencyChanges: Array<{
    file: string;
    packageName: string;
    from: string;
    to: string;
  }>;
}
```

**Implementation:** `git log --since --until --name-status --format="%H|%ai|%an|%s"` — parse output into structured commits. For each commit touching `package.json`, diff the lockfile to extract package version bumps.

### Tool: `get_dep_diff`

```typescript
// Given two commit SHAs, diff package.json and return added/removed/changed packages
function getDepDiff(repo: string, fromSha: string, toSha: string): DepChange[]
```

**Implementation:** `git show {sha}:package.json` for both SHAs, JSON diff packages.

---

## Layer 3: Symptom-Driven Code Tools

### Tool: `trace_call_graph`

Uses the existing `code_graph` table (v24):

```typescript
interface TraceInput {
  repo: string;
  startFile: string;     // identified from ticket description (e.g. 'useRecommendedLinks.ts')
  direction: 'callers' | 'callees' | 'both';
  maxDepth: number;      // default 3
}

interface TraceOutput {
  nodes: Array<{ file: string; symbol: string; repo: string; team: string | null }>;
  edges: Array<{ from: string; to: string; type: string }>;
  externalDeps: string[];    // deps not owned by any team in ownership map
  crossRepoBoundaries: Array<{ fromRepo: string; toRepo: string; via: string }>;
}
```

### Tool: `read_changed_files`

```typescript
// Read files that changed in the temporal window — FULL content, not 140-line window
function readChangedFiles(commits: GitCommit[]): FileContent[]
// Caps at 5 files × 500 lines each = max 2500 lines of context
```

### Tool: `signal_external_dep`

```typescript
// If no example-service files are in the call graph for the symptom path,
// and a dependency bump exists in the temporal window,
// emit an ExternalDepSignal
interface ExternalDepSignal {
  depName: string;
  fromVersion: string;
  toVersion: string;
  changelogUrl: string | null;
  affectedPath: string;    // which import path in example-service uses this dep
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}
```

---

## ReAct Orchestrator

### System Prompt (Layer 1 knowledge injected here)

```
You are a senior software engineer investigating a production bug. You have access to:
- Architecture knowledge: how subsystems interact, who owns what
- Git history: what changed around the regression date
- Code reading: full file content for changed files
- Call graph: which files/functions call which

## Investigation Protocol

1. START with the regression date. Always run git_log_window first for ±3 days.
2. CHECK for dependency bumps before reading application code.
3. TRACE from the symptom (what the user sees) → not from keywords.
4. SIGNAL "external dependency" if:
   - No owned files changed in the regression window, AND
   - A third-party dep changed version, AND
   - The symptom path touches that dep
5. NEVER propose a fix in a file your team does not own without explicitly flagging "this is owned by {team}".
6. STATE your confidence (0.0–1.0) at each step.
7. STOP at 8 iterations. If unresolved, produce a "needs more info" conclusion.

## Architecture Knowledge (auto-injected from codebase_knowledge table)
{architecture_snapshot}

## Ownership Map
{ownership_map}
```

### ReAct Loop Structure

```
Iteration 1: Thought: "Regression date is April 17. Run git log ±3 days."
             Tool: git_log_window(since=Apr14, until=Apr18)
             Observe: "Commit 44a5ed8912 on Apr16: @types/openui5 1.145→1.146"

Iteration 2: Thought: "openui5 type bump. Check if it's a breaking change.
                        Also check what in example-service uses openui5."
             Tool: grep_code(pattern="openui5|ResourceBundle|getResourceBundle", repo=example-service)
             Observe: "No direct usage in example-service/src. Used in smrdp-ui-plugins."

Iteration 3: Thought: "Symptom is blank recommended links panel.
                        Trace who provides recommended links."
             Tool: trace_call_graph(startFile=useRecommendedLinks.ts, direction=callees)
             Observe: "shouldSkipTheRequest() → returns false when contextLinks present.
                        Plugin-first: contextLinks wins. smrdp-ui-plugins provides contextLinks."

Iteration 4: Thought: "smrdp-ui-plugins is not in example-service. Check ownership."
             Tool: get_ownership(file=smrdp-ui-plugins/**)
             Observe: "Owner: SMRDP team. Saturn does not own this repo."

Iteration 5: Thought: "Root cause candidate: openui5 1.135+ changed getResourceBundle() to async.
                        smrdp-ui-plugins/Component.js calls it synchronously.
                        SMRDP team needs to fix. Confidence: 0.85"
             → TERMINATE

Conclusion: {
  rootCause: "UI5 async getResourceBundle() breaking change in smrdp-ui-plugins",
  fixOwner: "SMRDP team",
  example-serviceAction: "No code change needed. Monitor after SMRDP deploys fix.",
  confidence: 0.85,
  evidence: [commit 44a5ed8912, call graph trace, ownership map]
}
```

### InvestigationReport Schema

```typescript
interface InvestigationReport {
  issueKey:        string;
  title:           string;
  regressionDate:  string | null;

  // Core findings
  rootCause:       string;            // one paragraph
  rootCauseType:   'code-change'      // we changed something that broke it
                 | 'dep-upgrade'      // a dependency changed behavior
                 | 'config-change'    // env/config/FF changed
                 | 'external-system'  // external service / plugin changed
                 | 'unknown';

  // Ownership
  fixOwner:        string;            // team/person who should fix
  example-serviceAction:  string;            // what Saturn team should do (may be "nothing, monitor")
  isExternalDep:   boolean;

  // Evidence trail
  evidence: Array<{
    type: 'git-commit' | 'dep-diff' | 'code-trace' | 'ownership' | 'architecture';
    description: string;
    detail: string;
  }>;

  // Proposed fix (only if fixOwner is Saturn)
  proposedFix: {
    description: string;
    steps: string[];
    files: string[];
    missingInfo: string | null;
  } | null;

  // Confidence + React trace
  confidence:      number;            // 0.0–1.0
  reactTrace: Array<{
    iteration: number;
    thought: string;
    tool: string;
    toolInput: Record<string, unknown>;
    observation: string;
  }>;

  analyzedAt: string;
}
```

---

## Prompt Engineering Decisions

### Decision 1: Role Framing Over Generic Assistant

**Before (current):**
```
You are a work intelligence assistant. Answer based on the provided context.
```

**After:**
```
You are a senior software engineer at  investigating a production regression.
You own the example-service codebase. External plugins (smrdp-*, BTP services) are owned by other teams.
Your job is to find root cause, not to generate fixes in code you don't own.
```

**Why:** Role framing activates domain-specific reasoning patterns. "Senior software engineer" + "you own X" gives Claude the lens to say "this is not in my blast radius."

### Decision 2: Tool-Use for Structured Reasoning (not free-form text)

All investigation steps use `tool_choice: { type: 'tool' }` with structured schemas. This prevents Claude from hallucinating file paths or inventing commits. Every claim must come from a tool observation.

### Decision 3: Explicit Confidence Scoring

Each iteration requires Claude to update a `confidence` field (0.0–1.0). Loop terminates at ≥0.8 or 8 iterations. This prevents both premature conclusions and infinite loops.

### Decision 4: "External Dependency" as a First-Class Output

Current system has no output type for "the bug is in something we don't own." The new `rootCauseType: 'external-system' | 'dep-upgrade'` + `isExternalDep: boolean` + `fixOwner` fields make this a structured, surfaceable result rather than a gap in reasoning.

### Decision 5: Temporal Context Before Code Context

System prompt explicitly orders investigation steps: temporal first, code second. This mirrors how senior devs think: "what changed?" before "what does the code do?"

### Decision 6: Chat Messages Are Investigation Signals

When a user says **"I think this is the cause"**, **"maybe this PR caused it"**, or **"could be the auth change"** in chat, that is a hypothesis — not a casual remark. The system must:

1. **Detect** hypothesis phrases in the chat message
2. **Extract** the artifact reference (PR number, commit, file, keyword)
3. **Persist** it immediately to `jira_analysis.notes` for the active ticket
4. **Seed** the next investigation run with this hypothesis as a starting context item (highest priority, above all other context)

This mirrors how a senior dev works: if a teammate says "check the PR from last Thursday" you don't ignore it — you pull that PR first before doing anything else.

**Trigger phrases (regex):**
```
/i think|maybe|could be|possibly|probably|might be|i suspect|looks like|this (pr|commit|change|merge)/i
```

**Artifact extraction patterns:**
- PR number: `#\d+` or `PR \d+` or `pull request \d+`
- Commit SHA: `\b[0-9a-f]{7,40}\b`
- Jira key: `\b[A-Z]+-\d+\b`
- File path: anything matching `\S+\.(ts|js|tsx|jsx|json|yaml|yml)`
- Branch name: after `branch`, `merge`, `from`

**Storage:** appended to `jira_analysis.notes` with a `[Chat hypothesis — {timestamp}]` prefix so it survives across sessions and is visible in the Notes tab.

**Investigation seeding:** when `POST /api/jira/investigate` is called and `jira_analysis.notes` contains chat hypotheses, those are injected into the ReAct system prompt as:
```
## User Hypotheses (from chat — investigate these first)
- [2026-04-21 14:32] "maybe this PR caused it" → PR #4821
- [2026-04-21 14:35] "I think it's the openui5 bump"
```
The orchestrator's iteration 1 will prioritise these over the default `git_log_window` call.

---

## Context Sharing Between Sessions

### Problem

Every analyze call today is amnesiac. PROJ-15257 was investigated, but the finding ("getResourceBundle() async, SMRDP owns it") is lost after the session. Next time a similar bug appears, the system starts from zero.

### Solution: Investigation Sessions + Pattern Extraction

1. **`investigation_sessions` table** — every completed investigation persists its `react_trace` + `report_json`
2. **Post-investigation learning** — after conclusion, extract a `bug_pattern`:

```typescript
interface BugPattern {
  pattern:     string;   // "UI5 async API change in external plugin"
  symptoms:    string[]; // ["blank panel", "TypeError in SDK hook", "Promise {<pending>}"]
  indicators:  string[]; // ["dep bump in openui5/*", "external plugin calls sync API"]
  resolution:  string;   // "File issue with plugin team. No example-service change needed."
  confidence:  number;
}
```

3. **Pattern retrieval** — before starting a new investigation, search `investigation_sessions` by symptom keywords. If a similar past investigation exists with high confidence, surface it immediately.

```
New ticket: "BIS links blank after UI5 upgrade"
→ FTS search: "blank" + "UI5" + "links"
→ Hits PROJ-15257 investigation session
→ Report shows: "This matches the UI5 async getResourceBundle() pattern.
   Previous investigation (PROJ-15257) found same root cause.
   Fix owner: SMRDP team. Confidence: 0.92 (pattern match)"
→ Skip full ReAct loop, propose pattern match directly
```

---

## Test Harness

### Mock Problem: PROJ-15257 Replay Test

```typescript
// tests/intelligence/bug-investigation.test.ts

describe('BugInvestigationEngine', () => {

  describe('Layer 2: Temporal Investigation', () => {
    it('detects @types/openui5 bump in git log window', async () => {
      // MOCK: git log output with 44a5ed8912 commit
      mockGitLog([{
        sha: '44a5ed8912',
        date: '2026-04-16',
        author: 'dependabot',
        message: 'chore(deps): bump @types/openui5 from 1.145.0 to 1.146.0',
        filesChanged: ['package.json', 'package-lock.json'],
      }]);

      const result = await gitLogWindow({
        repo: 'example-service',
        since: '2026-04-14',
        until: '2026-04-18',
      });

      expect(result.commits).toHaveLength(1);
      expect(result.commits[0].isDependencyBump).toBe(true);
      expect(result.dependencyChanges).toContainEqual({
        packageName: '@types/openui5',
        from: '1.145.0',
        to: '1.146.0',
      });
    });

    it('returns empty when no commits in window', async () => {
      mockGitLog([]);
      const result = await gitLogWindow({ repo: 'example-service', since: '2026-04-14', until: '2026-04-18' });
      expect(result.commits).toHaveLength(0);
      expect(result.dependencyChanges).toHaveLength(0);
    });
  });

  describe('Layer 3: Call Graph', () => {
    it('traces recommended links to plugin boundary', async () => {
      // MOCK: code_graph table with example-service → smrdp boundary
      mockCodeGraph([
        { file: 'useRecommendedLinks.ts', symbol: 'shouldSkipTheRequest', refFile: 'getRecommendedLinks.ts', refType: 'call' },
        { file: 'getRecommendedLinks.ts', symbol: 'getRecommendedLinks', refFile: 'smrdp-ui-plugins/Component.js', refType: 'api_call', refRepo: 'external' },
      ]);

      const result = await traceCallGraph({
        repo: 'example-service',
        startFile: 'useRecommendedLinks.ts',
        direction: 'callees',
        maxDepth: 3,
      });

      expect(result.crossRepoBoundaries).toContainEqual({
        fromRepo: 'example-service',
        toRepo: 'external',
        via: 'smrdp-ui-plugins/Component.js',
      });
      expect(result.externalDeps).toContain('smrdp-ui-plugins');
    });
  });

  describe('Layer 1: Ownership', () => {
    it('identifies SMRDP as owner of smrdp-ui-plugins', () => {
      const owner = getOwnership('smrdp-ui-plugins/webapps/plugins/Component.js');
      expect(owner.team).toBe('SMRDP');
      expect(owner.contact).toBe('smrdp-team');
    });

    it('identifies Saturn as owner of example-service recommended-links', () => {
      const owner = getOwnership('example-service/apps/recommended-links/useRecommendedLinks.ts');
      expect(owner.team).toBe('Saturn');
    });
  });

  describe('ReAct Orchestrator — PROJ-15257 mock replay', () => {
    it('reaches correct root cause within 6 iterations', async () => {
      // Mock all tools with PROJ-15257 scenario data
      mockAllTools(BDS15257_SCENARIO);

      const report = await investigateBug({
        issueKey: 'PROJ-15257',
        title: 'BIS Recommended Links Not Showing After April 17',
        description: 'Since April 17, BIS recommended links are blank...',
        createdAt: '2026-04-17',
      });

      expect(report.rootCauseType).toBe('dep-upgrade');
      expect(report.isExternalDep).toBe(true);
      expect(report.fixOwner).toBe('SMRDP');
      expect(report.example-serviceAction).toMatch(/no code change/i);
      expect(report.confidence).toBeGreaterThanOrEqual(0.8);
      expect(report.reactTrace.length).toBeLessThanOrEqual(6);
    });

    it('produces no proposed fix when fix owner is external', async () => {
      mockAllTools(BDS15257_SCENARIO);
      const report = await investigateBug({ issueKey: 'PROJ-15257', ... });
      expect(report.proposedFix).toBeNull();
    });

    it('surfaces external dep signal when dep bump + no owned files changed', async () => {
      mockAllTools(BDS15257_SCENARIO);
      const report = await investigateBug({ issueKey: 'PROJ-15257', ... });

      const depEvidence = report.evidence.find(e => e.type === 'dep-diff');
      expect(depEvidence).toBeDefined();
      expect(depEvidence.description).toContain('@types/openui5');
    });
  });

  describe('Pattern Matching — cross-session memory', () => {
    it('matches new ticket to past investigation by symptom', async () => {
      // Seed DB with PROJ-15257 completed investigation
      seedInvestigation(BDS15257_COMPLETED_REPORT);

      const match = await findSimilarInvestigation({
        title: 'Help Portal Links Missing After UI5 Update',
        symptoms: ['blank panel', 'UI5', 'plugin'],
      });

      expect(match).toBeDefined();
      expect(match.issueKey).toBe('PROJ-15257');
      expect(match.confidence).toBeGreaterThan(0.7);
    });
  });

  describe('Edge Cases', () => {
    it('handles no regression date in ticket gracefully', async () => {
      const report = await investigateBug({
        issueKey: 'PROJ-99999',
        title: 'Button sometimes not clickable',
        description: 'No specific date, intermittent issue',
        createdAt: '2026-04-21',
      });
      // Should use createdAt - 3 days as fallback window
      expect(report.reactTrace[0].tool).toBe('git_log_window');
    });

    it('terminates at max iterations and produces uncertainty report', async () => {
      // Mock tools to return inconclusive data every iteration
      mockAllTools(INCONCLUSIVE_SCENARIO);
      const report = await investigateBug({ issueKey: 'PROJ-00001', ... });
      expect(report.reactTrace.length).toBe(8);
      expect(report.confidence).toBeLessThan(0.5);
      expect(report.rootCauseType).toBe('unknown');
    });

    it('does not propose fix for external team files', async () => {
      mockAllTools(EXTERNAL_OWNERSHIP_SCENARIO);
      const report = await investigateBug({ issueKey: 'PROJ-00002', ... });
      expect(report.proposedFix).toBeNull();
      expect(report.example-serviceAction).toMatch(/contact|escalate|SMRDP|external/i);
    });
  });
});
```

---

## Implementation Phases

### Phase 55 — Wave 1: Foundation (Layer 1 + DB schema)
- Schema v35: `codebase_knowledge`, `subsystem_owners`, `investigation_sessions`
- Ownership map seed (`src/intelligence/ownership-map.ts`)
- Architecture indexer: scan example-service docs/ADRs → `codebase_knowledge`
- Unit tests: ownership resolution

### Phase 55 — Wave 2: Temporal Layer
- `git_log_window` tool implementation
- `get_dep_diff` tool (package.json comparison between commits)
- Regression date extractor (NLP from ticket description)
- Unit tests: mock git log scenarios

### Phase 55 — Wave 3: Symptom Layer
- `trace_call_graph` using existing `code_graph` table
- `read_changed_files` (full file read, not 140-line window)
- `signal_external_dep` logic
- Unit tests: call graph traversal, external dep detection

### Phase 55 — Wave 4: ReAct Orchestrator
- `InvestigationOrchestrator` class with ReAct loop
- Tool registry + tool dispatch
- Confidence scoring + termination conditions
- System prompt with Layer 1 knowledge injection
- Integration tests: PROJ-15257 mock replay

### Phase 55 — Wave 5: UI + Cross-Session Memory
- New "Investigate" tab in TicketDetailPanel (replaces current "Analysis")
- ReactTrace viewer (expandable thought/tool/observe steps)
- `investigation_sessions` persistence + pattern retrieval
- E2E test: full investigation flow in browser

---

## Consequences

**Positive:**
- Regression bugs with clear date signals will reach correct root cause without human guidance
- External ownership is surfaced as a structured output, not a gap
- Investigation sessions persist — second occurrence of same bug pattern resolves in 1 step
- ReAct trace is fully auditable — user can see exactly why the system reached its conclusion

**Negative:**
- Layer 1 (ownership map, architecture docs) requires manual maintenance as the codebase evolves
- ReAct loop adds latency (~8 × 2s tool calls = ~16s worst case) vs current 5s parallel blasts
- `code_graph` table must be populated (via `POST /api/code-graph/index`) for call graph traversal to work
- External repos (smrdp-ui-plugins) remain invisible unless explicitly added as connected repos

**Mitigations:**
- Layer 1 can be refreshed incrementally (only re-index changed files)
- Streaming UI (show each ReAct iteration as it completes) makes latency feel like progress
- `code_graph` indexing runs in background, falls back gracefully to keyword search if empty
- External repo support is a Phase 56 follow-on (add smrdp-ui-plugins to `./repos/`)

---

## Alternatives Considered

| Option | Rejected Because |
|---|---|
| Add more keywords to rg search | Still keyword-driven, still blind to temporal signal and ownership |
| Use Opus model for analysis | Better reasoning from same wrong context = still wrong answer |
| Ask user to specify regression date | Manual step, defeats the purpose |
| Embed all code and do semantic search | Embedding drift, storage cost; call graph is more precise for tracing |
| RAG over example-service docs | Documents alone don't know who owns a file; ownership map is structural |

---

*This ADR is the design contract for Phase 55 (Bug Investigation Engine).*  
*Implementation begins after user sign-off on this document.*
