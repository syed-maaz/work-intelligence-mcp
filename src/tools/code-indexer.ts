import { Project, SyntaxKind } from 'ts-morph';
import { execSync } from 'child_process';
import { Worker } from 'worker_threads';
import { existsSync, readFileSync } from 'fs';
import { join, relative, resolve, extname } from 'path';
import type Database from 'better-sqlite3';
import type { RepoConfig } from '../services/config.js';

import {
  findFilesByExt,
  findFilesByName,
  findTsConfig,
} from './code-indexer-helpers.js';
import type {
  WorkerMessage,
  WorkerProgress,
  WorkerFullResult,
  WorkerIncrementalResult,
} from './code-indexer-worker.js';

// Resolve the worker entry from dist/ at runtime. Built file lives next
// to the indexer in dist/tools/. The `new URL(...)` form keeps TypeScript
// happy and survives bundling, since import.meta.url is preserved.
const WORKER_ENTRY_URL = new URL('./code-indexer-worker.js', import.meta.url);

/**
 * Progress event surfaced to optional consumers (the SSE route). Same
 * shape as the worker's internal WorkerProgress.
 */
export type IndexProgress = Pick<WorkerProgress, 'filesDone' | 'filesTotal' | 'ratio'>;

export interface IndexProgressOptions {
  /** Receives a progress event roughly every N files. Default N=25. */
  onProgress?: (p: IndexProgress) => void;
}

export interface IndexResult {
  repo: string;
  filesIndexed: number;
  edgesAdded: number;
  durationMs: number;
}

export interface IncrementalIndexResult {
  repo: string;
  filesProcessed: number;
  edgesAdded: number;
  edgesRemoved: number;
  durationMs: number;
  sinceMs: number;
}

export interface CodeEdge {
  repo: string;
  file_path: string;
  symbol: string | null;
  ref_repo: string;
  ref_file: string;
  ref_symbol: string | null;
  ref_type:
    | 'import'
    | 'call'
    | 'type'
    | 'api_call'
    | 'env_var'
    | 'test_covers'
    | 'config_ref'
    | 'docker_base_image'
    | 'helm_chart_dep'
    | 'shell_env_ref';
  line_number: number | null;
}

/**
 * Test-friendly helper that runs the per-file edge extraction against a raw
 * source string. Used by `tests/tools/code-indexer.test.ts` to assert that
 * call/type/api_call edges actually emit — these used to silently produce zero
 * rows even though the schema accepted those ref_type values.
 *
 * The CodeIndexer instance method `extractEdges` delegates to the same logic.
 */
export function extractEdgesFromSource(
  source: string,
  opts: { repoName: string; repoLocalPath: string; relPath: string },
): CodeEdge[] {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  // Mount the file in-memory at the same relative path so import-resolution
  // probes (resolveToRelative-style) still make sense for the test.
  const sf = project.createSourceFile(opts.relPath, source, { overwrite: true });
  return extractEdgesImpl(sf, opts.repoName, opts.repoLocalPath, opts.relPath);
}

export class CodeIndexer {
  private insertEdge: Database.Statement;
  private databasePath: string;

  constructor(private db: Database.Database, private repos: RepoConfig[]) {
    this.insertEdge = db.prepare(`
      INSERT OR REPLACE INTO code_graph
        (repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type, line_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // better-sqlite3 stores the on-disk path on the Database instance as
    // `name`. We capture it so the worker can open its own handle on the
    // same file. WAL is process-wide pragma on the .db file, so a fresh
    // handle inherits journal_mode automatically.
    this.databasePath = (db as Database.Database & { name: string }).name;
  }

  /**
   * Full sweep of one repo. The CPU-heavy ts-morph parsing runs in a
   * worker_threads worker so the bridge's main event loop stays
   * responsive — closes the residual block from the OOM-fix commit
   * (d9ca432). See CLAUDE.md § Bridge MUST never be blocked.
   */
  async indexRepo(repoName: string, opts?: IndexProgressOptions): Promise<IndexResult> {
    const repo = this.repos.find((r) => r.name === repoName);
    if (!repo) throw new Error(`Unknown repo: ${repoName}`);
    if (!existsSync(repo.localPath)) throw new Error(`Repo path not found: ${repo.localPath}`);

    // The worker does the DELETE FROM code_graph WHERE repo=? itself
    // (single writer for this repo's rows during the run). The main
    // thread holds the per-repo lock via web-server.js for serialisation.
    const result = await this.runWorker(
      {
        databasePath: this.databasePath,
        repo: { name: repo.name, localPath: repo.localPath },
        mode: 'full',
      },
      opts,
    );
    if (result.mode !== 'full') {
      // Defensive — should never happen, but TypeScript needs the narrow.
      throw new Error(`indexRepo: expected mode='full', got '${result.mode}'`);
    }
    return {
      repo: result.repo,
      filesIndexed: result.filesIndexed,
      edgesAdded: result.edgesAdded,
      durationMs: result.durationMs,
    };
  }

  async indexChangedFiles(repoName: string): Promise<IndexResult> {
    const start = Date.now();
    const repo = this.repos.find((r) => r.name === repoName);
    if (!repo) throw new Error(`Unknown repo: ${repoName}`);

    let changedFiles: string[] = [];
    try {
      const out = execSync('git diff --name-only HEAD~1', { cwd: repo.localPath, encoding: 'utf8' });
      changedFiles = out.trim().split('\n').filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
    } catch {
      return this.indexRepo(repoName);
    }

    if (changedFiles.length === 0) {
      return { repo: repoName, filesIndexed: 0, edgesAdded: 0, durationMs: Date.now() - start };
    }

    const edges: CodeEdge[] = [];
    const project = new Project({ tsConfigFilePath: findTsConfig(repo.localPath) ?? undefined, skipAddingFilesFromTsConfig: true });

    for (const relFile of changedFiles) {
      const absPath = join(repo.localPath, relFile);
      if (!existsSync(absPath)) continue;
      this.db.prepare('DELETE FROM code_graph WHERE repo = ? AND file_path = ?').run(repoName, relFile);
      const sf = project.addSourceFileAtPath(absPath);
      edges.push(...this.extractEdges(sf, repo, relFile));
      // 2026-06-23 OOM fix: same as scanRepo. `git diff HEAD~1` is usually a
      // small set, but a force-push or large merge could surface a large
      // change-list — keep the AST footprint bounded uniformly.
      project.removeSourceFile(sf);
    }

    const insertAll = this.db.transaction((edgeList: CodeEdge[]) => {
      for (const e of edgeList) {
        this.insertEdge.run(e.repo, e.file_path, e.symbol, e.ref_repo, e.ref_file, e.ref_symbol, e.ref_type, e.line_number);
      }
    });
    insertAll(edges);

    return { repo: repoName, filesIndexed: changedFiles.length, edgesAdded: edges.length, durationMs: Date.now() - start };
  }

  async syncAll(): Promise<IndexResult[]> {
    return Promise.all(this.repos.map((r) => this.indexRepo(r.name)));
  }

  /**
   * Incremental index based on filesystem mtime. Runs in a worker thread
   * for the same reason as `indexRepo` — even an incremental tick can
   * include the entire repo on the first run after rsync (every file's
   * mtime is post-cutover), so the worker is non-negotiable.
   *
   * sync_state checkpoint is written inside the worker (single writer
   * during the run), matching the pre-worker behaviour.
   */
  async indexChangedSince(
    repoName: string,
    sinceMs: number,
    opts?: IndexProgressOptions,
  ): Promise<IncrementalIndexResult> {
    const repo = this.repos.find((r) => r.name === repoName);
    if (!repo) throw new Error(`Unknown repo: ${repoName}`);
    if (!existsSync(repo.localPath)) throw new Error(`Repo path not found: ${repo.localPath}`);

    const result = await this.runWorker(
      {
        databasePath: this.databasePath,
        repo: { name: repo.name, localPath: repo.localPath },
        mode: 'incremental',
        sinceMs,
      },
      opts,
    );
    if (result.mode !== 'incremental') {
      throw new Error(`indexChangedSince: expected mode='incremental', got '${result.mode}'`);
    }
    return {
      repo: result.repo,
      filesProcessed: result.filesProcessed,
      edgesAdded: result.edgesAdded,
      edgesRemoved: result.edgesRemoved,
      durationMs: result.durationMs,
      sinceMs: result.sinceMs,
    };
  }

  /**
   * Spawn the indexer worker, relay progress events to `opts.onProgress`,
   * and resolve with the worker's final WorkerFullResult /
   * WorkerIncrementalResult. Rejects on worker error message, non-zero
   * exit, or premature `exit` without a `result` message.
   *
   * The worker holds its own better-sqlite3 handle on the same .db file
   * — WAL is on, so concurrent main-thread reads (and the agent's
   * /api/status probes) remain unblocked.
   */
  private runWorker(
    mission: {
      databasePath: string;
      repo: { name: string; localPath: string };
      mode: 'full' | 'incremental';
      sinceMs?: number;
    },
    opts?: IndexProgressOptions,
  ): Promise<WorkerFullResult | WorkerIncrementalResult> {
    return new Promise((resolveP, rejectP) => {
      const worker = new Worker(WORKER_ENTRY_URL, {
        workerData: mission,
      });

      let finalResult: WorkerFullResult | WorkerIncrementalResult | null = null;
      let workerError: Error | null = null;

      worker.on('message', (msg: WorkerMessage) => {
        if (msg.type === 'progress') {
          if (opts?.onProgress) {
            try {
              opts.onProgress({ filesDone: msg.filesDone, filesTotal: msg.filesTotal, ratio: msg.ratio });
            } catch {
              // Swallow consumer errors — progress is best-effort. A
              // broken SSE write must not crash the indexer.
            }
          }
          return;
        }
        if (msg.type === 'result') {
          finalResult = msg;
          return;
        }
        if (msg.type === 'error') {
          const err = new Error(msg.message);
          if (msg.stack) err.stack = msg.stack;
          workerError = err;
        }
      });

      worker.on('error', (err) => {
        workerError = err instanceof Error ? err : new Error(String(err));
      });

      worker.on('exit', (code) => {
        if (workerError) return rejectP(workerError);
        if (code !== 0) {
          return rejectP(new Error(`code-indexer-worker exited with code ${code} without a result`));
        }
        if (!finalResult) {
          return rejectP(new Error('code-indexer-worker exited 0 but never sent a result message'));
        }
        resolveP(finalResult);
      });
    });
  }

  private extractEdges(sf: ReturnType<Project['addSourceFileAtPath']>, repo: RepoConfig, relPath: string): CodeEdge[] {
    return extractEdgesImpl(sf, repo.name, repo.localPath, relPath);
  }

  // resolveToRelative was previously a private method; it has been moved to a
  // module-level helper (resolveToRelativeStandalone) so extractEdgesImpl can
  // call it without an instance. No callers remain on the class.

  // findTsFiles / findFilesByExt / findFilesByName / findTsConfig were moved
  // to `./code-indexer-helpers.ts` (2026-06-24, worker-thread migration) so
  // the worker entrypoint can call them without dragging better-sqlite3 into
  // the worker bundle through this module's imports. Behaviour is preserved
  // verbatim; the helpers module is the single source of truth.

  // extractNonTsEdges (full-sweep) and extractNonTsEdgesForFile (per-file)
  // were promoted to module-level exports (2026-06-24, worker-thread migration)
  // — the worker bundles its own non-TS extraction and the test hatch reaches
  // them directly. See extractNonTsEdgesFullSweep / extractNonTsEdgesForFile
  // below. Behaviour preserved verbatim; the SYNC INVARIANT documented on
  // those exports still applies.
}

// ───────────────────────────────────────────────────────────────────────────────
// Non-TS edge extractors — promoted from `CodeIndexer` private methods to
// module-level exports in the 2026-06-24 worker-thread migration. The
// production callers are now (a) the worker entrypoint
// (`code-indexer-worker.ts`, which inlines the same logic for full-sweep
// and per-file paths), and (b) the test hatch `__test_only_nonTs__` below
// which exercises the drift-prevention test for the SYNC INVARIANT.
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Non-TS edge extractor (full-sweep path). Runs three regex passes against
 * repo files:
 *
 *   - Dockerfile         ^FROM <image>          → 'docker_base_image'
 *   - Helm Chart.yaml    deps: - name: <chart>  → 'helm_chart_dep'
 *   - .sh                $VAR / ${VAR}          → 'shell_env_ref' (deduped per-file)
 *
 * Plus the original operations-only YAML/JSON env-var scan (`config_ref`).
 *
 * No tree-sitter, no new npm dep — these are line-anchored literal patterns
 * that don't justify a full parser. Tree-sitter is reserved for nested-DDL
 * languages (SQL) when those files actually land in the repo.
 *
 * SYNC INVARIANT (Phase 73 / ADR-028 F2):
 *   The set of file shapes recognized here MUST match the set recognized by
 *   `extractNonTsEdgesForFile` (the per-file dispatcher). Adding a new shape
 *   here without adding it there silently drops edges on every incremental
 *   tick — those edges only reappear after Sunday's full sweep. The
 *   drift-prevention test in `tests/tools/code-indexer.test.ts` exercises
 *   both dispatchers against a shared fixture array and fails if their
 *   coverage diverges.
 *
 *   Intentional exception: the legacy `config_ref` (operations-only
 *   YAML/JSON env-var scan, last block in this function) is full-sweep-only
 *   by design. It is NOT mirrored on `extractNonTsEdgesForFile` because
 *   the heuristic ($VAR in any YAML/JSON) is too noisy to run per-file
 *   on every changed YAML in the application repo. Do not add it to the per-file
 *   dispatcher.
 *
 *   Lifecycle note (2026-06-24): the production full-sweep caller is the
 *   worker entrypoint (`code-indexer-worker.ts`), which bundles the same
 *   logic. This export remains the source of truth for the drift-prevention
 *   test and provides a single function reference if a future code path
 *   ever wants full-sweep non-TS edges without spawning a worker.
 */
/**
 * Subset of `RepoConfig` actually consumed by the non-TS edge extractors —
 * just `name` (used as `repo.name` in edge rows) and `localPath` (used to
 * walk the filesystem). Carrying the narrow shape lets the worker pass its
 * own `{ name, localPath }` mission without constructing a full RepoConfig.
 */
export type NonTsExtractorRepo = Pick<RepoConfig, 'name' | 'localPath'>;

export function extractNonTsEdgesFullSweep(repo: NonTsExtractorRepo): CodeEdge[] {
  const edges: CodeEdge[] = [];

  // ---- Dockerfile / Helm / shell — run on every repo --------------------
  const dockerFiles = findFilesByName(repo.localPath, [/^Dockerfile(\..+)?$/]);
  for (const absPath of dockerFiles) {
    try {
      const content = readFileSync(absPath, 'utf8');
      const relPath = relative(repo.localPath, absPath);
      edges.push(...extractDockerEdges(content, repo.name, relPath));
    } catch {
      // skip unreadable
    }
  }

  const helmCharts = findFilesByName(repo.localPath, [/^Chart\.ya?ml$/]);
  for (const absPath of helmCharts) {
    try {
      const content = readFileSync(absPath, 'utf8');
      const relPath = relative(repo.localPath, absPath);
      edges.push(...extractHelmChartEdges(content, repo.name, relPath));
    } catch {
      // skip unreadable
    }
  }

  const shellFiles = findFilesByExt(repo.localPath, ['.sh']);
  for (const absPath of shellFiles) {
    try {
      const content = readFileSync(absPath, 'utf8');
      const relPath = relative(repo.localPath, absPath);
      edges.push(...extractShellEnvEdges(content, repo.name, relPath));
    } catch {
      // skip unreadable
    }
  }

  // ---- Legacy operations YAML/JSON env-var scan (config_ref) ------------
  // Kept narrow to operations because the heuristic ($VAR in any YAML/JSON)
  // produces too much noise on a generic application repo.
  if (repo.name === 'operations') {
    const yamlFiles = findFilesByExt(repo.localPath, ['.yaml', '.yml', '.json']);
    const envVarPattern = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;
    for (const absPath of yamlFiles) {
      try {
        const content = readFileSync(absPath, 'utf8');
        const relPath = relative(repo.localPath, absPath);
        let match;
        while ((match = envVarPattern.exec(content)) !== null) {
          const envVar = match[1] || match[2];
          edges.push({
            repo: repo.name,
            file_path: relPath,
            symbol: null,
            ref_repo: repo.name,
            ref_file: '.env',
            ref_symbol: envVar,
            ref_type: 'config_ref',
            line_number: null,
          });
        }
      } catch {
        // skip unreadable
      }
    }
  }

  return edges;
}

/**
 * Per-file non-TS extractor — used by the worker's incremental path and by
 * the test hatch. Dispatches by basename / extension; returns [] for any
 * file that doesn't match a known non-TS shape.
 *
 * SYNC INVARIANT (Phase 73 / ADR-028 F2):
 *   The set of file shapes recognized here MUST match the set recognized by
 *   `extractNonTsEdgesFullSweep` (the full-sweep dispatcher). Adding a new
 *   shape to the full-sweep dispatcher without adding it here means the new
 *   edges only appear after the next Sunday full sweep — incremental ticks
 *   will silently drop them. The drift-prevention test in
 *   `tests/tools/code-indexer.test.ts` covers both dispatchers against a
 *   shared fixture array.
 *
 *   `config_ref` is intentionally absent from this path — see the JSDoc on
 *   `extractNonTsEdgesFullSweep` for why.
 */
export function extractNonTsEdgesForFile(
  repo: NonTsExtractorRepo,
  absPath: string,
  relPath: string,
): CodeEdge[] {
  const baseName = relPath.split(/[\\/]/).pop() ?? '';
  let content: string;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }

  if (/^Dockerfile(\..+)?$/.test(baseName)) {
    return extractDockerEdges(content, repo.name, relPath);
  }
  if (/^Chart\.ya?ml$/.test(baseName)) {
    return extractHelmChartEdges(content, repo.name, relPath);
  }
  if (extname(baseName) === '.sh') {
    return extractShellEnvEdges(content, repo.name, relPath);
  }
  return [];
}

// ───────────────────────────────────────────────────────────────────────────────
// Standalone edge extractor — used by both the class method `extractEdges` and
// the test helper `extractEdgesFromSource`. Decoupled from the SQLite-bound
// class so unit tests can exercise the parsing logic without a DB handle.
// ───────────────────────────────────────────────────────────────────────────────

function resolveToRelativeStandalone(absPath: string, repoRoot: string): string | null {
  const extensions = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
  for (const ext of extensions) {
    const candidate = absPath + ext;
    if (existsSync(candidate)) {
      return relative(repoRoot, candidate);
    }
  }
  return null;
}

export function extractEdgesImpl(
  sf: ReturnType<Project['createSourceFile']>,
  repoName: string,
  repoLocalPath: string,
  relPath: string,
): CodeEdge[] {
  const edges: CodeEdge[] = [];
  const isTest = relPath.includes('.test.') || relPath.includes('.spec.');

  // Imports (and type-only imports → ref_type='type').
  // For tests using in-memory FS, resolveToRelativeStandalone will return null
  // (no on-disk target file). We still emit import/type edges using the raw
  // module specifier as ref_file so the edge isn't dropped.
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (!spec.startsWith('.')) continue; // skip node_modules
    const resolvedAbs = resolve(join(repoLocalPath, relPath, '..'), spec);
    const refFile = resolveToRelativeStandalone(resolvedAbs, repoLocalPath) ?? spec;

    const line = imp.getStartLineNumber();
    const isTypeOnly = imp.isTypeOnly();
    let refType: CodeEdge['ref_type'];
    if (isTest) {
      refType = 'test_covers';
    } else if (isTypeOnly) {
      refType = 'type';
    } else {
      const named = imp.getNamedImports();
      const allTypeOnly = named.length > 0 && named.every((n) => n.isTypeOnly());
      refType = allTypeOnly ? 'type' : 'import';
    }
    edges.push({ repo: repoName, file_path: relPath, symbol: null, ref_repo: repoName, ref_file: refFile, ref_symbol: null, ref_type: refType, line_number: line });
  }

  // Type references — bind imported names to their source module and emit
  // ref_type='type' for cross-file type usage.
  const importedTypeBindings = new Map<string, string>();
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (!spec.startsWith('.')) continue;
    const resolvedAbs = resolve(join(repoLocalPath, relPath, '..'), spec);
    const refFile = resolveToRelativeStandalone(resolvedAbs, repoLocalPath) ?? spec;
    for (const named of imp.getNamedImports()) {
      importedTypeBindings.set(named.getName(), refFile);
      const alias = named.getAliasNode()?.getText();
      if (alias) importedTypeBindings.set(alias, refFile);
    }
    const def = imp.getDefaultImport()?.getText();
    if (def) importedTypeBindings.set(def, refFile);
  }
  if (importedTypeBindings.size > 0) {
    const seenTypeRefs = new Set<string>();
    sf.getDescendantsOfKind(SyntaxKind.TypeReference).forEach((node) => {
      const headText = node.getTypeName().getText().split('.')[0].split('<')[0].trim();
      const refFile = importedTypeBindings.get(headText);
      if (!refFile) return;
      const key = `${refFile}|${headText}`;
      if (seenTypeRefs.has(key)) return;
      seenTypeRefs.add(key);
      edges.push({ repo: repoName, file_path: relPath, symbol: null, ref_repo: repoName, ref_file: refFile, ref_symbol: headText, ref_type: 'type', line_number: node.getStartLineNumber() });
    });
  }

  // process.env.X references
  sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).forEach((node) => {
    const text = node.getText();
    if (text.startsWith('process.env.')) {
      const envVar = text.replace('process.env.', '');
      edges.push({ repo: repoName, file_path: relPath, symbol: null, ref_repo: repoName, ref_file: '.env', ref_symbol: envVar, ref_type: 'env_var', line_number: node.getStartLineNumber() });
    }
  });

  // Call edges + api_call edges.
  const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'request']);
  const NOISY_CALLEES = new Set([
    'log', 'warn', 'error', 'info', 'debug', 'trace',
    'expect', 'describe', 'it', 'test', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
    'push', 'pop', 'shift', 'unshift', 'map', 'filter', 'forEach', 'reduce', 'find', 'some', 'every', 'includes', 'indexOf', 'slice', 'splice', 'join', 'split', 'concat',
    'then', 'catch', 'finally',
    'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Array', 'Object',
    'require',
    // ADR-028 F3 (Phase 73, sample-100 verdict 2026-05-31): vitest matchers
    // dominate test-file call-edge counts; filter at the assertion-name level.
    'toBe', 'toBeUndefined', 'toBeNull', 'toBeTruthy', 'toBeFalsy', 'toBeVisible',
    'toBeInTheDocument', 'toContain', 'toEqual', 'toHaveBeenCalled', 'toHaveBeenCalledWith',
    'toHaveAttribute', 'toBeLessThanOrEqual', 'toBeGreaterThanOrEqual', 'toThrow', 'not',
    // ADR-028 F3: zod schema constructors are non-domain noise — they appear once per
    // schema declaration but never represent a "call" the call-graph-tracer cares about.
    'object', 'array', 'string', 'enum', 'optional', 'union', 'int', 'safeParse',
    // Math.* methods — common in numeric code, low signal as call-edges.
    // Added per ADR-028 audit F-028-1 (2026-05-31). Caveat: a domain
    // function literally named floor() / max() / etc. would also be
    // filtered — collision risk is low (these names are rare in business
    // logic) but real. If a real call site needs to be tracked, the
    // collision can be resolved by renaming the domain function.
    'floor', 'ceil', 'round', 'abs', 'max', 'min', 'sqrt', 'pow', 'random', 'log2', 'log10', 'trunc', 'sign',
  ]);
  const seenCalls = new Set<string>();
  sf.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((node) => {
    const expr = node.getExpression().getText();
    const calleeName = expr.split('.').pop() ?? expr;

    // 'call' edge — coarse-grained, deduped per (file, callee).
    const calleeIsSimple = /^[A-Za-z_$][\w$]*$/.test(calleeName);
    if (calleeIsSimple && !NOISY_CALLEES.has(calleeName)) {
      if (!seenCalls.has(calleeName)) {
        seenCalls.add(calleeName);
        edges.push({ repo: repoName, file_path: relPath, symbol: null, ref_repo: repoName, ref_file: relPath, ref_symbol: calleeName, ref_type: 'call', line_number: node.getStartLineNumber() });
      }
    }

    // 'api_call' edge — broaden beyond literal fetch('/api/...').
    const isFetchLike = expr === 'fetch' || expr.endsWith('.fetch');
    const isHttpVerb = HTTP_VERBS.has(calleeName.toLowerCase()) && expr.includes('.');
    const isAxiosCall = /^axios(\.|$)/.test(expr) || expr === 'axios';
    if (!(isFetchLike || isHttpVerb || isAxiosCall)) return;

    const args = node.getArguments();
    if (args.length === 0) return;
    const firstArg = args[0];
    let urlish: string | null = null;
    const kind = firstArg.getKind();
    if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
      urlish = firstArg.getText().replace(/^['"`]|['"`]$/g, '');
    } else if (kind === SyntaxKind.TemplateExpression) {
      const raw = firstArg.getText();
      const m = raw.match(/(\/[A-Za-z][\w/\-.:]*)/);
      if (m) urlish = m[1];
    } else if (kind === SyntaxKind.ObjectLiteralExpression) {
      const m = firstArg.getText().match(/url\s*:\s*['"`]([^'"`]+)['"`]/);
      if (m) urlish = m[1];
    }
    if (!urlish) return;
    const looksLikeApi =
      urlish.startsWith('/api/') ||
      /^https?:\/\//.test(urlish) ||
      /^\/[A-Za-z][\w/\-.:]+/.test(urlish);
    if (!looksLikeApi) return;

    edges.push({ repo: repoName, file_path: relPath, symbol: null, ref_repo: 'mcp', ref_file: urlish, ref_symbol: null, ref_type: 'api_call', line_number: node.getStartLineNumber() });
  });

  return edges;
}

// ───────────────────────────────────────────────────────────────────────────────
// Non-TS regex extractors (Dockerfile, Helm Chart.yaml, shell). Pure functions —
// take raw file content + identifying metadata, return CodeEdge[]. Exported so
// the test suite can exercise them without a DB or a real repo on disk.
//
// All three regexes are line-anchored against literal patterns; no parser is
// needed for these formats. If a future format requires nested-structure
// reasoning (e.g. SQL DDL), reach for tree-sitter then — not here.
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Extract container-image references from a Dockerfile (FROM lines).
 *
 * ADR-028 v2 F4 (Closed: deferred 2026-05-31): broader Dockerfile
 * pattern expansion (^COPY, ^ENTRYPOINT, ^CMD, ARG defaulting) was
 * scoped out — current FROM-only extraction covers the blast-radius
 * "what container changed" question; multi-pattern would inflate the
 * graph without a consumer pull. See
 * docs/docs/adr/adr-028-defer-tree-sitter.md L395 / V2 OPEN ITEMS box.
 */
export function extractDockerEdges(content: string, repoName: string, relPath: string): CodeEdge[] {
  const edges: CodeEdge[] = [];
  const lines = content.split(/\r?\n/);
  // Anchored at line start (after optional whitespace), case-insensitive FROM,
  // image must contain a recognisable char set — alphanumerics, ./:-_/@ plus
  // tag/digest separators. Stops at whitespace so trailing `AS stage` is dropped.
  const re = /^\s*FROM\s+([\w./:@-]+)/i;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*#/.test(ln)) continue;
    const m = re.exec(ln);
    if (!m) continue;
    const image = m[1];
    edges.push({
      repo: repoName,
      file_path: relPath,
      symbol: null,
      ref_repo: 'docker',
      ref_file: image,
      ref_symbol: null,
      ref_type: 'docker_base_image',
      line_number: i + 1,
    });
  }
  return edges;
}

/**
 * Helm Chart.yaml — emit one 'helm_chart_dep' edge per dependency.
 *
 * The trick here is that `name:` is a common YAML key (chart's own name,
 * maintainer name, etc.). We only want `- name:` lines that appear inside a
 * top-level `dependencies:` block. We track that scope by:
 *   - entering when a line matches `^dependencies:\s*$`
 *   - leaving when we hit another top-level key (column 0 + non-space)
 * Inside the block, lines like `  - name: nginx` (any indent depth ≥ 2) emit
 * an edge.
 */
export function extractHelmChartEdges(content: string, repoName: string, relPath: string): CodeEdge[] {
  const edges: CodeEdge[] = [];
  const lines = content.split(/\r?\n/);
  let inDeps = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^dependencies:\s*$/.test(ln)) {
      inDeps = true;
      continue;
    }
    // Leaving the dependencies block: a new top-level key (no leading space)
    // that isn't blank, comment, or list marker.
    if (inDeps && /^[A-Za-z]/.test(ln)) {
      inDeps = false;
    }
    if (!inDeps) continue;

    const m = /^\s+-\s+name:\s*(\S+)/.exec(ln);
    if (!m) continue;
    const dep = m[1].replace(/^["']|["']$/g, '');
    edges.push({
      repo: repoName,
      file_path: relPath,
      symbol: null,
      ref_repo: 'helm',
      ref_file: dep,
      ref_symbol: null,
      ref_type: 'helm_chart_dep',
      line_number: i + 1,
    });
  }
  return edges;
}

/**
 * Extract shell env-var references from a .sh / .bash file.
 *
 * ADR-028 v2 F4 (Closed: deferred 2026-05-31): cross-file shell glue
 * (`source ./foo.sh`, `. ../helpers.sh`) was scoped out — shell_env_ref
 * already shipped real production value (568 rows at audit time), no
 * consumer has asked for cross-file glue, every new ref_type is
 * maintenance debt. See docs/docs/adr/adr-028-defer-tree-sitter.md L395
 * if you are considering adding it; revisit only when the kill-criteria
 * at L171-186 fire.
 */
export function extractShellEnvEdges(content: string, repoName: string, relPath: string): CodeEdge[] {
  const edges: CodeEdge[] = [];
  // Match either ${NAME} or $NAME (NAME must start with a letter or underscore
  // and be all upper-snake — keeps shell control vars like $? out).
  const re = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*#/.test(ln)) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(ln)) !== null) {
      const name = m[1] || m[2];
      if (seen.has(name)) continue;
      seen.add(name);
      edges.push({
        repo: repoName,
        file_path: relPath,
        symbol: null,
        ref_repo: repoName,
        ref_file: '.env',
        ref_symbol: name,
        ref_type: 'shell_env_ref',
        line_number: i + 1,
      });
    }
  }
  return edges;
}

/**
 * Test-only helper exposing the two non-TS dispatchers — `extractNonTsEdgesFullSweep`
 * (full-sweep) and `extractNonTsEdgesForFile` (incremental per-file) — to
 * `tests/tools/code-indexer.test.ts` so the SYNC INVARIANT documented on
 * those exports can be exercised by the drift-prevention test (Phase 73 /
 * ADR-028 F2).
 *
 * Pre-2026-06-24 the production callers were private methods on the
 * `CodeIndexer` class; that surface is now (a) inlined in the worker
 * entrypoint (`code-indexer-worker.ts`) and (b) exposed as module-level
 * functions above. The test hatch shape is preserved verbatim for the
 * existing test file's import shape; the property names match the original
 * dispatcher names so the SYNC INVARIANT test reads unchanged.
 *
 * Do NOT call this from non-test code.
 */
export const __test_only_nonTs__ = {
  extractNonTsEdges(repo: RepoConfig): CodeEdge[] {
    return extractNonTsEdgesFullSweep(repo);
  },
  extractNonTsEdgesForFile(repo: RepoConfig, absPath: string, relPath: string): CodeEdge[] {
    return extractNonTsEdgesForFile(repo, absPath, relPath);
  },
};
