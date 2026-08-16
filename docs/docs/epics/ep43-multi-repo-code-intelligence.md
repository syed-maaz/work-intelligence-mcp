---
sidebar_position: 43
title: EP-43 Multi-Repo Code Intelligence
---

# EP-43: Multi-Repo Code Intelligence

| Field | Value |
|-------|-------|
| **Status** | ✅ Done |
| **Priority** | High |
| **Complexity** | Large (4–6 days) |
| **Blocked By** | None (EP-31-6 route split recommended first) |
| **Schema version** | v24 — adds `code_graph` table |

## Summary

Work Intelligence MCP becomes the brain for two additional codebases. Both repos live in `./repos/` inside this project — gitignored, local workspace only. MCP creates branches, runs tests, and opens PRs inside these copies freely without touching your active working copies.

```
work-intelligence-mcp/
  repos/
    example-service/      ← cp -r ~/Desktop/projects/acme/example-service repos/example-service
    operations/    ← cp -r ~/Desktop/projects/acme/operations repos/operations
```

- **example-service**: `./repos/example-service` — main application
- **Operations**: `./repos/operations` — deployment + ops configs

This epic builds the **Code Interlink Map** — a SQLite graph of how files, functions, and symbols reference each other across all three repos. Enables: blast radius analysis (what breaks if I change X), test coverage targeting (which tests cover these files), reviewer suggestion (who owns this code), and cross-repo impact detection (does changing example-service break Operations configs).

## Decisions Made

- **Local workspace** — repos live in `./repos/` (gitignored). MCP operates on these copies freely — creates branches, runs tests, opens PRs — without touching your active working copies at `~/Desktop/projects/acme/`.
- **Refresh by copy** — no submodules, no re-checkout. Just `cp -r ~/Desktop/projects/acme/example-service repos/example-service` or `git pull` inside the copy.
- **AST-based indexing** — `ts-morph` for TypeScript files; regex patterns for YAML/JSON config files in Operations. No runtime instrumentation.
- **Incremental updates** — `git diff --name-only HEAD~1` to find changed files; only re-index those on sync.
- **Full reindex on demand** — `POST /api/code-graph/index` triggers full re-scan (runs in background, ~2 min for large repo).
- **Stored in MCP's SQLite DB** — same database, new table. No separate graph DB needed at this scale.

---

## EP-43-1: Environment Configuration

### Add to `.env`

```bash
example-service_PATH=./repos/example-service
OPERATIONS_PATH=./repos/operations
GITHUB_TOKEN=ghp_...              # for PR creation + review posting
example-service_GITHUB=org/example-service     # GitHub repo slug
OPERATIONS_GITHUB=org/operations
```

### Add to `src/services/config.ts`

```typescript
export interface RepoConfig {
  name: string;        // 'example-service' | 'operations' | 'mcp'
  localPath: string;
  githubSlug: string;
  testCmd: string;
  e2eCmd?: string;
  defaultBranch: string;
}

// ConfigManager.getRepos(): RepoConfig[]
```

---

## EP-43-2: Schema Migration v23

### Add to `src/db/schema.ts`

```typescript
if (currentVersion < 23) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_graph (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      file_path TEXT NOT NULL,     -- relative path from repo root
      symbol TEXT,                 -- function/class/export name (null = file-level)
      ref_repo TEXT NOT NULL,
      ref_file TEXT NOT NULL,
      ref_symbol TEXT,
      ref_type TEXT NOT NULL CHECK(ref_type IN (
        'import', 'call', 'type', 'api_call', 'env_var',
        'test_covers', 'config_ref'
      )),
      line_number INTEGER,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type)
    );
    CREATE INDEX IF NOT EXISTS idx_code_graph_source ON code_graph(repo, file_path);
    CREATE INDEX IF NOT EXISTS idx_code_graph_ref    ON code_graph(ref_repo, ref_file);
    CREATE INDEX IF NOT EXISTS idx_code_graph_type   ON code_graph(ref_type);
  `);
  db.prepare('UPDATE schema_version SET version = 23').run();
}
```

---

## EP-43-3: Code Indexer

### New file: `src/tools/code-indexer.ts`

```typescript
import { Project, SourceFile } from 'ts-morph';

export interface IndexResult {
  repo: string;
  filesIndexed: number;
  edgesAdded: number;
  durationMs: number;
}

export class CodeIndexer {
  constructor(private db: Database, private repos: RepoConfig[]) {}

  // Full reindex — clears existing rows for repo, re-scans all .ts/.tsx files
  async indexRepo(repoName: string): Promise<IndexResult>

  // Incremental — only reindex files changed since last commit
  async indexChangedFiles(repoName: string): Promise<IndexResult>

  // Run after every runFullSync()
  async syncAll(): Promise<IndexResult[]>
}
```

**Extraction logic per file:**
```typescript
// For each TypeScript file:
// 1. All import declarations → ref_type: 'import'
sourceFile.getImportDeclarations().forEach(imp => {
  const moduleSpecifier = imp.getModuleSpecifierValue();
  // Resolve to actual file path relative to repo root
  // INSERT INTO code_graph ...
});

// 2. fetch('/api/...') calls → ref_type: 'api_call'
// 3. process.env.X references → ref_type: 'env_var'
// 4. Type references → ref_type: 'type'

// For test files (*.test.ts, *.spec.ts):
// Imports from source files → ref_type: 'test_covers'

// For YAML/JSON in operations:
// References to env vars / service names → ref_type: 'config_ref'
```

---

## EP-43-4: Blast Radius + Query Functions

### Add to `src/db/queries.ts`

```typescript
export interface BlastRadiusNode {
  repo: string;
  file_path: string;
  ref_type: string;
  depth: number;  // 1 = direct, 2 = transitive
}

// "What breaks if I change this file?"
export function getBlastRadius(
  db: Database,
  repo: string,
  filePath: string,
  maxDepth?: number  // default 2
): BlastRadiusNode[]

// "Which tests cover these files?"
export function getTestCoverage(
  db: Database,
  changedFiles: Array<{ repo: string; file: string }>
): string[]  // test file paths to run

// "Who owns this file most?" (joins with team_members via github_handle)
export function getFileOwners(
  db: Database,
  repo: string,
  filePath: string
): Array<{ github_handle: string; commit_count: number }>
```

---

## EP-43-5: API Endpoints

### Add to `web-server.js`

```javascript
// GET /api/code-graph/blast-radius?repo=example-service&file=src/auth/login.ts
// → { nodes: BlastRadiusNode[], crossRepoImpact: boolean }

// GET /api/code-graph/test-coverage?files[]=example-service:src/auth/login.ts
// → { testFiles: string[], command: string }

// GET /api/code-graph/owners?repo=example-service&file=src/auth/login.ts
// → { owners: [{ github_handle, commit_count }] }

// POST /api/code-graph/index
// body: { repo: 'example-service' | 'operations' | 'all' }
// → 202 immediately, runs in background, result in error_logs
```

---

## CLAUDE.md Addition

```markdown
## Connected Repositories

| Repo | Local Path | GitHub | Purpose |
|------|-----------|--------|---------|
| example-service | `$example-service_PATH` | org/example-service | Main application |
| Operations | `$OPERATIONS_PATH` | org/operations | Deployment + ops |

Configure in `.env`:
GITHUB_TOKEN=ghp_...

Code interlink: GET /api/code-graph/blast-radius?repo=example-service&file=...
Reindex: POST /api/code-graph/index { repo: "example-service" }
```

---

## Key Code Locations

| File | Change |
|------|--------|
| `src/db/schema.ts` | Migration v23: `code_graph` table |
| `src/db/queries.ts` | `getBlastRadius`, `getTestCoverage`, `getFileOwners` |
| `src/tools/code-indexer.ts` | NEW — `CodeIndexer` class |
| `src/services/config.ts` | Add `RepoConfig`, `getRepos()` |
| `web-server.js` | 4 new code-graph endpoints |
| `CLAUDE.md` | Add Connected Repositories section |
| `.env` | `example-service_PATH`, `OPERATIONS_PATH`, `GITHUB_TOKEN` |

## Acceptance Criteria

- [x] `code_graph` table created in migration v24
- [x] `CodeIndexer.indexRepo('example-service')` successfully indexes `./repos/example-service`
- [x] `getBlastRadius()` returns correct transitive file set for a given file
- [x] `getTestCoverage()` returns test files that cover changed source files
- [x] `POST /api/code-graph/index` runs in background, returns 202
- [x] `GET /api/code-graph/blast-radius` returns correct JSON
- [x] Cross-repo impact detected when example-service file referenced in operations
- [x] `npm run typecheck` passes

---

## Downstream Integration (unlocked by this epic)

Once EP-43 is merged, these existing pages get code intelligence automatically:

| Page | Extension | Doc |
|------|-----------|-----|
| **JiraReportPage** | 4th analysis tab "Code Impact" + blast radius badge per ticket | [EP-29 extension](../epics/ep29-jira-deep-analysis#code-intelligence-extension-requires-ep-43) |
| **TeamsUpdatesPage** | "Code Context" section in each result card (related files, owners, blast radius) | [EP-30 extension](../epics/ep30-teams-updates-redesign#code-intelligence-extension-requires-ep-43) |
| **PRReviewPage** | Full PR review with blast radius + work context + suggested reviewers | [EP-44](../epics/ep44-pr-intelligence) |
| **TeammatesPage** | Code ownership per teammate via `code_graph` + `git log` | [EP-45](../epics/ep45-teammate-intelligence) |
