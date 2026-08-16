/**
 * Local HTTP bridge server for the Work Intelligence Web UI.
 * Wraps the MCP tools in a simple REST API so the Next.js frontend can call them.
 *
 * Run with: node local-server.js
 * Listens on: http://localhost:3132
 */

import { createServer } from 'http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDatabase, closeDatabase } from './dist/db/connection.js';
import { searchMessages, formatSearchResults, getActionItems, formatActionItems, getDailyDigest, configureTopic } from './dist/tools/index.js';
import { getJiraReport } from './dist/tools/jira-report.js';
import { getTeamsUpdates } from './dist/tools/teams-updates.js';
import { searchAll } from './dist/tools/search-all.js';
import { askTopicExpert } from './dist/tools/topic-expert.js';
import { getOrBuildNotebook, listNotebooks, deleteNotebook } from './dist/tools/notebook.js';
import { getTopicSuggestions, dismissTopicSuggestion } from './dist/tools/topic-suggestions.js';
import { generateDailySummary } from './dist/tools/daily-summary.js';
import { getBrowserSession } from './dist/fetcher/sources/browser-session.js';
import { fetchEpicChildren } from './dist/fetcher/sources/jira-adapter.js';
import { AIAnalyzer } from './dist/services/analyzer.js';
import { insertErrorLog, listErrorLogs, markErrorResolved, updateErrorAnalysis, saveDigest, getCachedDigest, listDigests, deleteDigest, upsertCalendarEvent, getUpcomingEvents, getLatestCalendarScrapeTime, saveJiraIssues, loadJiraIssues, getJiraIssuesCachedAt, saveBoardIssues, loadBoardIssues, getNotebook, saveNotebookChatEntry, getNotebookChatHistory, saveJiraAnalysis, loadJiraAnalysis, saveJiraNotes, listFavKeywords, saveFavKeyword, deleteFavKeyword, saveAnnotation, getAnnotation, getCorrections, appendCorrection, insertDataQualityIssue, listDataQualityIssues, resolveDataQualityIssue, startIngestionLog, finishIngestionLog, getPendingReviewItems, confirmActionItem, dismissActionItem, autoPromotePendingItems, getLastTransition, recordTransition, getTopicHealthScores, getWeeklyVelocity, getCycleTime, getCycleTimesForSimilarTickets, getLearning, saveLearning, findSimilarLearnings, getBlastRadius, getTestCoverage, getFileOwners, addTeamMember, markMember, softDeleteMember, getTeamMember, getAllMembers, getMarkedMembers, getMemberProfile, getExpertCandidates } from './dist/db/queries.js';
import { buildAliasesForMember } from './dist/tools/identity-resolver.js';
import { buildOrUpdateMemberProfile } from './dist/tools/profile-builder.js';
import { CodeIndexer } from './dist/tools/code-indexer.js';
import { ConfigManager } from './dist/services/config.js';
import { GitHubMcpClient, splitGithubSlug } from './dist/fetcher/sources/github-mcp-client.js';
// ADR-044 S2.5/S3: connector registry — enabled connectors + capabilities manifest.
import { getEnabledConnectors, getCapabilitiesManifest, getConnectorStatuses } from './dist/services/connector-registry.js';
import { getBridgePort } from './dist/services/wi-config.js';

// Default Jira project for endpoints that accept an optional ?project= param.
const DEFAULT_JIRA_PROJECT = process.env.JIRA_PROJECT_KEY ?? 'PROJ';

function isGitHubMcpConfigured() {
  if (process.env.GITHUB_MCP_TOKEN) return true;
  try {
    const claudeJson = JSON.parse(readFileSync(path.join(process.env.HOME ?? '~', '.claude.json'), 'utf8'));
    const proj = claudeJson.projects?.[process.cwd()];
    return !!(proj?.mcpServers?.['github-tools']?.headers?.Authorization);
  } catch { return false; }
}
import { generateWeeklyReport, generateChatDigest } from './dist/services/analyzer.js';
import { rankContextItems } from './dist/tools/context-ranker.js';
import { exportNotebooksToVault, exportSingleNotebook, countVaultNotes, extractVaultAnnotations, mirrorVaultAnnotationsToMemory } from './dist/tools/obsidian-export.js';
import { indexVault, watchVault } from './dist/services/obsidian/vault-indexer.js';
import { locateMemoryDir } from './dist/routes/persona.js';
import { knowledgeIndexer } from './dist/intelligence/knowledge-indexer.js';
import { extractEntities } from './dist/intelligence/entity-extractor.js';
import { extractLinks } from './dist/services/link-extractor.js';
import { LinkFetcher } from './dist/services/link-fetcher.js';
import { parseTraversalPaths, formatTraversalAsText } from './dist/intelligence/traversal-formatter.js';
import { KNOWLEDGE_TTL_DAYS, resolveHypothesisAccuracy, getBrainStats, getInvestigationSession } from './dist/db/queries/investigation.js';
import { DEFAULT_OWNERSHIP_MAP } from './dist/intelligence/ownership-map.js';
import { ResearchEngine } from './dist/intelligence/research-engine.js';
import { findCachedResearch, saveResearchFinding, saveReferences, indexFindingAsMessage } from './dist/db/queries/research.js';
import { ClaudeCodeRunner, adaptToContextItems, computeInputHash } from './dist/services/claude-code-runner.js';
import { CostGateClassifier } from './dist/intelligence/cost-gate.js';
import { PromptEvolver } from './dist/intelligence/prompt-evolver.js';
import { QualityScorer } from './dist/intelligence/quality-scorer.js';
import { seedTemplatesIfEmpty } from './dist/intelligence/prompt-seeds.js';
import { runOPRO, checkABPromotion, OPRO_SWEEP_TRIGGER_TYPES } from './dist/intelligence/prompt-evolution-jobs.js';
import { getCachedResearch, upsertResearch, getResearchStats, updateOutcomeFeedback, getResearchByQuestion, pruneExpiredResearch } from './dist/db/queries/research-cache.js';
import { enrichKnowledgeFromResearch } from './dist/intelligence/knowledge-enrichment.js';
// REFACTOR-001: extracted route families. Each module exports a RouteHandler[]
// consumed by the dispatcher in the request handler. To extract a new family:
// add the import + entry to EXTRACTED_ROUTES, remove the now-duplicate if-blocks below.
// Status table: src/routes/README.md
import { brainRoutes } from './dist/routes/brain.js';
import { actionItemsRoutes } from './dist/routes/action-items.js';
import { topicsRoutes } from './dist/routes/topics.js';
import { digestRoutes } from './dist/routes/digest.js';
import { prRoutes } from './dist/routes/pr.js';
import { personaRoutes } from './dist/routes/persona.js';
// 78a-04 / Task 3: in-process persona helper + heuristic mode detector.
import { getPersonaForMode } from './dist/routes/persona.js';
import { detectMode } from './dist/services/chat/mode-detect.js';
// 78a-04 / Task 3: mode-scoped recall (CHAT-03).
import { recallMemory as brainRecallMemory } from './dist/services/brain/recall.js';
import { skillsRoutes } from './dist/routes/skills.js';
import { profileRoutes } from './dist/routes/profile.js';
import { systemHealthTokensRoutes } from './dist/routes/system-health-tokens.js';
import { modelConfigRoutes } from './dist/routes/model-config.js';
import { bugsRoutes, captureBug, buildBugsHealthBlock } from './dist/routes/bugs.js';
import { palaceRoutes } from './dist/routes/palace.js';
import { cypherSessionsRoutes } from './dist/routes/cypher-sessions.js';
import { dreamRoutes } from './dist/routes/dream.js';
import { startDreamScheduler } from './dist/services/dream/scheduler.js';
import { nextSunday0317UTC } from './dist/services/code-graph/scheduler.js';
import {
  tryAcquireCodeGraphLock,
  releaseCodeGraphLock,
  isCodeGraphBusy,
  withCodeGraphLock,
  recordCodeGraphBusyRejection,
  getCodeGraphBusyRejections,
} from './dist/services/code-graph/lock.js';
import { withCodeGraphIndexDeadline } from './dist/services/code-graph/deadline.js';
import {
  createTask as tmCreateTask,
  getTask as tmGetTask,
  listTasks as tmListTasks,
  closeTask as tmCloseTask,
  loadTaskContext as tmLoadTaskContext,
  renderTaskContextBlock as tmRenderTaskContextBlock,
  recurateTaskContext as tmRecurateTaskContext,
} from './dist/services/cypher/task-memory.js';
import {
  createProject as pjCreateProject,
  listProjects as pjListProjects,
} from './dist/services/cypher/projects.js';
import { reapBootOrphans } from './dist/services/cypher/boot-reaper.js';
import { loadWiConfig, getJiraMcpClientName, getJiraMcpUrl, getJiraBrowseUrl, getJiraBrowserBaseUrl, getJiraBoardUrl, getGitHubApiBaseUrl, getGitHubMcpUrl, getGitHubCompareUrl, getRepos } from './dist/services/wi-config.js';

const EXTRACTED_ROUTES = [
  ...brainRoutes,
  ...actionItemsRoutes,
  ...topicsRoutes,
  ...digestRoutes,
  ...prRoutes,
  ...personaRoutes,
  ...skillsRoutes,
  ...profileRoutes,
  ...systemHealthTokensRoutes,
  ...modelConfigRoutes,
  ...bugsRoutes,
  ...palaceRoutes,
  ...cypherSessionsRoutes,
  ...dreamRoutes,
];

/**
 * EP-59: Reciprocal Rank Fusion across multiple rank lists.
 * Each list is an array of ContextItems in rank order.
 * Uses k=60 matching embedder.ts hybridSearch().
 * Returns items sorted by fused RRF score, deduplicated by title.
 */
function rrfFuse(rankLists, k = 60) {
  const scores = new Map();    // title -> { score, item }
  for (const list of rankLists) {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const key = item.title || item.content?.slice(0, 80) || String(i);
      const existing = scores.get(key);
      const rrfScore = 1 / (k + i + 1);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(key, { score: rrfScore, item });
      }
    }
  }
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(s => s.item);
}

// ── Embedding lane (post-graphify action plan, step 2) ──────────────────────
// Pure-semantic 5th lane for rrfFuse. Calls embedder.semanticSearch (NO FTS
// prefilter — that's the whole point) and joins back to messages to produce
// ContextItem rows. Never throws; returns [] on any failure.
//
// Module-level cache: probed once at boot via existing checkOllamaAvailable.
// We re-check lazily on first use as a safety net (e.g. if Ollama came up
// after the bridge booted), but the boot probe sets the happy path.
let _embeddingEnabled = null; // null = not yet probed; boolean = cached

async function probeEmbeddingEnabled() {
  try {
    const { checkOllamaAvailable } = await import('./dist/services/embedder.js');
    _embeddingEnabled = await checkOllamaAvailable();
  } catch {
    _embeddingEnabled = false;
  }
  return _embeddingEnabled;
}

async function embeddingsRankList(query, db, limit = 25) {
  // Fast path: if we've already probed and Ollama isn't there, skip.
  if (_embeddingEnabled === false) return [];
  if (_embeddingEnabled === null) {
    // Lazy first-call probe — boot probe normally beats us, but be defensive.
    await probeEmbeddingEnabled();
    if (!_embeddingEnabled) return [];
  }

  try {
    const result = await Promise.race([
      (async () => {
        const { semanticSearch } = await import('./dist/services/embedder.js');
        const hits = await semanticSearch(query, db, limit);
        if (!hits.length) return [];

        // Join back to messages to build ContextItem rows. Per-message granularity
        // (FTS lane aggregates into snippet blocks; the two lanes' titles diverge
        // by design — RRF gives each lane equal voice without consensus boost,
        // which is acceptable per the action plan).
        const ids = hits.map(h => h.message_id);
        const placeholders = ids.map(() => '?').join(',');
        const rows = db.prepare(
          `SELECT id, source, author, subject, content, timestamp
           FROM messages WHERE id IN (${placeholders})`
        ).all(...ids);
        const byId = new Map(rows.map(r => [r.id, r]));

        // Preserve the score-sorted order from semanticSearch.
        const items = [];
        for (const h of hits) {
          const r = byId.get(h.message_id);
          if (!r) continue;
          const subjectLine = r.subject ? `${r.subject}: ` : '';
          items.push({
            source: 'embedding-search',
            // Stable per-message title — used as rrfFuse dedupe key.
            title: `message:${r.id}`,
            content: `[${String(r.source || '').toUpperCase()} – ${r.author || 'unknown'} – ${String(r.timestamp || '').slice(0, 10)}]\n${subjectLine}${String(r.content || '').slice(0, 600)}`,
            timestamp: r.timestamp,
            metadata: { messageId: r.id, similarity: h.score },
          });
        }
        return items;
      })(),
      new Promise(resolve => setTimeout(() => resolve([]), 500)),
    ]);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

const PORT = getBridgePort();

// ── C.1 / A-6: dist/ freshness check ───────────────────────────────────────
// The bridge loads agents and route modules via dynamic `import('./dist/...')`.
// If a developer edits a TS file and forgets `npm run build`, the bridge boots
// with yesterday's code while the smoke + browser say "everything's fine".
// We check a sample TS file against its dist twin at startup. On drift we
// log loudly and (when SKIP_STALE_DIST_CHECK is unset) refuse to start.
(function checkDistFreshness() {
  if (process.env.SKIP_STALE_DIST_CHECK === '1') return;
  // Use a few load-bearing files. If any one of them is older than its source,
  // the build is stale. We don't walk the whole tree — that's slow.
  const samples = [
    ['src/services/brain/decision-engine.ts', 'dist/services/brain/decision-engine.js'],
    ['src/services/brain/budget.ts',          'dist/services/brain/budget.js'],
    ['src/routes/brain.ts',                   'dist/routes/brain.js'],
    ['src/services/orchestrator-agent.ts',    'dist/services/orchestrator-agent.js'],
    ['src/intelligence/cost-gate.ts',         'dist/intelligence/cost-gate.js'],
  ];
  const stale = [];
  for (const [tsPath, jsPath] of samples) {
    try {
      const tsStat = fs.statSync(tsPath);
      let jsStat;
      try { jsStat = fs.statSync(jsPath); }
      catch { stale.push({ src: tsPath, dist: jsPath, reason: 'missing dist file' }); continue; }
      if (tsStat.mtimeMs > jsStat.mtimeMs + 1000) {
        stale.push({
          src: tsPath, dist: jsPath,
          reason: `src ${Math.round((tsStat.mtimeMs - jsStat.mtimeMs) / 1000)}s newer`,
        });
      }
    } catch {
      // tsPath missing — repo layout drift, ignore
    }
  }
  if (stale.length > 0) {
    process.stderr.write('\n[freshness] dist/ is OLDER than src/ — bridge would run stale code:\n');
    for (const s of stale) process.stderr.write(`  • ${s.src} — ${s.reason}\n`);
    process.stderr.write(`\n  Run: npm run build\n  (or set SKIP_STALE_DIST_CHECK=1 to bypass)\n\n`);
    process.exit(1);
  }
})();

const db = getDatabase();

// ── Phase 79-5b: register cosine_similarity() SQLite UDF ──────────────────
// Must run after getDatabase() so the UDF is available to all recall queries.
try {
  const { registerCosineUDF } = await import('./dist/services/brain/cosine-udf.js');
  registerCosineUDF(db);
} catch (cosineUdfErr) {
  process.stderr.write(`[boot] cosine UDF registration failed (non-fatal): ${cosineUdfErr?.message?.slice(0, 120) ?? 'unknown'}\n`);
}

// ── ADR-038 v2.5 D7: bridge-boot snapshot reaper ──────────────────────────
// On startup, any cypher_sessions row left in status='pending' with a
// surviving dispatch_snapshots row is a dispatch that crashed mid-loop
// (bridge SIGKILL, jetsam, OOM, ungraceful exit). We mark it as
// halted/mixed with outcome_note='bridge_restart_during_dispatch' and
// delete the snapshot. This slice does NOT resume the loop — dispatches
// that didn't reach their outcome write are halted, not retried.
// Future slices may upgrade safe postures (read-only, tier-1-only) to
// true resume from messages_blob. See src/services/cypher/boot-reaper.ts.
try {
  const reap = reapBootOrphans(db);
  if (reap.orphans_found > 0) {
    process.stderr.write(
      `[boot-reaper] reaped ${reap.orphans_found} orphan dispatch(es) ` +
      `(${reap.snapshots_deleted} snapshot(s) deleted): ${reap.session_ids.join(', ')}\n`
    );
  }
} catch (reapErr) {
  // Reaper failure must never block bridge startup — it's a hygiene
  // pass, not a correctness gate.
  process.stderr.write(
    `[boot-reaper] failed (non-fatal): ${(reapErr && reapErr.message) || reapErr}\n`
  );
}

// ── ADR-030 Phase A: global error capture ──────────────────────────────────
// Every uncaught exception and unhandled rejection in this Node process is
// captured to the `bugs` table via captureBug(). Best-effort: a failure here
// must NEVER crash the bridge (or we infinite-loop). All work is wrapped in
// try/catch that swallows secondary errors silently — the original failure
// is what matters.
//
// We override Node's default uncaughtException-causes-exit behaviour because
// the bug-capture loop is more useful than a crashed bridge. If the failure
// is fatal enough that recovery is impossible, the next request will surface
// it via a 5xx and a fresh capture row.
function captureToInternalEndpoint(source, err, ctx) {
  try {
    captureBug(db, {
      source,
      errorName: err?.name || 'UnknownError',
      message: String(err?.message || err || 'no message'),
      stack: err?.stack || null,
      context: ctx || null,
    });
  } catch (innerErr) {
    process.stderr.write(`[Bugs] capture failed: ${innerErr?.message || innerErr}\n`);
  }
}

process.on('uncaughtException', (err) => {
  process.stderr.write(`[Bugs] uncaughtException: ${err?.message || err}\n`);
  captureToInternalEndpoint('bridge', err, { phase: 'uncaughtException' });
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  process.stderr.write(`[Bugs] unhandledRejection: ${err.message}\n`);
  captureToInternalEndpoint('bridge', err, { phase: 'unhandledRejection' });
});

// ADR-030 Phase A item #6: kill-switch env vars. Read at boot, log one line.
// Phase A doesn't gate any code on these — Phase B will gate the
// BugInvestigatorAgent registration on BUG_INVESTIGATOR_ENABLED, and Phase D
// will gate the auto-merge path on BUG_AUTO_MERGE. The vars are read here so
// future phases lean on the contract without a CLAUDE.md update.
const BUG_INVESTIGATOR_ENABLED = process.env.BUG_INVESTIGATOR_ENABLED !== '0';
const BUG_AUTO_MERGE = process.env.BUG_AUTO_MERGE === '1';
// ADR-030 Phase C — BUG_RESOLVER_ENABLED defaults to '0' (opt-in). When '1',
// the BugResolverAgent registers and POST /api/bugs/:id/resolve-attempt
// works; otherwise the route returns 400 'resolver_disabled'.
const BUG_RESOLVER_ENABLED = process.env.BUG_RESOLVER_ENABLED === '1';
process.stderr.write(
  `[Bugs] config: BUG_INVESTIGATOR_ENABLED=${BUG_INVESTIGATOR_ENABLED ? '1' : '0'} ` +
    `BUG_AUTO_MERGE=${BUG_AUTO_MERGE ? '1' : '0'} ` +
    `BUG_RESOLVER_ENABLED=${BUG_RESOLVER_ENABLED ? '1' : '0'}\n`,
);

// ADR-032 Phase 80 wave 77a-01 — Persona memory loop kill switches. All
// default OFF; flipped to 1 in `.env` only after the corresponding wave's
// smoke + MINJA red-team smoke (§ 21) pass. PERSONA_MEMORY_TIER0_ENABLED
// gates the Tier-0 parser run-on-boot (this file). PERSONA_MEMORY_INGEST_ENABLED
// gates 77a-04's pr_review_comments backfill. Other flags introduced in
// later waves. Vertical slice 77a-01 ships with everything off by default —
// the parser never writes to palace until the user opts in.
const PERSONA_MEMORY_TIER0_ENABLED = process.env.PERSONA_MEMORY_TIER0_ENABLED === '1';
const PERSONA_MEMORY_INGEST_ENABLED = process.env.PERSONA_MEMORY_INGEST_ENABLED === '1';
process.stderr.write(
  `[Persona] config: PERSONA_MEMORY_TIER0_ENABLED=${PERSONA_MEMORY_TIER0_ENABLED ? '1' : '0'} ` +
    `PERSONA_MEMORY_INGEST_ENABLED=${PERSONA_MEMORY_INGEST_ENABLED ? '1' : '0'}\n`,
);

loadWiConfig(); // idempotent — load wi.config.json at startup

const SATURN_LIST_NAME = process.env.JIRA_LIST_NAME ?? 'saturn'; // config-driven via wi.config.json (jira.defaultList)
const MY_ISSUES_LIST_NAME = 'my_issues';

const REPOS = getRepos();
const PRIMARY_REPO_PATH = REPOS[0]?.localPath ?? (process.env.REPO_PATH ? process.env.REPO_PATH : null);
const PRIMARY_REPO_NAME = REPOS[0]?.name ?? 'workspace';
const OPERATIONS_PATH = REPOS.find(r => r.name === 'operations')?.localPath ?? (process.env.OPERATIONS_PATH ? process.env.OPERATIONS_PATH : null);

// Phase 55 — knowledge indexer startup (fire-and-forget, non-blocking)
if (PRIMARY_REPO_PATH) {
  const { KnowledgeIndexer } = await import('./dist/intelligence/knowledge-indexer.js');
  const _startupIndexer = new KnowledgeIndexer(db, PRIMARY_REPO_PATH);
  _startupIndexer.indexAll().then(r => process.stderr.write(`[knowledge] indexed=${r.indexed} skipped=${r.skipped}\n`)).catch(err => process.stderr.write(`[knowledge] indexAll error: ${err.message}\n`));
}

// ── EP-67: Claude Code Research Engine initialization ──────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ALL_REPOS = [PRIMARY_REPO_PATH, OPERATIONS_PATH, '.'].filter(p => p && fs.existsSync(p));
const claudeCodeRunner = new ClaudeCodeRunner(2);
// REDUNDANCY-001: was `new CostGateClassifier(ANTHROPIC_KEY)` — Haiku LLM call.
// Now a deterministic budget check against brain_user_budget_ledger. No API key needed.
const costGate = new CostGateClassifier(db);
const promptEvolver = new PromptEvolver(db);
const qualityScorer = ANTHROPIC_KEY ? new QualityScorer(ANTHROPIC_KEY, db) : null;
seedTemplatesIfEmpty(db);

// ── EP-40-2: Stale-on-error fallback for read-only AI endpoints ──────────
// When an AI call fails (network/rate-limit/overload), return the last cached
// version with { stale: true, stale_reason: 'ai_error' } instead of HTTP 500.
// Only applied to read-only endpoints. Write operations must still fail explicitly.
async function withStaleFallback(freshFn, getCached, label) {
  try {
    const data = await freshFn();
    return { data, stale: false };
  } catch (err) {
    console.error(`[${label}] AI call failed, attempting stale fallback:`, err.message);
    const cached = getCached();
    if (cached) {
      return { data: cached, stale: true, stale_reason: 'ai_error' };
    }
    throw err; // no cache available — propagate
  }
}

// ── Jira browser mutexes — one fetch at a time per list (EP-20/21) ──────
// The BrowserSessionManager is a singleton. Running two JiraBrowserConnector
// fetches concurrently on the same session causes page-closed errors.
// Saturn and My Issues each have their own chain so they don't block each other.

// EP-48-4: check gh CLI availability once at startup
let ghAvailable = false;
try { execFileSync('gh', ['--version'], { stdio: 'pipe' }); ghAvailable = true; } catch { /* gh not installed */ }
let _saturnFetchChain = Promise.resolve();
function withSaturnLock(fn) {
  const next = _saturnFetchChain.then(fn).catch(() => {});
  _saturnFetchChain = next;
  return next;
}

let _myIssuesFetchChain = Promise.resolve();
function withMyIssuesLock(fn) {
  const next = _myIssuesFetchChain.then(fn).catch(() => {});
  _myIssuesFetchChain = next;
  return next;
}

let _teamsFetchChain = Promise.resolve();
function withTeamsLock(fn) {
  const next = _teamsFetchChain.then(fn).catch(() => {});
  _teamsFetchChain = next;
  return next;
}

// EP-48-1: Epic children browser fallback also uses the same singleton browser session.
// Serialize via a dedicated chain so concurrent expand-clicks can't crash the session.
let _epicChildrenFetchChain = Promise.resolve();
function withEpicChildrenLock(fn) {
  const next = _epicChildrenFetchChain.then(fn).catch((err) => { throw err; });
  _epicChildrenFetchChain = next.catch(() => {}); // keep chain healthy even if fn rejects
  return next;
}

// EP-48 GAP-1: Linked issues browser fallback — same singleton session, serialized.
let _linkedIssuesFetchChain = Promise.resolve();
function withLinkedIssuesLock(fn) {
  const next = _linkedIssuesFetchChain.then(fn).catch((err) => { throw err; });
  _linkedIssuesFetchChain = next.catch(() => {});
  return next;
}

// ── Calendar TTL (EP-51-0) ─────────────────────────────────────
const CALENDAR_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Saturn Board cache (EP-20) ──────────────────────────────────
const SATURN_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFETCH_TIMEOUT_MS = 120_000; // 2 minutes — stuck isRefreshing guard (EP-49-8)
const saturnCache = { data: [], fetchedAt: 0, isRefreshing: false, lastFailedAt: 0, refreshStartedAt: 0, dataSource: 'unknown' };

// GAP-2: per-key in-flight guard for POST /api/jira/analyze
const analyzeInProgress = new Set();

// Option 4 of the updateNotebook cost-reduction plan (2026-06-23):
// Gate background notebook refreshes behind a minimum interval. The original
// behaviour fired getOrBuildNotebook for every topic on every 15-min sync
// cycle plus every targeted Teams sync, which forced a Sonnet call any time
// even ONE new chatter message arrived. After Option 3 each call costs
// ~$0.02 instead of ~$0.08, so this gate is now a wedge on top of that —
// halving the call frequency at the worst case roughly halves the residual.
//
// User-facing requests (GET /api/notebooks/:topicName) are NOT gated —
// they always refresh on demand so the Topic Expert page never feels stale.
//
// Override via env: NOTEBOOK_REFRESH_INTERVAL_MS (default 60 min, 0 disables
// the gate entirely — useful for tests and the old behaviour).
// See .planning/updatenotebook-cost-reduction/01-...md § 7 Option 4.
const NOTEBOOK_REFRESH_INTERVAL_MS = Number(process.env.NOTEBOOK_REFRESH_INTERVAL_MS ?? 60 * 60_000);
const lastNotebookRefresh = new Map();  // topicName → epoch ms

function shouldRefreshNotebook(topicName) {
  if (NOTEBOOK_REFRESH_INTERVAL_MS <= 0) return true;  // gate disabled
  const last = lastNotebookRefresh.get(topicName) ?? 0;
  return Date.now() - last >= NOTEBOOK_REFRESH_INTERVAL_MS;
}

function markNotebookRefreshed(topicName) {
  lastNotebookRefresh.set(topicName, Date.now());
}

/**
 * ADR-038 v2.5 D17 — build the result_meta envelope for v2.5 callers.
 *
 * Returns the v2.5 contract shape:
 *   {
 *     outcome, cypher_session_id, taskId?, worktree_path?,
 *     self_assessment?, suspended_dispatch_id?, surface_tier_used?,
 *     contract_version: '2.5'
 *   }
 *
 * Only fields the underlying engine actually surfaced are included.
 * `cypher_session_id` is always present (every dispatch creates a row).
 * `contract_version: '2.5'` is always echoed so the client can detect
 * whether it got the upgraded shape.
 */
function buildResultMeta(result, body) {
  const meta = {
    cypher_session_id: result && result.session_id ? result.session_id : '',
    contract_version: '2.5',
  };
  if (result && result.outcome) meta.outcome = result.outcome;
  // taskId — preserved from request, since the engine doesn't yet
  // round-trip it on the response (D2 substrate stores it on
  // cypher_sessions.task_id; future slice could read it back).
  if (body && body.taskId) meta.taskId = String(body.taskId);
  // surface_tier_used — echo from request for now; D10 will populate
  // it from the actual surface tier the engine chose.
  if (body && (body.surface_tier === 0 || body.surface_tier === 1 || body.surface_tier === 2 || body.surface_tier === 3)) {
    meta.surface_tier_used = body.surface_tier;
  }
  // worktree_path — D4 will populate this from the per-task worktree.
  // For now, surfaces only when the engine attaches it to result.
  if (result && result.worktree_path) meta.worktree_path = String(result.worktree_path);
  // self_assessment — D8 wire-up persists self_assess_at_entry on
  // cypher_sessions; expose verbatim when present on the result.
  if (result && result.self_assessment) meta.self_assessment = result.self_assessment;
  // suspended_dispatch_id — D7 durability; pass through when present.
  if (result && result.suspended_dispatch_id) meta.suspended_dispatch_id = String(result.suspended_dispatch_id);
  return meta;
}

function warmSaturnCacheFromDB() {
  try {
    const rows = loadJiraIssues(db, SATURN_LIST_NAME);
    if (rows.length > 0) {
      saturnCache.data = rows.map(r => ({
        key: r.key, title: r.title, status: r.status,
        assignee: r.assignee, priority: r.priority,
        epicKey: r.epic_key ?? null, epicName: r.epic_name ?? null,
        updatedAt: r.updated_at, url: r.url,
      }));
      const cachedAt = getJiraIssuesCachedAt(db, SATURN_LIST_NAME);
      // Use the DB scraped_at for display, but reset the in-process age to now
      // so DB-warmed data isn't immediately re-fetched on startup.
      saturnCache.dbCachedAt = cachedAt ?? null;
      saturnCache.fetchedAt = Date.now();
      process.stderr.write(`[Saturn] Warmed from DB: ${rows.length} issues\n`);
    }
  } catch (err) {
    process.stderr.write('[Saturn] DB warm failed: ' + err.message + '\n');
  }
}

async function refreshSaturnCache() {
  // EP-49-8: if stuck for >2 min, force-reset before bailing
  if (saturnCache.isRefreshing) {
    if (Date.now() - saturnCache.refreshStartedAt > REFETCH_TIMEOUT_MS) {
      process.stderr.write('[Saturn] isRefreshing stuck — force resetting\n');
      saturnCache.isRefreshing = false;
      saturnCache.lastFailedAt = Date.now();
    } else {
      return; // genuinely in-flight
    }
  }
  saturnCache.isRefreshing = true;
  saturnCache.refreshStartedAt = Date.now();
  await withSaturnLock(async () => {
    try {
      const session = getBrowserSession();
      const { getSaturnIssues } = await import('./dist/tools/saturn-board.js');
      saturnCache.data = await getSaturnIssues(session);
      saturnCache.fetchedAt = Date.now();
      saturnCache.dataSource = 'browser';
      // Persist to DB
      saveJiraIssues(db, SATURN_LIST_NAME, saturnCache.data.map(i => ({
        key: i.key, title: i.title, status: i.status,
        assignee: i.assignee ?? null, priority: i.priority ?? null,
        epic_key: i.epicKey ?? null, epic_name: i.epicName ?? null,
        updated_at: i.updatedAt, url: i.url,
      })));
      // Detect status transitions (EP-42-2)
      for (const issue of saturnCache.data) {
        try {
          const projectKey = issue.key.split('-')[0] ?? 'UNKNOWN';
          const last = getLastTransition(db, issue.key);
          if (last?.to_status !== issue.status) {
            recordTransition(db, issue.key, projectKey, last?.to_status ?? null, issue.status);
          }
        } catch { /* non-fatal */ }
      }
      process.stderr.write(`[Saturn] Saved ${saturnCache.data.length} issues to DB\n`);
    } catch (err) {
      saturnCache.lastFailedAt = Date.now();
      process.stderr.write('[Saturn] Cache refresh failed: ' + err.message + '\n');
    } finally {
      saturnCache.isRefreshing = false; // always reset (EP-49-8)
    }
  });
}

// ── My Issues cache (EP-21) ────────────────────────────────────
const MY_ISSUES_TTL_MS = 60 * 60 * 1000; // 1 hour
const MY_ISSUES_URL = getJiraBoardUrl() || 'https://jira.example.com/issues/?filter=-1'; // config-driven via wi.config.json (jira.boardUrl)
const myIssuesCache = { data: [], fetchedAt: 0, authExpired: false, isRefreshing: false, lastFailedAt: 0, refreshStartedAt: 0 };

function warmMyIssuesCacheFromDB() {
  try {
    const rows = loadJiraIssues(db, MY_ISSUES_LIST_NAME);
    if (rows.length > 0) {
      myIssuesCache.data = rows.map(r => ({
        key: r.key, title: r.title, status: r.status,
        assignee: r.assignee, priority: r.priority,
        epicKey: r.epic_key ?? null, epicName: r.epic_name ?? null,
        updatedAt: r.updated_at, url: r.url,
      }));
      const cachedAt = getJiraIssuesCachedAt(db, MY_ISSUES_LIST_NAME);
      myIssuesCache.dbCachedAt = cachedAt ?? null;
      myIssuesCache.fetchedAt = Date.now();
      process.stderr.write(`[MyIssues] Warmed from DB: ${rows.length} issues\n`);
    }
  } catch (err) {
    process.stderr.write('[MyIssues] DB warm failed: ' + err.message + '\n');
  }
}

async function refreshMyIssuesCache() {
  // EP-49-8: if stuck for >2 min, force-reset before bailing
  if (myIssuesCache.isRefreshing) {
    if (Date.now() - myIssuesCache.refreshStartedAt > REFETCH_TIMEOUT_MS) {
      process.stderr.write('[MyIssues] isRefreshing stuck — force resetting\n');
      myIssuesCache.isRefreshing = false;
      myIssuesCache.lastFailedAt = Date.now();
    } else {
      return; // genuinely in-flight
    }
  }
  myIssuesCache.isRefreshing = true;
  myIssuesCache.refreshStartedAt = Date.now();
  await withMyIssuesLock(async () => {
    try {
      const session = getBrowserSession();
      const { createJiraDataSource } = await import('./dist/fetcher/sources/jira-adapter.js');
      const connector = createJiraDataSource(session);
      const messages = await connector.fetchMessages({ boardUrl: MY_ISSUES_URL });
      myIssuesCache.data = messages
        .filter(m => m.metadata?.jira)
        .map(m => {
          const jira = m.metadata.jira;
          const key = jira.issueKey ?? m.id;
          return {
            key,
            title: (m.subject ?? m.content.slice(0, 80)).replace(/^\[[\w-]+\]\s*/, ''),
            status: jira.status ?? 'Unknown',
            assignee: jira.assignee?.name ?? null,
            priority: jira.priority ?? null,
            epicKey: jira.epicKey ?? null,
            epicName: jira.epicName ?? null,
            updatedAt: (m.modifiedAt ?? m.createdAt).toISOString(),
            url: getJiraBrowseUrl(key),
          };
        });
      myIssuesCache.fetchedAt = Date.now();
      myIssuesCache.authExpired = false;
      // Persist to DB
      saveJiraIssues(db, MY_ISSUES_LIST_NAME, myIssuesCache.data.map(i => ({
        key: i.key, title: i.title, status: i.status,
        assignee: i.assignee ?? null, priority: i.priority ?? null,
        epic_key: i.epicKey ?? null, epic_name: i.epicName ?? null,
        updated_at: i.updatedAt, url: i.url,
      })));
      // Detect status transitions (EP-42-2)
      for (const issue of myIssuesCache.data) {
        try {
          const projectKey = issue.key.split('-')[0] ?? 'UNKNOWN';
          const last = getLastTransition(db, issue.key);
          if (last?.to_status !== issue.status) {
            recordTransition(db, issue.key, projectKey, last?.to_status ?? null, issue.status);
          }
        } catch { /* non-fatal */ }
      }
      process.stderr.write(`[MyIssues] Saved ${myIssuesCache.data.length} issues to DB\n`);
    } catch (err) {
      myIssuesCache.lastFailedAt = Date.now();
      if (err.message?.includes('Authentication')) {
        myIssuesCache.authExpired = true;
      }
      process.stderr.write('[MyIssues] Cache refresh failed: ' + err.message + '\n');
    } finally {
      myIssuesCache.isRefreshing = false;
    }
  });
}

// ── EP-50: Per-tab Jira board cache ──────────────────────────
const boardCache = {
  mine:   { data: null, cachedAt: null, isRefreshing: false, refreshStartedAt: null, lastFailedAt: null },
  sprint: { data: null, cachedAt: null, isRefreshing: false, refreshStartedAt: null, lastFailedAt: null },
  all:    { data: null, cachedAt: null, isRefreshing: false, refreshStartedAt: null, lastFailedAt: null },
};
const BOARD_TTL = { mine: 5 * 60 * 1000, sprint: 10 * 60 * 1000, all: 30 * 60 * 1000 };
const BOARD_REFRESH_TIMEOUT = 2 * 60 * 1000; // 2-min safety reset

// In-memory sprint meta after first successful open-sprint fetch
let sprintMeta = null; // { name, start, end, total }

// ── Calendar cache (EP-25) ────────────────────────────────────

// EP-51-1: extract meeting context from DB — pure SQL, no AI, used by /api/calendar/events/:id/context
function buildMeetingContext(db, event) {
  let attendees = [];
  try { attendees = JSON.parse(event.attendees || '[]'); } catch { attendees = []; }

  // Resolve member IDs + collect all alias strings via member_aliases (EP-45)
  const allAliasNames = attendees.flatMap(a => {
    const rows = db.prepare(
      `SELECT DISTINCT ma.alias FROM member_aliases ma
       WHERE lower(ma.alias) = lower(?) OR (? IS NOT NULL AND lower(ma.alias) LIKE lower(?))`
    ).all(a.name, a.email ?? null, a.email ? `%${a.email}%` : null);
    return [a.name, ...(a.email ? [a.email] : []), ...rows.map(r => r.alias)];
  });

  // FTS query from title keywords (≥4 chars, no stop words)
  const STOP_WORDS = new Set(['with','that','this','from','have','been','will','your','about','what','when','where','they','their','into','more','some','also','than','then','each','which','there','would','could']);
  const keywords = (event.title || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
    .slice(0, 8);

  // Recent messages: FTS search by attendee name (quoted phrase) OR title keywords, last 30 days before meeting
  let recentMessages = [];
  const startMs = event.start_time ? new Date(event.start_time).getTime() : NaN;
  const cutoff = !isNaN(startMs)
    ? new Date(startMs - 30 * 24 * 3600 * 1000).toISOString()
    : new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const attendeeTerms = attendees.map(a => `"${a.name.replace(/"/g, '')}"`);
  const ftsTerms = [...attendeeTerms, ...keywords.map(k => `"${k}"`)];
  if (ftsTerms.length > 0) {
    const ftsQuery = ftsTerms.join(' OR ');
    try {
      recentMessages = db.prepare(
        `SELECT m.id, m.subject, m.content, m.author, m.source, m.timestamp
         FROM messages_fts mf JOIN messages m ON mf.rowid = m.id
         WHERE mf MATCH ? AND m.timestamp >= ?
         ORDER BY bm25(messages_fts) LIMIT 10`
      ).all(ftsQuery, cutoff);
    } catch { recentMessages = []; }
  }

  // Past meetings: chat_name or title contains attendee first name
  const firstNames = attendees.map(a => a.name.split(' ')[0]).filter(n => n.length >= 3);
  let pastMeetings = [];
  if (firstNames.length > 0) {
    const placeholders = firstNames.map(() => 'chat_name LIKE ? OR title LIKE ?').join(' OR ');
    const params = firstNames.flatMap(n => [`%${n}%`, `%${n}%`]);
    pastMeetings = db.prepare(
      `SELECT id, chat_name, title, date, summary, decisions FROM meetings
       WHERE ${placeholders}
       ORDER BY date DESC LIMIT 5`
    ).all(...params);
  }

  // Open action items: filter in SQL using alias list
  let openActionItems = [];
  if (allAliasNames.length > 0) {
    const aPlaceholders = allAliasNames.map(() => 'lower(assignee) LIKE ?').join(' OR ');
    const aParams = allAliasNames.map(n => `%${n.toLowerCase()}%`);
    openActionItems = db.prepare(
      `SELECT id, title, assignee, due_date, status FROM action_items
       WHERE status != 'completed' AND (${aPlaceholders})
       ORDER BY CASE WHEN due_date < date('now') THEN 0 ELSE 1 END, due_date ASC NULLS LAST
       LIMIT 10`
    ).all(...aParams);
  }

  // Jira tickets: assignee matches any attendee name
  let jiraTickets = [];
  if (allAliasNames.length > 0) {
    const jPlaceholders = allAliasNames.map(() => 'lower(assignee) LIKE ?').join(' OR ');
    const jParams = allAliasNames.map(n => `%${n.toLowerCase()}%`);
    jiraTickets = db.prepare(
      `SELECT issue_key, summary, status, assignee FROM jira_issues
       WHERE status != 'Done' AND (${jPlaceholders})
       ORDER BY updated_at DESC LIMIT 8`
    ).all(...jParams);
  }

  return { attendees, recentMessages, pastMeetings, openActionItems, jiraTickets };
}

async function scrapeAndSaveCalendar() {
  let nativeSaved = 0;
  let emailSaved = 0;

  // 1. macOS Calendar.app (Exchange-synced Outlook calendar)
  try {
    const { MacCalendarConnector } = await import('./dist/fetcher/sources/mac-calendar.js');
    const connector = new MacCalendarConnector();
    const events = connector.fetchUpcoming(14);
    for (const ev of events) {
      upsertCalendarEvent(db, {
        source_id: ev.sourceId,
        title: ev.title,
        start_time: ev.startTime,
        end_time: ev.endTime ?? null,
        location: ev.location,
        organizer: null,
        attendees: '[]',
        body: ev.description,
        is_all_day: ev.isAllDay ? 1 : 0,
        response_status: ev.responseStatus,
      });
    }
    nativeSaved = events.length;
  } catch (err) {
    process.stderr.write('[Calendar] macOS sync failed: ' + err.message + '\n');
  }

  // 2. Extract meeting invites from emails/Teams messages (AI-powered)
  if (analyzer) {
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const rows = db.prepare(`
        SELECT id, source, content, author, timestamp, subject, metadata
        FROM messages
        WHERE timestamp >= ? AND (source = 'email' OR source = 'teams')
        ORDER BY timestamp DESC LIMIT 100
      `).all(since);

      const msgs = rows.map(r => ({
        id: String(r.id),
        source: r.source,
        content: r.content,
        author: r.author,
        timestamp: new Date(r.timestamp),
        metadata: r.subject ? { subject: r.subject } : undefined,
      }));

      const { createHash } = await import('node:crypto');
      const extracted = await analyzer.extractCalendarFromMessages(msgs);
      for (const ev of extracted) {
        if (!ev.startTime) continue;
        const sourceId = 'email-' + createHash('sha256')
          .update(ev.title + ev.startTime.slice(0, 16))
          .digest('hex').slice(0, 14);
        upsertCalendarEvent(db, {
          source_id: sourceId,
          title: ev.title,
          start_time: ev.startTime,
          end_time: ev.endTime ?? null,
          location: ev.location,
          organizer: null,
          attendees: '[]',
          body: ev.description,
          is_all_day: ev.isAllDay ? 1 : 0,
          response_status: null,
        });
        emailSaved++;
      }
    } catch (err) {
      process.stderr.write('[Calendar] Email extract failed: ' + err.message + '\n');
    }
  }

  process.stderr.write(`[Calendar] Synced: ${nativeSaved} native + ${emailSaved} from messages\n`);
}

// ── Teams sync helpers (mirrors src/scripts/teams-sync.ts) ────────────────

function upsertGroupChatLocal(db, name, lastMessageAt, isActiveOrUnread) {
  const lastMessageAtISO = (lastMessageAt && !isNaN(new Date(lastMessageAt).getTime()))
    ? new Date(lastMessageAt).toISOString() : null;
  const isActive = isActiveOrUnread ? 1 : 0;
  const existing = db.prepare('SELECT id FROM group_chats WHERE name = ?').get(name);
  if (existing) {
    db.prepare(`
      UPDATE group_chats SET
        last_message_at = COALESCE(?, last_message_at),
        is_active = ?,
        last_scraped_at = datetime('now'),
        inactive_since = CASE WHEN ? = 0 AND inactive_since IS NULL THEN datetime('now') WHEN ? = 1 THEN NULL ELSE inactive_since END
      WHERE id = ?
    `).run(lastMessageAtISO, isActive, isActive, isActive, existing.id);
    return existing.id;
  }
  const result = db.prepare(`
    INSERT INTO group_chats (name, last_message_at, is_active, last_scraped_at, message_count)
    VALUES (?, ?, ?, datetime('now'), 0)
  `).run(name, lastMessageAtISO, isActive);
  return result.lastInsertRowid;
}

// Cache of topic configs for Teams routing (rebuilt when topics change)
let _topicConfigCache = null;
function getTopicConfigCache(db) {
  if (_topicConfigCache) return _topicConfigCache;
  const rows = db.prepare('SELECT id, name, config FROM topics WHERE config IS NOT NULL').all();
  _topicConfigCache = rows.map(r => {
    try { return { id: r.id, name: r.name, config: JSON.parse(r.config) }; } catch { return null; }
  }).filter(Boolean);
  return _topicConfigCache;
}

// Find which configured topics a Teams chat belongs to based on chat name keywords
// A topic matches if: chat name contains any word from the topic name (≥3 chars),
// or the topic's jira.projects list has a keyword appearing in the chat name.
function findTopicsForChat(db, chatName) {
  const configs = getTopicConfigCache(db);
  const chatLower = chatName.toLowerCase();
  const matched = [];
  for (const t of configs) {
    // Skip the generic 'teams' catch-all
    if (t.name === 'teams') continue;
    // Check topic name words
    const nameWords = t.name.toLowerCase().split(/[\s_-]+/).filter(w => w.length >= 3);
    if (nameWords.some(w => chatLower.includes(w))) { matched.push(t.id); continue; }
    // Check jira project keys
    const jiraProjects = t.config?.jira?.projects ?? [];
    if (jiraProjects.some(p => chatLower.includes(p.toLowerCase()))) { matched.push(t.id); }
  }
  return matched;
}

function upsertMessageLocal(db, msg) {
  db.prepare(`INSERT OR IGNORE INTO topics (name, created_at) VALUES ('teams', datetime('now'))`).run();
  const topicRow = db.prepare('SELECT id FROM topics WHERE name = ?').get('teams');
  const msgData = [
    topicRow.id, msg.sourceId, `[Teams] ${msg.chatName}`,
    msg.bodyText, msg.senderName, new Date(msg.createdAt).toISOString(),
    JSON.stringify({ chatName: msg.chatName, html: msg.bodyHtml }),
  ];
  db.prepare(`
    INSERT OR IGNORE INTO messages (topic_id, source, source_id, subject, content, author, timestamp, raw_data)
    VALUES (?, 'teams', ?, ?, ?, ?, ?, ?)
  `).run(...msgData);

  // Also route to matching configured topics (e.g. KBA chat → KBA topic)
  const extraTopicIds = findTopicsForChat(db, msg.chatName);
  for (const tid of extraTopicIds) {
    // Use a variant source_id to avoid conflict with the 'teams' topic row
    const variantId = msg.sourceId + '_t' + tid;
    db.prepare(`
      INSERT OR IGNORE INTO messages (topic_id, source, source_id, subject, content, author, timestamp, raw_data)
      VALUES (?, 'teams', ?, ?, ?, ?, ?, ?)
    `).run(tid, variantId, `[Teams] ${msg.chatName}`,
      msg.bodyText, msg.senderName, new Date(msg.createdAt).toISOString(),
      JSON.stringify({ chatName: msg.chatName, html: msg.bodyHtml }));
  }

  db.prepare('UPDATE group_chats SET message_count = (SELECT COUNT(*) FROM messages WHERE source = \'teams\' AND subject = ?) WHERE name = ?')
    .run(`[Teams] ${msg.chatName}`, msg.chatName);
}

function upsertMeetingLocal(db, meeting) {
  db.prepare(`INSERT OR IGNORE INTO topics (name, created_at) VALUES ('teams', datetime('now'))`).run();
  const topicRow = db.prepare('SELECT id FROM topics WHERE name = ?').get('teams');
  db.prepare(`
    INSERT OR IGNORE INTO meetings
      (topic_id, title, date, attendees, notes, decisions, transcript, topics, summary, chat_name, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    topicRow.id, meeting.title, new Date(meeting.date).toISOString(),
    JSON.stringify(meeting.attendees ?? []), meeting.notes ?? '',
    JSON.stringify(meeting.decisions ?? []), meeting.transcriptText ?? '',
    JSON.stringify(meeting.topics ?? []), meeting.summary ?? '',
    meeting.chatName, meeting.sourceId,
  );
}

// ── EP-16-3: Since-last-update helper ─────────────────────────────────────
/**
 * Returns the earliest last_synced_at across all topics for a given source.
 * Using the minimum ensures no topic is left behind on a targeted sync.
 * Falls back to `fallbackDays` days ago if never synced.
 */
function getLastSyncTime(source, fallbackDays = 7) {
  try {
    const row = db.prepare(
      `SELECT MIN(last_synced_at) as oldest FROM sync_state WHERE source = ?`
    ).get(source);
    if (!row?.oldest) return new Date(Date.now() - fallbackDays * 24 * 60 * 60 * 1000);
    return new Date(row.oldest);
  } catch {
    return new Date(Date.now() - fallbackDays * 24 * 60 * 60 * 1000);
  }
}

// ── EP-15-2: Alert feed ────────────────────────────────────────────────────
let alertCache = { alerts: [], generatedAt: null };

function generateAlerts() {
  try {
    const alerts = [];
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();

    // Rule 1: overdue action items
    try {
      const overdue = db.prepare(
        `SELECT title, assignee, topic_id FROM action_items
         WHERE status != 'completed' AND due_date < ? LIMIT 20`
      ).all(today);
      if (overdue.length > 0) {
        alerts.push({
          id: `overdue-${today}`,
          type: 'overdue', severity: 'critical',
          title: `${overdue.length} overdue action item${overdue.length > 1 ? 's' : ''}`,
          body: overdue.slice(0, 3).map(a => a.title).join(', ') + (overdue.length > 3 ? '…' : ''),
          link: '/action-items',
          generatedAt: now.toISOString(),
        });
      }
    } catch { /* skip */ }

    // Rule 2: stale open items (open > 3 days, no due date)
    try {
      const stale = db.prepare(
        `SELECT ai.title FROM action_items ai
         LEFT JOIN messages m ON ai.source_message_id = m.id
         WHERE ai.status = 'open' AND ai.due_date IS NULL
           AND (m.timestamp < datetime('now', '-3 days') OR m.timestamp IS NULL)
         LIMIT 10`
      ).all();
      if (stale.length > 0) {
        alerts.push({
          id: `stale-${today}`,
          type: 'stale_item', severity: 'warning',
          title: `${stale.length} action item${stale.length > 1 ? 's' : ''} stale for 3+ days`,
          body: stale.slice(0, 2).map(a => a.title).join(', ') + (stale.length > 2 ? '…' : ''),
          link: '/action-items',
          generatedAt: now.toISOString(),
        });
      }
    } catch { /* skip */ }

    // Rule 3: high-activity topics
    try {
      const topics = db.prepare(`SELECT id, name FROM topics`).all();
      for (const topic of topics) {
        const last24h = db.prepare(
          `SELECT COUNT(*) as cnt FROM messages
           WHERE topic_id = ? AND timestamp >= datetime('now', '-1 day')`
        ).get(topic.id)?.cnt ?? 0;
        const avg7d = db.prepare(
          `SELECT COUNT(*) / 7.0 as avg FROM messages
           WHERE topic_id = ? AND timestamp >= datetime('now', '-7 days')`
        ).get(topic.id)?.avg ?? 0;
        if (avg7d > 2 && last24h > avg7d * 2) {
          alerts.push({
            id: `activity-${topic.name}-${today}`,
            type: 'high_activity', severity: 'warning',
            title: `High activity in ${topic.name}`,
            body: `${last24h} messages today vs ${Math.round(avg7d)} daily average`,
            topic: topic.name,
            link: '/teams-updates',
            generatedAt: now.toISOString(),
          });
        }
      }
    } catch { /* skip */ }

    // Rule 4: meetings in next 60 min
    try {
      const soon = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      const upcoming = db.prepare(
        `SELECT title, start_time FROM calendar_events
         WHERE start_time > ? AND start_time <= ?
         ORDER BY start_time ASC LIMIT 3`
      ).all(now.toISOString(), soon);
      for (const ev of upcoming) {
        const minsAway = Math.round((new Date(ev.start_time) - now) / 60000);
        alerts.push({
          id: `meeting-${ev.start_time}`,
          type: 'meeting_soon', severity: 'info',
          title: `Meeting in ${minsAway} min: ${ev.title}`,
          body: 'Pre-brief available in Topic Expert',
          link: '/topic-expert',
          generatedAt: now.toISOString(),
        });
      }
    } catch { /* skip */ }

    // Rule 5: past meetings with no transcript stored
    try {
      // Find calendar events that ended in the last 7 days
      const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const pastEvents = db.prepare(
        `SELECT id, title, end_time FROM calendar_events
         WHERE end_time IS NOT NULL
           AND end_time < ? AND end_time >= ?
         ORDER BY end_time DESC`
      ).all(now.toISOString(), cutoff);

      const missingTranscripts = [];
      for (const ev of pastEvents) {
        // Look for a meetings row whose chat_name or title fuzzy-matches the calendar event title
        // Use a simple keyword overlap: take the first 3 meaningful words of the event title
        const keywords = ev.title
          .replace(/[^\w\s]/g, '')
          .split(/\s+/)
          .filter(w => w.length > 3)
          .slice(0, 3);
        if (keywords.length === 0) continue;

        const likePattern = `%${keywords[0]}%`;
        const existing = db.prepare(
          `SELECT id FROM meetings
           WHERE (chat_name LIKE ? OR title LIKE ?)
             AND transcript IS NOT NULL AND length(transcript) > 100
           LIMIT 1`
        ).get(likePattern, likePattern);

        if (!existing) {
          missingTranscripts.push(ev.title);
        }
      }

      if (missingTranscripts.length > 0) {
        const sample = missingTranscripts.slice(0, 2).join(', ');
        const ctaMsg = `I have ${missingTranscripts.length} meeting${missingTranscripts.length > 1 ? 's' : ''} with missing transcripts: ${missingTranscripts.slice(0, 3).join(', ')}. Can you help me summarize what I might have missed?`;
        alerts.push({
          id: `missing-transcript-${today}`,
          type: 'missing_transcript', severity: 'warning',
          title: `${missingTranscripts.length} meeting${missingTranscripts.length > 1 ? 's' : ''} missing transcript`,
          body: sample + (missingTranscripts.length > 2 ? `… +${missingTranscripts.length - 2} more` : ''),
          link: '/teams-updates',
          cta: ctaMsg,
          generatedAt: now.toISOString(),
        });
      }
    } catch { /* skip */ }

    // Sort: critical first, then warning, then info
    const order = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    alertCache = { alerts, generatedAt: now.toISOString() };
  } catch (err) {
    process.stderr.write('[Alerts] generateAlerts failed: ' + err.message + '\n');
  }
}

// ── EP-15-3: Workload intensity ────────────────────────────────────────────
let workloadCache = { topics: [], generatedAt: null };

function generateWorkload() {
  try {
    const topics = db.prepare(`SELECT id, name FROM topics`).all();
    const result = [];
    for (const topic of topics) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const msgsThisWeek = db.prepare(
          `SELECT COUNT(*) as cnt FROM messages WHERE topic_id = ? AND timestamp >= datetime('now', '-7 days')`
        ).get(topic.id)?.cnt ?? 0;
        const msgsLastWeek = db.prepare(
          `SELECT COUNT(*) as cnt FROM messages WHERE topic_id = ? AND timestamp >= datetime('now', '-14 days') AND timestamp < datetime('now', '-7 days')`
        ).get(topic.id)?.cnt ?? 0;
        const openActionItems = db.prepare(
          `SELECT COUNT(*) as cnt FROM action_items WHERE topic_id = ? AND status != 'completed'`
        ).get(topic.id)?.cnt ?? 0;
        const overdueItems = db.prepare(
          `SELECT COUNT(*) as cnt FROM action_items WHERE topic_id = ? AND status != 'completed' AND due_date < ?`
        ).get(topic.id, today)?.cnt ?? 0;

        // Jira opened/closed this sprint (approximate: last 14 days)
        const jiraOpened = db.prepare(
          `SELECT COUNT(*) as cnt FROM messages WHERE topic_id = ? AND source = 'jira' AND timestamp >= datetime('now', '-14 days')`
        ).get(topic.id)?.cnt ?? 0;
        const jiraClosed = 0; // TODO: track resolved tickets separately

        const lastWeekBaseline = Math.max(msgsLastWeek, 1);
        const trend = msgsThisWeek > lastWeekBaseline * 1.2
          ? 'up'
          : msgsThisWeek < lastWeekBaseline * 0.8
          ? 'down'
          : 'steady';

        // Intensity score
        const score = (msgsThisWeek / Math.max(msgsLastWeek, 1))
          + (jiraOpened / Math.max(jiraClosed, 1))
          + (overdueItems * 2);
        const intensity = score > 3 ? 'intense' : score > 1.5 ? 'active' : 'calm';

        result.push({
          name: topic.name,
          messagesThisWeek: msgsThisWeek,
          messagesLastWeek: msgsLastWeek,
          messageTrend: trend,
          openActionItems,
          overdueItems,
          intensity,
          intensityScore: Math.round(score * 100) / 100,
        });
      } catch { /* skip this topic */ }
    }
    workloadCache = { topics: result, generatedAt: new Date().toISOString() };
  } catch (err) {
    process.stderr.write('[Workload] generateWorkload failed: ' + err.message + '\n');
  }
}

// ── EP-16-3: Targeted sync functions (event-driven, from last_synced_at) ──

async function runTargetedTeamsSync() {
  if (!process.env.BROWSER_PROFILE_PATH) return;
  const since = getLastSyncTime('teams');
  const sinceDays = Math.max(1, Math.min(
    Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000)),
    90
  ));
  process.stderr.write(`[TriggeredSync] Teams — fetching since ${since.toISOString().slice(0, 16)} (${sinceDays}d)\n`);
  try {
    const { TeamsChatScraper } = await import('./dist/fetcher/sources/teams-chats.js');
    const { TeamsMeetingsScraper } = await import('./dist/fetcher/sources/teams-meetings.js');
    const session = getBrowserSession();
    const chatScraper = new TeamsChatScraper(session);
    const meetingScraper = new TeamsMeetingsScraper(session, anthropicApiKey, db);
    const chats = await chatScraper.scrapeChats({
      unreadOnly: true,
      sinceDays,
      maxMessagesPerChat: 200,
      maxChats: 30,
      meetingScraper,
    });
    const topicsUpdated = new Set();
    let totalMessages = 0;
    for (const chat of chats) {
      const isActive = chat.lastMessageAt &&
        new Date(chat.lastMessageAt) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      upsertGroupChatLocal(db, chat.name, chat.lastMessageAt, isActive || chat.isUnread);
      db.transaction(() => {
        for (const msg of chat.messages) {
          const topicRow = db.prepare('SELECT id FROM topics WHERE name = ?').get('teams');
          if (topicRow) topicsUpdated.add(topicRow.id);
          upsertMessageLocal(db, msg);
          totalMessages++;
        }
      })();
      if (chat.meeting) upsertMeetingLocal(db, chat.meeting);
    }
    // Update sync_state
    const now = new Date().toISOString();
    const topics = db.prepare('SELECT id FROM topics').all();
    for (const t of topics) {
      db.prepare(`
        INSERT INTO sync_state (topic_id, source, last_synced_at, last_message_count)
        VALUES (?, 'teams', ?, ?)
        ON CONFLICT(topic_id, source) DO UPDATE SET
          last_synced_at = excluded.last_synced_at,
          last_message_count = excluded.last_message_count
      `).run(String(t.id), now, totalMessages);
    }
    // Update notebooks for affected topics (Option 4: gated on cadence)
    if (analyzer) {
      for (const topicId of topicsUpdated) {
        const t = db.prepare('SELECT name FROM topics WHERE id = ?').get(topicId);
        if (!t) continue;
        if (!shouldRefreshNotebook(t.name)) continue;
        await getOrBuildNotebook(db, t.name, analyzer).then(
          () => markNotebookRefreshed(t.name),
          () => {},
        );
      }
    }
    process.stderr.write(`[TriggeredSync] Teams done — ${chats.length} chats, ${totalMessages} msgs\n`);
  } catch (err) {
    process.stderr.write(`[TriggeredSync] Teams failed: ${err.message}\n`);
  }
}

async function runTargetedJiraSync(projectKeys = []) {
  const since = getLastSyncTime('jira');
  const boardUrl = process.env.JIRA_BOARD_URL;
  process.stderr.write(
    `[TriggeredSync] Jira — invalidating cache, re-fetching since ${since.toISOString().slice(0, 16)}` +
    (projectKeys.length ? ` | keys: ${projectKeys.join(', ')}` : '') + '\n'
  );
  // Invalidate in-memory caches — next request re-fetches from Jira
  saturnCache.fetchedAt = 0;
  myIssuesCache.fetchedAt = 0;
  // Eagerly re-fetch so data is ready before next page load
  await Promise.allSettled([
    refreshSaturnCache().catch(() => {}),
    refreshMyIssuesCache().catch(() => {}),
  ]);
  // Backfill messages table (same as runJiraSync) so targeted sync also populates FTS
  if (boardUrl) {
    try {
      const { upsertMessage } = await import('./dist/db/queries/messages.js');
      db.prepare(`INSERT OR IGNORE INTO topics (name, created_at) VALUES ('jira', datetime('now'))`).run();
      const topicId = db.prepare('SELECT id FROM topics WHERE name = ?').get('jira').id;
      const session = getBrowserSession();
      const { createJiraDataSource } = await import('./dist/fetcher/sources/jira-adapter.js');
      const { fetchOneSource } = await import('./dist/fetcher/orchestrator.js');
      const jira = createJiraDataSource(session);
      const { envelope, messages } = await fetchOneSource({
        source: 'jira',
        fetch: () => jira.fetchMessages({ boardUrl }, since),
        release: () => session.releaseBySource('jira'),
        timeoutMs: 90_000,
      });
      let persisted = 0;
      if (envelope.status === 'ok') {
        for (const m of messages) {
          try {
            upsertMessage(db, {
              topic_id: topicId,
              source: m.source,
              source_id: m.id,
              subject: m.subject || null,
              content: m.content ?? '',
              author: m.sender?.name || m.sender?.email || m.sender?.id || 'unknown',
              timestamp: (m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt)).toISOString(),
              metadata: m.metadata ? JSON.stringify(m.metadata) : null,
              raw_data: null,
            });
            persisted++;
          } catch (err) {
            process.stderr.write(`[TriggeredSync] Jira skipping row: ${err.message}\n`);
          }
        }
      }
      process.stderr.write(
        `[TriggeredSync] Jira messages: status=${envelope.status} fetched=${messages.length} persisted=${persisted}\n`,
      );
    } catch (err) {
      process.stderr.write(`[TriggeredSync] Jira messages backfill failed: ${err.message}\n`);
    }
  }
  // Update jira sync_state timestamp
  const now = new Date().toISOString();
  updateSyncStateForSource('jira', now, 0);
  process.stderr.write(`[TriggeredSync] Jira done\n`);
}

async function runTargetedCalendarSync() {
  const since = getLastSyncTime('calendar', 1);
  process.stderr.write(`[TriggeredSync] Calendar — since ${since.toISOString().slice(0, 16)}\n`);
  await scrapeAndSaveCalendar();
  process.stderr.write(`[TriggeredSync] Calendar done\n`);
}

async function runTeamsSync() {
  if (!process.env.BROWSER_PROFILE_PATH) {
    process.stderr.write('[TeamsSync] Skipped — BROWSER_PROFILE_PATH not set\n');
    return;
  }
  try {
    const { TeamsChatScraper } = await import('./dist/fetcher/sources/teams-chats.js');
    const { TeamsMeetingsScraper } = await import('./dist/fetcher/sources/teams-meetings.js');
    const session = getBrowserSession();
    const meetingScraper = new TeamsMeetingsScraper(session, anthropicApiKey, db);
    const chatScraper = new TeamsChatScraper(session);
    const since = getLastSyncTime('teams');
    const sinceDays = Math.max(1, Math.min(
      Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000)),
      90
    ));
    const chats = await chatScraper.scrapeChats({
      unreadOnly: true,
      sinceDays,
      maxMessagesPerChat: 200,
      maxChats: 30,
      meetingScraper,
    });
    let totalMessages = 0;
    let totalMeetings = 0;
    for (const chat of chats) {
      const isActive = chat.lastMessageAt && new Date(chat.lastMessageAt) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      upsertGroupChatLocal(db, chat.name, chat.lastMessageAt, isActive || chat.isUnread);
      db.transaction(() => {
        for (const msg of chat.messages) { upsertMessageLocal(db, msg); }
      })();
      totalMessages += chat.messages.length;
      if (chat.meeting) { upsertMeetingLocal(db, chat.meeting); totalMeetings++; }
    }
    // Update sync_state for teams source after successful sync
    const now = new Date().toISOString();
    const topics = db.prepare('SELECT id FROM topics').all();
    for (const t of topics) {
      db.prepare(`
        INSERT INTO sync_state (topic_id, source, last_synced_at, last_message_count)
        VALUES (?, 'teams', ?, ?)
        ON CONFLICT(topic_id, source) DO UPDATE SET
          last_synced_at = excluded.last_synced_at,
          last_message_count = excluded.last_message_count
      `).run(String(t.id), now, totalMessages);
    }
    process.stderr.write(`[TeamsSync] Done | Chats: ${chats.length} | Messages: ${totalMessages} | Meetings: ${totalMeetings} | Since: ${since.toISOString().slice(0,10)}\n`);
  } catch (err) {
    process.stderr.write('[TeamsSync] Sync failed: ' + err.message + '\n');
  }
}

// ── EP-52-3: Auto-capture transcript for a completed calendar event ────────
async function captureTranscriptForEvent(event) {
  if (!process.env.BROWSER_PROFILE_PATH) return;
  try {
    const { TeamsChatScraper } = await import('./dist/fetcher/sources/teams-chats.js');
    const { TeamsMeetingsScraper } = await import('./dist/fetcher/sources/teams-meetings.js');
    const session = getBrowserSession();
    const meetingScraper = new TeamsMeetingsScraper(session, anthropicApiKey, db);
    const chatScraper = new TeamsChatScraper(session);

    const chat = await withTeamsLock(() =>
      chatScraper.scrapeSpecificChat(event.title, meetingScraper, 1)
    );

    if (!chat?.meeting) {
      process.stderr.write(`[AutoCapture] No recap found for "${event.title}"\n`);
      return;
    }

    // Upsert meeting with auto_captured=1
    db.prepare(`INSERT OR IGNORE INTO topics (name, created_at) VALUES ('teams', datetime('now'))`).run();
    const topicRow = db.prepare('SELECT id FROM topics WHERE name = ?').get('teams');
    db.prepare(`
      INSERT INTO meetings
        (topic_id, title, date, attendees, notes, decisions, transcript, topics, summary, chat_name, source_id, auto_captured)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(source_id) DO UPDATE SET
        transcript = excluded.transcript,
        summary = excluded.summary,
        decisions = excluded.decisions,
        auto_captured = 1
    `).run(
      topicRow.id,
      chat.meeting.title,
      new Date(chat.meeting.date).toISOString(),
      JSON.stringify(chat.meeting.attendees ?? []),
      chat.meeting.notes ?? '',
      JSON.stringify(chat.meeting.decisions ?? []),
      chat.meeting.transcriptText ?? '',
      JSON.stringify(chat.meeting.topics ?? []),
      chat.meeting.summary ?? '',
      chat.meeting.chatName,
      chat.meeting.sourceId,
    );

    process.stderr.write(`[AutoCapture] Saved meeting for "${event.title}"\n`);

    // Dedup-safe action item upsert via content_hash
    if (Array.isArray(chat.meeting.actionItems)) {
      const meetingRow = db.prepare('SELECT id FROM meetings WHERE source_id = ?').get(chat.meeting.sourceId);
      if (meetingRow) {
        for (const item of chat.meeting.actionItems) {
          const contentHash = require('crypto')
            .createHash('sha256')
            .update(`${meetingRow.id}|${item.title ?? item}`)
            .digest('hex')
            .slice(0, 16);
          db.prepare(`
            INSERT OR IGNORE INTO action_items
              (topic_id, title, assignee, status, source, content_hash)
            VALUES (?, ?, ?, 'open', 'meeting', ?)
          `).run(topicRow.id, item.title ?? String(item), item.assignee ?? null, contentHash);
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[AutoCapture] Error for "${event.title}": ${err.message}\n`);
  }
}

// ── EP-52-3: Check recently ended meetings for missing transcripts ─────────
async function checkEndedMeetings() {
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const events = db.prepare(`
    SELECT ce.id, ce.title, ce.end_time
    FROM calendar_events ce
    WHERE ce.end_time BETWEEN ? AND ?
      AND ce.is_all_day = 0
      AND NOT EXISTS (
        SELECT 1 FROM meetings m
        WHERE m.title LIKE '%' || substr(ce.title, 1, 20) || '%'
           OR m.chat_name LIKE '%' || substr(ce.title, 1, 20) || '%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM data_quality dq
        WHERE dq.detail = 'auto-capture-attempted:' || ce.id
      )
  `).all(threeHoursAgo, now);

  for (const event of events) {
    // Mark as attempted first (exact match guard)
    db.prepare(`
      INSERT OR IGNORE INTO data_quality (source, detail, severity, created_at)
      VALUES ('calendar', ?, 'info', datetime('now'))
    `).run('auto-capture-attempted:' + event.id);

    process.stderr.write(`[AutoCapture] Checking ended meeting: "${event.title}" (id=${event.id})\n`);
    await captureTranscriptForEvent(event);
  }
}

// ── Sync All progress (EP-22) ──────────────────────────────────
const syncProgress = {
  running: false,
  currentTopic: null,
  completedTopics: [],
  startedAt: null,
  completedAt: null,
  error: null,
};

// ── EP-16-4: Watcher state (exposed in /api/sync/status) ───────
const watcherState = {
  outlookEnabled: false,
  teamsEnabled: false,
  lastOutlookCheck: null,
  lastTeamsCheck: null,
  lastTriggerAt: null,
  lastTriggerReason: null,
  triggerCount: 0,
};

// ── EP-53: Chat activity rollup — pure SQL, no AI, runs after every Teams sync ──

const JIRA_KEY_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/g;
const MY_USERNAME = (process.env.JIRA_MY_USERNAME ?? '').toLowerCase();
/** Brain cache_key + recall user — prefer JIRA_MY_USERNAME so past decisions match. */
const BRAIN_USER = (process.env.JIRA_MY_USERNAME ?? '').trim() || 'anon:ui';

function recomputeChatActivity(db) {
  if (process.env.CHAT_ACTIVITY !== '1') return;
  try {
    // Pull all Teams messages grouped by (chat_name, date)
    const rows = db.prepare(`
      SELECT
        REPLACE(subject, '[Teams] ', '') AS chat_name,
        substr(timestamp, 1, 10)         AS date,
        COUNT(*)                         AS message_count,
        COUNT(DISTINCT author)           AS unique_authors,
        GROUP_CONCAT(content, ' || ')    AS all_content
      FROM messages
      WHERE source = 'teams' AND subject IS NOT NULL
      GROUP BY chat_name, date
    `).all();

    const upsert = db.prepare(`
      INSERT INTO chat_activity (chat_name, date, message_count, unique_authors, jira_links, mentions_me)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_name, date) DO UPDATE SET
        message_count  = excluded.message_count,
        unique_authors = excluded.unique_authors,
        jira_links     = excluded.jira_links,
        mentions_me    = excluded.mentions_me
    `);

    const upsertMany = db.transaction((rows) => {
      for (const row of rows) {
        const text = row.all_content ?? '';
        const jiraKeys = [...new Set([...text.matchAll(JIRA_KEY_RE)].map(m => m[1]))];
        const mentionsMe = MY_USERNAME
          ? text.toLowerCase().includes(MY_USERNAME) ? 1 : 0
          : 0;
        upsert.run(
          row.chat_name,
          row.date,
          row.message_count,
          row.unique_authors,
          JSON.stringify(jiraKeys),
          mentionsMe
        );
      }
    });

    upsertMany(rows);

    // Also update group_chats.jira_links with all-time Jira keys per chat
    const chatJiraLinks = db.prepare(`
      SELECT
        REPLACE(subject, '[Teams] ', '') AS chat_name,
        GROUP_CONCAT(content, ' || ')    AS all_content
      FROM messages
      WHERE source = 'teams' AND subject IS NOT NULL
      GROUP BY chat_name
    `).all();

    const updateChatLinks = db.prepare(`
      UPDATE group_chats SET jira_links = ? WHERE name = ?
    `);
    const updateLinks = db.transaction((rows) => {
      for (const row of rows) {
        const text = row.all_content ?? '';
        const jiraKeys = [...new Set([...text.matchAll(JIRA_KEY_RE)].map(m => m[1]))];
        updateChatLinks.run(JSON.stringify(jiraKeys), row.chat_name);
      }
    });
    updateLinks(chatJiraLinks);

    process.stderr.write(`[ChatActivity] Recomputed activity for ${rows.length} chat-day rows\n`);
  } catch (err) {
    process.stderr.write(`[ChatActivity] Error: ${err.message}\n`);
  }
}

// Per-topic timeout wrapper — prevents one stuck connector from freezing the
// entire sync pipeline (e.g. Teams Playwright session hanging on auth wall).
// Default budgets are generous; override per call as needed.
async function withSyncTimeout(label, promiseFn, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(promiseFn),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`[${label}] timed out after ${Math.round(timeoutMs / 1000)}s`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ADR-044 S2.5 — background Email fetch (the outcome slice, cures AC-U1).
// Runs the real OutlookBrowserConnector through the fetcher orchestrator's
// fetchOneSource so a per-source timeout CANCELS the scrape and RELEASES the
// browser pool slot (session.releaseBySource('email')) rather than leaking it
// over repeated 15-min sync cycles (ADR-044 § Cancellation, re-audit #8).
// Persists via upsertMessage (dedup on source,source_id) into a resolved
// 'email' topic — email lands in `messages` from background sync alone, with
// NO manual /search-all call.
async function runEmailSync() {
  const session = getBrowserSession();
  const { OutlookBrowserConnector } = await import('./dist/fetcher/sources/outlook-browser.js');
  const { fetchOneSource } = await import('./dist/fetcher/orchestrator.js');
  const { upsertMessage } = await import('./dist/db/queries/messages.js');

  const connector = new OutlookBrowserConnector(session);
  // Resolve (create-if-missing) the email topic — never hardcode topic_id 0.
  db.prepare(`INSERT OR IGNORE INTO topics (name, created_at) VALUES ('email', datetime('now'))`).run();
  const topicId = db.prepare('SELECT id FROM topics WHERE name = ?').get('email').id;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const { envelope, messages } = await fetchOneSource({
    source: 'email',
    // The connector honors the signal at its per-email loop boundary; the slot
    // is force-freed by the release() below on timeout.
    fetch: (signal) => connector.fetchMessages({ folder: 'inbox' }, since, signal),
    release: () => session.releaseBySource('email'),
    timeoutMs: 90_000,
  });

  let persisted = 0;
  if (envelope.status === 'ok') {
    for (const m of messages) {
      try {
        upsertMessage(db, {
          topic_id: topicId,
          source: m.source,
          source_id: m.id,
          subject: m.subject || null,
          content: m.content ?? '',
          author: m.sender?.name || m.sender?.email || m.sender?.id || 'unknown',
          timestamp: (m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt)).toISOString(),
          metadata: m.metadata ? JSON.stringify(m.metadata) : null,
          raw_data: null,
        });
        persisted++;
      } catch (err) {
        process.stderr.write(`[Email] Skipping row: ${err.message}\n`);
      }
    }
  }
  process.stderr.write(
    `[Email] status=${envelope.status} fetched=${messages.length} persisted=${persisted} in ${envelope.durationMs}ms\n`,
  );

  // ADR-044 S2.6 — persist the fetch telemetry envelope (always: ok/timed_out/
  // error) so a silent failure is queryable via /api/sync/telemetry, and route
  // any non-ok outcome to /bugs so it can't fail silently the way Jira did.
  await recordFetchTelemetry({
    source: 'email',
    status: envelope.status,
    count: persisted,
    durationMs: envelope.durationMs,
    note: envelope.note ?? null,
    trigger: 'sync',
  });

  // Update sync_state for email source after successful sync
  const emailNow = new Date().toISOString();
  updateSyncStateForSource('email', emailNow, persisted);

  // Surface a timeout/error as a throw so runFullSync's try/catch records it as
  // 'Email:skipped' — matching the Teams/Calendar contract.
  if (envelope.status !== 'ok') {
    throw new Error(`[Email] ${envelope.status}${envelope.note ? ` (${envelope.note})` : ''}`);
  }
}

// ── Shared sync_state writer ──────────────────────────────────────────────
function updateSyncStateForSource(source, lastSyncedAt, messageCount = 0) {
  const topics = db.prepare('SELECT id FROM topics').all();
  for (const t of topics) {
    db.prepare(`
      INSERT INTO sync_state (topic_id, source, last_synced_at, last_message_count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(topic_id, source) DO UPDATE SET
        last_synced_at = excluded.last_synced_at,
        last_message_count = excluded.last_message_count
    `).run(String(t.id), source, lastSyncedAt, messageCount);
  }
}

// ADR-044 S2.6 — single writer for fetch telemetry. Records one fetch_runs row
// per attempt and, for any non-ok status, captures a /bugs row so a stalled or
// silently-empty source surfaces to a human instead of vanishing into stderr.
// Best-effort: a telemetry failure never breaks the fetch that produced it.
async function recordFetchTelemetry({ source, status, count, durationMs, note, trigger }) {
  try {
    const { recordFetchRun } = await import('./dist/db/queries/fetch-runs.js');
    recordFetchRun(db, { source, status, count, durationMs, note, trigger });
    if (status !== 'ok') {
      captureBug(db, {
        source: 'sync',
        errorName: `FetchFailure:${source}`,
        message: `Fetch for '${source}' returned status=${status}${note ? ` (${note})` : ''}`,
        context: { source, status, count, durationMs, trigger },
      });
    }
  } catch (err) {
    process.stderr.write(`[FetchTelemetry] record failed for ${source}: ${err.message}\n`);
  }
}

// ADR-044 S2.7 — background Jira fetch (closes the Jira search-corpus staleness
// gap). Before this, runFullSync only invalidated the board-UI caches
// (jira_issues); the `messages` table — what wi_search / search_all FTS over —
// was never refreshed by background sync, so Jira went stale in search until a
// human ran a cross-source search. This mirrors runEmailSync: fetch via the
// orchestrator's fetchOneSource (cancel-and-release), persist to `messages`
// (dedup on source,source_id) into a resolved 'jira' topic, and record
// telemetry (→ /api/sync/telemetry + non-ok → /bugs).
//
// AbortSignal: JiraDataSource.fetchMessages(config, since) has no signal param
// and the MCP-first path is a ~1s API call (not a long scrape), so the coarse
// release() (releaseBySource('jira')) covers only the browser-fallback slot —
// sufficient for M1. No signal threading needed here.
async function runJiraSync() {
  const boardUrl = process.env.JIRA_BOARD_URL;
  if (!boardUrl) {
    process.stderr.write('[Jira] skipped: JIRA_BOARD_URL not set\n');
    return; // graceful no-op, matches search-all behavior
  }
  const session = getBrowserSession();
  const { createJiraDataSource } = await import('./dist/fetcher/sources/jira-adapter.js');
  const { fetchOneSource } = await import('./dist/fetcher/orchestrator.js');
  const { upsertMessage } = await import('./dist/db/queries/messages.js');

  const jira = createJiraDataSource(session); // auto: MCP-first, browser fallback
  db.prepare(`INSERT OR IGNORE INTO topics (name, created_at) VALUES ('jira', datetime('now'))`).run();
  const topicId = db.prepare('SELECT id FROM topics WHERE name = ?').get('jira').id;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Jira moves slower than email
  const { envelope, messages } = await fetchOneSource({
    source: 'jira',
    fetch: () => jira.fetchMessages({ boardUrl }, since),
    release: () => session.releaseBySource('jira'),
    timeoutMs: 90_000,
  });

  let persisted = 0;
  if (envelope.status === 'ok') {
    for (const m of messages) {
      try {
        upsertMessage(db, {
          topic_id: topicId,
          source: m.source,
          source_id: m.id,
          subject: m.subject || null,
          content: m.content ?? '',
          author: m.sender?.name || m.sender?.email || m.sender?.id || 'unknown',
          timestamp: (m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt)).toISOString(),
          metadata: m.metadata ? JSON.stringify(m.metadata) : null,
          raw_data: null,
        });
        persisted++;
      } catch (err) {
        process.stderr.write(`[Jira] Skipping row: ${err.message}\n`);
      }
    }
  }
  process.stderr.write(
    `[Jira] status=${envelope.status} fetched=${messages.length} persisted=${persisted} in ${envelope.durationMs}ms\n`,
  );
  await recordFetchTelemetry({
    source: 'jira',
    status: envelope.status,
    count: persisted,
    durationMs: envelope.durationMs,
    note: envelope.note ?? null,
    trigger: 'sync',
  });

  // Update sync_state for jira source
  const jiraNow = new Date().toISOString();
  updateSyncStateForSource('jira', jiraNow, persisted);

  if (envelope.status !== 'ok') {
    throw new Error(`[Jira] ${envelope.status}${envelope.note ? ` (${envelope.note})` : ''}`);
  }
}

async function runFullSync() {
  if (syncProgress.running) return;
  syncProgress.running = true;
  syncProgress.completedTopics = [];
  syncProgress.startedAt = new Date().toISOString();
  syncProgress.completedAt = null;
  syncProgress.error = null;

  // Per-topic timeout budgets (ms). Override via env if a slow connector needs more.
  const TEAMS_BUDGET_MS = Number(process.env.SYNC_TEAMS_BUDGET_MS) || 5 * 60_000;
  const EMAIL_BUDGET_MS = Number(process.env.SYNC_EMAIL_BUDGET_MS) || 2 * 60_000;
  const JIRA_BUDGET_MS = Number(process.env.SYNC_JIRA_BUDGET_MS) || 2 * 60_000;
  const CALENDAR_BUDGET_MS = Number(process.env.SYNC_CALENDAR_BUDGET_MS) || 2 * 60_000;
  const NOTEBOOK_BUDGET_MS = Number(process.env.SYNC_NOTEBOOK_BUDGET_MS) || 3 * 60_000;

  try {
    // 1. Teams — scrape all unread chats + meeting notes (requires browser)
    syncProgress.currentTopic = 'Teams chats';
    try {
      await withSyncTimeout('Teams', runTeamsSync, TEAMS_BUDGET_MS);
      syncProgress.completedTopics.push('Teams');
    } catch (err) {
      process.stderr.write(`[FullSync] Teams skipped: ${err.message}\n`);
      syncProgress.completedTopics.push('Teams:skipped');
    }

    // 1b. Recompute chat activity rollup (EP-53 — pure SQL, no AI)
    recomputeChatActivity(db);

    // 1c. Email — Outlook inbox via fetcher orchestrator (ADR-044 S2.5).
    //     Cancel-and-release timeout inside runEmailSync frees the browser slot
    //     on stall; the outer withSyncTimeout is a coarse backstop budget.
    syncProgress.currentTopic = 'Email';
    try {
      await withSyncTimeout('Email', runEmailSync, EMAIL_BUDGET_MS);
      syncProgress.completedTopics.push('Email');
    } catch (err) {
      process.stderr.write(`[FullSync] Email skipped: ${err.message}\n`);
      syncProgress.completedTopics.push('Email:skipped');
    }

    // 1d. Jira — persist issues to `messages` via fetcher orchestrator (ADR-044
    //     S2.7). This is what keeps Jira fresh in the SEARCH corpus (wi_search /
    //     search_all FTS); the board-UI caches are separately invalidated below.
    syncProgress.currentTopic = 'Jira';
    try {
      await withSyncTimeout('Jira', runJiraSync, JIRA_BUDGET_MS);
      syncProgress.completedTopics.push('Jira');
    } catch (err) {
      process.stderr.write(`[FullSync] Jira skipped: ${err.message}\n`);
      syncProgress.completedTopics.push('Jira:skipped');
    }

    // 2. Calendar — macOS native via AppleScript (no browser needed)
    syncProgress.currentTopic = 'Calendar';
    try {
      await withSyncTimeout('Calendar', scrapeAndSaveCalendar, CALENDAR_BUDGET_MS);
      syncProgress.completedTopics.push('Calendar');
    } catch (err) {
      process.stderr.write(`[FullSync] Calendar skipped: ${err.message}\n`);
      syncProgress.completedTopics.push('Calendar:skipped');
    }

    // 3. Invalidate Jira caches so next visit re-fetches fresh data
    saturnCache.fetchedAt = 0;
    myIssuesCache.fetchedAt = 0;

    // 4. Update topic notebooks (LLM memory) — background, non-blocking per topic
    // Option 4 (cost reduction): gate on shouldRefreshNotebook so we don't
    // burn a Sonnet call every 15-min sync cycle just because Teams pushed
    // an "ok thanks" message. Default 60-min interval; tunable via env.
    if (analyzer) {
      syncProgress.currentTopic = 'Updating notebooks';
      const topics = db.prepare(`SELECT name FROM topics`).all();
      for (const topic of topics) {
        if (!shouldRefreshNotebook(topic.name)) {
          syncProgress.completedTopics.push(`Notebook:${topic.name} (skipped — cadence)`);
          continue;
        }
        try {
          await withSyncTimeout(
            `Notebook:${topic.name}`,
            () => getOrBuildNotebook(db, topic.name, analyzer),
            NOTEBOOK_BUDGET_MS,
          );
          markNotebookRefreshed(topic.name);
          syncProgress.completedTopics.push(`Notebook:${topic.name}`);
        } catch (err) {
          process.stderr.write(`[Notebooks] Failed to update notebook for "${topic.name}": ${err.message}\n`);
        }
      }
    }

    // 4b. Auto-export notebooks to Obsidian vault (EP-27, non-blocking)
    // EP-58: pass palaceClient for Deep Memory enrichment (optional — skipped when null)
    if (process.env.OBSIDIAN_VAULT_PATH) {
      exportNotebooksToVault(db, process.env.OBSIDIAN_VAULT_PATH, palaceClient ?? undefined)
        .catch(err => process.stderr.write(`[Vault] export failed: ${err.message}\n`));
      // §6 vault→persona bridge: mirror human annotations into the memory dir so
      // persona.ts injects them into the next chat turn. Independent of palace —
      // just reads vault files + writes memory/vault_annotations.md. Fire-and-forget.
      try {
        const memoryDir = locateMemoryDir(process.cwd());
        if (memoryDir) {
          const n = mirrorVaultAnnotationsToMemory(process.env.OBSIDIAN_VAULT_PATH, memoryDir);
          if (n > 0) process.stderr.write(`[Vault] mirrored ${n} annotation(s) → memory/vault_annotations.md\n`);
        }
      } catch (err) {
        process.stderr.write(`[Vault] annotation mirror failed: ${err.message}\n`);
      }
    }

    // Phase 79-08: Boot scan + file watcher for obsidian_notes (6th recall lane).
    // Non-blocking: indexVault is synchronous but fast (mtime-gated).
    // watchVault returns a cleanup fn registered on SIGTERM/SIGINT below.
    if (process.env.OBSIDIAN_VAULT_PATH) {
      try {
        indexVault(db, process.env.OBSIDIAN_VAULT_PATH);
      } catch (err) {
        process.stderr.write(`[vault-indexer] boot scan failed: ${err.message}\n`);
      }
      const stopVaultWatcher = watchVault(db, process.env.OBSIDIAN_VAULT_PATH);
      process.once('SIGTERM', stopVaultWatcher);
      process.once('SIGINT', stopVaultWatcher);
    }

    // 4b2. Extract Obsidian annotations → palace (EP-60, fire-and-forget)
    if (process.env.OBSIDIAN_VAULT_PATH && palaceClient && palaceClient.isConnected) {
      try {
        const annotations = extractVaultAnnotations(process.env.OBSIDIAN_VAULT_PATH);
        if (annotations.length > 0) {
          process.stderr.write(`[annotation-sync] Found ${annotations.length} new/changed annotations\n`);
          for (const ann of annotations) {
            try {
              // Write annotation as palace drawer
              await palaceClient.addDrawer('annotations', ann.topicName, ann.content, ann.filePath);

              // Extract entities for KG enrichment
              const entities = extractEntities(ann.content, knownPeopleNames);

              // Human annotations create superseding KG triples
              for (const key of entities.jiraKeys) {
                await palaceClient.kgAdd(key, 'human-annotated', ann.content.slice(0, 200), new Date().toISOString().slice(0, 10));
              }
              for (const person of entities.people) {
                await palaceClient.kgAdd(person, 'human-annotated', ann.topicName, new Date().toISOString().slice(0, 10));
              }

              // Audit trail via diary
              await palaceClient.diaryWrite('annotation-sync',
                `Synced annotation from ${ann.filePath}: ${ann.content.slice(0, 100)}... (${entities.jiraKeys.length} Jira keys, ${entities.people.length} people)`,
                ann.topicName
              );
            } catch (err) {
              process.stderr.write(`[annotation-sync] Failed for ${ann.topicName}: ${err.message}\n`);
            }
          }
        }
      } catch (err) {
        process.stderr.write(`[annotation-sync] extraction failed: ${err.message}\n`);
      }
    }

    // 4c. Enrich palace memory from sync data (EP-58, fire-and-forget)
    if (memoryEnricher) {
      try {
        const topicNotebooks = db.prepare(`SELECT topic_name AS name, content FROM topic_notebooks WHERE content IS NOT NULL`).all()
          .map(r => ({ name: r.name, content: r.content }));

        const jiraTransitions = db.prepare(
         `SELECT issue_key, from_status, to_status, transitioned_at
            FROM jira_transitions
            WHERE transitioned_at > datetime('now', '-1 day')
            ORDER BY transitioned_at DESC`
        ).all();

        const conversations = db.prepare(
          `SELECT DISTINCT gc.name AS chatSlug, gc.name AS summary
            FROM group_chats gc
            WHERE gc.last_message_at > datetime('now', '-1 day')`
        ).all().map(r => ({
          chatSlug: r.chatSlug || 'unknown',
          summary: r.summary || '',
          participants: [],
          topicName: null,
        }));

        const meetingRows = db.prepare(
          `SELECT id, chat_name AS meetingSlug, title, transcript, date, decisions AS decisionsJson
           FROM meetings
           WHERE transcript IS NOT NULL AND length(transcript) > 100
             AND date > datetime('now', '-1 day')`
        ).all();

        const meetings = meetingRows.map(r => {
          let decisions = [];
          try {
            if (r.decisionsJson && typeof r.decisionsJson === 'string') {
              const parsed = JSON.parse(r.decisionsJson);
              if (Array.isArray(parsed)) {
                for (const d of parsed) {
                  if (typeof d === 'string' && !decisions.includes(d)) {
                    decisions.push(d);
                  }
                }
              }
            }
          } catch {}

          return {
            meetingSlug: r.meetingSlug || `meeting-${r.id}`,
            title: r.title || '',
            transcript: r.transcript,
            decisions,
            date: r.date,
          };
        });

        const recentMessages = db.prepare(
          `SELECT content, author, subject, source FROM messages
           WHERE timestamp > datetime('now', '-1 day')
           ORDER BY timestamp DESC LIMIT 200`
        ).all();

        memoryEnricher.enrichFromSync({
          topicNotebooks: topicNotebooks,
          jiraTransitions: jiraTransitions,
          conversations: conversations,
          meetings: meetings,
          messages: recentMessages,
        }).then(enrichResult => {
          process.stderr.write(`[palace-enricher] ${enrichResult.drawersWritten} drawers, ${enrichResult.triplesWritten} triples, ${enrichResult.entitiesExtracted} entities (${enrichResult.skippedDeduplicated} deduped)\n`);
        }).catch(err => {
          process.stderr.write(`[palace-enricher] failed: ${err.message}\n`);
        });

        syncProgress.completedTopics.push('Palace');
      } catch (err) {
        process.stderr.write(`[palace-enricher] query error: ${err.message}\n`);
      }
    }

    // 5. Pre-meeting briefs for events in next 24h (EP-15-4)
    if (anthropicApiKey) {
      syncProgress.currentTopic = 'Pre-meeting briefs';
      try {
        const { generatePreBrief } = await import('./dist/services/analyzer.js');
        const upcomingMeetings = db.prepare(
          `SELECT id, title, attendees, start_time FROM calendar_events
           WHERE start_time > datetime('now')
             AND start_time <= datetime('now', '+24 hours')
             AND pre_brief IS NULL`
        ).all();
        for (const meeting of upcomingMeetings) {
          try {
            const hoursAway = (new Date(meeting.start_time) - new Date()) / 3600000;
            // Fetch relevant context from messages
            const keywords = meeting.title
              .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
              .filter(w => w.length > 3).slice(0, 5);
            const ftsQuery = keywords.map(k => k.replace(/"/g, '""')).join(' OR ');
            let contextItems = [];
            if (ftsQuery) {
              try {
                const rows = db.prepare(`
                  SELECT m.subject, m.content FROM messages_fts
                  JOIN messages m ON messages_fts.rowid = m.id
                  WHERE messages_fts MATCH ?
                  ORDER BY bm25(messages_fts) LIMIT 15
                `).all(ftsQuery);
                contextItems = rows.map(r => ({
                  subject: r.subject || meeting.title,
                  content: r.content,
                }));
              } catch { /* FTS not available */ }
            }
            const brief = await generatePreBrief(
              meeting.title,
              meeting.attendees || '',
              hoursAway,
              contextItems,
              anthropicApiKey
            );
            db.prepare(
              `UPDATE calendar_events SET pre_brief = ? WHERE id = ?`
            ).run(brief, meeting.id);
            process.stderr.write(`[PreBrief] Generated for: ${meeting.title}\n`);
          } catch (err) {
            process.stderr.write(`[PreBrief] Failed for "${meeting.title}": ${err.message}\n`);
          }
        }
      } catch (err) {
        process.stderr.write(`[PreBrief] Import error: ${err.message}\n`);
      }
    }

    // 6. Regenerate alerts and workload (EP-15-2/3)
    generateAlerts();
    generateWorkload();

    // 7. Auto-promote pending_review action items older than 48h (EP-35)
    try { autoPromotePendingItems(db, 48); } catch {}

    // 10. Rebuild profiles for marked teammates (EP-45)
    if (analyzer) {
      try {
        const markedMembers = getMarkedMembers(db);
        if (markedMembers.length > 0) {
          syncProgress.currentTopic = 'Teammate profiles';
          await Promise.allSettled(
            markedMembers.map(m => buildOrUpdateMemberProfile(db, m.id, analyzer))
          );
          syncProgress.completedTopics.push('Teammates');
        }
      } catch (err) {
        process.stderr.write(`[Teammates] Profile rebuild error: ${err.message}\n`);
      }
    }

    // 8. Detect cross-topic relationships (EP-39)
    try {
      const { detectJiraOverlaps, detectSharedPeople, saveRelationships } = await import('./dist/tools/relationship-detector.js');
      const all = [...detectJiraOverlaps(db), ...detectSharedPeople(db)];
      saveRelationships(db, all);
    } catch {}

    // 9. Index new messages for semantic search (EP-37)
    try {
      const { createEmbeddingService } = await import('./dist/services/embedder.js');
      const embedder = createEmbeddingService(db);
      if (await embedder.checkEnabled()) {
        syncProgress.currentTopic = 'Indexing embeddings';
        const unindexed = db.prepare(`
          SELECT m.id FROM messages m
          LEFT JOIN message_embeddings e ON e.message_id = m.id
          WHERE e.message_id IS NULL
          ORDER BY m.id DESC LIMIT 500
        `).all().map(r => r.id);
        if (unindexed.length > 0) {
          const result = await embedder.indexMessages(unindexed);
          process.stderr.write(`[Embeddings] Indexed ${result.indexed} messages (${result.skipped} skipped)\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[Embeddings] Error: ${err.message}\n`);
    }

    // 11. Refresh stale knowledge entries (Phase 56 — self-learning brain)
    try {
      syncProgress.currentTopic = 'Knowledge refresh';
      const refreshed = await knowledgeIndexer.refreshStaleEntries(db);
      if (refreshed > 0) {
        process.stderr.write(`[knowledge] Refreshed ${refreshed} stale entries (TTL: ${KNOWLEDGE_TTL_DAYS}d)\n`);
      }
      syncProgress.completedTopics.push('Knowledge');
    } catch (err) {
      process.stderr.write(`[knowledge] Stale refresh error: ${err.message}\n`);
    }

    syncProgress.currentTopic = null;
    syncProgress.completedAt = new Date().toISOString();

    // EP-59: Invalidate graph cache after sync so next chat query gets fresh KG data
    if (palaceClient) palaceClient.invalidateGraphCache();
  } catch (err) {
    syncProgress.error = err.message;
  } finally {
    syncProgress.running = false;
  }
}

// ── OP-4 / A-1: CORS allow-list + optional bearer-token auth ─────────────────
// Threat closed: any website the user visits could previously `fetch()` the
// bridge on localhost:3132 because every response sent `Access-Control-Allow-Origin: *`.
// Now: only echo back the Origin header when it matches the allow-list; anything
// else gets no CORS headers (browser blocks the response).
//
// MCP_BRIDGE_ALLOWED_ORIGINS: comma-separated origins (defaults to the Vite dev server)
// MCP_BRIDGE_TOKEN: when set, non-same-origin requests must send `Authorization: Bearer <token>`
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5175', 'http://127.0.0.1:5175'];
const ALLOWED_ORIGINS = (process.env.MCP_BRIDGE_ALLOWED_ORIGINS
  ? process.env.MCP_BRIDGE_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS);
const BRIDGE_TOKEN = process.env.MCP_BRIDGE_TOKEN || '';

function corsHeadersFor(req) {
  const origin = req.headers.origin;
  // Same-origin / no-origin (curl, Atlas, MCP) — no CORS headers needed at all
  if (!origin) return {};
  // Allow-listed browser origin — echo it back (NOT '*')
  if (ALLOWED_ORIGINS.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type, X-WI-Consumer, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Vary': 'Origin',
    };
  }
  // Disallowed browser origin — return no CORS headers; the browser blocks the response
  return {};
}

/**
 * Returns `{ ok: true }` when the request is allowed, or `{ ok: false, status, body }` when not.
 *  - When MCP_BRIDGE_TOKEN is unset → allow everything (backward compatible default).
 *  - When set → require either an allow-listed Origin OR `Authorization: Bearer <token>`.
 *  - Always allows OPTIONS preflight (no body, no auth — browser pattern).
 */
function checkAuth(req) {
  if (req.method === 'OPTIONS') return { ok: true };
  if (!BRIDGE_TOKEN) return { ok: true };
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) return { ok: true };
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${BRIDGE_TOKEN}`) return { ok: true };
  return {
    ok: false,
    status: 401,
    body: {
      error: 'unauthorized',
      message:
        'Bridge requires Authorization: Bearer <MCP_BRIDGE_TOKEN> for non-allow-listed origins. ' +
        'Set MCP_BRIDGE_TOKEN= to disable auth (not recommended).',
    },
  };
}

/**
 * `json(res, status, data)` — unchanged signature. CORS headers come from
 * `res._corsHeaders` set once per request by the server entry middleware below.
 * This keeps all ~250 existing call sites untouched.
 */
function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...(res._corsHeaders || {}),
  });
  res.end(JSON.stringify(data));
}

// ── OP-5 / A-2: per-agent isolation + health registry ────────────────────────
// Previously the boot block was one big try/catch — a single failed dynamic
// import (e.g. stale dist/) would silently kill every agent. Now each agent
// registers, runs in its own scope, and reports health.
//
// Status values:
//   'starting' — registered, init in progress
//   'ready'    — init completed (interval running, but no tick yet)
//   'healthy'  — last tick succeeded
//   'flaky'    — 1–2 recent tick failures (still running)
//   'degraded' — ≥ 3 failures (still running, but treat output with suspicion)
//   'crashed'  — init failed; agent is not running
//   'disabled' — preconditions not met (e.g. no API key, no palace)
const agentHealth = new Map();

// post-graphify step 3: per-repo busy flag for code-graph indexing. Wraps
// BOTH the CodeGraphIndexer agent tick AND the manual POST /api/code-graph/index
// handler so the two cannot race (the agent's mtime-diff would clobber a
// concurrent force-refresh and vice versa).
//
// Implementation extracted to src/services/code-graph/lock.ts so the
// synchronous claim semantics can be deterministically unit-tested
// (tests/code-graph/lock.test.ts). Closes ADR-027 v2 Path B item #3.
//
// All five exports — tryAcquireCodeGraphLock, releaseCodeGraphLock,
// isCodeGraphBusy, withCodeGraphLock, recordCodeGraphBusyRejection,
// getCodeGraphBusyRejections — share a single module-scoped Map (matches
// the previous module-scope behaviour). DO NOT define another lock Map
// in this file or callers will diverge.

// ADR-027 v2 item #3: synchronous check-and-set so the manual POST handler
// can claim the lock BEFORE writing the 202 response. The previous shape
// (isCodeGraphBusy → json(202) → withCodeGraphLock) had a race window:
// two concurrent POSTs could both pass isCodeGraphBusy, both write 202,
// and the second's withCodeGraphLock would throw — but the response was
// already sent. tryAcquireCodeGraphLock(repos) atomically claims all-or-none.
// (Lock is now imported from ./dist/services/code-graph/lock.js above.)


function _setAgentStatus(name, patch) {
  const prev = agentHealth.get(name) || { name, ticks: 0, failures: 0 };
  agentHealth.set(name, { ...prev, ...patch, name });
}

function registerAgent(name) {
  _setAgentStatus(name, { status: 'starting', error: undefined });
}

function markAgentReady(name) {
  _setAgentStatus(name, { status: 'ready', startedAt: new Date().toISOString() });
}

function markAgentDisabled(name, reason) {
  _setAgentStatus(name, { status: 'disabled', error: reason });
}

function markAgentCrashed(name, err) {
  _setAgentStatus(name, {
    status: 'crashed',
    error: err?.message || String(err),
    lastErrorAt: new Date().toISOString(),
  });
  process.stderr.write(`[${name}] init failed: ${err?.message || err}\n`);
}

/**
 * Wrap a tick body in try/catch + health bookkeeping. Tick failures don't kill
 * the interval — the agent keeps running, but `agentHealth` records it.
 */
async function withAgentTick(name, fn) {
  const now = new Date().toISOString();
  try {
    await fn();
    const h = agentHealth.get(name);
    _setAgentStatus(name, {
      status: 'healthy',
      lastTickAt: now,
      lastSuccessAt: now,
      ticks: (h?.ticks || 0) + 1,
      error: undefined,
    });
  } catch (err) {
    // ADR-030 Phase A: capture the agent crash as a bug BEFORE the existing
    // flaky→degraded escalation. We do NOT call markAgentCrashed — the
    // agent stays alive (this is the whole point of best-effort capture).
    // The capture itself is wrapped in try/catch so a capture failure can
    // never escalate this catch arm into a process crash.
    try {
      captureBug(db, {
        source: 'agent',
        errorName: err?.name || 'AgentTickError',
        message: String(err?.message || err || 'no message'),
        stack: err?.stack || null,
        context: { agent: name },
      });
    } catch (innerErr) {
      process.stderr.write(`[Bugs] capture failed for agent ${name}: ${innerErr?.message || innerErr}\n`);
    }

    const h = agentHealth.get(name);
    const failures = (h?.failures || 0) + 1;
    _setAgentStatus(name, {
      status: failures >= 3 ? 'degraded' : 'flaky',
      lastTickAt: now,
      lastErrorAt: now,
      ticks: (h?.ticks || 0) + 1,
      failures,
      error: err?.message || String(err),
    });
    process.stderr.write(`[${name}] tick error #${failures}: ${err?.message || err}\n`);
  }
}

function getAgentHealthSnapshot() {
  return Array.from(agentHealth.values()).map(h => ({ ...h })); // shallow copy
}

// ADR-030 Phase B (Plan 75-04): derive investigator_status for the
// /api/system-health.bugs block. Returns undefined when the agent is
// neither registered nor explicitly disabled — caller falls back to
// 'not-implemented'.
function deriveInvestigatorStatus() {
  if (process.env.BUG_INVESTIGATOR_ENABLED === '0') return 'disabled';
  const agent = agentHealth.get('BugInvestigatorAgent');
  if (!agent) return undefined;
  if (agent.status === 'healthy') return 'ready';
  if (agent.status === 'degraded') return 'degraded';
  if (agent.status === 'crashed') return 'crashed';
  // 'flaky', 'running' map to 'ready' — the agent is alive, just shaky.
  return 'ready';
}

// ADR-030 Phase C (Plan 76-03): derive resolver_status for the
// /api/system-health.bugs block. Same shape as deriveInvestigatorStatus.
// Note: BUG_RESOLVER_ENABLED defaults to '0' (conservative — opt-in), so
// this returns 'disabled' on a fresh install until the user explicitly
// flips it.
function deriveResolverStatus() {
  if (process.env.BUG_RESOLVER_ENABLED !== '1') return 'disabled';
  const agent = agentHealth.get('BugResolverAgent');
  if (!agent) return undefined;
  if (agent.status === 'healthy') return 'ready';
  if (agent.status === 'degraded') return 'degraded';
  if (agent.status === 'crashed') return 'crashed';
  return 'ready';
}

// ADR-030 Phase C — singleton resolver instance. Set inside the agents
// boot block when BUG_RESOLVER_ENABLED=1; consumed by the
// /api/bugs/:id/resolve-attempt route via _routeCtx.bugResolver.
let bugResolverInstance = null;

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

/**
 * EP-31-1: Zod validation helper.
 * Returns { ok: true, data } on success, { ok: false, error: string } on failure.
 */
function parseBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path?.join('.') ?? 'body';
    return { ok: false, error: `${field}: ${issue?.message ?? 'Invalid input'}` };
  }
  return { ok: true, data: result.data };
}

// ── EP-31-1: Zod schemas for POST/PUT endpoints ───────────────────────────

const SearchSchema = z.object({
  topic: z.string().optional().default(''),
  keywords: z.string().optional(),
  source: z.string().optional(),
});

const SearchAllSchema = z.object({
  query: z.string().min(1, 'query is required'),
  sources: z.array(z.string()).optional(),
  since: z.string().optional(),
  maxResults: z.number().optional(),
  sortBy: z.enum(['relevance', 'recency']).optional(),
});

const DigestSchema = z.object({
  topic: z.string().min(1, 'topic is required'),
  date: z.string().optional(),
  refresh: z.boolean().optional(),
});

const JiraReportSchema = z.object({
  projectKey: z.string().min(1, 'projectKey is required'),
  boardUrl: z.string().min(1, 'boardUrl is required'),
  since: z.string().optional(),
});

const TeamsUpdatesSchema = z.object({
  query: z.string().min(1, 'query is required'),
  since: z.string().optional(),
  includeMeetings: z.boolean().optional(),
  maxResults: z.number().optional(),
});

const TopicExpertSchema = z.object({
  question: z.string().min(1, 'question is required'),
  projectKey: z.string().optional(),
  sources: z.array(z.string()).optional(),
});

const ConfigureTopicSchema = z.object({
  name: z.string().min(1, 'name is required'),
  sources: z.record(z.unknown()),
});

const ChatSchema = z.object({
  message: z.string().min(1, 'message is required'),
  history: z.array(z.object({ role: z.string(), content: z.string() })).optional().default([]),
  context: z.object({ page: z.string() }).passthrough().optional().default({ page: '' }),
  injectedContext: z.string().optional(),
  // 78a-04 / Task 3: mode-aware chat. `mode === 'auto'` (default) runs the
  // heuristic detector. `'work'` / `'life'` is treated as the manualMode
  // override (CHAT-06). Any other value rejected at parse time.
  mode: z.enum(['work', 'life', 'auto']).optional().default('auto'),
  // 78a-04: per-conversation row in chat_modes is keyed by this id. Optional
  // for backward compat (existing /api/chat callers don't send it); when
  // missing we use a deterministic fallback ('default').
  conversationId: z.string().min(1).max(128).optional().default('default'),
});

const NotebookChatSchema = z.object({
  message: z.string().min(1, 'message is required'),
  history: z.array(z.object({ role: z.string(), content: z.string() })).optional().default([]),
});

const JiraAnalyzeSchema = z.object({
  issueKey: z.string().regex(/^[A-Z]+-\d+$/, 'issueKey must match PROJECT-NNN format'),
  title: z.string().min(1, 'title is required'),
  status: z.string().min(1, 'status is required'),
  assignee: z.string().nullable().optional(),
  epic: z.string().nullable().optional(),
});

const JiraInvestigateSchema = z.object({
  issueKey:    z.string().regex(/^[A-Z]+-\d+$/, 'issueKey must match PROJECT-NNN format'),
  title:       z.string().min(1, 'title is required'),
  description: z.string().min(1, 'description is required'),
  status:      z.string().min(1, 'status is required'),
  assignee:    z.string().nullable().optional(),
  createdAt:   z.string().min(1, 'createdAt is required'),
});

const DraftPrSchema = z.object({
  title: z.string().min(1, 'title is required').max(500),
  prBody: z.string().max(10000).optional(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repo must be in owner/repo format').optional(),
});

const TopicUpdateSchema = z.object({
  name: z.string().optional(),
  config: z.unknown().optional(),
  lookback_days: z.number().optional(),
});

const AnnotationSchema = z.object({
  annotation: z.string(),
});
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

// ── Error tracking helpers (EP-18) ─────────────────────────────
function persistError(source, message, opts = {}) {
  try {
    insertErrorLog(db, {
      source,
      message: String(message).slice(0, 2000),
      stack: opts.stack ? String(opts.stack).slice(0, 4000) : null,
      request_path: opts.path ?? null,
      severity: opts.severity ?? 'error',
      category: opts.category ?? null,
      suggested_fix: null,
    });
  } catch {
    // never throw from error logging
  }
}

// Clean up errors older than 30 days on startup
try {
  db.prepare("DELETE FROM error_logs WHERE occurred_at < datetime('now', '-30 days')").run();
} catch {
  // table may not exist yet on first boot (migration hasn't run) — ignore
}

// Warm Jira caches from DB so sections show data immediately on restart
warmSaturnCacheFromDB();
warmMyIssuesCacheFromDB();

const analyzer = anthropicApiKey ? new AIAnalyzer({ apiKey: anthropicApiKey, db }) : null;

// ── EP-58: Shared PalaceClient v2 + MemoryEnricher (declared at module scope) ──
let palaceClient = null;
let memoryEnricher = null;

// ── ADR-020: Proactive Research Helpers ─────────────────────────────
function needsDeepResearch(message, contextItems) {
  if (message.length < 20) return false;
  const lower = message.toLowerCase();
  // Work-data questions (Teams, Jira, calendar, …) must never invoke ResearchEngine.
  if (/\b(teams?|jira|email|outlook|meeting|calendar|action items?|digest|sprint|messages?|chats?|transcript|recap|activity)\b/i.test(message)) {
    return false;
  }
  if (/^summari[sz]e?\b/i.test(lower) || /\b(yesterday|today|last week|overnight)\b/i.test(lower)) {
    return false;
  }
  const skipPatterns = [
    /^(what|show|list).*(action item|todo|task)/,
    /^summari[sz]e?\b/i,
    /^who is (assigned|working)/,
    /^(hi|hello|thanks|ok|yes|no)\s*[.!?]?$/,
  ];
  if (skipPatterns.some(p => p.test(lower))) return false;

  const strongSignals = [
    'how does', 'where is', 'trace the', 'what calls', 'who uses',
    'look into', 'dig into', 'search the code', 'look at the repo',
    'what.*architecture', 'find the', 'show me the code', 'check the implementation',
  ];
  const hasStrong = strongSignals.some(s => new RegExp(s).test(lower));
  if (!hasStrong) return false;

  const codeResults = contextItems.filter(c => c.source === 'code' || c.source === 'research').length;
  return codeResults < 2;
}

// REFACTOR-001 (2026-05-21): enrichKnowledgeFromResearch moved to
// src/intelligence/knowledge-enrichment.ts so the bridge + extracted route
// modules share one source. Behaviour unchanged.
// (Imported at the top of this file alongside other intelligence modules.)

// EP-60: Palace health metrics cache (5-min TTL)
let healthCache = null;
let healthCacheTime = 0;
const HEALTH_CACHE_TTL = 5 * 60 * 1000;

async function computeHealthMetrics() {
  if (!palaceClient || !palaceClient.isConnected) {
    return { staleFacts: 0, orphanRate: 0, topicCoverage: 0, retrievalHitRate: 0, computed: false };
  }

  const stats = palaceClient.stats;
  const retrievalHitRate = stats.retrievalHitRate;

  // Topic coverage: % of configured topics with >0 palace drawers
  const topics = db.prepare('SELECT name FROM topics').all();
  let topicsWithDrawers = 0;
  for (const t of topics) {
    try {
      const raw = await palaceClient.search(t.name, undefined, 1);
      if (raw) {
        const results = JSON.parse(raw);
        if (Array.isArray(results) && results.length > 0) topicsWithDrawers++;
      }
    } catch { /* skip */ }
  }
  const topicCoverage = topics.length > 0 ? topicsWithDrawers / topics.length : 0;

  // Triple/entity counts come from mempalace_kg_stats (the same surface
  // /api/palace/status uses). Earlier code passed { entity: '*' } to
  // mempalace_kg_query, but '*' is NOT a wildcard for that tool — it returned
  // [] and the dashboard reported tripleCount=0 even when the KG had hundreds
  // of triples. See docs/docs/architecture/mempalace-second-brain.md
  // "Palace observability — known gotchas" and the smoke divergence guard
  // in scripts/smoke-bridge.sh.
  let totalTriples = 0;
  let totalEntities = 0;
  try {
    const raw = await palaceClient.callToolRaw('mempalace_kg_stats', {});
    if (raw) {
      const kg = JSON.parse(raw);
      totalTriples = kg.total_triples ?? kg.triple_count ?? kg.triples ?? 0;
      totalEntities = kg.total_entities ?? kg.entity_count ?? kg.entities ?? 0;
    }
  } catch { /* palace unavailable */ }

  // kg_stats does not expose per-triple valid_from / valid_to or per-entity
  // edge fan-out, so staleFacts and orphanRate are not derivable here without
  // a separate enumeration tool. Report 0 (unknown) until/unless mempalace
  // exposes a streaming enumeration; the live-truth signals callers should
  // trust are totalTriples + totalEntities, both pulled from kg_stats.
  const staleFactsRate = 0;
  const orphanRate = 0;
  const orphans = 0;
  const staleFacts = 0;

  return {
    staleFacts: staleFactsRate,
    orphanRate,
    topicCoverage,
    retrievalHitRate,
    computed: true,
    meta: { totalTriples, totalEntities, orphans, staleCount: staleFacts, topicsChecked: topics.length, topicsWithDrawers },
  };
}

// EP-59: Load known people names for entity extraction (used by both chat handlers)
const knownPeopleNames = (() => {
  try {
    const rows = db.prepare('SELECT name FROM team_members WHERE deleted_at IS NULL').all();
    process.stderr.write(`[ep59] Loaded ${rows.length} known people names for entity extraction\n`);
    return rows.map(r => r.name);
  } catch {
    process.stderr.write(`[ep59] team_members table not available — entity extraction will skip people matching\n`);
    return [];
  }
})();

// Per-user TTL cache for GET /api/brain/context (ADR-024 Pillar 2 / Phase 69-02).
// Map<user, { at: epochMs, payload: BrainContext }>. 60s window. Map-based —
// memory grows with distinct consumer identities (bounded in practice: ui, atlas,
// mcp, plus a handful of test users), so no eviction policy needed for v1.
const brainContextCache = new Map();
const BRAIN_CONTEXT_TTL_MS = 60_000;

const server = createServer(async (req, res) => {
  // OP-4 / A-1: compute CORS once per request; stash on res so json() picks it up.
  res._corsHeaders = corsHeadersFor(req);

  // Preflight — answer with CORS only.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, res._corsHeaders);
    res.end();
    return;
  }

  // Auth gate (no-op when MCP_BRIDGE_TOKEN is unset; back-compat default).
  const auth = checkAuth(req);
  if (!auth.ok) { json(res, auth.status, auth.body); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // REFACTOR-001: extracted route families. Walk in order; first match wins.
  // Route handlers MUST end the response themselves. Adding a new family is
  // a one-line import + one entry in EXTRACTED_ROUTES below.
  const _routeCtx = {
    db,
    palaceClient,
    memoryEnricher,
    anthropicApiKey: anthropicApiKey || '',
    analyzer, // shared AIAnalyzer instance (may be null when no API key)
    bugResolver: bugResolverInstance, // ADR-030 Phase C; null when BUG_RESOLVER_ENABLED!=1
  };
  for (const route of EXTRACTED_ROUTES) {
    if (route.method !== req.method) continue;
    // Convention: route.path may contain `:<param>` segments, e.g.
    //   /api/skills/:name
    //   /api/bugs/:id
    //   /api/bugs/:id/resolve
    // We match by splitting both into segments and walking them in lockstep.
    // The handler reads the parameter values directly from url.pathname; we
    // don't decompose into named bindings here.
    let matches = false;
    if (route.path === path) {
      matches = true;
    } else if (route.path.includes('/:')) {
      const routeSegs = route.path.split('/').filter(Boolean);
      const pathSegs = path.split('/').filter(Boolean);
      if (routeSegs.length === pathSegs.length) {
        matches = routeSegs.every((seg, i) => seg.startsWith(':') || seg === pathSegs[i]);
      }
    }
    if (!matches) continue;
    try {
      await route.handle(req, res, _routeCtx, url);
    } catch (err) {
      // Last-resort safety net. Individual handlers already catch + reply
      // for known error classes; this only fires on truly unexpected errors.
      if (!res.writableEnded) {
        process.stderr.write(`[routes/${path}] uncaught: ${err.message}\n`);
        json(res, 500, { error: 'internal_error', message: String(err?.message || err) });
      }
    }
    return;
  }

  try {
    // GET /internal/throw-uncaught — ADR-030 Phase A test fixture.
    // Schedules a synchronous throw via setImmediate so it escapes the route
    // handler's try/catch and trips process.on('uncaughtException'). Dev/test
    // only — gated behind NODE_ENV !== 'production'.
    if (path === '/internal/throw-uncaught' && req.method === 'GET') {
      if (process.env.NODE_ENV === 'production') {
        json(res, 404, { error: 'not_found' });
        return;
      }
      const msg = url.searchParams.get('msg') || 'SyntheticUncaught';
      json(res, 200, { ok: true, scheduled: msg });
      setImmediate(() => {
        throw new Error(msg);
      });
      return;
    }

    // GET /api/status
    if (path === '/api/status' && req.method === 'GET') {
      (async () => {
        const msgCount = db.prepare('SELECT COUNT(*) as n FROM messages').get();
        const actionCount = db.prepare("SELECT COUNT(*) as n FROM action_items WHERE status != 'completed'").get();
        const topicsCount = db.prepare('SELECT COUNT(*) as n FROM topics').get();
        const meetingsCount = db.prepare('SELECT COUNT(*) as n FROM meetings').get();
        const lastSync = db.prepare('SELECT MAX(last_synced_at) as ts FROM sync_state').get();
        const { checkOllamaAvailable } = await import('./dist/services/embedder.js');
        const embeddingsAvailable = await checkOllamaAvailable();
        const { readHeartbeatStatus } = await import('./dist/services/cypher/heartbeat.js');
        const heartbeat = readHeartbeatStatus(db);
        json(res, 200, {
          messages: msgCount.n, openActions: actionCount.n,
          topics: topicsCount.n, meetings: meetingsCount.n,
          lastSync: lastSync.ts, dbPath: process.env.DATABASE_PATH || '~/.work-intelligence-mcp/data.db',
          anthropicConnected: !!anthropicApiKey, browserConnected: !!process.env.BROWSER_PROFILE_PATH,
          githubConnected: isGitHubMcpConfigured(),
          embeddingsAvailable,
          demoMode: process.env.WI_DEMO_MODE === '1',
          min_wi_tools_version: 1,
          brainUser: BRAIN_USER,
          heartbeat,
        });
      })().catch(err => {
        if (!res.headersSent) json(res, 500, { error: 'Status check failed' });
        process.stderr.write(`[api/status] error: ${err.message}\n`);
      });
      return;
    }

    // GET /api/connectors — connector registry state (ADR-044 S2.5/S3):
    // enabled connectors from wi.config.json, the full capabilities manifest,
    // and per-connector { enabled, mode, hasRequiredEnv } status. Re-reads
    // wi.config.json so the setup wizard reflects edits without a restart.
    if (path === '/api/connectors' && req.method === 'GET') {
      const { clearWiConfigCache } = await import('./dist/services/wi-config.js');
      clearWiConfigCache();
      json(res, 200, {
        registry: getEnabledConnectors(),
        capabilities: getCapabilitiesManifest(),
        configured: getConnectorStatuses(),
      });
      return;
    }

    // GET /api/connectors/capabilities — the raw capabilities.json manifest.
    if (path === '/api/connectors/capabilities' && req.method === 'GET') {
      json(res, 200, getCapabilitiesManifest());
      return;
    }

    // POST /api/connectors — STEP 11: the setup wizard writes enabled/mode.
    // Structure only: sets connectors.<name>.enabled / .mode, never touches
    // secret-bearing fields. Validates against capabilities.json modes AND
    // the full wi.config.schema.json, then atomic-writes (tmp + rename) and
    // clears the wi-config cache so the next read sees the edit.
    if (path === '/api/connectors' && req.method === 'POST') {
      const body = await readBody(req);
      const { name, enabled, mode } = body || {};
      const manifest = getCapabilitiesManifest();
      const entry = manifest.connectors?.[name];
      if (!entry) {
        json(res, 400, { error: `Unknown connector "${name}"` });
        return;
      }
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        json(res, 400, { error: 'enabled must be a boolean' });
        return;
      }
      if (mode !== undefined && !entry.modes.includes(mode)) {
        json(res, 400, { error: `mode "${mode}" not in ${entry.modes.join('/')} for ${name}` });
        return;
      }
      if (enabled === undefined && mode === undefined) {
        json(res, 400, { error: 'Nothing to update: send enabled and/or mode' });
        return;
      }

      const cfgPath = process.cwd() + '/wi.config.json'; // NOTE: `path` is shadowed by the URL pathname in this scope
      let cfg;
      try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      } catch (e) {
        json(res, 500, { error: `wi.config.json unreadable: ${e.message}` });
        return;
      }
      cfg.connectors = cfg.connectors || {};
      cfg.connectors[name] = cfg.connectors[name] || {};
      if (enabled !== undefined) cfg.connectors[name].enabled = enabled;
      if (mode !== undefined) cfg.connectors[name].mode = mode;

      // Validate the full config vs wi.config.schema.json (same check as
      // `npm run config:validate`). ajv is a devDependency; if unavailable,
      // the capabilities.json checks above already bound enabled/mode.
      try {
        const { default: Ajv2020 } = await import('ajv/dist/2020.js');
        const schema = JSON.parse(fs.readFileSync(process.cwd() + '/wi.config.schema.json', 'utf-8'));
        const validate = new Ajv2020({ validateFormats: false }).compile(schema);
        if (!validate(cfg)) {
          const first = validate.errors?.[0];
          const where = first ? `${first.instancePath || '/root'}: ${first.message}` : 'unknown';
          json(res, 400, { error: `wi.config.schema.json validation failed — ${where}` });
          return;
        }
      } catch { /* ajv missing → rely on the mode/enabled checks above */ }

      const tmp = cfgPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      fs.renameSync(tmp, cfgPath);
      const { clearWiConfigCache } = await import('./dist/services/wi-config.js');
      clearWiConfigCache();

      json(res, 200, {
        name,
        enabled: cfg.connectors[name].enabled === true,
        mode: cfg.connectors[name].mode ?? null,
        ok: true,
      });
      return;
    }

    // GET /api/config/sprint — returns current active sprint from sprint_config table
    if (path === '/api/config/sprint' && req.method === 'GET') {
      const row = db.prepare('SELECT * FROM sprint_config WHERE active = 1 LIMIT 1').get();
      if (!row) {
        json(res, 404, { error: 'No active sprint configured' });
        return;
      }
      json(res, 200, {
        id: row.id,
        sprint_name: row.sprint_name,
        project_key: row.project_key,
        start_date: row.start_date,
        end_date: row.end_date,
        active: row.active,
        created_at: row.created_at,
      });
      return;
    }

    // PUT /api/config/sprint — set a new active sprint (deactivates all others in a transaction)
    if (path === '/api/config/sprint' && req.method === 'PUT') {
      const body = await readBody(req);
      const { sprint_name, project_key, start_date, end_date } = body;
      if (!sprint_name || !project_key || !start_date || !end_date) {
        json(res, 400, { error: 'Missing required fields: sprint_name, project_key, start_date, end_date' });
        return;
      }
      db.transaction(() => {
        db.prepare('UPDATE sprint_config SET active = 0').run();
        db.prepare(
          'INSERT INTO sprint_config (sprint_name, project_key, start_date, end_date, active) VALUES (?, ?, ?, ?, 1)'
        ).run(sprint_name, project_key, start_date, end_date);
      })();
      sprintMeta = null;
      const newRow = db.prepare('SELECT * FROM sprint_config WHERE active = 1 LIMIT 1').get();
      json(res, 200, newRow);
      return;
    }

    // GET /api/palace/status — Palace process health + stats (EP-58, R6)
    if (path === '/api/palace/status' && req.method === 'GET') {
      if (!palaceClient) {
        json(res, 200, {
          connected: false,
          uptime: 0,
          callCount: 0,
          lastError: 'MEMPALACE_PATH not configured',
          drawerCount: 0,
          tripleCount: 0,
        });
        return;
      }

      const stats = palaceClient.stats;

      // Fetch drawer and triple counts from palace (best-effort)
      let drawerCount = 0;
      let tripleCount = 0;

      try {
        const statusResult = await palaceClient.callToolRaw('mempalace_status', {});
        if (statusResult) {
          const parsed = JSON.parse(statusResult);
          drawerCount = parsed.total_drawers ?? parsed.drawer_count ?? parsed.drawers ?? 0;
        }
      } catch { /* best effort */ }

      try {
        const kgStatsRaw = await palaceClient.callToolRaw('mempalace_kg_stats', {});
        if (kgStatsRaw) {
          const kg = JSON.parse(kgStatsRaw);
          tripleCount = kg.total_triples ?? kg.triple_count ?? kg.triples ?? 0;
        }
      } catch { /* best effort */ }

      json(res, 200, {
        connected: stats.connected,
        uptime: stats.uptime,
        callCount: stats.callCount,
        lastError: stats.lastError,
        drawerCount,
        tripleCount,
        retrievalHitRate: stats.retrievalHitRate,
        palaceHits: stats.palaceHits,
        totalQueries: stats.totalQueries,
      });
      return;
    }

    // GET /api/palace/health/detailed — 4 health metrics (EP-60, 60-C5)
    if (path === '/api/palace/health/detailed' && req.method === 'GET') {
      const now = Date.now();
      if (healthCache && (now - healthCacheTime) < HEALTH_CACHE_TTL) {
        json(res, 200, healthCache);
        return;
      }
      try {
        const metrics = await computeHealthMetrics();
        healthCache = metrics;
        healthCacheTime = now;
        json(res, 200, metrics);
      } catch (err) {
        json(res, 500, { error: 'Health computation failed' });
      }
      return;
    }

    // POST /api/palace/health/refresh — force recalculation (EP-60)
    if (path === '/api/palace/health/refresh' && req.method === 'POST') {
      healthCache = null;
      healthCacheTime = 0;
      computeHealthMetrics().then(metrics => {
        healthCache = metrics;
        healthCacheTime = Date.now();
      }).catch(() => {});
      json(res, 202, { status: 'refresh_queued' });
      return;
    }

    // GET /api/palace/drawer/:id — Drawer content for provenance deep-linking (EP-59)
    const drawerMatch = path.match(/^\/api\/palace\/drawer\/(.+)$/);
    if (drawerMatch && req.method === 'GET') {
      const drawerId = decodeURIComponent(drawerMatch[1]);
      if (!palaceClient) {
        json(res, 200, { connected: false, error: 'Palace not available' });
        return;
      }
      try {
        const raw = await palaceClient.callToolRaw('mempalace_search', { query: drawerId, limit: 1 });
        if (!raw) {
          json(res, 404, { error: 'Drawer not found' });
          return;
        }
        const results = JSON.parse(raw);
        const drawer = Array.isArray(results) ? results.find(r => r.id === drawerId || r.room === drawerId) : null;
        if (!drawer) {
          json(res, 404, { error: 'Drawer not found' });
          return;
        }
        json(res, 200, {
          id: drawer.id || drawerId,
          wing: drawer.wing || '',
          room: drawer.room || '',
          content: drawer.content || '',
          label: drawer.label || drawer.room || '',
          createdAt: drawer.created_at || drawer.createdAt || '',
        });
      } catch (err) {
        json(res, 500, { error: 'Failed to fetch drawer' });
      }
      return;
    }

    // GET /api/topics
    // REFACTOR-001 (2026-05-21): /api/topics and /api/topics/health moved to src/routes/topics.ts

    // ── EP-42-3: Jira Analytics ────────────────────────────────────────────

    // GET /api/jira/velocity?project=PROJ&weeks=8
    if (path === '/api/jira/velocity' && req.method === 'GET') {
      const project = url.searchParams.get('project') ?? DEFAULT_JIRA_PROJECT;
      const weeks = Math.min(parseInt(url.searchParams.get('weeks') || '8'), 26);
      const stats = getWeeklyVelocity(db, project, weeks);
      json(res, 200, { project, weeks, stats });
      return;
    }

    // GET /api/jira/cycle-time?issue=PROJ-123
    if (path === '/api/jira/cycle-time' && req.method === 'GET') {
      const issue = url.searchParams.get('issue');
      if (!issue) { json(res, 400, { error: 'issue param required' }); return; }
      const hours = getCycleTime(db, issue);
      json(res, 200, { issue, cycle_time_hours: hours, cycle_time_days: hours != null ? +(hours / 24).toFixed(1) : null });
      return;
    }

    // U-9 / A-9 follow-up: GET /api/brain/budget?user=… — surface today's spend
    // so the UI can show a budget chip and warn before 429.
    if (path === '/api/brain/budget' && req.method === 'GET') {
      const user = (url.searchParams.get('user') || 'anon:ui').toString();
      const dayIso = new Date().toISOString().slice(0, 10);
      const maxCalls = Math.max(0, parseInt(process.env.BRAIN_USER_DAILY_CALLS || '50', 10));
      const maxTokens = Math.max(0, parseInt(process.env.BRAIN_USER_DAILY_INPUT_TOKENS || '200000', 10));
      let row;
      try {
        row = db.prepare(`SELECT calls, input_tokens, output_tokens
                          FROM brain_user_budget_ledger
                          WHERE user = ? AND day_iso = ? AND bucket = 'brain'`).get(user, dayIso);
      } catch { row = undefined; }
      const calls = row?.calls ?? 0;
      const tokens = row?.input_tokens ?? 0;
      // Compute reset time = tomorrow UTC midnight
      const now = new Date();
      const resetMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
      json(res, 200, {
        user,
        day_iso: dayIso,
        calls,
        max_calls: maxCalls,
        tokens,
        max_tokens: maxTokens,
        reset_in_ms: resetMs,
      });
      return;
    }

    // POST /api/wi/dispatch — Cypher engagement (ADR-033 / wi_dispatch MCP tool).
    // Calls runCypher with the JSON body; returns the structured session result.
    // Best-effort palace pass-through: when MEMPALACE_PATH is unset palace=null
    // and Cypher's memory.persist falls through to no-op.
    //
    // ADR-034 L1.1 C2 (2026-06-15): after a fresh dispatch produces a new
    // session row, run the rerun-detector. If the same goal was dispatched
    // by the same user in the last 24h, write a `rerun` outcome row keyed
    // against the EARLIER session (AC L1.1-X-05). Best-effort — any failure
    // is logged but does not break the dispatch (AC L1.1-B-06).
    if (path === '/api/wi/dispatch' && req.method === 'POST') {
      // ADR-040 commit 5 (§6.6): backpressure at intake. If ≥
      // E2E_BACKPRESSURE_COUNT cards are aging beyond
      // E2E_BACKPRESSURE_AGE_DAYS in the e2e column, refuse new work
      // rather than dilute the DoD by piling up unverifiable cards.
      // Reject-not-block: caller sees 429 with the aging cards named.
      if (process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1') {
        const count = Number(process.env.E2E_BACKPRESSURE_COUNT ?? 5);
        const ageDays = Number(process.env.E2E_BACKPRESSURE_AGE_DAYS ?? 3);
        const ageMs = ageDays * 24 * 3600 * 1000;
        const cutoff = Date.now() - ageMs;
        const aging = db
          .prepare(
            `SELECT id, title, goal_text, entered_column_at FROM tasks
              WHERE kanban_column = 'e2e' AND status != 'closed'
                AND (entered_column_at IS NULL OR entered_column_at < ?)
              ORDER BY entered_column_at ASC LIMIT ?`,
          )
          .all(cutoff, count);
        if (aging.length >= count) {
          json(res, 429, {
            error: 'backpressure',
            detail: `${aging.length} cards aging >${ageDays}d in e2e — clear some before starting new work`,
            aging_cards: aging.map((r) => ({ id: r.id, title: r.title, goal_text: r.goal_text })),
          });
          return;
        }
      }
      try {
        const body = await readBody(req);

        // ── ADR-040 F5 fix (2026-07-09) ────────────────────────────────────
        // When OUTCOME_HONEST_KANBAN_ENABLED=1 AND the caller isn't asking
        // for the v2.5 contract shape (which currently depends on the
        // pipeline's `trace` output), route to runLoop so /wi/dispatch
        // actually executes rather than recommending. The v1 pipeline
        // returned `execute: skipped` on non-CLI callers (see audit F5).
        // Card creation happens inside runCypher today; when the loop path
        // is chosen we mirror that write here so /board still lights up.
        // Legacy callers (v2.5 contract, session_id re-entry, or flag off)
        // continue to hit runCypher — no back-compat break.
        const useLoop =
          process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1' &&
          process.env.CYPHER_LOOP_ENABLED !== '0' &&
          !(body && body.contract_version === '2.5') &&
          !(body && body.session_id);

        if (useLoop) {
          const { runLoop } = await import('./dist/services/cypher/loop.js');
          const { randomBytes } = await import('node:crypto');
          const goal = String((body && body.goal) || '').trim();
          const user = String((body && body.user) || 'maaz');
          if (!goal) {
            json(res, 400, { error: 'goal is required' });
            return;
          }
          const sessionId = `cyp_${randomBytes(6).toString('hex')}`;
          const nowMs = Date.now();
          // Classify the goal into a project (ADR-038 D3 + ADR-040 F-UI).
          // Explicit body.project wins; otherwise infer from goal text so
        // the board's project swimlanes are meaningful (configured repos PROJ-*
          // work doesn't get dumped under 'wi').
          let project = (body && body.project) || null;
          if (!project) {
            try {
              const { resolveProjectFromGoal, listProjects } = await import('./dist/services/cypher/projects.js');
              const known = listProjects(db).map((p) => p.id);
              project = resolveProjectFromGoal(goal, known);
            } catch {
              project = 'wi';
            }
          }
          // Insert the cypher_sessions row + the /board card up-front so the
          // UI can render the card even if the loop stalls. Idempotent on PK.
          try {
            // v104 dispatch_source: honest write-time provenance per ADR-050
            // Phase 0. Default is 'unknown' (fail-honest): an unmarked caller is
            // never silently promoted into the trusted 'user' bucket, so a
            // forgotten tag understates M2 confidence rather than inflating it
            // with fake successes. Genuine human dispatches set 'user' explicitly;
            // smoke scripts set 'smoke'. (See GATE-RESOLVED Issue 2.)
            const dispatchSource = (body && body.dispatch_source) || 'unknown';
            db.prepare(
              `INSERT OR IGNORE INTO cypher_sessions(
                 session_id, goal, task_class, user, status, started_at, dispatch_source)
               VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
            ).run(sessionId, goal, (body && body.task_class) || 'generic', user, nowMs, dispatchSource);
            // Board hygiene (2026-07-15): smoke/test dispatches must NOT seed a
            // board card — they polluted /board with ~70% smoke exhaust (goals
            // like "smoke § 20.2"). The cypher_sessions row above still lands
            // as the audit trail; only the human-facing card is suppressed.
            const tc = (body && body.task_class) || 'generic';
            const isSmokeDispatch =
              dispatchSource === 'smoke' || dispatchSource === 'test' ||
              tc === 'smoke' || tc === 'test' || /^smoke\s*§/i.test(goal || '');
            if (!isSmokeDispatch) {
              const taskId = `task_${sessionId.replace(/^cyp_/, '')}`;
              const title = goal.length > 80 ? `${goal.slice(0, 77)}...` : goal;
              // ADR-040 F-UI: assign the next sequential display number.
              const nextCardNum =
                (db.prepare(`SELECT COALESCE(MAX(card_number), 0) + 1 AS n FROM tasks`).get() || {}).n || 1;
              db.prepare(
                `INSERT OR IGNORE INTO tasks(
                   id, title, posture, project, owner_user_id,
                   goal_text, kanban_column, kanban_order, entered_column_at,
                   created_at, last_touched, card_number
                 ) VALUES (?, ?, ?, ?, ?, ?, 'ready', 0, ?, ?, ?, ?)`,
              ).run(taskId, title, (body && body.posture) || 'generic', project, user, goal, nowMs, nowMs, nowMs, nextCardNum);
              db.prepare(
                `UPDATE cypher_sessions SET task_id = ? WHERE session_id = ? AND task_id IS NULL`,
              ).run(taskId, sessionId);
            }
          } catch (seedErr) {
            process.stderr.write(`[wi/dispatch] loop seed failed: ${(seedErr && seedErr.message) || seedErr}\n`);
          }
          // Non-streaming execution. The loop runs fully and returns a
          // structured LoopResult. Timeouts fall through to the loop's
          // own budget guards.
          try {
            const loopResult = await runLoop({
              db,
              session_id: sessionId,
              user,
              goal,
              posture: (body && body.posture) || 'generic',
              task_class: (body && body.task_class) || 'generic',
              task_id: `task_${sessionId.replace(/^cyp_/, '')}`,
              confirm_mode: (body && body.confirm_mode) || 'auto',
              is_interactive: false,
              halt_flag: { get halted() { return false; }, halt() {} },
              phase: process.env.CYPHER_REFINEMENT_ENABLED === '1' ? 'scope' : 'execute',
            });
            json(res, 200, {
              session_id: sessionId,
              engine: 'loop',
              verdict: loopResult.verdict,
              surface: loopResult.surface,
              iterations: loopResult.iterations,
              duration_ms: loopResult.duration_ms,
              tool_calls: loopResult.tool_calls?.length ?? 0,
            });
          } catch (loopErr) {
            process.stderr.write(`[wi/dispatch] loop error: ${(loopErr && loopErr.message) || loopErr}\n`);
            json(res, 500, {
              session_id: sessionId,
              engine: 'loop',
              error: (loopErr && loopErr.message) || String(loopErr),
            });
          }
          return;
        }

        // ── Legacy pipeline path (v2.5 contract or flag off) ───────────────
        const { runCypher } = await import('./dist/services/cypher/run.js');
        const result = await runCypher(body || {}, {
          db,
          palace: typeof palaceClient !== 'undefined' ? palaceClient : null,
        });
        // Rerun-detector — fire only on freshly-opened sessions (no
        // session_id in request). A close-the-loop request that passes
        // an existing session_id is not a "new dispatch" and shouldn't
        // trigger rerun analysis on itself.
        if (result && result.session_id && !(body && body.session_id)) {
          try {
            const { detectRerun } = await import('./dist/services/cypher/outcomes.js');
            const r = detectRerun(db, result.session_id);
            if (r.rerun_rows_written > 0) {
              result.rerun_detected = {
                matched_sessions: r.matched_sessions,
                rows_written: r.rerun_rows_written,
              };
            }
          } catch (rerunErr) {
            // Best-effort: log to stderr, do not break the dispatch.
            process.stderr.write(`[wi/dispatch] rerun-detect failed: ${(rerunErr && rerunErr.message) || rerunErr}\n`);
          }
        }
        // ADR-038 v2.5 D17 — contract evolution. v2.5 callers
        // (contract_version === '2.5') get a result_meta envelope on
        // top of the v2.0 result shape. v2.0 callers (omitted or '2.0')
        // get the result unchanged so existing clients keep working.
        if (body && body.contract_version === '2.5') {
          result.result_meta = buildResultMeta(result, body);
        }
        json(res, 200, result);
      } catch (err) {
        process.stderr.write(`[wi/dispatch] error: ${(err && err.message) || err}\n`);
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // POST /api/wi/dispatch/stream — ADR-037 Phase 4 streaming entry point.
    //
    // Branches on CYPHER_LOOP_ENABLED:
    //   - "1" → runLoop (the ADR-037 D1 tool-use loop, default off until Phase 6).
    //   - any other value (default "0") → falls back to the legacy 9-stage
    //     pipeline via runCypher and emits a single SSE 'result' event so
    //     existing UI consumers continue to work.
    //
    // SSE event schema (Phase 4 / D20):
    //   event: engine    data: { engine: 'loop' | 'pipeline' }  -- first chunk
    //                                                              suppressed by
    //                                                              CYPHER_HIDE_ENGINE_BADGE
    //   event: plan_rendered       data: { plan_shape_hash, phase }
    //   event: confirm_required    data: { question }
    //   event: tool_call_started   data: { call_id, name, input }
    //   event: tool_call_completed data: { call_id, name, duration_ms, ok }
    //   event: text_delta          data: { text }
    //   event: result              data: <LoopResult>
    //   event: error               data: { error, message? }
    //   event: done                data: { verdict, surface }
    //
    // Request body (mirrors /api/wi/dispatch POST):
    //   {
    //     goal:         string                            (required)
    //     user:         string                            (required)
    //     task_class?:  string
    //     session_id?:  string                            (re-enters existing session;
    //                                                      DB row must already exist)
    //     posture?:     'pr-review'|'bug-investigate'|'pm'|'generic'  (default 'generic')
    //     confirm_mode?:'interactive'|'auto'|'reject'                  (default 'interactive';
    //                                                                   non-TTY callers should
    //                                                                   pass 'auto' to actually
    //                                                                   run the loop)
    //   }
    //
    // The route opens a cypher_sessions row when no session_id is supplied
    // — the loop body REQUIRES the row to exist for outcome writeback.
    if (path === '/api/wi/dispatch/stream' && req.method === 'POST') {
      const consumerHeader = (req.headers['x-wi-consumer'] || 'ui').toString().toLowerCase();
      const hideEngineBadge = process.env.CYPHER_HIDE_ENGINE_BADGE === '1';
      // ADR-037 Phase 6 cutover (2026-06-23): default flipped from === '1'
      // to !== '0'. Loop is now the default engine; pipeline remains
      // callable via explicit CYPHER_LOOP_ENABLED=0 (one env-var flip,
      // no code change). Rollback rule: legacy run.ts stays in the
      // codebase for ≥4 weeks post-cutover per execution plan § 7
      // (hardened from 2 weeks on 2026-06-23). See CLAUDE.md §
      // CYPHER_LOOP_ENABLED and .planning/cypher/15-SHADOW-MODE-METRICS.md
      // for the readiness checklist and rollback protocol.
      const useLoop = process.env.CYPHER_LOOP_ENABLED !== '0';

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(res._corsHeaders || {}),
      });
      res.flushHeaders?.();
      res.write('retry: 3000\n\n');

      const send = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
        catch { /* client disconnected */ }
      };

      // Keep-alive every 15s so a long Anthropic call doesn't time out a
      // proxy. The brain/decide/stream route uses the same cadence.
      const keepAlive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 15_000);

      // Halt-flag shared with runLoop. The bridge mutates this on
      // transport disconnect (and, in Phase 4+, on a /stop control
      // message — that wire is not in scope for this commit).
      //
      // 2026-06-23 fix: use `res.on('close')` rather than `req.on('close')`.
      // Node's IncomingMessage emits 'close' as soon as the request body
      // has been fully consumed (`readBody(req)` reads to 'end' a couple of
      // lines below), which races the loop's halt-flag check at the top of
      // its first iteration (loop.ts:677). That made every confirm_mode='auto'
      // dispatch halt at iteration 0 with `duration_ms ≈ 1`, blocking the
      // loop's hot path entirely. ServerResponse emits 'close' only when
      // the underlying socket closes (client disconnect or server `res.end`),
      // which is the lifecycle we actually want for "transport disconnected".
      // See `.planning/cypher/15-SHADOW-MODE-METRICS.md § Why the soak cost
      // is exactly $0` for the discovery trail.
      const haltFlag = { value: false };
      res.on('close', () => {
        haltFlag.value = true;
        clearInterval(keepAlive);
      });

      (async () => {
        let body = {};
        try { body = await readBody(req); } catch { body = {}; }
        const goal = (body && body.goal ? String(body.goal) : '').trim();
        const user = (body && body.user ? String(body.user) : '').trim();
        const taskClass = body && body.task_class ? String(body.task_class) : 'build-feature';
        let sessionId = body && body.session_id ? String(body.session_id) : '';
        const posture = body && body.posture ? String(body.posture) : 'generic';
        const confirmMode = body && body.confirm_mode ? String(body.confirm_mode) : 'interactive';

        try {
          if (!['ui', 'atlas', 'mcp'].includes(consumerHeader)) {
            send('error', { error: 'invalid_consumer', allowed: ['ui', 'atlas', 'mcp'] });
            return;
          }
          if (!goal) { send('error', { error: 'goal_required' }); return; }
          if (!user) { send('error', { error: 'user_required' }); return; }
          if (!['pr-review', 'bug-investigate', 'pm', 'generic'].includes(posture)) {
            send('error', { error: 'invalid_posture', value: posture });
            return;
          }
          if (!['interactive', 'auto', 'reject'].includes(confirmMode)) {
            send('error', { error: 'invalid_confirm_mode', value: confirmMode });
            return;
          }

          // Engine badge — first event before any work fires (D20). Hidden
          // when CYPHER_HIDE_ENGINE_BADGE=1.
          if (!hideEngineBadge) {
            send('engine', { engine: useLoop ? 'loop' : 'pipeline' });
          }

          if (useLoop) {
            // Open a cypher_sessions row if the caller didn't supply one.
            // The loop body needs the row to exist before writeback fires.
            if (!sessionId) {
              const { randomBytes } = await import('node:crypto');
              sessionId = `cyp_${randomBytes(6).toString('hex')}`;
              // posture persisted on session-create (v71, 2026-06-25) so v2.5
              // D8's T1/T2 warm-tier aggregations (Q-2.5.1) can see every loop
              // dispatch. Historical rows stay NULL; selfAssess() treats NULL
              // posture as ineligible for T1/T2 and falls back to T3.
              // v104: dispatch_source — honest write-time provenance. Default
              // 'unknown' (fail-honest): unmarked callers never masquerade as
              // 'user'. Genuine human dispatches set 'user'; smoke sets 'smoke'.
              db.prepare(
                `INSERT INTO cypher_sessions (session_id, goal, task_class, user, status, posture, dispatch_source)
                 VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
              ).run(sessionId, goal, taskClass, user, posture, (body && body.dispatch_source) || 'unknown');
            }

            const { runLoop } = await import('./dist/services/cypher/loop.js');

            // ADR-039 AC-7 commit 2 (2026-06-29) — bridge SCOPE→EXECUTE
            // chain. When CYPHER_REFINEMENT_ENABLED=1, the bridge runs
            // a SCOPE-phase dispatch first to produce a refined_goal
            // brief, then chains an EXECUTE-phase dispatch with the
            // brief pre-loaded as authoritative context. Both halves
            // share the same session_id so cypher_sessions has one
            // row with scope_iters > 0 and refined_goal populated.
            //
            // Halt paths in SCOPE (clarifying question, iter cap,
            // refiner error) skip the EXECUTE half and return the
            // SCOPE result directly — the user replies with the
            // missing info and re-dispatches, at which point SCOPE
            // either produces a valid brief or halts again with a
            // sharper question.
            //
            // When the flag is off (default), only the EXECUTE
            // dispatch runs — today's single-pass behavior, unchanged.
            const refinementEnabled = process.env.CYPHER_REFINEMENT_ENABLED === '1';
            const baseLoopOpts = {
              db,
              palace: typeof palaceClient !== 'undefined' ? palaceClient : null,
              user,
              session_id: sessionId,
              posture,
              task_class: taskClass,
              confirm_mode: confirmMode,
              // Streaming endpoint is always interactive from the loop's
              // perspective — the SSE channel CAN surface confirm_required
              // events. CLI callers asking for non-interactive behavior
              // pass confirm_mode='auto' explicitly.
              is_interactive: true,
              halt_flag: haltFlag,
              on_event: (event) => {
                // Map LoopEvent → SSE event with the same `type` as the
                // event name. The `data` payload drops the `type` field
                // since SSE already encodes it. NOTE: runLoop emits its
                // own `done` event for each phase — when refinement is
                // enabled and SCOPE succeeds, we suppress SCOPE's `done`
                // so the SSE stream only terminates after EXECUTE.
                const { type, ...rest } = event;
                if (refinementEnabled && type === 'done' && rest.verdict === 'success') {
                  // SCOPE just emitted done+success. Don't forward —
                  // EXECUTE is coming.
                  return;
                }
                send(type, rest);
              },
            };

            let result;
            // confirm_mode='reject' is a capability-probe / dry-run path
            // that MUST short-circuit before any model call (per ADR-037
            // D18 + runLoop's existing reject-path contract). Even when
            // refinement is enabled, we skip the SCOPE→EXECUTE chain
            // and let runLoop handle the reject inline as a single
            // dispatch. This preserves smoke § 24.1's "exactly one
            // done event" invariant.
            if (refinementEnabled && confirmMode !== 'reject') {
              // SCOPE phase first.
              send('text_delta', {
                text: '\n[ADR-039 SCOPE phase] refining goal before execute…\n',
              });
              const scopeResult = await runLoop({
                ...baseLoopOpts,
                goal,
                phase: 'scope',
              });
              if (scopeResult.verdict === 'success' && scopeResult.surface) {
                // ADR-053 branch: when enabled, detect cross-repo shape and run PM orchestrator instead of EXECUTE
                let pmHandled = false;
                if (process.env.ADR_053_ENABLED === '1') {
                  try {
                    const { parseRefinedGoal } = await import('./dist/services/cypher/refined-goal-schema.js');
                    // Parse the AUTHORITATIVE persisted brief, not the SSE
                    // surface: the surface may carry a low-confidence
                    // recognition annotation appended by SCOPE (loop.ts
                    // appends "> ⚠️ Low-confidence recognition — best guess
                    // `x`. Rate it … { \"verdict\": … }" after the JSON), which
                    // breaks JSON.parse and silently skipped the PM tier
                    // (dogfood 2026-08-14: 14/15 scenarios fell through).
                    // cypher_sessions.refined_goal is persisted clean BEFORE
                    // the surface is assembled (loop.ts persistRefinedGoal).
                    const persistedRow = db
                      .prepare(`SELECT refined_goal FROM cypher_sessions WHERE session_id = ?`)
                      .get(sessionId);
                    const surfaceJson =
                      persistedRow && typeof persistedRow.refined_goal === 'string'
                        ? persistedRow.refined_goal
                        : typeof scopeResult.surface === 'string'
                          ? scopeResult.surface
                          : null;
                    const parsed = surfaceJson ? parseRefinedGoal(surfaceJson) : { ok: false };
                    if (parsed.ok) {
                      const { briefFromRefinedGoal, detectCrossRepoShape } = await import('./dist/services/cypher/pm-shape-detection.js');
                      const brief = briefFromRefinedGoal(goal, parsed.value);
                      if (detectCrossRepoShape(brief)) {
                        console.info('[ADR-053][metric] orchestrator_engaged', { goal });
                        send('text_delta', { text: '[ADR-053] PM orchestration engaged (feature-cross-repo)\n' });
                        const { draftPlanViaSonnet } = await import('./dist/services/cypher/pm-drafter-sonnet.js');
                        const { architectReviewLive } = await import('./dist/services/cypher/architect-review-live.js');
                        const { runPmOrchestrator } = await import('./dist/services/cypher/pm-orchestrator.js');
                        const emitCard = (card) => {
                          // card.depends_on arrives already resolved to the
                          // parents' COMMITTED task ids — the orchestrator
                          // emits in topological order (parents first) and
                          // maps local draft ids through the committed id
                          // each emitCard call returns.
                          const depIds = Array.isArray(card.depends_on) && card.depends_on.length > 0
                            ? card.depends_on
                            : undefined;
                          // Create via task-memory helper for parity with /api/board/tasks
                          // then rewrite the id to the worker-eligible handle `task_<subtask-id>`.
                          const created = tmCreateTask(db, {
                            title: card.title,
                            posture: card.posture ?? 'generic',
                            intent: 'execute',
                            goal_text: goal,
                            depends_on: depIds,
                          });
                          // Allocate the worker-eligible handle at insert time
                          // (RADAR "emitCard PK-rewrite orphan-edge hazard").
                          // `task_<draft-id>` when free; on collision fall back
                          // to a SESSION-SCOPED handle `task_<session>-<draft-id>`
                          // so sibling goals drafting the same local ids
                          // (the drafter happily reuses `be`/`fe`/`ops`) never
                          // starve each other out of handles. Children resolve
                          // depends_on through the COMMITTED id returned here,
                          // so renumbering NEVER orphans an edge. A persistent
                          // collision throws → the whole plan halts rather than
                          // committing a broken DAG.
                          let newId = `task_${card.id}`;
                          const taken = (id) => db.prepare(`SELECT 1 FROM tasks WHERE id = ?`).get(id);
                          if (taken(newId)) {
                            newId = `task_${sessionId.replace(/^cyp_/, '').slice(0, 8)}-${card.id}`;
                            if (taken(newId)) {
                              throw new Error(
                                `could not allocate unique task handle for '${card.id}' (both ` +
                                  `task_${card.id} and ${newId} are taken)`,
                              );
                            }
                          }
                          try {
                            db.prepare(`UPDATE tasks SET id = ? WHERE id = ?`).run(newId, created.id);
                          } catch (err) {
                            throw new Error(
                              `card emit failed for '${card.id}': handle '${newId}' collision ` +
                                `(${String((err && err.message) || err)})`,
                            );
                          }
                          return newId;
                        };
                        const deps = {
                          draftPlan: (b, notes) => draftPlanViaSonnet(db, b, notes),
                          // Live two-tier architect: deterministic gate first
                          // (structural defects need no Opus spend), then one
                          // semantic LLM review via the `architect` bucket
                          // (Opus, "call sparingly", ≤1×/goal per Q4). The LLM
                          // pass is advisory — infra failure degrades to the
                          // deterministic verdict, never blocks the plan.
                          architectReview: ({ plan, brief: b }) => architectReviewLive(db, { plan, brief: b }),
                          emitCard,
                        };
                        const pmRes = await runPmOrchestrator(brief, deps);
                        if (pmRes.ok) {
                          // SSE surface polish: emit a one-line plan summary and any revise notes
                          if (pmRes.plan_summary) {
                            send('text_delta', { text: `[ADR-053] Plan: ${pmRes.plan_summary}\n` });
                          }
                          if (pmRes.revise_notes_used && pmRes.revise_notes_used.length > 0) {
                            send('text_delta', { text: `[ADR-053] Architect notes applied: ${pmRes.revise_notes_used.join('; ')}\n` });
                          }
                          console.info('[ADR-053][metric] orchestrator_ok', { cards: (pmRes.cards ? pmRes.cards.length : 0), summary: pmRes.plan_summary || '' });
                          send('result', { outcome: 'success', pm_cards: pmRes.cards });
                          send('done', { verdict: 'success', surface: 'PM orchestrator emitted board cards' });
                          pmHandled = true;
                        } else {
                          console.info('[ADR-053][metric] orchestrator_halted', { reason: pmRes.reason || '' });
                          send('text_delta', { text: `[ADR-053] PM orchestration halted: ${pmRes.reason}\n` });
                        }
                      }
                    }
                  } catch (err) {
                    console.info('[ADR-053][metric] orchestrator_error', { error: String((err && err.message) || err) });
                    send('text_delta', { text: `[ADR-053] PM orchestration error: ${String((err && err.message) || err)}\n` });
                  }
                }
                if (!pmHandled) {
                  // Fallback to normal EXECUTE phase
                  send('text_delta', { text: '[ADR-039 SCOPE phase] brief produced; entering EXECUTE phase\n' });
                  const executeGoal =
                    `Original user goal: ${goal}\n\n` +
                    `Refined brief (from SCOPE phase — treat as authoritative interpretation of intent and scope):\n` +
                    scopeResult.surface;
                  result = await runLoop({ ...baseLoopOpts, goal: executeGoal, phase: 'execute' });
                } else {
                  clearInterval(keepAlive); try { res.end(); } catch {}
                  return;
                }
              } else {
                // SCOPE halted (clarifying question, iter cap) or
                // failed. Surface its result directly; user replies
                // and re-dispatches. No EXECUTE in this turn.
                send('text_delta', {
                  text:
                    `[ADR-039 SCOPE phase] halted: ${scopeResult.verdict}. ` +
                    `Re-dispatch with the answer to continue.\n`,
                });
                // Re-emit the suppressed done event so SSE terminates.
                send('done', {
                  verdict: scopeResult.verdict,
                  surface: scopeResult.surface,
                });
                result = scopeResult;
              }
            } else {
              // Refinement off — today's single-pass behavior.
              result = await runLoop({
                ...baseLoopOpts,
                goal,
              });
            }
            // Emit the full LoopResult as a `result` event for consumers
            // that want the structured payload (the loop already emitted
            // `done` via on_event — we don't repeat it).
            // ADR-038 v2.5 D17 — attach result_meta when v2.5 caller.
            if (body && body.contract_version === '2.5' && result) {
              result.result_meta = buildResultMeta(result, body);
            }
            send('result', result);
          } else {
            // Legacy path — runCypher returns the full pipeline result in
            // one shot. Stream it as a single 'result' event + 'done' so
            // SSE consumers don't have to special-case the legacy shape.
            // The legacy path doesn't emit its own 'done' via on_event,
            // so we synthesize one here from the runCypher result.
            const { runCypher } = await import('./dist/services/cypher/run.js');
            const result = await runCypher(body || {}, {
              db,
              palace: typeof palaceClient !== 'undefined' ? palaceClient : null,
            });
            // ADR-038 v2.5 D17 — same envelope for the legacy path.
            if (body && body.contract_version === '2.5' && result) {
              result.result_meta = buildResultMeta(result, body);
            }
            send('result', result);
            send('done', {
              verdict: result && result.outcome ? result.outcome : 'mixed',
              surface: result && result.summary ? result.summary : '',
            });
          }
        } catch (err) {
          console.error('[wi/dispatch/stream] error:', err);
          send('error', {
            error: 'internal_error',
            message: String((err && err.message) || err),
          });
        } finally {
          clearInterval(keepAlive);
          try { res.end(); } catch {}
        }
      })();
      return;
    }

    // ── ADR-053 Phase 3.2: POST /api/wi/resume ──────────────────────────────
    // PM re-entry endpoint (posture='pm-resume'). PM does not stay alive during
    // execution (Q7 Option B); executors emit sub_task_events, and this endpoint
    // lets the user (or a future auto-trigger) fire `/wi resume <parent_goal_id>`
    // so PM reads unresolved events and resolves them (ack) or escalates.
    //
    // AC-S8: returns 404 when ADR_053_ENABLED !== '1' — the whole PM tier is
    // gated off by default and this route must not exist when disabled.
    //
    // Body: { sub_task_id: string, decisions?: Record<kind, 'ack'|'escalate'> }
    // Default decision when unspecified: ack blocker/question/scope_discovery,
    // leave nothing escalated. MVP resolution is deterministic; the live-LLM
    // decision-maker layers on later behind the same flag.
    if (path === '/api/wi/resume' && req.method === 'POST') {
      if (process.env.ADR_053_ENABLED !== '1') {
        json(res, 404, { error: 'not_found', reason: 'ADR-053 PM orchestration disabled' });
        return;
      }
      (async () => {
        try {
          let body = {};
          try { body = await readBody(req); } catch { body = {}; }
          const subTaskId = (body && body.sub_task_id ? String(body.sub_task_id) : '').trim();
          if (!subTaskId) { json(res, 400, { error: 'sub_task_id_required' }); return; }
          const overrides = (body && body.decisions) || {};
          const { pmResume } = await import('./dist/services/cypher/pm-resume.js');
          const decide = (kind) => {
            const action = overrides[kind] === 'escalate' ? 'escalate' : 'ack';
            return { action, note: `pm-resume via bridge (${action})` };
          };
          const result = pmResume(db, subTaskId, decide);
          json(res, 200, { ok: true, sub_task_id: subTaskId, ...result });
        } catch (err) {
          json(res, 500, { error: 'internal_error', message: String((err && err.message) || err) });
        }
      })();
      return;
    }

    // Five endpoints — all read-only except /link, all backed by
    // src/services/cypher/pm.ts (Hard rule 7 — only the helper module
    // touches work_items / work_item_links).
    //
    //   GET  /api/cypher/pm/next?limit=N           — top N pending unblocked items
    //   GET  /api/cypher/pm/status?id=X            — single work item + evidence list
    //   GET  /api/cypher/pm/rollup                 — counts by phase × wave
    //   GET  /api/cypher/pm/impact?kind=X&value=Y  — work items linked to evidence (e.g. file_path)
    //   POST /api/cypher/pm/link                   — append evidence to a work item
    //   GET  /api/cypher/pm/drift?staleDays=N      — rotted items (stale, no commit, dead path)
    //                                                body: { work_item_id, evidence_kind, evidence_value, note? }
    //
    //   GET  /api/cypher/health/priors             — Beta priors + per-skill success rate (slice 81b)
    //   GET  /api/cypher/health/sessions?limit=N   — last N dispatches with verdict + outcome
    //   GET  /api/cypher/health/sessions/:id       — single session drill-down (steps + links + auto_actions)
    //   GET  /api/cypher/health/sessions/stale?ageHours=N&limit=N
    //                                              — pending sessions older than ageHours (default 2, slice 82a-1)
    //   POST /api/cypher/health/sessions/sweep     — bulk-close stale sessions; body: { session_ids[], outcome }
    //   GET  /api/cypher/skill-catalog             — catalog of installed SKILL.md files (phase 82b)
    //
    // CORS allow-list, X-WI-Consumer header, ?user=<n> all pass through
    // by virtue of the bridge's standard middleware running before this
    // handler.
    // ── ADR-040 commit 1: /board kanban read endpoint ──────────────────
    //
    // GET /api/board/tasks — list tasks with optional column filter, ordered
    // by (kanban_column, kanban_order, created_at DESC). Behind the
    // OUTCOME_HONEST_KANBAN_ENABLED env flag; when flag != '1' the route
    // falls through to 404. Read-only; POST/PATCH land in later commits.
    //
    // Query params:
    //   column (optional): 'ready'|'in_progress'|'review'|'e2e'|'done'
    //   limit  (optional): int, default 100, max 500
    //   offset (optional): int, default 0
    //
    // See ADR-040 §5.1 for the sibling /api/board/health endpoint (commit 6).
    if (
      process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1' &&
      path === '/api/board/tasks' &&
      req.method === 'GET'
    ) {
      try {
        const col = url.searchParams.get('column');
        const validCols = ['ready', 'in_progress', 'review', 'e2e', 'done'];
        if (col && !validCols.includes(col)) {
          json(res, 400, { error: `invalid column: ${col}`, valid: validCols });
          return;
        }
        const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500));
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
        const params = [];
        let sql =
          `SELECT t.id, t.title, t.posture, t.goal_text, t.acceptance_text, ` +
          `       t.kanban_column, t.kanban_order, t.assigned_worker_id, ` +
          `       t.blocked, t.blocked_reason, t.entered_column_at, ` +
          `       t.depends_on_json, t.created_at, t.last_touched, ` +
          `       t.project, t.parent_task_id, t.external_ref, t.card_number, ` +
          `       t.needs_answer, t.stalled, t.stalled_reason, ` +
          `       (SELECT COUNT(*) FROM card_comments cc WHERE cc.task_id = t.id) AS comment_count ` +
          `FROM tasks t`;
        if (col) {
          sql += ` WHERE t.kanban_column = ?`;
          params.push(col);
        }
        sql += ` ORDER BY t.kanban_column, t.kanban_order, t.created_at DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);
        const tasks = db.prepare(sql).all(...params);
        json(res, 200, { tasks });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // ── ADR-043 Phase 1: POST /api/board/tasks (create) ─────────────────
    // Board-side task creation with PM fields. Wraps
    // src/services/cypher/task-memory.ts:createTask() so worktree wiring +
    // project validation still fire. Behind BOTH
    // OUTCOME_HONEST_KANBAN_ENABLED=1 (board substrate) AND
    // PM_ORCHESTRATION_ENABLED=1 (PM layer flag).
    //
    // Body:
    //   {
    //     title:            string (required, ≤120 chars)
    //     posture:          string (optional, default 'generic')
    //     goal_text?:       string
    //     acceptance_text?: string
    //     intent?:          'brainstorm' | 'plan' | 'execute' | 'decide' (default 'execute')
    //     priority?:        integer 0..100 (default 50)
    //     effort_points?:   integer in {1,2,3,5,8,13} | null
    //     depends_on?:      string[]  // task ids
    //     external_ref?:    string
    //     project?:         string (default 'wi')
    //     parent_task_id?:  string   // used by ADR-043 Phase 3 (Cypher hook) for follow-up cards
    //   }
    if (
      process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1' &&
      process.env.PM_ORCHESTRATION_ENABLED === '1' &&
      path === '/api/board/tasks' &&
      req.method === 'POST'
    ) {
      try {
        const body = await readBody(req);
        const title = String((body && body.title) || '').trim();
        if (!title) {
          json(res, 400, { error: 'title required' });
          return;
        }
        const validIntents = ['brainstorm', 'plan', 'execute', 'decide'];
        const intent = validIntents.includes(body && body.intent) ? body.intent : 'execute';
        const priority = Number.isInteger(body && body.priority)
          ? Math.max(0, Math.min(100, body.priority))
          : 50;
        const validEffort = [1, 2, 3, 5, 8, 13];
        const effort_points =
          body && body.effort_points === null
            ? null
            : Number.isInteger(body && body.effort_points) && validEffort.includes(body.effort_points)
              ? body.effort_points
              : null;
        const posture = String((body && body.posture) || 'generic');
        const validPostures = ['pr_review', 'bug_investigate', 'pm', 'generic', 'fe', 'be', 'ops'];
        const finalPosture = validPostures.includes(posture) ? posture : 'generic';
        const depends_on = Array.isArray(body && body.depends_on)
          ? body.depends_on.map((s) => String(s)).filter(Boolean)
          : undefined;

        const task = tmCreateTask(db, {
          title: title.slice(0, 120),
          posture: finalPosture,
          external_ref: body && body.external_ref ? String(body.external_ref) : undefined,
          project: body && body.project ? String(body.project) : undefined,
          goal_text: body && body.goal_text ? String(body.goal_text) : undefined,
          acceptance_text: body && body.acceptance_text ? String(body.acceptance_text) : undefined,
          intent,
          priority,
          effort_points,
          depends_on,
        });

        // If parent_task_id was provided, patch it after INSERT (createTask
        // doesn't accept it — it's a separate relationship, not a create-time
        // required field). Used by Phase 3's mid-session capture path.
        if (body && body.parent_task_id) {
          db.prepare(`UPDATE tasks SET parent_task_id = ? WHERE id = ?`).run(
            String(body.parent_task_id),
            task.id,
          );
        }

        // Fetch back with all board columns so the response mirrors GET shape.
        const row = db
          .prepare(
            `SELECT id, title, posture, status, goal_text, acceptance_text,
                    kanban_column, kanban_order, assigned_worker_id,
                    blocked, blocked_reason, entered_column_at, depends_on_json,
                    created_at, last_touched, project, parent_task_id,
                    external_ref, card_number, needs_answer, stalled, stalled_reason,
                    priority, effort_points, intent
               FROM tasks WHERE id = ?`,
          )
          .get(task.id);
        json(res, 201, { task: row });
      } catch (err) {
        json(res, 400, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // ── ADR-043 Phase 1: GET /api/board/backlog ─────────────────────────
    // Returns the ranked backlog. Consumed by /pm next and /pm backlog.
    //
    // Query params:
    //   limit  (optional): int, default 20, max 500
    //   intent (optional): 'execute' (default) | 'all'
    //   scope  (optional): 'ready' (default) | 'open'
    //
    // Response shape (pinned by ADR-043 AC-S4):
    //   {
    //     top_task_id: string | null,
    //     backlog: [
    //       {
    //         id, title, intent, kanban_column, priority,
    //         effort_points, blocked, card_number,
    //         rank_score,
    //         reasons: [{ signal, value, weight, contribution }, ...]
    //       }, ...
    //     ]
    //   }
    // Invariant: sum(reasons[i].contribution) == rank_score (± 0.01).
    if (
      process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1' &&
      process.env.PM_ORCHESTRATION_ENABLED === '1' &&
      path === '/api/board/backlog' &&
      req.method === 'GET'
    ) {
      try {
        const { computeBacklogRank } = await import('./dist/services/board/ranker.js');
        const limit = Math.max(
          1,
          Math.min(500, parseInt(url.searchParams.get('limit') || '20', 10)),
        );
        const intentQ = url.searchParams.get('intent');
        const scopeQ = url.searchParams.get('scope');
        const intent = intentQ === 'all' ? 'all' : 'execute';
        const scope = scopeQ === 'open' ? 'open' : 'ready';
        const result = computeBacklogRank(db, { limit, intent, scope });
        json(res, 200, result);
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // ── ADR-040 F-UI (2026-07-09): PATCH /api/board/tasks/:id ────────────
    // Manual column move + reorder + block-toggle from the UI. Behind
    // OUTCOME_HONEST_KANBAN_ENABLED. Body accepts any subset of:
    //   { kanban_column, kanban_order, blocked, blocked_reason }
    //
    // The `kanban_column = 'done'` transition still hits the SQL trigger
    // `tasks_done_requires_user_observed` — a manual UI move to `done`
    // WILL FAIL unless the user has already lodged a user_observed
    // outcome_evidence row (that's the DoD contract, §2.4). All other
    // column transitions are freely movable.
    if (
      process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1' &&
      path.startsWith('/api/board/tasks/') &&
      req.method === 'PATCH'
    ) {
      const taskId = path.slice('/api/board/tasks/'.length).split('/')[0];
      if (!taskId) {
        json(res, 400, { error: 'task id required' });
        return;
      }
      try {
        const body = await readBody(req);
        const validCols = ['ready', 'in_progress', 'review', 'e2e', 'done'];
        const patch = {};
        if (body && typeof body.kanban_column === 'string') {
          if (!validCols.includes(body.kanban_column)) {
            json(res, 400, { error: `invalid kanban_column: ${body.kanban_column}`, valid: validCols });
            return;
          }
          patch.kanban_column = body.kanban_column;
        }
        if (body && typeof body.kanban_order === 'number') patch.kanban_order = body.kanban_order;
        if (body && (body.blocked === 0 || body.blocked === 1)) patch.blocked = body.blocked;
        if (body && (typeof body.blocked_reason === 'string' || body.blocked_reason === null)) {
          patch.blocked_reason = body.blocked_reason;
        }
        // ADR-043 Phase 1: PM fields are patchable behind PM_ORCHESTRATION_ENABLED.
        // Priority 0-100 clamp; effort in {null,1,2,3,5,8,13}; intent enum.
        if (process.env.PM_ORCHESTRATION_ENABLED === '1') {
          if (body && Number.isInteger(body.priority)) {
            patch.priority = Math.max(0, Math.min(100, body.priority));
          }
          if (body && (body.effort_points === null || [1,2,3,5,8,13].includes(body.effort_points))) {
            patch.effort_points = body.effort_points;
          }
          const validIntents = ['brainstorm', 'plan', 'execute', 'decide'];
          if (body && validIntents.includes(body.intent)) {
            patch.intent = body.intent;
          }
        }
        if (Object.keys(patch).length === 0) {
          json(res, 400, { error: 'no updatable fields in body' });
          return;
        }
        const nowMs = Date.now();
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(patch)) {
          sets.push(`${k} = ?`);
          vals.push(v);
        }
        if (patch.kanban_column) {
          sets.push('entered_column_at = ?');
          vals.push(nowMs);
          // Free the worker on any move away from in_progress.
          if (patch.kanban_column !== 'in_progress') {
            sets.push('assigned_worker_id = NULL');
          }
        }
        sets.push('last_touched = ?');
        vals.push(nowMs);
        vals.push(taskId);
        try {
          const info = db
            .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
            .run(...vals);
          if (info.changes === 0) {
            json(res, 404, { error: 'task not found', id: taskId });
            return;
          }
          // If the move frees a worker's current_task_id link, clear it.
          if (patch.kanban_column && patch.kanban_column !== 'in_progress') {
            db.prepare(`UPDATE workers SET current_task_id = NULL WHERE current_task_id = ?`)
              .run(taskId);
          }
          const row = db
            .prepare(
              `SELECT id, title, posture, goal_text, acceptance_text, kanban_column, kanban_order,
                      assigned_worker_id, blocked, blocked_reason, entered_column_at, depends_on_json,
                      created_at, last_touched, project, parent_task_id, external_ref, card_number,
                      priority, effort_points, intent, stalled, stalled_reason
                 FROM tasks WHERE id = ?`,
            )
            .get(taskId);
          json(res, 200, { task: row });
        } catch (sqlErr) {
          // The DoD SQL trigger surfaces here with the human-readable
          // message from RAISE(ABORT, ...). Return 409 not 500 — this
          // is a legitimate business-rule refusal, not a server error.
          const msg = (sqlErr && sqlErr.message) || String(sqlErr);
          if (/user_observed|verified_via/i.test(msg)) {
            json(res, 409, {
              error: 'done_requires_user_observed',
              detail: msg,
              hint: 'Move to `e2e` first, then verify + click 👍 to close.',
            });
          } else {
            throw sqlErr;
          }
        }
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // ── ADR-040 F-UI (2026-07-09): card comment thread ───────────────────
    // GET  /api/board/tasks/:id/comments — list the card's activity + Q&A
    //      thread (progress / question / answer / note) oldest-first.
    // POST /api/board/tasks/:id/comments { body, author?, kind? } — add a
    //      comment. When kind='answer' (the default for user posts) the
    //      card's needs_answer flag is cleared so it leaves the
    //      "needs answer" state on the board.
    if (
      process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1' &&
      /^\/api\/board\/tasks\/[^/]+\/comments$/.test(path)
    ) {
      const taskId = path.split('/')[4];
      if (req.method === 'GET') {
        try {
          const rows = db
            .prepare(
              `SELECT id, task_id, author, kind, body, created_at
                 FROM card_comments WHERE task_id = ? ORDER BY created_at ASC`,
            )
            .all(taskId);
          const t = db
            .prepare(`SELECT needs_answer FROM tasks WHERE id = ?`)
            .get(taskId);
          json(res, 200, { comments: rows, needs_answer: t ? t.needs_answer : 0 });
        } catch (err) {
          json(res, 500, { error: (err && err.message) || String(err) });
        }
        return;
      }
      if (req.method === 'POST') {
        try {
          const body = await readBody(req);
          const text = String((body && body.body) || '').trim();
          if (!text) {
            json(res, 400, { error: 'comment body required' });
            return;
          }
          const author = ['worker', 'cypher', 'user', 'system'].includes(body && body.author)
            ? body.author
            : 'user';
          const kind = ['progress', 'question', 'answer', 'note'].includes(body && body.kind)
            ? body.kind
            : 'answer';
          const exists = db.prepare(`SELECT 1 FROM tasks WHERE id = ?`).get(taskId);
          if (!exists) {
            json(res, 404, { error: 'task not found', id: taskId });
            return;
          }
          const { randomBytes } = await import('node:crypto');
          const id = `cmt_${randomBytes(6).toString('hex')}`;
          const nowMs = Date.now();
          db.prepare(
            `INSERT INTO card_comments(id, task_id, author, kind, body, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(id, taskId, author, kind, text, nowMs);
          // A user answer (or any answer) clears the needs_answer flag.
          if (kind === 'answer') {
            db.prepare(`UPDATE tasks SET needs_answer = 0, last_touched = ? WHERE id = ?`)
              .run(nowMs, taskId);
          }
          json(res, 201, {
            comment: { id, task_id: taskId, author, kind, body: text, created_at: nowMs },
          });
        } catch (err) {
          json(res, 500, { error: (err && err.message) || String(err) });
        }
        return;
      }
    }

    // ── ADR-040 F-UI (2026-07-10): GET /api/board/workers ───────────────
    // Worker roster + free/on-duty rollup for the board header strip.
    // Each worker: number, profile_hint, health, current card (+ its number
    // + goal), heartbeat freshness. Rollup: total / on_duty / free / stale.
    if (
      process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1' &&
      path === '/api/board/workers' &&
      req.method === 'GET'
    ) {
      try {
        const nowMs = Date.now();
        const rows = db
          .prepare(
            `SELECT w.number, w.profile_hint, w.health_status, w.current_task_id,
                    w.last_active_at,
                    t.card_number AS card_number, t.goal_text AS goal_text,
                    t.stalled AS card_stalled
               FROM workers w
               LEFT JOIN tasks t ON t.id = w.current_task_id
              ORDER BY w.number ASC`,
          )
          .all();
        const workers = rows.map((r) => ({
          number: r.number,
          profile_hint: r.profile_hint,
          health_status: r.health_status,
          on_duty: r.current_task_id != null,
          current_card_number: r.card_number ?? null,
          current_goal: r.goal_text ?? null,
          current_task_stalled: r.card_stalled === 1,
          heartbeat_age_sec: Math.round((nowMs - r.last_active_at) / 1000),
        }));
        const on_duty = workers.filter((w) => w.on_duty).length;
        json(res, 200, {
          workers,
          total: workers.length,
          on_duty,
          free: workers.length - on_duty,
        });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // ── ADR-040 F-UI (2026-07-10): POST /api/board/tasks/:id/retrigger ───
    // Re-dispatch a stalled card's goal as a fresh session and clear the
    // stalled flag. Used by the UI "Retrigger" button on cards whose prior
    // dispatch died (session stuck 'pending' with no live run). Sends the
    // card back to `ready` so the BoardWorkerAgent picks it up fresh.
    if (
      process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1' &&
      req.method === 'POST' &&
      /^\/api\/board\/tasks\/[^/]+\/retrigger$/.test(path)
    ) {
      const taskId = path.split('/')[4];
      try {
        const t = db
          .prepare(`SELECT id, goal_text, project FROM tasks WHERE id = ?`)
          .get(taskId);
        if (!t) {
          json(res, 404, { error: 'task not found', id: taskId });
          return;
        }
        const nowMs = Date.now();
        // Reset the card: clear stalled, unassign, back to ready.
        db.prepare(
          `UPDATE tasks SET stalled = 0, stalled_reason = NULL, needs_answer = 0,
                  assigned_worker_id = NULL, kanban_column = 'ready',
                  entered_column_at = ?, last_touched = ? WHERE id = ?`,
        ).run(nowMs, nowMs, taskId);
        db.prepare(`UPDATE workers SET current_task_id = NULL WHERE current_task_id = ?`)
          .run(taskId);
        // Detach any dead session so a fresh dispatch can relink.
        db.prepare(`UPDATE cypher_sessions SET task_id = NULL WHERE task_id = ? AND status = 'pending'`)
          .run(taskId);
        // Re-dispatch (2026-07-15): resetting to 'ready' is NOT enough — the
        // BoardWorkerAgent only advances the kanban column (ready→in_progress
        // via assign()); it never ORIGINATES a dispatch. Card creation is the
        // only other seed path. So a bare reset left the card parked in
        // in_progress with no runLoop ever firing → zombie-stall at the 30-min
        // sweep (observed on cards #22/#23). Re-seed a fresh session for the
        // card's goal and fire runLoop FIRE-AND-FORGET so the HTTP response
        // returns immediately (bridge-must-never-block rule) while the loop
        // runs in the background — exactly how the streaming path detaches.
        const goalText = (t.goal_text && String(t.goal_text).trim()) || '';
        let newSessionId = null;
        if (goalText) {
          const { randomBytes } = await import('node:crypto');
          newSessionId = `cyp_${randomBytes(6).toString('hex')}`;
          // v104 dispatch_source: this path is /retrigger — the BoardWorkerAgent
          // re-dispatches a stalled card. That's agent-invoked, not user-invoked.
          db.prepare(
            `INSERT OR IGNORE INTO cypher_sessions(
               session_id, goal, task_class, user, status, started_at, task_id, dispatch_source)
             VALUES (?, ?, 'generic', 'maaz', 'pending', ?, ?, 'agent')`,
          ).run(newSessionId, goalText, nowMs, taskId);
          // Fire-and-forget: do NOT await. Errors are logged, not surfaced —
          // the card is already back on the board and will reflect the loop's
          // outcome via the normal session→column watcher.
          (async () => {
            try {
              const { runLoop } = await import('./dist/services/cypher/loop.js');
              await runLoop({
                db,
                session_id: newSessionId,
                user: 'maaz',
                goal: goalText,
                posture: 'generic',
                task_class: 'generic',
                task_id: taskId,
                confirm_mode: 'auto',
                is_interactive: false,
                halt_flag: { get halted() { return false; }, halt() {} },
                phase: process.env.CYPHER_REFINEMENT_ENABLED === '1' ? 'scope' : 'execute',
              });
            } catch (redispatchErr) {
              process.stderr.write(
                `[board/retrigger] re-dispatch loop error for ${taskId}: ${(redispatchErr && redispatchErr.message) || redispatchErr}\n`,
              );
            }
          })();
        }
        db.prepare(
          `INSERT INTO card_comments(id, task_id, author, kind, body, created_at)
           VALUES (?, ?, 'user', 'note', ?, ?)`,
        ).run(
          `cmt_${(await import('node:crypto')).randomBytes(6).toString('hex')}`,
          taskId,
          newSessionId
            ? `🔄 Retriggered by user — fresh dispatch ${newSessionId} started.`
            : '🔄 Retriggered by user — card reset to ready (no goal_text to re-dispatch).',
          nowMs,
        );
        json(res, 200, { ok: true, id: taskId, kanban_column: 'ready', session_id: newSessionId });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // ── ADR-040 commit 4.5: outcome-evidence endpoints ─────────────────
    //
    // POST /api/outcome-evidence/token — issue a fresh interaction token
    // for a (task_id, session_id) pair. 5-min TTL, single-use, guarded
    // by OUTCOME_HONEST_KANBAN_ENABLED. Returns 201 {token, expires_at}.
    //
    // POST /api/outcome-evidence — consume a token, validate the DoD
    // condition-2 mechanism (non-empty hash, non-stale hash), INSERT
    // outcome_evidence with verified_via='user_observed'. This is the
    // sole path by which server code writes user_observed rows; a
    // Cypher session cannot spoof one without a token.
    //
    // See ADR-040 §2.4 condition (2), AC-U10, .planning/adr-040-commit-4.5-plan.md.
    if (
      process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1' &&
      path === '/api/outcome-evidence/token' &&
      req.method === 'POST'
    ) {
      try {
        const body = (await readBody(req)) || {};
        const { task_id, session_id } = body;
        if (!task_id || !session_id) {
          json(res, 400, { error: 'task_id and session_id required' });
          return;
        }
        const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(task_id);
        if (!task) { json(res, 404, { error: `task_id ${task_id} not found` }); return; }
        const sess = db.prepare('SELECT session_id FROM cypher_sessions WHERE session_id = ?').get(session_id);
        if (!sess) { json(res, 404, { error: `session_id ${session_id} not found` }); return; }

        const { randomBytes } = await import('node:crypto');
        const token = randomBytes(16).toString('hex');
        const now = Date.now();
        const expires_at = now + 5 * 60 * 1000; // 5-min TTL
        db.prepare(
          `INSERT INTO interaction_tokens(id, task_id, session_id, issued_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(token, task_id, session_id, now, expires_at);
        json(res, 201, { token, expires_at });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    if (
      process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1' &&
      path === '/api/outcome-evidence' &&
      req.method === 'POST'
    ) {
      try {
        const body = (await readBody(req)) || {};
        const {
          token, task_id, session_id, verifier_session_id,
          verification_output_hash, non_fixture_identifier, verdict, raw_payload,
        } = body;

        // Field-presence gate.
        const missing = [];
        for (const [k, v] of Object.entries({
          token, task_id, session_id, verifier_session_id,
          verification_output_hash, non_fixture_identifier, verdict,
        })) if (!v) missing.push(k);
        if (missing.length) {
          json(res, 400, { error: 'missing required fields', missing });
          return;
        }

        // Empty-hash guard: sha256('') is a hard reject (Maaz clicked
        // without running the flow). Constant is derived, not magic.
        const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
        if (verification_output_hash === EMPTY_SHA256) {
          json(res, 422, { error: 'empty_hash', detail: 'verification_output_hash is sha256("") — capture appears empty' });
          return;
        }

        // Stale-hash guard: reject any hash used by a *different* task
        // in the last 24h. Same-task re-attempts are fine (rework loop).
        const dayAgo = Date.now() - 24 * 3600 * 1000;
        const stale = db.prepare(
          `SELECT id, task_id FROM outcome_evidence
            WHERE verification_output_hash = ? AND task_id != ? AND created_at > ?
            LIMIT 1`,
        ).get(verification_output_hash, task_id, dayAgo);
        if (stale) {
          json(res, 422, {
            error: 'stale_hash',
            detail: `hash reused from task_id=${stale.task_id} within 24h — clipboard likely stale`,
          });
          return;
        }

        // Consume the token atomically. If UPDATE hits 0 rows, the
        // token is invalid, expired, or already consumed.
        const now = Date.now();
        const consumed = db.prepare(
          `UPDATE interaction_tokens
              SET consumed_at = ?
            WHERE id = ? AND task_id = ? AND session_id = ?
              AND consumed_at IS NULL AND expires_at > ?`,
        ).run(now, token, task_id, session_id, now);
        if (consumed.changes !== 1) {
          json(res, 403, { error: 'invalid_or_consumed_token' });
          return;
        }

        // Ensure the verifier session exists as an FK target. Client
        // hands us a fresh 'cyp_ui_<hex>' per capture; we materialize
        // the row here so outcome_evidence.created_by_session_id has
        // a valid FK target. Idempotent via INSERT OR IGNORE.
        // v104 dispatch_source: this is a verifier session inserted by a
        // separate agent to satisfy outcome_evidence FK — 'agent' provenance.
        db.prepare(
          `INSERT OR IGNORE INTO cypher_sessions(session_id, goal, task_class, user, status, dispatch_source)
           VALUES (?, ?, '*', 'maaz', 'done', 'agent')`,
        ).run(verifier_session_id, `Verifier session for ${task_id}`);

        // INSERT the evidence row. The row-level CHECKs on
        // outcome_evidence enforce author-independence + non-null
        // hash + non-null non-fixture-id. verifier_session_id !=
        // session_id is verified there — no need to double-check here.
        const { randomBytes } = await import('node:crypto');
        const oe_id = 'oe_' + randomBytes(8).toString('hex');
        try {
          db.prepare(
            `INSERT INTO outcome_evidence(
               id, task_id, session_id, created_by_session_id,
               tier, verified_via, verdict,
               verification_output_hash, raw_payload, non_fixture_identifier, created_at
             ) VALUES (?, ?, ?, ?, 6, 'user_observed', ?, ?, ?, ?, ?)`,
          ).run(
            oe_id, task_id, session_id, verifier_session_id, verdict,
            verification_output_hash, JSON.stringify(raw_payload || {}),
            non_fixture_identifier, now,
          );
        } catch (checkErr) {
          // CHECK failures land here (e.g. author-independence violation
          // if the client somehow slipped through the token layer).
          json(res, 422, { error: 'check_failed', detail: (checkErr && checkErr.message) || String(checkErr) });
          return;
        }
        // ADR-040 F-UI (2026-07-10) fix: the evidence write alone didn't
        // move the card — the handler INSERTed the user_observed row then
        // stopped, so 👍 left the card stuck in e2e. Now transition it:
        //   pass → done  (DoD §2.4; SQL trigger re-verifies the evidence)
        //   fail → in_progress  (failure loop §2.7 — rework)
        let moved_to = null;
        try {
          if (verdict === 'pass') {
            db.prepare(
              `UPDATE tasks SET kanban_column = 'done', entered_column_at = ?, last_touched = ? WHERE id = ?`,
            ).run(now, now, task_id);
            moved_to = 'done';
          } else if (verdict === 'fail') {
            db.prepare(
              `UPDATE tasks SET kanban_column = 'in_progress', entered_column_at = ?, last_touched = ? WHERE id = ?`,
            ).run(now, now, task_id);
            moved_to = 'in_progress';
          }
        } catch (moveErr) {
          // The DoD trigger can still ABORT (e.g. a race that removed the
          // evidence). Evidence is written; report the move failure so the
          // UI can surface it rather than silently leaving the card in e2e.
          json(res, 200, {
            id: oe_id,
            verified_via: 'user_observed',
            moved_to: null,
            move_error: (moveErr && moveErr.message) || String(moveErr),
          });
          return;
        }
        json(res, 201, { id: oe_id, verified_via: 'user_observed', moved_to });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // ── ADR-040 commit 5: panel dispatch trigger ─────────────────────────
    // POST /api/board/tasks/:id/panel — manually fire the panel for a card
    // in `review`. Async in spirit: returns the panel_review_id and
    // panel result summary. Behind OUTCOME_HONEST_KANBAN_ENABLED.
    if (
      process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1' &&
      req.method === 'POST' &&
      path.startsWith('/api/board/tasks/') && path.endsWith('/panel')
    ) {
      try {
        const taskId = path.slice('/api/board/tasks/'.length, -'/panel'.length);
        const { runPanel } = await import('./dist/services/cypher/panel.js');
        const result = await runPanel(db, taskId);
        if (!result) {
          json(res, 400, { error: 'task not in review or not found' });
          return;
        }
        json(res, 200, result);
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // ── ADR-040 commit 6: /api/board/health ──────────────────────────────
    // Header-strip source per ADR §5.1. Returns snapshot metrics the /board
    // UI renders + AC-S15 drift alert. Behind OUTCOME_HONEST_KANBAN_ENABLED.
    if (
      process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1' &&
      path === '/api/board/health' &&
      req.method === 'GET'
    ) {
      try {
        const now = Date.now();
        const weekAgo = now - 7 * 24 * 3600 * 1000;
        const monthAgo = now - 30 * 24 * 3600 * 1000;
        const driftThreshold = Number(process.env.VERIFIED_VIA_DRIFT_THRESHOLD ?? 0.40);

        // cards_in_flight: worker_number → current_task_id (or null)
        const cardsInFlight = {};
        const workers = db
          .prepare('SELECT number, current_task_id FROM workers ORDER BY number')
          .all();
        for (const w of workers) cardsInFlight[w.number] = w.current_task_id;

        // panel_unanimity_rate_7d
        const punRow = db
          .prepare(
            `SELECT
               COALESCE(SUM(CASE WHEN unanimous=1 THEN 1 ELSE 0 END), 0) AS unan,
               COUNT(*) AS total
             FROM panel_reviews WHERE started_at > ?`,
          )
          .get(weekAgo);
        const panelUnanimityRate7d = punRow.total > 0 ? punRow.unan / punRow.total : 0;

        // avg_age_per_column
        const avgAgeRows = db
          .prepare(
            `SELECT kanban_column,
                    AVG((? - COALESCE(entered_column_at, created_at)) / (1000.0 * 3600 * 24)) AS avg_days
             FROM tasks WHERE kanban_column != 'done'
             GROUP BY kanban_column`,
          )
          .all(now);
        const avgAgePerColumn = { ready: 0, in_progress: 0, review: 0, e2e: 0, done: 0 };
        for (const r of avgAgeRows) avgAgePerColumn[r.kanban_column] = Number(r.avg_days.toFixed(2));

        // verified_via_distribution_30d + self_reported_fraction + alert
        const vvRows = db
          .prepare(
            `SELECT verified_via, COUNT(*) AS n FROM outcome_evidence
              WHERE created_at > ? GROUP BY verified_via`,
          )
          .all(monthAgo);
        const vvDist = { self_reported: 0, smoke_passed: 0, cross_family_checked: 0, user_observed: 0 };
        let vvTotal = 0;
        for (const r of vvRows) { vvDist[r.verified_via] = r.n; vvTotal += r.n; }
        const selfReportedFraction = vvTotal > 0 ? vvDist.self_reported / vvTotal : 0;
        const selfReportedAlert = selfReportedFraction > driftThreshold;

        // panel_disagreement_rate_7d + injection + cost_capped counts
        const pdRow = db
          .prepare(
            `SELECT
               COALESCE(SUM(CASE WHEN panel_disagreement=1 THEN 1 ELSE 0 END), 0) AS disag,
               COALESCE(SUM(CASE WHEN injection_detected=1 THEN 1 ELSE 0 END), 0) AS inj,
               COALESCE(SUM(CASE WHEN cost_capped=1 THEN 1 ELSE 0 END), 0) AS cc,
               COUNT(*) AS total
             FROM panel_reviews WHERE started_at > ?`,
          )
          .get(weekAgo);
        const panelDisagreementRate7d = pdRow.total > 0 ? pdRow.disag / pdRow.total : 0;

        // weekly_spend_usd_current
        const spendRow = db
          .prepare('SELECT COALESCE(SUM(usd_estimated), 0) AS usd FROM cost_ledger WHERE created_at > ?')
          .get(weekAgo);

        // wip_cap_hit_rate_7d — not materialized (subagent_dispatches write kept for
        // Cypher board-worker, but cap-hit-rate query never landed). Phase 88-1:
        // kept as 0 placeholder for future work.

        json(res, 200, {
          cards_in_flight: cardsInFlight,
          panel_unanimity_rate_7d: Number(panelUnanimityRate7d.toFixed(3)),
          wip_cap_hit_rate_7d: 0,
          avg_age_per_column: avgAgePerColumn,
          verified_via_distribution_30d: vvDist,
          self_reported_fraction_30d: Number(selfReportedFraction.toFixed(3)),
          self_reported_alert: selfReportedAlert,
          panel_disagreement_rate_7d: Number(panelDisagreementRate7d.toFixed(3)),
          injection_detected_count_7d: pdRow.inj,
          cost_capped_events_7d: pdRow.cc,
          weekly_spend_usd_current: Number(spendRow.usd.toFixed(2)),
        });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    if (path === '/api/cypher/pm/next' && req.method === 'GET') {
      try {
        const { nextItems } = await import('./dist/services/cypher/pm.js');
        const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '5', 10), 100));
        const items = nextItems(db, limit);
        json(res, 200, { items, total: items.length });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    if (path === '/api/cypher/pm/status' && req.method === 'GET') {
      try {
        const id = url.searchParams.get('id');
        if (!id) { json(res, 400, { error: 'id query param required' }); return; }
        const { getWorkItem, evidenceFor } = await import('./dist/services/cypher/pm.js');
        const item = getWorkItem(db, id);
        if (!item) { json(res, 404, { error: `work_item not found: ${id}` }); return; }
        const evidence = evidenceFor(db, id);
        json(res, 200, { item, evidence });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    if (path === '/api/cypher/pm/rollup' && req.method === 'GET') {
      try {
        const { statusRollup } = await import('./dist/services/cypher/pm.js');
        json(res, 200, { rollup: statusRollup(db) });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    if (path === '/api/cypher/pm/impact' && req.method === 'GET') {
      try {
        const kind = url.searchParams.get('kind');
        const value = url.searchParams.get('value');
        const VALID_KINDS = ['commit_sha', 'cypher_session_id', 'smoke_section', 'file_path', 'pr_url'];
        if (!kind || !value) { json(res, 400, { error: 'kind and value query params required' }); return; }
        if (!VALID_KINDS.includes(kind)) { json(res, 400, { error: `kind must be one of: ${VALID_KINDS.join(', ')}` }); return; }
        const { impactedBy } = await import('./dist/services/cypher/pm.js');
        const items = impactedBy(db, kind, value);
        json(res, 200, { items, total: items.length });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    if (path === '/api/cypher/pm/link' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const id = body && body.work_item_id;
        const kind = body && body.evidence_kind;
        const value = body && body.evidence_value;
        const note = body && body.note;
        const VALID_KINDS = ['commit_sha', 'cypher_session_id', 'smoke_section', 'file_path', 'pr_url'];
        if (!id || !kind || !value) {
          json(res, 400, { error: 'work_item_id, evidence_kind, evidence_value all required' });
          return;
        }
        if (!VALID_KINDS.includes(kind)) {
          json(res, 400, { error: `evidence_kind must be one of: ${VALID_KINDS.join(', ')}` });
          return;
        }
        const { getWorkItem, linkEvidence } = await import('./dist/services/cypher/pm.js');
        if (!getWorkItem(db, id)) { json(res, 404, { error: `work_item not found: ${id}` }); return; }
        linkEvidence(db, id, kind, value, note);
        json(res, 200, { ok: true, work_item_id: id, evidence_kind: kind, evidence_value: value });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // GET /api/cypher/pm/drift — surface rotted work_items.
    // Three buckets: stale_in_progress (no movement in N days, default 7),
    // shipped_no_commit (status=shipped without any commit_sha evidence),
    // dead_file_path (file_path evidence pointing at a missing file).
    // Read-only. Cheap (pure SQL + one stat per file_path link).
    // Optional ?staleDays=N overrides the staleness threshold.
    if (path === '/api/cypher/pm/drift' && req.method === 'GET') {
      try {
        const staleDaysParam = url.searchParams.get('staleDays');
        const staleDays = staleDaysParam ? Math.max(1, parseInt(staleDaysParam, 10) || 7) : 7;
        const { detectDrift } = await import('./dist/services/cypher/drift.js');
        const report = detectDrift(db, { staleDays, repoRoot: process.cwd() });
        json(res, 200, report);
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // GET /api/cypher/health/priors — Beta priors snapshot + per-skill
    // success rate (slice 81b). Read-only, two SELECTs.
    if (path === '/api/cypher/health/priors' && req.method === 'GET') {
      try {
        const { getCurrentPriors } = await import('./dist/services/cypher/health.js');
        json(res, 200, getCurrentPriors(db));
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // GET /api/cypher/cost-comparison
    //   ?days=14  (optional, default 14, max 60) — window for the trend
    //
    // Phase 5 / ADR-037 instrumentation: returns the data backing the
    // pipeline-vs-loop cost comparison on /cypher/cost. Pure read against
    // token_usage + cypher_sessions; no Anthropic calls.
    //
    // Response shape:
    //   {
    //     days: 14,
    //     daily: [{ day, cost_total, cost_loop, cost_legacy }],
    //     by_method: [{ method, calls, total_cost, avg_cost }],   -- top 15
    //     dispatches: [{ day, total, loop_n, legacy_n }],         -- by engine
    //     loop_outcomes: [{ outcome, dispatches, avg_duration_ms, avg_tokens }],
    //     summary: {
    //       v14: { window, dispatches, total_cost, avg_per_call },
    //       phase5: { window, dispatches, total_cost, avg_per_call },
    //     },
    //   }
    if (path === '/api/cypher/cost-comparison' && req.method === 'GET') {
      try {
        const daysParam = url.searchParams.get('days');
        const days = daysParam ? Math.max(1, Math.min(60, parseInt(daysParam, 10) || 14)) : 14;
        const windowExpr = `datetime('now', '-${days} days')`;

        // Daily totals — split out loop vs legacy by joining cypher_sessions
        // method-prefix patterns. token_usage doesn't tag engine directly,
        // so we approximate: any cypher_sessions row with engine='loop' in
        // the same wall-clock window contributes its dispatch count to
        // loop_n; cost stays aggregate per day. Imperfect — adequate for
        // Phase 5 visibility.
        const daily = db.prepare(`
          SELECT
            date(recorded_at) AS day,
            SUM(cost_usd) AS cost_total,
            SUM(input_tokens) AS in_tokens,
            SUM(output_tokens) AS out_tokens,
            COUNT(*) AS calls
          FROM token_usage
          WHERE recorded_at > ${windowExpr}
          GROUP BY date(recorded_at)
          ORDER BY day ASC
        `).all();

        const by_method = db.prepare(`
          SELECT
            method,
            COUNT(*) AS calls,
            SUM(cost_usd) AS total_cost,
            AVG(cost_usd) AS avg_cost,
            SUM(input_tokens) AS in_tokens,
            SUM(output_tokens) AS out_tokens
          FROM token_usage
          WHERE recorded_at > ${windowExpr}
          GROUP BY method
          ORDER BY SUM(cost_usd) DESC
          LIMIT 15
        `).all();

        const dispatches = db.prepare(`
          SELECT
            date(started_at) AS day,
            COUNT(*) AS total,
            SUM(CASE WHEN engine = 'loop' THEN 1 ELSE 0 END) AS loop_n,
            SUM(CASE WHEN engine != 'loop' OR engine IS NULL THEN 1 ELSE 0 END) AS legacy_n
          FROM cypher_sessions
          WHERE started_at > ${windowExpr}
          GROUP BY date(started_at)
          ORDER BY day ASC
        `).all();

        const loop_outcomes = db.prepare(`
          SELECT
            COALESCE(outcome, '(open)') AS outcome,
            COUNT(*) AS dispatches,
            AVG(duration_ms) AS avg_duration_ms,
            AVG(total_tokens) AS avg_tokens
          FROM cypher_sessions
          WHERE engine = 'loop'
          GROUP BY outcome
          ORDER BY dispatches DESC
        `).all();

        // Anchored Phase 5 day-0 cutoff = 2026-06-23. v1.4 window =
        // anything before that; soak = anything from that day forward.
        const PHASE5_DAY0 = '2026-06-23';

        // Engine-split daily cost. token_usage rows aren't tagged with a
        // session_id today, so we approximate engine by recorded_at vs
        // the Phase 5 day-0 anchor:
        //   - recorded_at  < PHASE5_DAY0  → pipeline (v1.4)
        //   - recorded_at >= PHASE5_DAY0  → loop (Phase 5 soak)
        // Imperfect — mixed-source caveat surfaced inline in the UI tooltip.
        const daily_split = db.prepare(`
          SELECT
            date(recorded_at) AS day,
            SUM(CASE WHEN date(recorded_at) < ?
                     THEN cost_usd ELSE 0 END) AS pipeline_cost,
            SUM(CASE WHEN date(recorded_at) >= ?
                     THEN cost_usd ELSE 0 END) AS loop_cost,
            SUM(cost_usd) AS total_cost,
            COUNT(*) AS calls
          FROM token_usage
          WHERE recorded_at > ${windowExpr}
          GROUP BY date(recorded_at)
          ORDER BY day ASC
        `).all(PHASE5_DAY0, PHASE5_DAY0);

        // Per-call cost histogram: bucket every call by cost_usd into 6
        // bands, then group by engine (pipeline before day-0, loop after).
        // The CASE-WHEN is the canonical SQL histogram pattern; SQLite has
        // no native PERCENTILE_CONT so this is the cheapest p-distribution
        // proxy we can compute in one query.
        const HISTOGRAM_BUCKETS = [
          { key: 'b1', label: '$0 - $0.01',    lo: 0,    hi: 0.01 },
          { key: 'b2', label: '$0.01 - $0.05', lo: 0.01, hi: 0.05 },
          { key: 'b3', label: '$0.05 - $0.10', lo: 0.05, hi: 0.10 },
          { key: 'b4', label: '$0.10 - $0.50', lo: 0.10, hi: 0.50 },
          { key: 'b5', label: '$0.50 - $1.00', lo: 0.50, hi: 1.00 },
          { key: 'b6', label: '$1.00+',        lo: 1.00, hi: 1e9 },
        ];
        const histo_rows = db.prepare(`
          SELECT
            CASE
              WHEN date(recorded_at) < ? THEN 'pipeline'
              ELSE 'loop'
            END AS engine,
            CASE
              WHEN cost_usd < 0.01 THEN 'b1'
              WHEN cost_usd < 0.05 THEN 'b2'
              WHEN cost_usd < 0.10 THEN 'b3'
              WHEN cost_usd < 0.50 THEN 'b4'
              WHEN cost_usd < 1.00 THEN 'b5'
              ELSE 'b6'
            END AS bucket,
            COUNT(*) AS calls,
            SUM(cost_usd) AS total_cost
          FROM token_usage
          WHERE recorded_at > ${windowExpr}
          GROUP BY engine, bucket
          ORDER BY engine, bucket
        `).all(PHASE5_DAY0);

        // Pivot histo_rows into the {bucket, pipeline, loop} shape the UI wants.
        const cost_histogram = HISTOGRAM_BUCKETS.map((b) => {
          const pipelineRow = histo_rows.find((r) => r.engine === 'pipeline' && r.bucket === b.key);
          const loopRow = histo_rows.find((r) => r.engine === 'loop' && r.bucket === b.key);
          return {
            bucket: b.key,
            label: b.label,
            lo: b.lo,
            hi: b.hi,
            pipeline_calls: pipelineRow ? pipelineRow.calls : 0,
            pipeline_cost: pipelineRow ? pipelineRow.total_cost : 0,
            loop_calls: loopRow ? loopRow.calls : 0,
            loop_cost: loopRow ? loopRow.total_cost : 0,
          };
        });

        // Last 20 dispatches across BOTH engines — for the dispatch ledger.
        // Joins cypher_sessions to surface goal text + engine + outcome.
        // total_tokens / duration_ms come from the session row.
        const recent_dispatches = db.prepare(`
          SELECT
            session_id,
            started_at,
            COALESCE(engine, 'pipeline') AS engine,
            substr(goal, 1, 80) AS goal,
            user,
            task_class,
            COALESCE(outcome, '(open)') AS outcome,
            duration_ms,
            total_tokens
          FROM cypher_sessions
          ORDER BY started_at DESC
          LIMIT 20
        `).all();

        const v14 = db.prepare(`
          SELECT
            COUNT(*) AS dispatches,
            COALESCE(SUM(cost_usd), 0) AS total_cost,
            COALESCE(AVG(cost_usd), 0) AS avg_per_call
          FROM token_usage
          WHERE recorded_at BETWEEN ${windowExpr} AND ?
        `).get(PHASE5_DAY0);
        const phase5 = db.prepare(`
          SELECT
            COUNT(*) AS dispatches,
            COALESCE(SUM(cost_usd), 0) AS total_cost,
            COALESCE(AVG(cost_usd), 0) AS avg_per_call
          FROM token_usage
          WHERE recorded_at >= ?
        `).get(PHASE5_DAY0);

        json(res, 200, {
          days,
          phase5_day0: PHASE5_DAY0,
          daily,
          daily_split,
          cost_histogram,
          recent_dispatches,
          by_method,
          dispatches,
          loop_outcomes,
          summary: {
            v14: { window: `pre-${PHASE5_DAY0}, last ${days} days`, ...v14 },
            phase5: { window: `${PHASE5_DAY0}+`, ...phase5 },
          },
        });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // GET /api/cypher/health/sessions?limit=N — last N dispatches.
    // Default 20, max 100. Out-of-range limit returns 400.
    if (path === '/api/cypher/health/sessions' && req.method === 'GET') {
      try {
        const limitParam = url.searchParams.get('limit');
        const limit = limitParam ? parseInt(limitParam, 10) : 20;
        if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
          json(res, 400, { error: 'limit must be an integer between 1 and 100' });
          return;
        }
        const { getRecentSessions } = await import('./dist/services/cypher/health.js');
        const sessions = getRecentSessions(db, limit);
        json(res, 200, { sessions, total: sessions.length });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // GET /api/cypher/health/sessions/awaiting-user — sessions blocked on
    // user response (status='asked_user') for longer than minMinutes
    // (default 1). Distinct from /sessions/stale which watches 'pending'.
    // Must come before /sessions/:id (catch-all on same prefix).
    if (path === '/api/cypher/health/sessions/awaiting-user' && req.method === 'GET') {
      try {
        const minMinutesParam = url.searchParams.get('minMinutes');
        const minMinutes = minMinutesParam ? Math.max(0, parseFloat(minMinutesParam) || 1) : 1;
        const limitParam = url.searchParams.get('limit');
        const limit = limitParam ? parseInt(limitParam, 10) : 100;
        if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
          json(res, 400, { error: 'limit must be an integer between 1 and 500' });
          return;
        }
        const { getAwaitingUserSessions } = await import('./dist/services/cypher/health.js');
        json(res, 200, getAwaitingUserSessions(db, minMinutes, limit));
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // GET /api/cypher/health/sessions/stale — pending sessions older than
    // ageHours (default 2). Slice 82a-1. Must come before /sessions/:id
    // because :id is a catch-all on the same prefix.
    if (path === '/api/cypher/health/sessions/stale' && req.method === 'GET') {
      try {
        const ageHoursParam = url.searchParams.get('ageHours');
        const ageHours = ageHoursParam ? Math.max(0.25, parseFloat(ageHoursParam) || 2) : 2;
        const limitParam = url.searchParams.get('limit');
        const limit = limitParam ? parseInt(limitParam, 10) : 100;
        if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
          json(res, 400, { error: 'limit must be an integer between 1 and 500' });
          return;
        }
        const { getStaleSessions } = await import('./dist/services/cypher/health.js');
        json(res, 200, getStaleSessions(db, ageHours, limit));
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // POST /api/cypher/health/sessions/sweep — bulk-close stale sessions.
    // Body: { session_ids: string[] (max 50), outcome: 'mixed'|'failed' }.
    // Refuses outcome=success at the type boundary — sweep is by definition
    // not a real success. Updates skill_priors for each session that has
    // a chosen_skill. Slice 82a-1.
    if (path === '/api/cypher/health/sessions/sweep' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (err) { json(res, 400, { error: 'invalid JSON', detail: String(err?.message || err) }); return; }
      const ids = Array.isArray(body?.session_ids) ? body.session_ids.filter(s => typeof s === 'string') : null;
      const outcome = body?.outcome;
      if (!ids || ids.length === 0) { json(res, 400, { error: 'session_ids must be a non-empty array of strings' }); return; }
      if (ids.length > 50) { json(res, 400, { error: 'sweep capped at 50 ids per call' }); return; }
      if (outcome !== 'mixed' && outcome !== 'failed') { json(res, 400, { error: "outcome must be 'mixed' or 'failed'" }); return; }
      try {
        const { sweepStaleSessions } = await import('./dist/services/cypher/sweep.js');
        json(res, 200, sweepStaleSessions(db, ids, outcome));
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // GET /api/cypher/skill-catalog — phase 82b. Read-only listing
    // of every SKILL.md the discovery scanner has registered. Lets
    // the panel show what Cypher can see vs. what it has used.
    if (path === '/api/cypher/skill-catalog' && req.method === 'GET') {
      try {
        const { getCatalog } = await import('./dist/services/cypher/skill-discovery.js');
        json(res, 200, getCatalog(db));
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // GET /api/mcp/health — per-server reachability ping for every registered
    // MCP. Loops mcp_oauth_tokens, fires a cheap listTools() with a 3s timeout
    // each, returns {servers:[{name, url, reachable, error, latency_ms}]}. The
    // menubar surfaces unreachable servers as a critical signal (distinct from
    // /api/mcp/tokens which only reports OAuth expiry — a server can have a
    // fresh token but be down, or vice versa).
    if (path === '/api/mcp/health' && req.method === 'GET') {
      try {
        const rows = db.prepare(
          `SELECT server_name, server_url FROM mcp_oauth_tokens`
        ).all();
        const { McpClient } = await import('./dist/fetcher/sources/mcp-oauth-client.js');
        const probes = await Promise.all(rows.map(async (r) => {
          const t0 = Date.now();
          try {
            const client = new McpClient(db, r.server_name, r.server_url);
            // listTools is the cheapest call that proves auth + transport +
            // server side are alive. 3s upper bound enforced via Promise.race.
            await Promise.race([
              client.listTools(),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout-3s')), 3000)),
            ]);
            return {
              server_name: r.server_name,
              server_url: r.server_url,
              reachable: true,
              error: null,
              latency_ms: Date.now() - t0,
            };
          } catch (err) {
            return {
              server_name: r.server_name,
              server_url: r.server_url,
              reachable: false,
              error: (err && err.message) || String(err),
              latency_ms: Date.now() - t0,
            };
          }
        }));
        json(res, 200, { ok: true, servers: probes });
      } catch (err) {
        json(res, 500, { ok: false, error: (err && err.message) || String(err) });
      }
      return;
    }

    // GET /api/mcp/tokens — read-only summary of registered MCP servers and
    // their OAuth token expiry. NEVER returns the access_token or refresh_token
    // values themselves. Used by the menubar app to surface "your jira
    // token expired, run npm run mcp-setup -- --name jira --url ..." style
    // notifications.
    if (path === '/api/mcp/tokens' && req.method === 'GET') {
      try {
        const rows = db.prepare(
          `SELECT server_name, server_url, expires_at, updated_at FROM mcp_oauth_tokens`
        ).all();
        const nowMs = Date.now();
        const items = rows.map((r) => {
          const expiresAtMs = Number(r.expires_at);
          const msToExpiry = expiresAtMs - nowMs;
          return {
            server_name: r.server_name,
            server_url: r.server_url,
            expires_at_ms: expiresAtMs,
            updated_at_unix: Number(r.updated_at),
            expired: msToExpiry <= 0,
            // Negative if already expired. Floor to nearest minute.
            expires_in_minutes: Math.floor(msToExpiry / 60000),
          };
        });
        json(res, 200, { ok: true, items });
      } catch (err) {
        json(res, 500, { ok: false, error: (err && err.message) || String(err) });
      }
      return;
    }

    // ── ADR-034 L1.1 C3 — outcome ledger HTTP face ──────────────────────────
    //
    //   POST /api/cypher/outcomes
    //     body: { session_id: string, signal_kind: 'thumbs', value: 0.8 | -1.0 }
    //     auth: ?user=<name> query param OR X-WI-User header (AC L1.1-A-06)
    //     200 { ok:true, id, upserted, aggregate, signals }
    //     400 invalid signal_kind / value / thumbs allowlist
    //     401 missing user
    //     404 session not found
    //     503 OUTCOMES_DISABLED kill-switch active (AC L1.1-X-01)
    //
    //   GET /api/cypher/outcomes/:session_id
    //     200 { aggregate, signals[] } — public read, no auth gate (the
    //          visibility panel needs this without a user header).
    //     404 session not found (separate from "session exists, no signals" —
    //          the latter returns {aggregate:0, signals:[]} per AC L1.1-C-06).
    //
    // The endpoint validates 'thumbs' tightly (AC L1.1-A-05) but tolerates
    // any value in [-1, +1] for other kinds — future writers (edit_distance,
    // CI) don't need to touch this guard.
    if (path === '/api/cypher/outcomes' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        // Auth — query string OR header. Anonymous calls 401.
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const user = url.searchParams.get('user') || req.headers['x-wi-user'] || null;
        if (!user || typeof user !== 'string') {
          json(res, 401, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'pass ?user=<name> or X-WI-User header' } });
          return;
        }
        if (!body || typeof body !== 'object') {
          json(res, 400, { ok: false, error: { code: 'INVALID_BODY' } });
          return;
        }
        if (typeof body.session_id !== 'string' || !body.session_id) {
          json(res, 400, { ok: false, error: { code: 'INVALID_SESSION_ID' } });
          return;
        }
        if (typeof body.signal_kind !== 'string') {
          json(res, 400, { ok: false, error: { code: 'INVALID_SIGNAL_KIND' } });
          return;
        }
        if (typeof body.value !== 'number') {
          json(res, 400, { ok: false, error: { code: 'INVALID_VALUE' } });
          return;
        }
        const { recordOutcomeSignal, aggregateOutcome } = await import('./dist/services/cypher/outcomes.js');
        const result = recordOutcomeSignal(db, {
          session_id: body.session_id,
          signal_kind: body.signal_kind,
          value: body.value,
          weight: typeof body.weight === 'number' ? body.weight : undefined,
          metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : null,
          created_by: user,
        });
        if (!result.ok) {
          // Map module-level errors to HTTP statuses.
          const code = result.error || 'UNKNOWN';
          const status = code === 'OUTCOMES_DISABLED' ? 503
                       : code === 'SESSION_NOT_FOUND' ? 404
                       : 400;
          json(res, status, { ok: false, error: { code } });
          return;
        }
        const { aggregate, signals } = aggregateOutcome(db, body.session_id);
        json(res, 200, {
          ok: true,
          id: result.id,
          upserted: result.upserted,
          aggregate,
          signals,
        });
      } catch (err) {
        process.stderr.write(`[cypher/outcomes POST] ${(err && err.message) || err}\n`);
        json(res, 500, { ok: false, error: { code: 'INTERNAL', message: (err && err.message) || String(err) } });
      }
      return;
    }

    if (path.startsWith('/api/cypher/outcomes/') && req.method === 'GET') {
      try {
        const sessionId = path.slice('/api/cypher/outcomes/'.length);
        if (!sessionId || sessionId.includes('/')) {
          json(res, 400, { ok: false, error: { code: 'INVALID_SESSION_ID' } });
          return;
        }
        const session = db.prepare('SELECT 1 FROM cypher_sessions WHERE session_id = ?').get(sessionId);
        if (!session) {
          json(res, 404, { ok: false, error: { code: 'SESSION_NOT_FOUND', session_id: sessionId } });
          return;
        }
        const { aggregateOutcome } = await import('./dist/services/cypher/outcomes.js');
        const out = aggregateOutcome(db, sessionId);
        json(res, 200, { ok: true, session_id: sessionId, ...out });
      } catch (err) {
        json(res, 500, { ok: false, error: { code: 'INTERNAL', message: (err && err.message) || String(err) } });
      }
      return;
    }

    // ── ADR-039 AC-14/AC-15 + recognition-feedback (2026-07-17) ───────────
    //
    //   POST /api/cypher/sessions/:id/user-verdict
    //     body: { verdict: 'useful' | 'wrong_question' | 'wrong_scope' | 'unrated',
    //             skill?: '<the-skill-the-user-says-is-right>' }
    //     200 { ok:true, session_id, verdict, chosen_skill, named_skill,
    //           prior_updates, verdict_row_updated }
    //     400 invalid verdict (not in enum) / invalid body
    //     404 session not found
    //
    // Two things happen here (recognition-feedback loop):
    //   1. The verdict is written onto prompt_outcomes.user_verdict (the v86
    //      OPRO learning-substrate column) — best-effort, may miss if the
    //      scoreRefinedGoal() row hasn't landed yet (that's non-fatal).
    //   2. The Beta prior for the SUGGESTED skill (cypher_sessions.chosen_skill)
    //      moves: 'useful' → success, 'wrong_*' → failed, at the 'user_observed'
    //      tier (weight 1.0). When the user NAMES a right skill, that skill is
    //      credited + recorded on skill_actually_invoked.
    //
    // This is the ONLY path that turns a low-confidence recognition thumbs
    // into learning. It does NOT touch the ranking blend (user decision
    // 2026-07-16: priors only). A missing prompt_outcomes row no longer 404s —
    // priors still move, which is the load-bearing signal.
    //
    // No auth gate beyond the existing CORS allowlist — this is a local
    // dev bridge.
    {
      const verdictMatch = path.match(/^\/api\/cypher\/sessions\/([^/]+)\/user-verdict$/);
      if (verdictMatch && req.method === 'POST') {
        try {
          const sessionId = decodeURIComponent(verdictMatch[1]);
          if (!sessionId) {
            json(res, 400, { ok: false, error: { code: 'INVALID_SESSION_ID' } });
            return;
          }
          const body = await readBody(req);
          if (!body || typeof body !== 'object') {
            json(res, 400, { ok: false, error: { code: 'INVALID_BODY' } });
            return;
          }
          const { USER_VERDICT_VALUES } = await import('./dist/db/queries/research-cache.js');
          const { recordRecognitionFeedback } = await import('./dist/services/cypher/recognition-feedback.js');
          const result = recordRecognitionFeedback(db, {
            sessionId,
            verdict: body.verdict,
            skill: typeof body.skill === 'string' ? body.skill : null,
          });
          if (!result.ok) {
            if (result.reason === 'INVALID_VERDICT') {
              json(res, 400, {
                ok: false,
                error: {
                  code: 'INVALID_VERDICT',
                  message: `verdict must be one of ${USER_VERDICT_VALUES.join(', ')}`,
                  allowed: USER_VERDICT_VALUES,
                },
              });
              return;
            }
            json(res, 404, { ok: false, error: { code: result.reason, session_id: sessionId } });
            return;
          }
          json(res, 200, {
            ok: true,
            session_id: sessionId,
            verdict: result.verdict,
            chosen_skill: result.chosen_skill,
            named_skill: result.named_skill,
            task_class: result.task_class,
            prior_updates: result.prior_updates,
            verdict_row_updated: result.verdict_row_updated,
          });
        } catch (err) {
          process.stderr.write(`[cypher/user-verdict POST] ${(err && err.message) || err}\n`);
          json(res, 500, { ok: false, error: { code: 'INTERNAL', message: (err && err.message) || String(err) } });
        }
        return;
      }
    }

    // GET /api/cypher/health/sessions/:id — single session drill-down.
    // Returns 404 when the id doesn't resolve.
    if (path.startsWith('/api/cypher/health/sessions/') && req.method === 'GET') {
      try {
        const sessionId = path.slice('/api/cypher/health/sessions/'.length);
        if (!sessionId || sessionId.includes('/')) {
          json(res, 400, { error: 'session_id required' });
          return;
        }
        const { getSessionDetail } = await import('./dist/services/cypher/health.js');
        const detail = getSessionDetail(db, sessionId);
        if (!detail) {
          json(res, 404, { error: 'session not found', session_id: sessionId });
          return;
        }
        json(res, 200, detail);
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // GET /api/cypher/plan-shape-gaps — CAP-13-LITE recognition corpus
    // (ADR-037.5 v2 D5, PRD § E-01..E-10). Read-only listing of rows
    // written by the recognition hook in src/services/cypher/loop.ts.
    // No POST/PUT/PATCH/DELETE on this path (read-only by design).
    //
    // Query params (all optional):
    //   status — 'observed' | 'reviewed' | 'acted_on' | 'dismissed'
    //   limit  — integer 1..200, default 50
    //   offset — integer >=0, default 0
    //
    // Response shape: { rows: [...], total: N, has_more: boolean }
    // Rows expose all columns plus a derived `tool_sequence: string[]`
    // (parsed from tool_sequence_json). The raw JSON column is dropped
    // from the response.
    if (path === '/api/cypher/plan-shape-gaps' && req.method === 'GET') {
      const VALID_STATUS = ['observed', 'reviewed', 'acted_on', 'dismissed'];
      const statusParam = url.searchParams.get('status');
      if (statusParam !== null && !VALID_STATUS.includes(statusParam)) {
        json(res, 400, { error: 'invalid_status', allowed: VALID_STATUS });
        return;
      }
      const limitRaw = url.searchParams.get('limit');
      let limit = 50;
      if (limitRaw !== null) {
        const n = Number(limitRaw);
        if (!Number.isInteger(n) || n < 1) {
          json(res, 400, { error: 'invalid_limit' });
          return;
        }
        if (n > 200) {
          json(res, 400, { error: 'limit_too_large', max: 200 });
          return;
        }
        limit = n;
      }
      const offsetRaw = url.searchParams.get('offset');
      let offset = 0;
      if (offsetRaw !== null) {
        const n = Number(offsetRaw);
        if (!Number.isInteger(n) || n < 0) {
          json(res, 400, { error: 'invalid_offset' });
          return;
        }
        offset = n;
      }

      try {
        const params = [];
        let sql = `SELECT id, session_id, plan_shape_hash, posture, tool_sequence_json,
                          goal, user, prior_count, prior_success_rate, iterations, verdict,
                          status, created_at, reviewed_at, reviewed_by, reviewer_note
                     FROM plan_shape_gap_observed`;
        let countSql = `SELECT COUNT(*) AS n FROM plan_shape_gap_observed`;
        if (statusParam) {
          sql += ` WHERE status = ?`;
          countSql += ` WHERE status = ?`;
          params.push(statusParam);
        }
        sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        const rowParams = [...params, limit, offset];
        const rows = db.prepare(sql).all(...rowParams);
        const totalRow = db.prepare(countSql).get(...params);
        const total = (totalRow && totalRow.n) || 0;
        const shaped = rows.map(r => {
          let toolSeq = [];
          try { toolSeq = JSON.parse(r.tool_sequence_json); } catch { toolSeq = []; }
          const { tool_sequence_json: _drop, ...rest } = r;
          void _drop;
          return { ...rest, tool_sequence: toolSeq };
        });
        json(res, 200, {
          rows: shaped,
          total,
          has_more: offset + shaped.length < total,
        });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // ── ADR-038 v2.5 D5 — permissions ledger endpoints ───────────────────
    // POST   /api/cypher/grants        — create a grant (refuses tier-3)
    // GET    /api/cypher/grants        — list grants
    // DELETE /api/cypher/grants/:id    — revoke

    if (path === '/api/cypher/grants' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        (async () => {
          try {
            const input = JSON.parse(body || '{}');
            const action_pattern = String(input.action_pattern || '').slice(0, 240);
            const scope_kind = String(input.scope_kind || 'one_shot');
            if (!action_pattern) {
              json(res, 400, { error: 'missing_required_fields', hint: 'action_pattern is required' });
              return;
            }
            const VALID_SCOPES = ['one_shot', 'task', 'project', 'session', 'standing'];
            if (!VALID_SCOPES.includes(scope_kind)) {
              json(res, 400, { error: 'invalid_scope_kind', allowed: VALID_SCOPES });
              return;
            }
            // Tier-3 short-circuit: refuse to grant for action_patterns
            // that match any tier-3 tool in the catalog.
            const { TOOL_CATALOG, effectiveRiskTier } = await import('./dist/services/cypher/tool-catalog.js');
            const prefix = action_pattern.endsWith('*') ? action_pattern.slice(0, -1) : action_pattern;
            const tier3Hit = TOOL_CATALOG.find(t =>
              (t.name === action_pattern || t.name.startsWith(prefix)) && effectiveRiskTier(t) === 3
            );
            if (tier3Hit) {
              json(res, 403, {
                error: 'tier_3_not_grantable',
                tool_name: tier3Hit.name,
                hint: 'Tier-3 tools always ask; ledger ignored. No grant created.',
              });
              return;
            }
            const { grantPermission } = await import('./dist/services/cypher/permissions.js');
            const p = grantPermission(db, {
              action_pattern,
              scope_kind,
              scope_id: input.scope_id ? String(input.scope_id) : undefined,
              expires_at: typeof input.expires_at === 'number' ? input.expires_at : undefined,
              expires_after_n: typeof input.expires_after_n === 'number' ? input.expires_after_n : undefined,
              reason: input.reason ? String(input.reason).slice(0, 240) : undefined,
              granted_by: input.granted_by ? String(input.granted_by) : undefined,
            });
            json(res, 201, {
              id: p.id,
              action_pattern: p.action_pattern,
              scope_kind: p.scope_kind,
              scope_id: p.scope_id,
              status: p.status,
              granted_at: p.granted_at,
            });
          } catch (err) {
            json(res, 400, { error: (err && err.message) || String(err) });
          }
        })();
      });
      return;
    }

    if (path === '/api/cypher/grants' && req.method === 'GET') {
      (async () => {
        try {
          const { listPermissions } = await import('./dist/services/cypher/permissions.js');
          const statusParam = url.searchParams.get('status') || undefined;
          const limitRaw = Number(url.searchParams.get('limit') || '50');
          const limit = Math.min(Math.max(1, Number.isInteger(limitRaw) ? limitRaw : 50), 200);
          const grants = listPermissions(db, { status: statusParam }).slice(0, limit);
          json(res, 200, {
            rows: grants.map(g => ({
              id: g.id,
              action_pattern: g.action_pattern,
              scope_kind: g.scope_kind,
              scope_id: g.scope_id,
              status: g.status,
              uses_count: g.uses_count,
              expires_at: g.expires_at,
              expires_after_n: g.expires_after_n,
              granted_at: g.granted_at,
              reason: g.reason,
            })),
          });
        } catch (err) {
          json(res, 500, { error: (err && err.message) || String(err) });
        }
      })();
      return;
    }

    const grantRevokeMatch = path.match(/^\/api\/cypher\/grants\/([^/]+)$/);
    if (grantRevokeMatch && req.method === 'DELETE') {
      (async () => {
        try {
          const id = grantRevokeMatch[1];
          const { revokePermission, getPermission } = await import('./dist/services/cypher/permissions.js');
          const before = getPermission(db, id);
          if (!before) { json(res, 404, { error: 'grant_not_found', id }); return; }
          let reason;
          try {
            const body = await readBody(req);
            if (body && body.reason) reason = String(body.reason).slice(0, 240);
          } catch { /* no body OK */ }
          const revoked = revokePermission(db, id, reason);
          const after = getPermission(db, id);
          json(res, 200, {
            id,
            revoked,
            prior_status: before.status,
            status: after?.status ?? 'unknown',
          });
        } catch (err) {
          json(res, 500, { error: (err && err.message) || String(err) });
        }
      })();
      return;
    }

    // ── ADR-038 v2.5 D6 — GC endpoints ───────────────────────────────────
    // POST /api/cypher/gc/run  — run sweep (body: {dry_run?})
    // GET  /api/cypher/gc/log  — recent runs

    if (path === '/api/cypher/gc/run' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        (async () => {
          try {
            const input = body ? JSON.parse(body) : {};
            const { runGc } = await import('./dist/services/cypher/gc.js');
            const result = runGc(db, { dry_run: !!input.dry_run });
            json(res, 200, result);
          } catch (err) {
            json(res, 500, { error: (err && err.message) || String(err) });
          }
        })();
      });
      return;
    }

    if (path === '/api/cypher/gc/log' && req.method === 'GET') {
      (async () => {
        try {
          const { listGcLog } = await import('./dist/services/cypher/gc.js');
          const limitRaw = Number(url.searchParams.get('limit') || '20');
          const limit = Math.min(Math.max(1, Number.isInteger(limitRaw) ? limitRaw : 20), 100);
          json(res, 200, { rows: listGcLog(db, limit) });
        } catch (err) {
          json(res, 500, { error: (err && err.message) || String(err) });
        }
      })();
      return;
    }

    // ── ADR-038 v2.5 D3 slice 3 — project CRUD endpoints ─────────────────
    // POST /api/cypher/projects     — create (idempotent INSERT OR IGNORE)
    // GET  /api/cypher/projects     — list

    if (path === '/api/cypher/projects' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const input = JSON.parse(body || '{}');
          const id = String(input.id || '').slice(0, 64);
          const name = String(input.name || '').slice(0, 120);
          if (!id || !name) {
            json(res, 400, { error: 'missing_required_fields', hint: 'id and name are required' });
            return;
          }
          // Idempotent — INSERT OR IGNORE in createProject means a repeat
          // call returns the existing row. 201 for both cases is the
          // simpler contract (matches POST /api/cypher/tasks which
          // returns 201 unconditionally on success).
          const project = pjCreateProject(db, {
            id,
            name,
            description: input.description ? String(input.description).slice(0, 240) : undefined,
            default_branch: input.default_branch ? String(input.default_branch).slice(0, 64) : undefined,
            repo_path: input.repo_path ? String(input.repo_path).slice(0, 240) : undefined,
          });
          json(res, 201, {
            id: project.id,
            name: project.name,
            description: project.description,
            default_branch: project.default_branch,
            repo_path: project.repo_path,
            created_at: project.created_at,
          });
        } catch (err) {
          json(res, 400, { error: (err && err.message) || String(err) });
        }
      });
      return;
    }

    if (path === '/api/cypher/projects' && req.method === 'GET') {
      try {
        json(res, 200, {
          rows: pjListProjects(db).map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            default_branch: p.default_branch,
            repo_path: p.repo_path,
            created_at: p.created_at,
          })),
        });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // ── ADR-038 v2.5 D2 — task-memory CRUD endpoints ─────────────────────
    // POST /api/cypher/tasks              — create a task
    // GET  /api/cypher/tasks              — list tasks
    // PUT  /api/cypher/tasks/:id/close    — close a task
    // GET  /api/cypher/tasks/:id/context  — read curator context

    if (path === '/api/cypher/tasks' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const input = JSON.parse(body || '{}');
          const task = tmCreateTask(db, {
            title: String(input.title || '').slice(0, 120),
            posture: String(input.posture || 'generic'),
            external_ref: input.external_ref ? String(input.external_ref) : undefined,
            project: input.project ? String(input.project) : undefined,
            owner_user_id: input.owner_user_id ? String(input.owner_user_id) : undefined,
          });
          json(res, 201, {
            task_id: task.id,
            title: task.title,
            posture: task.posture,
            status: task.status,
            external_ref: task.external_ref,
            project: task.project,
            created_at: task.created_at,
          });
        } catch (err) {
          json(res, 400, { error: (err && err.message) || String(err) });
        }
      });
      return;
    }

    if (path === '/api/cypher/tasks' && req.method === 'GET') {
      try {
        const statusParam = url.searchParams.get('status') || undefined;
        // ADR-038 v2.5 D3 slice 3: scope=all_projects bypasses the project
        // filter entirely. Default scope='project' keeps the original
        // default-isolated behaviour (project='wi' unless overridden).
        const scopeParam = url.searchParams.get('scope') === 'all_projects'
          ? 'all_projects'
          : 'project';
        const projectParam = scopeParam === 'all_projects'
          ? undefined
          : (url.searchParams.get('project') || 'wi');
        const limitRaw = Number(url.searchParams.get('limit') || '50');
        const limit = Math.min(Math.max(1, Number.isInteger(limitRaw) ? limitRaw : 50), 200);
        const tasks = tmListTasks(db, { project: projectParam, status: statusParam }).slice(0, limit);
        json(res, 200, {
          rows: tasks.map(t => ({
            task_id: t.id,
            title: t.title,
            posture: t.posture,
            status: t.status,
            project: t.project,
            external_ref: t.external_ref,
            last_touched: t.last_touched,
            closed_at: t.closed_at,
          })),
        });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    const taskCloseMatch = path.match(/^\/api\/cypher\/tasks\/([^/]+)\/close$/);
    if (taskCloseMatch && req.method === 'PUT') {
      const taskId = taskCloseMatch[1];
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const input = JSON.parse(body || '{}');
          const existing = tmGetTask(db, taskId);
          if (!existing) { json(res, 404, { error: 'task_not_found', task_id: taskId }); return; }
          tmCloseTask(db, taskId, input.reason ? String(input.reason).slice(0, 240) : undefined);
          const updated = tmGetTask(db, taskId);
          json(res, 200, {
            task_id: updated.id,
            status: updated.status,
            closed_at: updated.closed_at,
            closed_reason: updated.closed_reason,
          });
        } catch (err) {
          json(res, 400, { error: (err && err.message) || String(err) });
        }
      });
      return;
    }

    const taskCtxMatch = path.match(/^\/api\/cypher\/tasks\/([^/]+)\/context$/);
    if (taskCtxMatch && req.method === 'GET') {
      try {
        const taskId = taskCtxMatch[1];
        const block = tmLoadTaskContext(db, taskId);
        if (!block) {
          const task = tmGetTask(db, taskId);
          if (!task) { json(res, 200, { error: 'task_not_found', task_id: taskId }); return; }
          json(res, 200, { error: 'task_not_open', task_id: taskId, status: task.status });
          return;
        }
        json(res, 200, {
          rendered: tmRenderTaskContextBlock(block),
          task_id: block.task.id,
          title: block.task.title,
          posture: block.task.posture,
          dispatch_count: block.dispatch_count,
          context_version: block.context ? block.context.version : null,
          has_open_questions: !!(block.context && block.context.open_questions),
          has_things_tried: !!(block.context && block.context.things_tried),
        });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // ── ADR-038 v2.5 D19 — recurate flag endpoint ────────────────────────
    // PUT /api/cypher/tasks/:id/recurate — flag for re-curation
    const taskRecurateMatch = path.match(/^\/api\/cypher\/tasks\/([^/]+)\/recurate$/);
    if (taskRecurateMatch && req.method === 'PUT') {
      try {
        const taskId = taskRecurateMatch[1];
        const existing = tmGetTask(db, taskId);
        if (!existing) { json(res, 404, { error: 'task_not_found', task_id: taskId }); return; }
        const flagged = tmRecurateTaskContext(db, taskId);
        const updated = tmGetTask(db, taskId);
        json(res, 200, {
          task_id: taskId,
          recurate_pending: flagged,
          recurate_pending_at: updated ? updated.recurate_pending_at : null,
        });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // GET /api/brain/context — Unified Brain Pillar 2 (ADR-024).
    if (path === '/api/brain/context' && req.method === 'GET') {
      const user = (req.headers['x-wi-consumer'] || url.searchParams.get('user') || 'anon').toString();
      const now = Date.now();
      const cached = brainContextCache.get(user);
      if (cached && now - cached.at < BRAIN_CONTEXT_TTL_MS) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...(res._corsHeaders || {}),
          'X-Brain-Cache': 'hit',
        });
        res.end(JSON.stringify(cached.payload));
        return;
      }
      try {
        const { buildBrainContext } = await import('./dist/services/brain/context-builder.js');
        const payload = await buildBrainContext(db, user, { palace: palaceClient });
        brainContextCache.set(user, { at: now, payload });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...(res._corsHeaders || {}),
          'X-Brain-Cache': 'miss',
        });
        res.end(JSON.stringify(payload));
      } catch (err) {
        console.error('[brain/context] error:', err);
        json(res, 500, { error: 'brain context build failed', detail: String(err?.message || err) });
      }
      return;
    }

    // POST /api/brain/decide — Unified Brain Pillar 1 (ADR-024 / Phase 69-05).
    // Body: { question: string, user: string, context?: object }.
    // Header: x-wi-consumer ∈ {ui, atlas, mcp} (default: 'ui').
    // Cache key: sha256(normalize(question) + 0x1F + user + 0x1F + utcDayIso())
    // — single-column UNIQUE index lookup; same triple → same decision_id.
    // 429 with Retry-After on per-user daily budget exhaustion (T-69-01).
    if (path === '/api/brain/decide' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const consumerHeader = (req.headers['x-wi-consumer'] || 'ui').toString().toLowerCase();
        if (!['ui', 'atlas', 'mcp'].includes(consumerHeader)) {
          json(res, 400, { error: 'invalid_consumer', allowed: ['ui', 'atlas', 'mcp'] });
          return;
        }
        const question = typeof body?.question === 'string' ? body.question : '';
        const user = typeof body?.user === 'string' ? body.user : '';
        if (!question.trim()) { json(res, 400, { error: 'question_required' }); return; }
        if (!user.trim()) { json(res, 400, { error: 'user_required' }); return; }

        const { runDecision, BudgetExceededError } = await import('./dist/services/brain/decision-engine.js');
        try {
          const result = await runDecision({
            db,
            question,
            user,
            context: body?.context && typeof body.context === 'object' ? body.context : undefined,
            palace: palaceClient,
            consumer: consumerHeader,
          });

          // Phase 71-04: surface prior outcomes for the same cluster_signature.
          // Resolution mirrors deriveClusterSignature() in proactive-scan.ts:
          //   1. evidence[0].signature
          //   2. evidence[0].id
          //   3. no signature → skip the join entirely
          // For (1) and (2), aggregate prior brain_decisions rows with the same
          // signature substring in evidence_json (excluding the just-inserted
          // row) GROUP BY outcome. If any rows are found, append a synthetic
          // past_outcome evidence entry so the UI badge can render trust signals.
          try {
            const evArr = Array.isArray(result?.evidence) ? result.evidence : [];
            const top = evArr.length > 0 && evArr[0] && typeof evArr[0] === 'object' ? evArr[0] : null;
            let signature = null;
            if (top) {
              if (typeof top.signature === 'string' && top.signature.length > 0) {
                signature = top.signature;
              } else if (typeof top.id === 'string' && top.id.length > 0) {
                signature = top.id;
              } else if (typeof top.id === 'number') {
                signature = String(top.id);
              }
            }
            if (signature) {
              const newId = result?.decision_id || '';
              const rows = db
                .prepare(
                  `SELECT outcome, COUNT(*) AS count, MAX(created_at) AS last_at
                   FROM brain_decisions
                   WHERE evidence_json LIKE ?
                     AND id != ?
                     AND outcome IS NOT NULL
                     AND outcome != 'pending'
                   GROUP BY outcome`,
                )
                .all(`%${signature}%`, newId);
              if (Array.isArray(rows) && rows.length > 0) {
                const outcomes = rows.map((r) => ({
                  outcome: r.outcome,
                  count: Number(r.count) || 0,
                  last_at: Number(r.last_at) || 0,
                }));
                result.evidence = [
                  ...evArr,
                  {
                    source: 'past_outcome',
                    id: signature,
                    outcomes,
                  },
                ];
              }
            }
          } catch (joinErr) {
            console.error('[brain/decide] past_outcome join failed:', joinErr);
            // Non-fatal — return the original decision without past_outcome.
          }

          json(res, 200, result);
        } catch (innerErr) {
          if (innerErr instanceof BudgetExceededError) {
            const now = new Date();
            const tomorrowUtcMs = Date.UTC(
              now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1
            );
            const retryAfter = Math.max(1, Math.floor((tomorrowUtcMs - Date.now()) / 1000));
            res.writeHead(429, {
              'Content-Type': 'application/json',
              ...(res._corsHeaders || {}),
              'Retry-After': String(retryAfter),
            });
            res.end(JSON.stringify({
              error: 'daily_budget_exceeded',
              reason: innerErr.reason,
              remainingCalls: innerErr.remainingCalls,
              remainingTokens: innerErr.remainingTokens,
            }));
            return;
          }
          throw innerErr;
        }
      } catch (err) {
        console.error('[brain/decide] error:', err);
        json(res, 500, { error: 'internal_error', message: String(err?.message || err) });
      }
      return;
    }

    // OP-7 / U-3: GET /api/brain/decide/stream — same pipeline as POST /api/brain/decide,
    // but streams stage progress via SSE so the UI can render "Loading context… →
    // Asking the brain…" instead of 5–25 s of dead silence.
    //
    // Query params:
    //   question  — required, the user's natural-language question
    //   user      — required, caller identity (e.g. an internal user ID)
    //   context   — optional JSON-encoded context object
    // Header:
    //   X-WI-Consumer — same as the POST route (default 'ui')
    //
    // Events:
    //   event: stage   data: { stage: 'cache_lookup' | 'cache_hit' | 'budget_check'
    //                          | 'thinking' | 'persisting' | 'done', ... }
    //   event: result  data: <DecisionResult JSON>
    //   event: error   data: { error: string, ... }
    if (path === '/api/brain/decide/stream' && req.method === 'GET') {
      const consumerHeader = (req.headers['x-wi-consumer'] || 'ui').toString().toLowerCase();
      const question = (url.searchParams.get('question') || '').trim();
      const user = (url.searchParams.get('user') || '').trim();
      let parsedContext;
      const ctxRaw = url.searchParams.get('context');
      if (ctxRaw) {
        try { parsedContext = JSON.parse(ctxRaw); } catch { /* ignore — invalid JSON → no context */ }
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(res._corsHeaders || {}),
      });
      res.flushHeaders?.();
      res.write('retry: 3000\n\n');

      const send = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
        catch { /* client disconnected */ }
      };

      if (!['ui', 'atlas', 'mcp'].includes(consumerHeader)) {
        send('error', { error: 'invalid_consumer', allowed: ['ui', 'atlas', 'mcp'] }); res.end(); return;
      }
      if (!question) { send('error', { error: 'question_required' }); res.end(); return; }
      if (!user) { send('error', { error: 'user_required' }); res.end(); return; }

      // Keep the connection alive across long thinking phases.
      const keepAlive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 15_000);
      req.on('close', () => clearInterval(keepAlive));

      (async () => {
        try {
          const { runDecision, BudgetExceededError } = await import('./dist/services/brain/decision-engine.js');
          const result = await runDecision({
            db,
            question,
            user,
            context: parsedContext,
            palace: palaceClient,
            consumer: consumerHeader,
            onStage: (stage, meta) => send('stage', { stage, ...(meta || {}) }),
          });
          send('result', result);
        } catch (err) {
          // Mirror POST /api/brain/decide's BudgetExceededError handling.
          // Compare by name (cross-module instanceof is fragile across dynamic imports).
          if (err && (err.name === 'BudgetExceededError' || err.constructor?.name === 'BudgetExceededError')) {
            send('error', {
              error: 'daily_budget_exceeded',
              reason: err.reason,
              remainingCalls: err.remainingCalls,
              remainingTokens: err.remainingTokens,
            });
          } else {
            console.error('[brain/decide/stream] error:', err);
            send('error', { error: 'internal_error', message: String(err?.message || err) });
          }
        } finally {
          clearInterval(keepAlive);
          try { res.end(); } catch {}
        }
      })();
      return;
    }

    // REFACTOR-001 (2026-05-21): /api/brain/learn, /api/brain/verify and
    // /api/brain/recall moved to src/routes/brain.ts. The dispatcher at the
    // top of this handler now serves those routes from the EXTRACTED_ROUTES
    // table before reaching this if-chain.

    // GET /api/jira/stuck?project=PROJ&days=3
    if (path === '/api/jira/stuck' && req.method === 'GET') {
      const project = url.searchParams.get('project') ?? DEFAULT_JIRA_PROJECT;
      const days = Math.max(1, parseInt(url.searchParams.get('days') || '3'));
      const rows = db.prepare(`
        SELECT jt.issue_key, jt.to_status AS current_status, jt.transitioned_at,
               ji.title, ji.assignee, ji.priority, ji.url
        FROM jira_transitions jt
        LEFT JOIN jira_issues ji ON ji.key = jt.issue_key
        WHERE jt.project_key = ?
          AND jt.to_status NOT IN ('Done', 'Closed', 'Resolved', 'Cancelled', 'Completed')
          AND NOT EXISTS (
            SELECT 1 FROM jira_transitions jt2
            WHERE jt2.issue_key = jt.issue_key AND jt2.transitioned_at > jt.transitioned_at
          )
          AND jt.transitioned_at < datetime('now', '-' || ? || ' days')
        ORDER BY jt.transitioned_at ASC
      `).all(project, days);
      json(res, 200, { project, days, stuck: rows, count: rows.length });
      return;
    }

    // DELETE /api/topics/:id
    const topicDeleteMatch = path.match(/^\/api\/topics\/(\d+)$/);
    if (topicDeleteMatch && req.method === 'DELETE') {
      const topicId = parseInt(topicDeleteMatch[1], 10);
      const topic = db.prepare('SELECT id, name FROM topics WHERE id = ?').get(topicId);
      if (!topic) { json(res, 404, { error: 'Topic not found' }); return; }
      db.prepare('DELETE FROM action_items WHERE topic_id = ?').run(topicId);
      db.prepare('DELETE FROM sync_state WHERE topic_id = ?').run(topicId);
      db.prepare('DELETE FROM topic_notebooks WHERE topic_name = ?').run(topic.name);
      db.prepare('DELETE FROM digests WHERE topic_name = ?').run(topic.name);
      db.prepare('DELETE FROM topics WHERE id = ?').run(topicId);
      _topicConfigCache = null; // invalidate routing cache
      json(res, 200, { ok: true });
      return;
    }

    // PUT /api/topics/:id
    const topicUpdateMatch = path.match(/^\/api\/topics\/(\d+)$/);
    if (topicUpdateMatch && req.method === 'PUT') {
      const topicId = parseInt(topicUpdateMatch[1], 10);
      const topic = db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId);
      if (!topic) { json(res, 404, { error: 'Topic not found' }); return; }
      const rawBody = await readBody(req);
      const parsed = parseBody(TopicUpdateSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const { name, config, lookback_days } = parsed.data;
      if (name) db.prepare('UPDATE topics SET name = ? WHERE id = ?').run(name, topicId);
      if (config !== undefined) db.prepare('UPDATE topics SET config = ? WHERE id = ?').run(JSON.stringify(config), topicId);
      if (lookback_days !== undefined) db.prepare('UPDATE topics SET lookback_days = ? WHERE id = ?').run(lookback_days, topicId);
      _topicConfigCache = null; // invalidate routing cache
      const updated = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
      json(res, 200, updated);
      return;
    }

    // GET /api/action-items
    // REFACTOR-001 (2026-05-21): /api/action-items moved to src/routes/action-items.ts

    // GET /api/messages/recent
    if (path === '/api/messages/recent' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const source = url.searchParams.get('source') || null;
      const query = source
        ? db.prepare('SELECT * FROM messages WHERE source = ? ORDER BY timestamp DESC LIMIT ?').all(source, limit)
        : db.prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?').all(limit);
      json(res, 200, query);
      return;
    }

    // GET /api/meetings/recent
    if (path === '/api/meetings/recent' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '10');
      const rows = db.prepare('SELECT id, chat_name, summary, decisions, topics, date as timestamp FROM meetings ORDER BY date DESC LIMIT ?').all(limit);
      json(res, 200, rows);
      return;
    }

    // GET /api/meetings/:id/topic-suggestions — EP-52-5
    const meetingTopicSuggestMatch = path.match(/^\/api\/meetings\/(\d+)\/topic-suggestions$/);
    if (meetingTopicSuggestMatch && req.method === 'GET') {
      const meetingId = parseInt(meetingTopicSuggestMatch[1]);
      const { suggestTopicLinks } = await import('./dist/db/queries/meeting-topics.js');
      const suggestions = suggestTopicLinks(db, meetingId);
      json(res, 200, { suggestions });
      return;
    }

    // POST /api/meetings/:id/topic-suggestions/:topicId/confirm — EP-52-5
    const meetingTopicConfirmMatch = path.match(/^\/api\/meetings\/(\d+)\/topic-suggestions\/(\d+)\/confirm$/);
    if (meetingTopicConfirmMatch && req.method === 'POST') {
      const meetingId = parseInt(meetingTopicConfirmMatch[1]);
      const topicId = parseInt(meetingTopicConfirmMatch[2]);
      const { confirmTopicLink } = await import('./dist/db/queries/meeting-topics.js');
      confirmTopicLink(db, meetingId, topicId);
      json(res, 200, { ok: true });
      return;
    }

    // DELETE /api/meetings/:id/topic-suggestions/:topicId — EP-52-5
    const meetingTopicRemoveMatch = path.match(/^\/api\/meetings\/(\d+)\/topic-suggestions\/(\d+)$/);
    if (meetingTopicRemoveMatch && req.method === 'DELETE') {
      const meetingId = parseInt(meetingTopicRemoveMatch[1]);
      const topicId = parseInt(meetingTopicRemoveMatch[2]);
      const { removeTopicLink } = await import('./dist/db/queries/meeting-topics.js');
      removeTopicLink(db, meetingId, topicId);
      json(res, 200, { ok: true });
      return;
    }

    // GET /api/sync-state
    if (path === '/api/sync-state' && req.method === 'GET') {
      const rows = db.prepare('SELECT * FROM sync_state ORDER BY last_synced_at DESC').all();
      json(res, 200, rows);
      return;
    }

    // POST /api/search
    if (path === '/api/search' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const parsed = parseBody(SearchSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const result = await searchMessages(db, { topic: parsed.data.topic, keywords: parsed.data.keywords, source: parsed.data.source });
      json(res, 200, { results: result, formatted: formatSearchResults(result, { topic: parsed.data.topic, keywords: parsed.data.keywords }) });
      return;
    }

    // POST /api/search-all
    if (path === '/api/search-all' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const parsed = parseBody(SearchAllSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      if (!process.env.BROWSER_PROFILE_PATH) {
        json(res, 400, { error: 'BROWSER_PROFILE_PATH not set — browser tools unavailable' });
        return;
      }
      const session = getBrowserSession();
      const result = await searchAll(db, parsed.data, session, anthropicApiKey);
      json(res, 200, { markdown: result });
      return;
    }

    // POST /api/digest
    if (path === '/api/digest' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const parsed = parseBody(DigestSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const { topic, date: dateParam, refresh } = parsed.data;
      const date = dateParam || new Date().toISOString().slice(0, 10);

      const topicExists = db.prepare('SELECT 1 FROM topics WHERE name = ?').get(topic);
      if (!topicExists) {
        json(res, 404, { error: `Topic "${topic}" not found. Configure it first via the Topics page.` });
        return;
      }

      // Check cache first (1-hour TTL stored in digests table)
      const cached = getCachedDigest(db, topic, date);
      if (cached && !refresh) {
        json(res, 200, { markdown: cached.markdown, cached: true });
        return;
      }

      const result = await withStaleFallback(
        () => getDailyDigest(db, { topic, date }, anthropicApiKey),
        () => { const c = getCachedDigest(db, topic, date); return c ? { markdown: c.markdown, cached: true } : null; },
        'digest'
      );
      if (!result.stale) {
        const expiresAt = new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19);
        saveDigest(db, topic, date, result.data, expiresAt);
        json(res, 200, { markdown: result.data, cached: false });
      } else {
        json(res, 200, { ...result.data, stale: true, stale_reason: result.stale_reason });
      }
      return;
    }

    // POST /api/jira-report
    if (path === '/api/jira-report' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const parsed = parseBody(JiraReportSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const jiraSourceJr = process.env.JIRA_SOURCE ?? 'auto';
      if (jiraSourceJr === 'browser' && !process.env.BROWSER_PROFILE_PATH) {
        json(res, 400, { error: 'BROWSER_PROFILE_PATH not set — browser tools unavailable' });
        return;
      }
      const session = getBrowserSession();
      const result = await getJiraReport(db, parsed.data, session, anthropicApiKey);
      json(res, 200, result);
      return;
    }

    // ── EP-53: Teams Intelligence Feed endpoints ──────────────────────────────

    // GET /api/teams/chats — chat list with activity metrics
    if (path === '/api/teams/chats' && req.method === 'GET') {
      const now = new Date().toISOString();
      const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const cutoff7d  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();

      const rows = db.prepare(`
        SELECT
          gc.name,
          gc.message_count,
          gc.last_message_at,
          gc.is_active,
          gc.digest,
          gc.digest_generated_at,
          gc.jira_links,
          (SELECT COUNT(*) FROM messages
           WHERE source = 'teams'
             AND REPLACE(subject, '[Teams] ', '') = gc.name
             AND timestamp >= ?) AS last24h_count,
          (SELECT COUNT(*) FROM messages
           WHERE source = 'teams'
             AND REPLACE(subject, '[Teams] ', '') = gc.name
             AND timestamp >= ?) AS last7d_count,
          (SELECT COUNT(DISTINCT author) FROM messages
           WHERE source = 'teams'
             AND REPLACE(subject, '[Teams] ', '') = gc.name) AS member_count,
          (SELECT author FROM messages
           WHERE source = 'teams'
             AND REPLACE(subject, '[Teams] ', '') = gc.name
           ORDER BY timestamp DESC LIMIT 1) AS last_author,
          (SELECT content FROM messages
           WHERE source = 'teams'
             AND REPLACE(subject, '[Teams] ', '') = gc.name
           ORDER BY timestamp DESC LIMIT 1) AS last_content,
          (SELECT COUNT(*) FROM meetings
           WHERE chat_name = gc.name
             AND (summary IS NULL OR length(summary) < 20)) AS unanalyzed_meetings
        FROM group_chats gc
        ORDER BY last24h_count DESC, last7d_count DESC, gc.last_message_at DESC
      `).all(cutoff24h, cutoff7d);

      const chats = rows.map(r => ({
        name: r.name,
        messageCount: r.message_count ?? 0,
        last24hCount: r.last24h_count ?? 0,
        last7dCount: r.last7d_count ?? 0,
        lastMessageAt: r.last_message_at,
        lastMessageAuthor: r.last_author ?? '',
        lastMessagePreview: (r.last_content ?? '').slice(0, 100),
        memberCount: r.member_count ?? 0,
        hasUnanalyzedMeetings: (r.unanalyzed_meetings ?? 0) > 0,
        jiraLinks: (() => { try { return JSON.parse(r.jira_links || '[]'); } catch { return []; } })(),
        mentionsMe: false, // computed per-request would be expensive; available in chat_activity
        digest: r.digest ?? null,
        digestAge: r.digest_generated_at
          ? Math.round((Date.now() - new Date(r.digest_generated_at).getTime()) / 60000)
          : null,
      }));

      json(res, 200, { chats });
      return;
    }

    // GET /api/teams/chats/:chatName/feed — messages + action items + meetings for one chat
    const chatFeedMatch = path.match(/^\/api\/teams\/chats\/(.+)\/feed$/);
    if (chatFeedMatch && req.method === 'GET') {
      const chatName = decodeURIComponent(chatFeedMatch[1]);
      const limit = Math.min(parseInt(url.searchParams?.get?.('limit') ?? '100', 10) || 100, 200);

      const messages = db.prepare(`
        SELECT id, author, content, timestamp
        FROM messages
        WHERE source = 'teams'
          AND REPLACE(subject, '[Teams] ', '') = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(chatName, limit);

      // Extract Jira links per message in JS (SQLite has no native regex)
      const messagesWithLinks = messages.map(m => ({
        id: m.id,
        author: m.author,
        content: m.content,
        timestamp: m.timestamp,
        jiraLinks: [...new Set([...m.content.matchAll(JIRA_KEY_RE)].map(x => x[1]))],
      }));

      const meetings = db.prepare(`
        SELECT id, title, date, summary, decisions, attendees
        FROM meetings
        WHERE chat_name = ?
        ORDER BY date DESC
        LIMIT 20
      `).all(chatName).map(m => ({
        ...m,
        decisions: (() => { try { return JSON.parse(m.decisions || '[]'); } catch { return []; } })(),
        attendees: (() => { try { return JSON.parse(m.attendees || '[]'); } catch { return []; } })(),
      }));

      // Action items linked to this chat via topic routing
      const actionItems = db.prepare(`
        SELECT ai.id, ai.title, ai.assignee, ai.status, ai.due_date
        FROM action_items ai
        JOIN topics t ON t.id = ai.topic_id
        WHERE t.name IN (
          SELECT DISTINCT REPLACE(subject, '[Teams] ', '') FROM messages
          WHERE source = 'teams' AND REPLACE(subject, '[Teams] ', '') = ?
          LIMIT 1
        )
        ORDER BY ai.due_date ASC NULLS LAST
        LIMIT 30
      `).all(chatName);

      const allJiraLinks = [...new Set(messagesWithLinks.flatMap(m => m.jiraLinks))];

      json(res, 200, { messages: messagesWithLinks, meetings, actionItems, jiraLinks: allJiraLinks });
      return;
    }

    // POST /api/teams/chats/:chatName/digest — generate or refresh AI digest for a chat
    const chatDigestMatch = path.match(/^\/api\/teams\/chats\/(.+)\/digest$/);
    if (chatDigestMatch && req.method === 'POST') {
      const chatName = decodeURIComponent(chatDigestMatch[1]);
      if (!anthropicApiKey) { json(res, 503, { error: 'No Anthropic API key configured' }); return; }

      // Check if fresh digest exists (<2h)
      const existing = db.prepare(
        `SELECT digest, digest_generated_at FROM group_chats WHERE name = ?`
      ).get(chatName);
      if (existing?.digest && existing?.digest_generated_at) {
        const ageMin = (Date.now() - new Date(existing.digest_generated_at).getTime()) / 60000;
        if (ageMin < 120) {
          json(res, 200, { digest: existing.digest, digestAge: Math.round(ageMin), cached: true });
          return;
        }
      }

      // Fire async generation
      (async () => {
        try {
          const messages = db.prepare(`
            SELECT author, content, timestamp FROM messages
            WHERE source = 'teams' AND REPLACE(subject, '[Teams] ', '') = ?
            ORDER BY timestamp DESC LIMIT 100
          `).all(chatName);

          // Pull meeting decisions for context
          const meetingRows = db.prepare(`
            SELECT decisions FROM meetings WHERE chat_name = ? AND decisions IS NOT NULL
          `).all(chatName);
          const decisions = meetingRows.flatMap(r => {
            try { return JSON.parse(r.decisions); } catch { return []; }
          });

          const digest = await generateChatDigest(
            { chatName, messages, decisions },
            anthropicApiKey
          );

          db.prepare(`
            UPDATE group_chats
            SET digest = ?, digest_generated_at = datetime('now')
            WHERE name = ?
          `).run(digest, chatName);
        } catch (err) {
          process.stderr.write(`[ChatDigest] Error for "${chatName}": ${err.message}\n`);
        }
      })();

      json(res, 202, { status: 'generating', chatName });
      return;
    }

    // POST /api/teams-updates
    if (path === '/api/teams-updates' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const parsed = parseBody(TeamsUpdatesSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const result = await getTeamsUpdates(db, parsed.data, anthropicApiKey);
      json(res, 200, { markdown: result });
      return;
    }

    // GET /api/teams-fav-keywords
    if (path === '/api/teams-fav-keywords' && req.method === 'GET') {
      json(res, 200, { keywords: listFavKeywords(db) });
      return;
    }

    // POST /api/teams-fav-keywords
    if (path === '/api/teams-fav-keywords' && req.method === 'POST') {
      const { keyword } = await readBody(req);
      if (!keyword?.trim()) { json(res, 400, { error: 'keyword required' }); return; }
      const row = saveFavKeyword(db, keyword.trim());
      json(res, 200, row);
      return;
    }

    // DELETE /api/teams-fav-keywords/:id
    const favDelMatch = path.match(/^\/api\/teams-fav-keywords\/(\d+)$/);
    if (favDelMatch && req.method === 'DELETE') {
      deleteFavKeyword(db, parseInt(favDelMatch[1]));
      json(res, 200, { ok: true });
      return;
    }

    // POST /api/topic-expert
    if (path === '/api/topic-expert' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const parsed = parseBody(TopicExpertSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const result = await askTopicExpert(db, { ...parsed.data, palace: palaceClient }, anthropicApiKey);
      json(res, 200, { markdown: result });
      return;
    }

    // GET /api/notebooks — list all notebooks
    if (path === '/api/notebooks' && req.method === 'GET') {
      const notebooks = listNotebooks(db).map(n => ({
        topic_name: n.topic_name,
        last_updated: n.last_updated,
        message_count: n.message_count,
      }));
      json(res, 200, { notebooks });
      return;
    }

    // GET /api/notebooks/graph — graph data (nodes + edges) for all topics (EP-27)
    // IMPORTANT: must be before the :topicName route so "graph" isn't treated as a topic name
    if (path === '/api/notebooks/graph' && req.method === 'GET') {
      const notebooks = listNotebooks(db);
      const { extractPeopleNames } = await import('./dist/tools/obsidian-export.js');
      const nodes = notebooks.map(n => ({ topicName: n.topic_name, messageCount: n.message_count }));

      // Build per-topic people and ticket sets
      const jiraKeyRe = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
      const topicData = notebooks.map(n => {
        const messages = db.prepare(
          `SELECT content FROM messages WHERE topic_id = (SELECT id FROM topics WHERE name = ?)`
        ).all(n.topic_name);
        const tickets = new Set();
        for (const m of messages) {
          for (const match of (m.content || '').matchAll(jiraKeyRe)) {
            tickets.add(match[1]);
          }
        }
        return {
          topicName: n.topic_name,
          people: new Set(extractPeopleNames(n.content || '')),
          tickets,
        };
      });

      const edges = [];
      for (let i = 0; i < topicData.length; i++) {
        for (let j = i + 1; j < topicData.length; j++) {
          const sharedPeople = [...topicData[i].people].filter(p => topicData[j].people.has(p));
          const sharedTickets = [...topicData[i].tickets].filter(t => topicData[j].tickets.has(t));
          if (sharedPeople.length > 0 || sharedTickets.length > 0) {
            edges.push({ from: topicData[i].topicName, to: topicData[j].topicName, sharedPeople, sharedTickets });
          }
        }
      }
      json(res, 200, { nodes, edges });
      return;
    }

    // GET /api/notebooks/:topicName — get or build notebook
    const notebookMatch = path.match(/^\/api\/notebooks\/([^/]+)$/);
    if (notebookMatch && req.method === 'GET') {
      const topicName = decodeURIComponent(notebookMatch[1]);
      if (!analyzer) {
        json(res, 503, { error: 'AI unavailable — ANTHROPIC_API_KEY not set' });
        return;
      }
      const result = await getOrBuildNotebook(db, topicName, analyzer);
      // Option 4: a user-facing fetch is by definition a fresh refresh —
      // tell the cadence gate so background sync doesn't fire another
      // call within the interval. (If the call was a no-op fresh=false,
      // marking is still fine: it just postpones the next sweep.)
      markNotebookRefreshed(topicName);
      json(res, 200, result);
      return;
    }

    // POST /api/notebooks/:topicName/rebuild — force full rebuild
    const rebuildMatch = path.match(/^\/api\/notebooks\/([^/]+)\/rebuild$/);
    if (rebuildMatch && req.method === 'POST') {
      const topicName = decodeURIComponent(rebuildMatch[1]);
      if (!analyzer) {
        json(res, 503, { error: 'AI unavailable — ANTHROPIC_API_KEY not set' });
        return;
      }
      const result = await getOrBuildNotebook(db, topicName, analyzer, { forceRebuild: true });
      json(res, 200, result);
      return;
    }

    // DELETE /api/notebooks/:topicName — delete notebook
    const deleteNotebookMatch = path.match(/^\/api\/notebooks\/([^/]+)$/);
    if (deleteNotebookMatch && req.method === 'DELETE') {
      const topicName = decodeURIComponent(deleteNotebookMatch[1]);
      deleteNotebook(db, topicName);
      json(res, 200, { ok: true });
      return;
    }

    // POST /api/notebooks/:topicName/chat — chat against notebook memory
    const chatMatch = path.match(/^\/api\/notebooks\/([^/]+)\/chat$/);
    if (chatMatch && req.method === 'POST') {
      const topicName = decodeURIComponent(chatMatch[1]);
      if (!analyzer) {
        json(res, 503, { error: 'AI unavailable — ANTHROPIC_API_KEY not set' });
        return;
      }
      const rawBody = await readBody(req);
      const parsed = parseBody(NotebookChatSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const { message, history } = parsed.data;
      const cleanHistory = history.filter(h => h.content?.trim());
      const nb = getNotebook(db, topicName);
      const notebookContent = nb?.content ?? null;
      // NOTE: notebook is now passed directly to chatWithContext() as a system block (EP-40-1)
      // rather than as a contextItem, so it gets proper cache_control and higher priority.
      const contextItems = [];

      // Inject user annotation as highest-priority context (EP-27)
      const userAnnotation = getAnnotation(db, topicName);
      if (userAnnotation?.trim()) {
        contextItems.unshift({
          source: 'user-notes',
          title: `${topicName} — Your Personal Notes (treat as authoritative)`,
          content: userAnnotation,
        });
      }

      // --- Pull recent raw messages for the active topic ---
      // The notebook is a summary, but specific questions need the raw conversations.
      // Include up to 20 recent messages from this topic as grounding context.
      try {
        const topicRow = db.prepare('SELECT id FROM topics WHERE name = ?').get(topicName);
        if (topicRow) {
          // FTS search within the topic first (question-relevant messages)
          const rawTerms = message
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 4)
            .slice(0, 8);
          let topicMsgs = [];
          if (rawTerms.length > 0) {
            const rawFts = rawTerms.map(t => t.replace(/["()*:]/g, ' ').trim()).filter(Boolean).join(' OR ');
            try {
              topicMsgs = db.prepare(`
                SELECT m.source, m.author, m.subject, m.content, m.timestamp
                FROM messages_fts
                JOIN messages m ON messages_fts.rowid = m.id
                WHERE messages_fts MATCH ? AND m.topic_id = ?
                ORDER BY bm25(messages_fts) LIMIT 15
              `).all(rawFts, topicRow.id);
            } catch { /* FTS unavailable */ }
          }
          // Fallback: most recent messages if FTS found nothing
          if (topicMsgs.length === 0) {
            topicMsgs = db.prepare(`
              SELECT source, author, subject, content, timestamp
              FROM messages WHERE topic_id = ? ORDER BY timestamp DESC LIMIT 15
            `).all(topicRow.id);
          }
          if (topicMsgs.length > 0) {
            const snippets = topicMsgs.map(r =>
              `[${r.source?.toUpperCase()} – ${r.author} – ${String(r.timestamp).slice(0,10)}]\n${r.subject ? r.subject + ': ' : ''}${String(r.content).slice(0, 600)}`
            ).join('\n\n---\n\n');
            contextItems.push({
              source: 'topic-messages',
              title: `Recent messages in ${topicName} (${topicMsgs.length} items)`,
              content: snippets,
            });
          }
        }
      } catch { /* non-fatal */ }

      // --- Cross-topic context (EP-14, Point 4) ---
      // EP-59: Structured entity extraction replaces naive keyword filtering
      const entities = extractEntities(message, knownPeopleNames);

      // Build FTS query from extracted entities (Jira keys + flags + people names)
      const ftsTerms = [
        ...entities.jiraKeys,
        ...entities.flags,
        ...entities.people.flatMap(p => p.split(/\s+/).filter(w => w.length >= 3)),
      ].map(t => t.replace(/"/g, '""'));
      const questionTerms = ftsTerms; // Backward compat for existing cross-topic search code below

      if (questionTerms.length > 0) {
        // 1. FTS search across ALL messages for those terms
        const ftsQuery = questionTerms
          .map(t => t.replace(/["()*:]/g, ' ').trim())
          .filter(Boolean)
          .join(' OR ');
        try {
          const sinceIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
          const crossMsgs = db.prepare(`
            SELECT m.source, m.author, m.subject, m.content, m.timestamp
            FROM messages_fts
            JOIN messages m ON messages_fts.rowid = m.id
            WHERE messages_fts MATCH ?
              AND m.timestamp >= ?
            ORDER BY bm25(messages_fts)
            LIMIT 10
          `).all(ftsQuery, sinceIso);

          if (crossMsgs.length > 0) {
            // Group into a single context block labelled clearly
            const snippets = crossMsgs.map(r =>
              `[${r.source.toUpperCase()} – ${r.author} – ${String(r.timestamp).slice(0,10)}]\n${r.subject ? r.subject + ': ' : ''}${String(r.content).slice(0, 300)}`
            ).join('\n\n---\n\n');
            contextItems.push({
              source: 'cross-topic-search',
              title: `Cross-topic messages matching: ${questionTerms.slice(0,3).join(', ')}`,
              content: snippets,
            });
          }
        } catch {
          // FTS may not be available — skip silently
        }

        // 2. Other topic notebooks that contain any of the question terms
        try {
          const otherNotebooks = db.prepare(
            `SELECT topic_name, content FROM topic_notebooks WHERE topic_name != ? ORDER BY last_updated DESC`
          ).all(topicName);

          for (const other of otherNotebooks) {
            const lcContent = String(other.content).toLowerCase();
            const matches = questionTerms.filter(t => lcContent.includes(t));
            if (matches.length >= 2) {
              // This other notebook contains at least 2 of the query terms — include it
              contextItems.push({
                source: 'notebook',
                title: `${other.topic_name} — related notebook`,
                content: String(other.content).slice(0, 1500),
              });
            }
          }
        } catch {
          // skip silently
        }
      }

      // EP-59: Palace search in parallel with FTS (59-C6: 500ms timeout)
      const palaceTimeout = (promise) => Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(''), 500))
      ]);

      const [palaceSearchRaw, palaceKgRaw, palaceTraversalRaw, embeddingList] = await Promise.all([
        palaceClient ? palaceTimeout(palaceClient.search(message, undefined, 5)) : Promise.resolve(''),
        palaceClient && entities.jiraKeys.length > 0
          ? palaceTimeout(palaceClient.kgQuery(entities.jiraKeys[0]))
          : Promise.resolve(''),
        // EP-59: KG traversal for multi-hop answers (59-C5)
        palaceClient && (entities.jiraKeys.length > 0 || entities.flags.length > 0 || entities.people.length > 0)
          ? palaceTimeout(palaceClient.traverse(
              entities.jiraKeys[0] || entities.flags[0] || entities.people[0]
            ))
          : Promise.resolve(''),
        // post-graphify step 2: pure-semantic 5th lane, parallel for latency budget
        embeddingsRankList(message, db, 25),
      ]);

      // Convert palace results to ContextItem[]
      const palaceContextItems = [];
      if (palaceSearchRaw) {
        try {
          const palaceResults = JSON.parse(palaceSearchRaw);
          // Cap palace context at ~2000 tokens (~500 chars per item, ~4 items) per 59-C8
          const cappedResults = Array.isArray(palaceResults) ? palaceResults.slice(0, 4) : [];
          for (const r of cappedResults) {
            palaceContextItems.push({
              source: 'palace-search',
              title: r.label || r.room || 'Palace Memory',
              content: (r.content || '').slice(0, 500),
              timestamp: r.created_at || r.createdAt,
              metadata: { wing: r.wing, room: r.room, drawerId: r.id },
            });
          }
        } catch { /* palace returned non-JSON — ignore */ }
      }
      if (palaceKgRaw) {
        try {
          const kgResult = JSON.parse(palaceKgRaw);
          const triples = Array.isArray(kgResult) ? kgResult : (kgResult.triples || []);
          if (triples.length > 0) {
            palaceContextItems.push({
              source: 'palace-kg',
              title: `KG: ${entities.jiraKeys[0]} relationships`,
              content: triples.slice(0, 10).map(t => `${t.subject} ${t.predicate} ${t.object}`).join('; '),
              metadata: { wing: 'kg', drawerId: entities.jiraKeys[0] },
            });
          }
        } catch { /* KG returned non-JSON — ignore */ }
      }

      // EP-59: Convert traversal paths to ContextItem (59-C5)
      if (palaceTraversalRaw) {
        const paths = parseTraversalPaths(palaceTraversalRaw);
        const formatted = formatTraversalAsText(paths);
        if (formatted) {
          palaceContextItems.push({
            source: 'palace-graph',
            title: `KG Traversal: ${entities.jiraKeys[0] || entities.flags[0] || entities.people[0]}`,
            content: formatted,
            metadata: { wing: 'kg', type: 'traversal' },
          });
        }
      }

      // Record palace hit rate
      if (palaceClient) {
        palaceClient.recordQuery(palaceContextItems.length > 0);
      }

      // EP-59 + post-graphify step 2: RRF fusion across 5 lanes
      const ftsRankList = [...contextItems]; // existing FTS-sourced items (already in rank order)
      const palaceSearchList = palaceContextItems.filter(i => i.source === 'palace-search');
      const palaceKgList = palaceContextItems.filter(i => i.source === 'palace-kg');
      const palaceGraphList = palaceContextItems.filter(i => i.source === 'palace-graph');
      const embeddingRankList = Array.isArray(embeddingList) ? embeddingList : [];

      // Fuse all rank lists using RRF with k=60
      const fusedItems = rrfFuse([ftsRankList, palaceSearchList, palaceKgList, palaceGraphList, embeddingRankList]);

      // EP-34: rank fused items by relevance + recency before passing to AI
      const rankedItems = rankContextItems(fusedItems);

      // EP-59 + post-graphify: Retrieval instrumentation (now includes embeddingHits)
      process.stderr.write(`[retrieval] ${JSON.stringify({
        handler: 'notebook-chat',
        query: message.slice(0, 100),
        entities: {
          jiraKeys: entities.jiraKeys.length,
          people: entities.people.length,
          flags: entities.flags.length,
          files: entities.files.length,
        },
        ftsHits: ftsRankList.length,
        palaceSearchHits: palaceSearchList.length,
        palaceKgHits: palaceKgList.length,
        palaceGraphHits: palaceGraphList.length,
        embeddingHits: embeddingRankList.length,
        fusedTotal: fusedItems.length,
        rankedTotal: rankedItems.length,
        topSources: rankedItems.slice(0, 5).map(i => i.source),
      })}\n`);

      const { reply, suggestedFollowUps } = await analyzer.chatWithContext(cleanHistory, message, rankedItems, notebookContent ?? undefined);
      saveNotebookChatEntry(db, topicName, message.trim(), reply);

      // EP-59: Build sources array for provenance UI
      const sources = rankedItems.slice(0, 10).map((item) => ({
        type: item.source,
        title: item.title,
        url: item.url || (item.metadata?.drawerId ? `/api/palace/drawer/${encodeURIComponent(item.metadata.drawerId)}` : undefined),
        wing: item.metadata?.wing || undefined,
        room: item.metadata?.room || undefined,
        drawerId: item.metadata?.drawerId || undefined,
      }));

      json(res, 200, { reply, suggestedFollowUps, sources, hasNotebook: !!notebookContent });
      return;
    }

    // GET /api/notebooks/:topicName/history — last 10 Q&A pairs
    const historyMatch = path.match(/^\/api\/notebooks\/([^/]+)\/history$/);
    if (historyMatch && req.method === 'GET') {
      const topicName = decodeURIComponent(historyMatch[1]);
      const entries = getNotebookChatHistory(db, topicName, 10);
      json(res, 200, { history: entries });
      return;
    }

    // GET /api/notebooks/:topicName/annotation — get user annotation (EP-27)
    const annotationGetMatch = path.match(/^\/api\/notebooks\/([^/]+)\/annotation$/);
    if (annotationGetMatch && req.method === 'GET') {
      const topicName = decodeURIComponent(annotationGetMatch[1]);
      const annotation = getAnnotation(db, topicName);
      json(res, 200, { annotation });
      return;
    }

    // PUT /api/notebooks/:topicName/annotation — save user annotation (EP-27)
    const annotationPutMatch = path.match(/^\/api\/notebooks\/([^/]+)\/annotation$/);
    if (annotationPutMatch && req.method === 'PUT') {
      const topicName = decodeURIComponent(annotationPutMatch[1]);
      const rawBody = await readBody(req);
      const parsed = parseBody(AnnotationSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const annotation = parsed.data.annotation;
      saveAnnotation(db, topicName, annotation);
      // Trigger single-file vault export if vault is configured
      if (process.env.OBSIDIAN_VAULT_PATH) {
        try {
          exportSingleNotebook(db, process.env.OBSIDIAN_VAULT_PATH, topicName);
        } catch (err) {
          process.stderr.write(`[Vault] single export failed for "${topicName}": ${err.message}\n`);
        }
      }
      json(res, 200, { ok: true });
      return;
    }

    // POST /api/notebooks/:topicName/feedback — append a human correction (EP-49-4)
    const feedbackMatch = path.match(/^\/api\/notebooks\/([^/]+)\/feedback$/);
    if (feedbackMatch && req.method === 'POST') {
      const topicName = decodeURIComponent(feedbackMatch[1]);
      const body = await readBody(req);
      const correction = typeof body?.correction === 'string' ? body.correction.trim() : '';
      if (!correction) { json(res, 400, { error: 'correction is required' }); return; }
      appendCorrection(db, topicName, correction);
      json(res, 200, { ok: true });
      return;
    }

    // GET /api/vault/status — vault configuration and stats (EP-27)
    if (path === '/api/vault/status' && req.method === 'GET') {
      const vaultPath = process.env.OBSIDIAN_VAULT_PATH ?? null;
      const noteCount = vaultPath ? countVaultNotes(vaultPath) : 0;
      json(res, 200, { configured: !!vaultPath, vaultPath, noteCount });
      return;
    }

    // POST /api/vault/export — manual export trigger (EP-27)
    if (path === '/api/vault/export' && req.method === 'POST') {
      const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultPath) {
        json(res, 400, { error: 'OBSIDIAN_VAULT_PATH not configured' });
        return;
      }
      try {
        const result = await exportNotebooksToVault(db, vaultPath);
        json(res, 200, result);
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return;
    }

    // GET /api/topic-suggestions — list undismissed suggestions (EP-14-3)
    if (path === '/api/topic-suggestions' && req.method === 'GET') {
      const rows = db.prepare(
        `SELECT id, keyword, message_count, author_count, sample_msgs, suggested_at
         FROM topic_suggestions WHERE dismissed = 0 ORDER BY message_count DESC LIMIT 20`
      ).all();
      const suggestions = rows.map(r => ({
        ...r,
        sample_msgs: r.sample_msgs ? JSON.parse(r.sample_msgs) : [],
      }));
      json(res, 200, { suggestions });
      return;
    }

    // POST /api/topic-suggestions/:id/dismiss — dismiss a suggestion (EP-14-3)
    const dismissMatch = path.match(/^\/api\/topic-suggestions\/(\d+)\/dismiss$/);
    if (dismissMatch && req.method === 'POST') {
      const id = Number(dismissMatch[1]);
      const result = dismissTopicSuggestion(db, id);
      json(res, 200, { ok: true, message: result });
      return;
    }

    // POST /api/configure-topic
    if (path === '/api/configure-topic' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const parsed = parseBody(ConfigureTopicSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const result = await configureTopic(db, parsed.data);
      _topicConfigCache = null; // invalidate routing cache
      json(res, 200, result);
      return;
    }

    // GET /api/saturn/issues (EP-20)
    if ((path === '/api/saturn/issues' || path === '/api/board/issues') && req.method === 'GET') {
      const jiraSource = process.env.JIRA_SOURCE ?? 'auto';
      if (jiraSource === 'browser' && !process.env.BROWSER_PROFILE_PATH) {
        json(res, 200, { issues: [], error: 'browser_not_configured', isRefreshing: false });
        return;
      }
      const forceRefresh = url.searchParams.get('refresh') === 'true';
      const age = Date.now() - saturnCache.fetchedAt;
      const saturnCoolingDown = (Date.now() - saturnCache.lastFailedAt) < 60_000;
      if (saturnCache.fetchedAt === 0 && !saturnCache.isRefreshing && !saturnCoolingDown) {
        refreshSaturnCache(); // fire-and-forget — client polls via isRefreshing
      } else if ((age > SATURN_CACHE_TTL_MS || forceRefresh) && !saturnCache.isRefreshing && !saturnCoolingDown) {
        refreshSaturnCache(); // fire-and-forget
      }
      json(res, 200, {
        issues: saturnCache.data,
        cachedAt: saturnCache.fetchedAt ? new Date(saturnCache.fetchedAt).toISOString() : null,
        isRefreshing: saturnCache.isRefreshing,
        lastFailedAt: saturnCache.lastFailedAt ? new Date(saturnCache.lastFailedAt).toISOString() : null,
        dataSource: saturnCache.dataSource ?? 'unknown',
      });
      return;
    }

    // GET /api/jira/my-issues (EP-21)
    if (path === '/api/jira/my-issues' && req.method === 'GET') {
      const jiraSourceMi = process.env.JIRA_SOURCE ?? 'auto';
      if (jiraSourceMi === 'browser' && !process.env.BROWSER_PROFILE_PATH) {
        json(res, 200, { issues: [], error: 'browser_not_configured', isRefreshing: false });
        return;
      }
      const forceRefresh = url.searchParams.get('refresh') === 'true';
      const age = Date.now() - myIssuesCache.fetchedAt;
      const myIssuesCoolingDown = (Date.now() - myIssuesCache.lastFailedAt) < 60_000;
      if (myIssuesCache.fetchedAt === 0 && !myIssuesCache.isRefreshing && !myIssuesCoolingDown) {
        refreshMyIssuesCache(); // fire-and-forget — client polls via isRefreshing
      } else if ((age > MY_ISSUES_TTL_MS || forceRefresh) && !myIssuesCache.isRefreshing && !myIssuesCoolingDown) {
        refreshMyIssuesCache(); // fire-and-forget
      }
      const resp = {
        issues: myIssuesCache.data,
        cachedAt: myIssuesCache.fetchedAt ? new Date(myIssuesCache.fetchedAt).toISOString() : null,
        isRefreshing: myIssuesCache.isRefreshing,
      };
      if (myIssuesCache.authExpired) resp.error = 'auth_expired';
      json(res, 200, resp);
      return;
    }

    // ── EP-42-5: Unified Jira Issues endpoint ─────────────────────────────
    // GET /api/jira/issues?filter=mine|saturn|sprint|backlog
    if (path === '/api/jira/issues' && req.method === 'GET') {
      const filter = url.searchParams.get('filter') ?? SATURN_LIST_NAME;
      let issues = [];
      let cachedAt = null;
      let isRefreshing = false;

      if (filter === 'mine') {
        issues = myIssuesCache.data;
        cachedAt = myIssuesCache.fetchedAt ? new Date(myIssuesCache.fetchedAt).toISOString() : null;
        isRefreshing = myIssuesCache.isRefreshing;
      } else {
        // saturn / sprint / backlog — all served from saturnCache, filtered by status
        issues = saturnCache.data;
        cachedAt = saturnCache.fetchedAt ? new Date(saturnCache.fetchedAt).toISOString() : null;
        isRefreshing = saturnCache.isRefreshing;

        if (filter === 'sprint') {
          issues = issues.filter(i => i.status && !['Done', 'Closed', 'Resolved', 'Cancelled', 'Completed'].includes(i.status));
        } else if (filter === 'backlog') {
          issues = issues.filter(i => i.status && ['To Do', 'Open', 'Backlog'].includes(i.status));
        }
        // filter=saturn: return all
      }

      // GAP-7: attach similarLearning per issue (only when corpus has >= 10 learnings)
      const issuesWithLearnings = issues.map(issue => {
        const projectKey = issue.key.split('-')[0];
        const totalLearnings = db.prepare('SELECT COUNT(*) as n FROM ticket_learnings WHERE project_key = ?').get(projectKey)?.n ?? 0;
        if (totalLearnings < 10) return { ...issue, similarLearning: null };
        const stopWords = new Set(['the','a','an','is','are','was','in','on','at','to','for','of','and','or','with','not','it','be','do','does','this','that','its']);
        const keywords = (issue.title || '').toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w));
        const learning = keywords.length > 0 ? findSimilarLearnings(db, keywords, 1)[0] : null;
        return { ...issue, similarLearning: learning ? { summary: learning.summary, solution: learning.solution } : null };
      });

      json(res, 200, { filter, issues: issuesWithLearnings, cachedAt, isRefreshing });
      return;
    }

    // ── EP-42-7: Ticket Learnings ──────────────────────────────────────────

    // GET /api/jira/ticket/:key — live ticket detail (EP-49-10, extended EP-50)
    const ticketSummaryMatch = path.match(/^\/api\/jira\/ticket\/([A-Z][A-Z0-9]+-\d+)$/);
    if (ticketSummaryMatch && req.method === 'GET') {
      const key = ticketSummaryMatch[1];
      // Try MCP first — use jira_get_issue for full detail including comments
      try {
        const { McpClient } = await import('./dist/fetcher/sources/mcp-oauth-client.js');
        const client = new McpClient(db, getJiraMcpClientName(), process.env.JIRA_MCP_URL ?? 'https://jira.example.com/mcp' /* config-driven — set JIRA_MCP_URL env var */);
        let issueData = null;
        // Try jira_get_issue for full detail with comments
        try {
          const raw = await client.callTool('jira_get_issue', { issue_key: key, fields: 'summary,status,assignee,description,comment,issuetype,priority,labels,reporter', comment_limit: 20 });
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          // Jira MCP returns a flat object with a 'key' field directly (no 'fields' wrapper, no 'issues' array)
          // Jira REST API returns { key, fields: {...} }. Handle both shapes.
          if (parsed?.fields) {
            issueData = parsed; // REST shape
          } else if (parsed?.key) {
            issueData = parsed; // MCP flat shape
          } else if (parsed?.issues?.[0]) {
            issueData = parsed.issues[0]; // search result shape
          }
        } catch {
          // Fall back to jira_search if jira_get_issue not available
          const raw = await client.callTool('jira_search', { jql: `key = ${key}`, fields: 'summary,status,assignee,description,issuetype,priority,labels,reporter', limit: 1 });
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const items = parsed?.issues ?? (Array.isArray(parsed) ? parsed : []);
          issueData = items[0] ?? null;
        }
        if (issueData) {
          const f = issueData.fields || issueData;
          // Jira MCP returns flat structure with snake_case fields; Jira REST API returns nested fields
          // Comments: MCP → top-level f.comments[].author.display_name; REST → f.comment.comments[].author.displayName
          const rawComments = f.comments ?? f.comment?.comments ?? [];
          const comments = rawComments.map(c => ({
            author: c.author?.display_name ?? c.author?.displayName ?? 'Unknown',
            body: typeof c.body === 'string' ? c.body : (c.body?.content ? JSON.stringify(c.body.content) : ''),
            created: c.created ?? '',
          }));
          json(res, 200, {
            key: issueData.key ?? key,
            title: f.summary ?? '',
            status: f.status?.name ?? '',
            // MCP uses display_name; REST API uses displayName
            assignee: f.assignee?.display_name ?? f.assignee?.displayName ?? null,
            reporter: f.reporter?.display_name ?? f.reporter?.displayName ?? null,
            priority: f.priority?.name ?? null,
            // MCP uses issue_type; REST API uses issuetype
            issueType: f.issue_type?.name ?? f.issuetype?.name ?? null,
            labels: Array.isArray(f.labels) ? f.labels : [],
            description: (typeof f.description === 'string' ? f.description : '').slice(0, 3000),
            url: getJiraBrowseUrl(key),
            comments,
          });
          return;
        }
      } catch { /* fall through to DB */ }
      // DB fallback
      const row = db.prepare(`SELECT key, title, status, assignee, url FROM jira_issues WHERE key = ? LIMIT 1`).get(key);
      if (row) {
        json(res, 200, { key: row.key, title: row.title, status: row.status, assignee: row.assignee ?? null, reporter: null, priority: null, issueType: null, labels: [], description: '', url: row.url ?? getJiraBrowseUrl(key), comments: [] });
      } else {
        json(res, 404, { error: 'Ticket not found' });
      }
      return;
    }

    // GET /api/jira/board — EP-50 My Work Cockpit (mine|sprint|all tabs)
    if (path === '/api/jira/board' && req.method === 'GET') {
      const tab = url.searchParams.get('tab') || 'mine';
      const forceRefresh = url.searchParams.get('refresh') === 'true';
      const validTab = ['mine', 'sprint', 'all'].includes(tab) ? tab : 'mine';

      const cache = boardCache[validTab];
      const ttl = BOARD_TTL[validTab];
      const now = Date.now();

      // isRefreshing timeout safety reset
      if (cache.isRefreshing && cache.refreshStartedAt && (now - cache.refreshStartedAt) > BOARD_REFRESH_TIMEOUT) {
        cache.isRefreshing = false;
      }

      const isFresh = cache.cachedAt && (now - new Date(cache.cachedAt).getTime()) < ttl;

      if (!forceRefresh && isFresh && cache.data) {
        json(res, 200, { ...cache.data, isRefreshing: false });
        return;
      }

      if (cache.data && !forceRefresh) {
        // Return stale + trigger background refresh
        cache.isRefreshing = true;
        cache.refreshStartedAt = now;
        _fetchBoardTab(validTab).catch(e => {
          cache.isRefreshing = false;
          process.stderr.write(`[board] bg refresh failed (${validTab}): ${e.message}\n`);
        });
        json(res, 200, { ...cache.data, isRefreshing: true });
        return;
      }

      // No cache — blocking fetch
      cache.isRefreshing = true;
      cache.refreshStartedAt = now;
      try {
        const result = await _fetchBoardTab(validTab);
        json(res, 200, result);
      } catch (err) {
        cache.isRefreshing = false;
        json(res, 500, { error: err.message });
      }
      return;
    }

    // GET /api/jira/mcp-status — check if Jira MCP is reachable (EP-49)
    if (path === '/api/jira/mcp-status' && req.method === 'GET') {
      try {
        const { McpClient } = await import('./dist/fetcher/sources/mcp-oauth-client.js');
        const client = new McpClient(db, getJiraMcpClientName(), process.env.JIRA_MCP_URL ?? 'https://jira.example.com/mcp' /* config-driven — set JIRA_MCP_URL env var */);
        await client.callTool('jira_search', { jql: 'issueType = Epic' });
        json(res, 200, { connected: true });
      } catch (err) {
        json(res, 200, { connected: false, error: err.message ?? 'MCP unreachable' });
      }
      return;
    }

    // GET /api/jira/ticket/:key/learn
    const learnGetMatch = path.match(/^\/api\/jira\/ticket\/([^/]+)\/learn$/);
    if (learnGetMatch && req.method === 'GET') {
      const issueKey = learnGetMatch[1];
      const learning = getLearning(db, issueKey);
      json(res, 200, { learning });
      return;
    }

    // POST /api/jira/ticket/:key/learn
    const learnPostMatch = path.match(/^\/api\/jira\/ticket\/([^/]+)\/learn$/);
    if (learnPostMatch && req.method === 'POST') {
      const issueKey = learnPostMatch[1];
      const rawBody = await readBody(req);
      let body;
      try { body = JSON.parse(rawBody); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
      const { summary, solution, files_changed, traps, cycle_time_hours } = body;
      if (!summary || !solution) { json(res, 400, { error: 'summary and solution are required' }); return; }
      saveLearning(db, {
        issue_key: issueKey,
        project_key: issueKey.split('-')[0] ?? 'UNKNOWN',
        summary: String(summary),
        solution: String(solution),
        files_changed: files_changed ? JSON.stringify(files_changed) : null,
        traps: traps ? String(traps) : null,
        cycle_time_hours: cycle_time_hours ?? null,
        auto_captured: 0,
        embedding: null,
      });
      json(res, 201, { ok: true });
      return;
    }

    // GET /api/jira/learnings?project=PROJ&q=search+terms
    if (path === '/api/jira/learnings' && req.method === 'GET') {
      const project = url.searchParams.get('project') ?? DEFAULT_JIRA_PROJECT;
      const q = url.searchParams.get('q') ?? '';
      const keywords = q.split(/\s+/).filter(Boolean);
      const learnings = keywords.length > 0
        ? findSimilarLearnings(db, keywords, 10)
        : db.prepare('SELECT * FROM ticket_learnings WHERE project_key = ? ORDER BY learned_at DESC LIMIT 20').all(project);
      json(res, 200, { learnings });
      return;
    }

    // GET /api/jira/epic/:key/children — EP-48-1: fetch child issues of an epic
    const epicChildrenMatch = path.match(/^\/api\/jira\/epic\/([^/]+)\/children$/);
    if (epicChildrenMatch && req.method === 'GET') {
      const epicKey = epicChildrenMatch[1];
      if (!/^[A-Z]+-\d+$/.test(epicKey)) { json(res, 400, { error: 'Invalid epic key' }); return; }
      try {
        const session = getBrowserSession();
        // Wrap in lock: MCP path is stateless but browser fallback uses the singleton
        // session — concurrent scrapes crash with page-closed errors (same class as EP-20/21).
        const children = await withEpicChildrenLock(() => fetchEpicChildren(epicKey, session));
        json(res, 200, { children });
      } catch (err) {
        json(res, 500, { error: String(err?.message ?? err) });
      }
      return;
    }

    // POST /api/sync/all (EP-22)
    if (path === '/api/sync/all' && req.method === 'POST') {
      if (syncProgress.running) {
        json(res, 200, { status: 'already_running', ...syncProgress });
        return;
      }
      runFullSync(); // fire-and-forget
      json(res, 200, { status: 'started', ...syncProgress });
      return;
    }

    // POST /api/sync?source=email|jira|teams|calendar — per-source targeted sync
    if (path === '/api/sync' && req.method === 'POST') {
      const source = url.searchParams.get('source');
      if (!source) {
        json(res, 400, { ok: false, error: 'Missing ?source= parameter. Use: email, jira, teams, calendar' });
        return;
      }
      if (syncProgress.running) {
        json(res, 200, { status: 'already_running', ...syncProgress });
        return;
      }
      switch (source) {
        case 'email':
          try { await runEmailSync(); json(res, 200, { ok: true, source: 'email' }); }
          catch (err) { json(res, 200, { ok: true, source: 'email', warning: String(err.message) }); }
          break;
        case 'jira':
          await runTargetedJiraSync();
          json(res, 200, { ok: true, source: 'jira' });
          break;
        case 'teams':
          try { await runTargetedTeamsSync(); json(res, 200, { ok: true, source: 'teams' }); }
          catch (err) { json(res, 200, { ok: true, source: 'teams', warning: String(err.message) }); }
          break;
        case 'calendar':
          try { await runTargetedCalendarSync(); json(res, 200, { ok: true, source: 'calendar' }); }
          catch (err) { json(res, 200, { ok: true, source: 'calendar', warning: String(err.message) }); }
          break;
        default:
          json(res, 400, { ok: false, error: `Unknown source '${source}'. Use: email, jira, teams, calendar` });
      }
      return;
    }

    // GET /api/sync/stream (ADR-044 AC-U3/U4) — per-source SSE. Pushes
    // started/result/error per source as each lands (email at ~5s, jira at
    // ~90s) instead of the poll-only /api/sync/status + /api/sync/telemetry.
    // Sources run SEQUENTIALLY because they share one browser session (same
    // ordering as runFullSync). Each runXSync already writes a fetch_runs row
    // + captures a /bugs entry on non-ok, so the result event reads the count
    // straight from telemetry (single source of truth). AC-U4: the work is
    // await-based I/O that yields the event loop, so /api/status stays
    // responsive throughout — same property runFullSync relies on.
    if (path === '/api/sync/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(res._corsHeaders || {}),
      });
      res.flushHeaders?.();
      res.write('retry: 3000\n\n');
      const send = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
        catch { /* client disconnected */ }
      };
      const keepAlive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 15_000);

      // Optional ?sources=email,jira,teams,calendar (default: all four).
      const requested = (url.searchParams.get('sources') || 'email,jira,teams,calendar')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const RUNNERS = {
        email: runEmailSync,
        jira: runTargetedJiraSync,
        teams: runTargetedTeamsSync,
        calendar: runTargetedCalendarSync,
      };
      const sources = requested.filter((s) => s in RUNNERS);

      if (syncProgress.running) {
        send('error', { error: 'already_running', detail: 'a full sync is in progress' });
        send('done', { ok: false, reason: 'already_running' });
        clearInterval(keepAlive);
        res.end();
        return;
      }

      const latestCount = (source) => {
        try {
          const row = db.prepare(
            `SELECT count, status FROM fetch_runs WHERE source = ? ORDER BY id DESC LIMIT 1`,
          ).get(source);
          return row || null;
        } catch { return null; }
      };

      send('started', { sources, at: new Date().toISOString() });

      (async () => {
        const summary = [];
        for (const source of sources) {
          send('progress', { source, phase: 'fetching' });
          const startedMs = Date.now();
          try {
            await RUNNERS[source]();
            const tel = latestCount(source);
            const entry = {
              source,
              status: tel?.status ?? 'ok',
              count: tel?.count ?? null,
              durationMs: Date.now() - startedMs,
            };
            summary.push(entry);
            send('result', entry);
          } catch (err) {
            // A source failure NEVER sinks the stream — emit its error event and
            // move to the next source (per-source isolation, ADR-044 § fetch semantics).
            const entry = {
              source,
              status: 'error',
              note: err instanceof Error ? err.message.split('\n')[0] : String(err),
              durationMs: Date.now() - startedMs,
            };
            summary.push(entry);
            send('error', entry);
          }
        }
        send('done', { ok: true, summary });
        clearInterval(keepAlive);
        res.end();
      })().catch((err) => {
        // Defensive: the loop's per-source try/catch should prevent this, but a
        // failure above the loop must still close the stream cleanly.
        send('error', { error: 'stream_failed', detail: err instanceof Error ? err.message : String(err) });
        send('done', { ok: false });
        clearInterval(keepAlive);
        res.end();
      });
      return;
    }

    // POST /api/search-all/stream (ADR-044 S4) — SSE parallel search across
    // local FTS + Outlook email + Jira + Teams. `local` is emitted FIRST
    // (synchronous FTS over already-synced data) so the caller ALWAYS has a
    // grounding answer within ~10ms even if every live source stalls. Each
    // live source runs in parallel with its OWN 15s timeout via the
    // orchestrator's cancel-and-release path (session.releaseBySource → the
    // browser pool slot is FREED, not leaked, on timeout). AbortController on
    // req.close aborts all in-flight fetches when the client disconnects.
    //
    // Body: {query: string, sources?: string[]}  (default sources: local, teams, jira, email)
    // Event schema (mirrors GET /api/sync/stream):
    //   data: {kind:'started',  source}
    //   data: {kind:'result',   source, status, count, durationMs, note?}
    //   data: {kind:'done',     sources: [...]}
    if (path === '/api/search-all/stream' && req.method === 'POST') {
      const rawBody = await readBody(req);
      let body;
      try { body = JSON.parse(rawBody || '{}'); }
      catch { json(res, 400, { error: 'invalid_json' }); return; }
      const query = String(body?.query ?? '').trim();
      if (!query) { json(res, 400, { error: 'query is required' }); return; }
      const requestedSources = Array.isArray(body?.sources) && body.sources.length > 0
        ? body.sources.map((s) => String(s))
        : ['local', 'teams', 'jira', 'email'];

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(res._corsHeaders || {}),
      });
      res.flushHeaders?.();
      res.write('retry: 3000\n\n');

      // AbortController wired to req.close — a client disconnect aborts every
      // in-flight source fetch, and the orchestrator's release() (called by
      // fetchOneSource on abort) force-closes the pooled browser page + frees
      // its slot. Without this, a client Ctrl-C would leak the pool.
      const streamAbort = new AbortController();
      const onClose = () => { try { streamAbort.abort(); } catch {} };
      req.on('close', onClose);

      const writeEvent = (payload) => {
        try { res.write(`data: ${JSON.stringify(payload)}\n\n`); }
        catch { /* client gone */ }
      };
      const keepAlive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 15_000);

      try {
        const { fetchStream, localSpec } = await import('./dist/fetcher/orchestrator.js');
        const specs = [];
        const notes = [];

        // Cap per-source timeout at 15s (per plan/ADR — local NEVER cancels;
        // live sources get 15s each; overall wall-clock cap 30s below).
        const PER_SOURCE_TIMEOUT_MS = 15_000;
        const sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        for (const src of requestedSources) {
          if (src === 'local') {
            specs.push(localSpec(db, query, 50, 5_000));
          } else if (src === 'email') {
            if (!process.env.BROWSER_PROFILE_PATH) {
              // No browser profile — synthesize an error envelope rather than
              // silently drop the source (caller sees why).
              notes.push({ source: 'email', reason: 'BROWSER_PROFILE_PATH_missing' });
              continue;
            }
            const session = getBrowserSession();
            const { OutlookBrowserConnector } = await import('./dist/fetcher/sources/outlook-browser.js');
            const connector = new OutlookBrowserConnector(session);
            specs.push({
              source: 'email',
              fetch: (signal) => connector.fetchMessages({ folder: 'inbox', subjectFilter: query }, sinceDate, signal),
              release: () => session.releaseBySource('email'),
              timeoutMs: PER_SOURCE_TIMEOUT_MS,
            });
          } else if (src === 'jira') {
            const boardUrl = process.env.JIRA_BOARD_URL;
            if (!boardUrl) {
              notes.push({ source: 'jira', reason: 'JIRA_BOARD_URL_missing' });
              continue;
            }
            const session = getBrowserSession();
            const { createJiraDataSource } = await import('./dist/fetcher/sources/jira-adapter.js');
            const jira = createJiraDataSource(session);
            specs.push({
              source: 'jira',
              fetch: () => jira.fetchMessages({ boardUrl }, sinceDate),
              release: () => session.releaseBySource('jira'),
              timeoutMs: PER_SOURCE_TIMEOUT_MS,
            });
          } else if (src === 'teams') {
            // Teams is search-only in this endpoint (mirrors src/tools/search-all.ts
            // — the teams-sync background loop is the writer). Emit a synthetic
            // ok envelope with the count of local teams-scoped FTS matches so
            // the client can distinguish "teams has hits" from "teams empty".
            const teamsQuery = query.replace(/"/g, '""');
            let count = 0;
            try {
              const row = db.prepare(
                `SELECT COUNT(*) AS c FROM messages_fts JOIN messages m ON messages_fts.rowid = m.id
                 WHERE messages_fts MATCH ? AND m.source = 'teams'`
              ).get(teamsQuery);
              count = row?.c ?? 0;
            } catch { /* FTS parse error → 0 */ }
            specs.push({
              source: 'teams',
              // Local read; no network, no browser slot. Resolves synchronously
              // inside the fetch closure so it lands near-instantly.
              fetch: async () => {
                // The orchestrator persists messages from returned array; we
                // return [] to skip persistence (rows already in DB) and rely
                // on the envelope's count field, which we override below by
                // wrapping in a spec that reports `count` via note. But since
                // fetchOneSource sets count = messages.length, we cheat by
                // returning empty-shell UnifiedMessages *only* if count > 0
                // is needed. Simplest honest path: return [] and put count in
                // note. That said, plan wants "envelope ok" — an ok with
                // count=0 satisfies "did not fail". We surface real count in
                // note.
                return [];
              },
              timeoutMs: PER_SOURCE_TIMEOUT_MS,
              // NOTE: no release() — no slot held.
              // Stash the FTS count so we can annotate the envelope below.
              __teamsLocalCount: count,
            });
          } else {
            notes.push({ source: src, reason: 'unknown_source' });
          }
        }

        // Emit any config-skipped sources up-front so the client has a full picture.
        for (const n of notes) {
          writeEvent({ kind: 'result', source: n.source, status: 'error', count: 0, durationMs: 0, note: n.reason });
        }

        // Overall hard cap — 30s wall clock (per plan). If exceeded, abort all
        // remaining and emit a done frame.
        const HARD_CAP_MS = 30_000;
        const hardCap = setTimeout(() => { try { streamAbort.abort(); } catch {} }, HARD_CAP_MS);

        try {
          for await (const ev of fetchStream(db, specs)) {
            if (streamAbort.signal.aborted && ev.kind !== 'done') {
              // Client disconnected or hard-cap fired — stop pushing (but let
              // the generator drain naturally so cleanup runs).
              continue;
            }
            // Enrich the teams envelope with its local FTS count via note.
            if (ev.kind === 'result' && ev.source === 'teams') {
              const spec = specs.find((s) => s.source === 'teams');
              const teamsCount = spec && '__teamsLocalCount' in spec ? spec.__teamsLocalCount : 0;
              writeEvent({ ...ev, count: teamsCount, note: (ev.note ? ev.note + '; ' : '') + `local_fts_count=${teamsCount}` });
            } else {
              writeEvent(ev);
            }
          }
        } finally {
          clearTimeout(hardCap);
        }
      } catch (err) {
        writeEvent({ kind: 'error', source: 'orchestrator', message: err instanceof Error ? err.message : String(err) });
        writeEvent({ kind: 'done', sources: [] });
      } finally {
        clearInterval(keepAlive);
        req.removeListener('close', onClose);
        res.end();
      }
      return;
    }

    // GET /api/sync/status (EP-22)
    if (path === '/api/sync/status' && req.method === 'GET') {
      json(res, 200, { ...syncProgress, watcher: watcherState });
      return;
    }

    // POST /api/sync/enricher-backfill (Phase 88-3) — re-process last 4 weeks through MemoryEnricher.
    // This populates KG triples for meetings/Jira transitions that were missed when
    // decisions:[] was hardcoded in the sync-loop caller. Idempotent — re-processing
    // old data overwrites existing triples with the same key.
    if (path === '/api/sync/enricher-backfill' && req.method === 'POST' && memoryEnricher && palaceClient) {
      try {
        const backfillMeetings = db.prepare(
          `SELECT m.id, m.chat_name AS meetingSlug, m.title, m.transcript, m.date, m.decisions AS decisionsJson
           FROM meetings m
           WHERE m.transcript IS NOT NULL AND length(m.transcript) > 100
             AND m.date > datetime('now', '-28 days')`
        ).all();

        const meetings = backfillMeetings.map(r => {
          let decisions = [];
          try {
            if (r.decisionsJson && typeof r.decisionsJson === 'string') {
              const parsed = JSON.parse(r.decisionsJson);
              if (Array.isArray(parsed)) {
                for (const d of parsed) {
                  if (typeof d === 'string' && !decisions.includes(d)) {
                    decisions.push(d);
                  }
                }
              }
            }
          } catch {}

          return {
            meetingSlug: r.meetingSlug || `meeting-${r.id}`,
            title: r.title || '',
            transcript: r.transcript,
            decisions,
            date: r.date,
          };
        });

        const backfillJiraTransitions = db.prepare(
          `SELECT issue_key, from_status, to_status, transitioned_at
            FROM jira_transitions
           WHERE transitioned_at > datetime('now', '-28 days')
           ORDER BY transitioned_at DESC`
        ).all();

        const backfillConversations = db.prepare(
          `SELECT DISTINCT gc.name AS chatSlug, gc.name AS summary
            FROM group_chats gc
            WHERE gc.last_message_at > datetime('now', '-28 days')`
        ).all().map(r => ({
          chatSlug: r.chatSlug || 'unknown',
          summary: r.summary || '',
          participants: [],
          topicName: null,
        }));

        const topicNotebooks = db.prepare(
          `SELECT topic_name AS name, content FROM topic_notebooks
           WHERE last_updated > datetime('now', '-28 days')`
        ).all().map(r => ({ name: r.name, content: r.content }));

        const result = await memoryEnricher.enrichFromSync({
          topicNotebooks,
          jiraTransitions: backfillJiraTransitions,
          conversations: backfillConversations,
          meetings,
          messages: [],
        });

        json(res, 200, {
          ok: true,
          meetingsProcessed: meetings.length,
          triplesWritten: result.triplesWritten,
          drawersWritten: result.drawersWritten,
          entitiesExtracted: result.entitiesExtracted,
          errors: result.errors,
        });
      } catch (err) {
        json(res, 500, { error: (err && err.message) || String(err) });
      }
      return;
    }

    // GET /api/sync/telemetry (ADR-044 S2.6) — per-source fetch telemetry.
    // Recent ledger + per-source rollup (last status/when/count) so a stalled
    // or silently-empty source is visible instead of vanishing into stderr.
    if (path === '/api/sync/telemetry' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
      const { readFetchTelemetry } = await import('./dist/db/queries/fetch-runs.js');
      json(res, 200, readFetchTelemetry(db, limit));
      return;
    }

    // GET /api/daily-summary (EP-23)
    // REFACTOR-001 (2026-05-21): /api/daily-summary moved to src/routes/digest.ts

    // ── Error Tracking endpoints (EP-18) ──────────────────────────────

    // GET /api/errors
    if (path === '/api/errors' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const resolvedParam = url.searchParams.get('resolved');
      const resolved = resolvedParam === null ? undefined : resolvedParam === 'true';
      const errors = listErrorLogs(db, { limit, resolved });
      json(res, 200, { errors, count: errors.length });
      return;
    }

    // GET /api/token-stats (EP-32) — token usage summary
    if (path === '/api/token-stats' && req.method === 'GET') {
      const days = parseInt(url.searchParams.get('days') || '30');
      const { getTokenStats } = await import('./dist/db/queries.js');
      const stats = getTokenStats(db, days);
      json(res, 200, { days, ...stats });
      return;
    }

    // POST /api/errors/:id/analyze
    const analyzeMatch = path.match(/^\/api\/errors\/(\d+)\/analyze$/);
    if (analyzeMatch && req.method === 'POST') {
      const id = parseInt(analyzeMatch[1]);
      const errRow = db.prepare('SELECT * FROM error_logs WHERE id = ?').get(id);
      if (!errRow) { json(res, 404, { error: 'Error not found' }); return; }
      if (!anthropicApiKey) { json(res, 400, { error: 'ANTHROPIC_API_KEY not set' }); return; }
      const { analyzeError } = await import('./dist/tools/error-analyzer.js');
      const analysis = await analyzeError(errRow, anthropicApiKey, db);
      updateErrorAnalysis(db, id, analysis);
      json(res, 200, { analysis });
      return;
    }

    // POST /api/errors/:id/resolve
    const resolveMatch = path.match(/^\/api\/errors\/(\d+)\/resolve$/);
    if (resolveMatch && req.method === 'POST') {
      const id = parseInt(resolveMatch[1]);
      markErrorResolved(db, id);
      json(res, 200, { ok: true });
      return;
    }

    // ── Digest list/delete endpoints (EP-19) ─────────────────────────

    // REFACTOR-001 (2026-05-21): /api/digests moved to src/routes/digest.ts

    // DELETE /api/digests/:id
    const deleteDigestMatch = path.match(/^\/api\/digests\/(\d+)$/);
    if (deleteDigestMatch && req.method === 'DELETE') {
      const id = parseInt(deleteDigestMatch[1]);
      deleteDigest(db, id);
      json(res, 200, { ok: true });
      return;
    }

    // GET /api/jira/analysis/:issueKey — fetch persisted analysis
    const analysisGetMatch = path.match(/^\/api\/jira\/analysis\/([A-Z]+-\d+)$/);
    if (analysisGetMatch && req.method === 'GET') {
      const issueKey = analysisGetMatch[1];
      const row = loadJiraAnalysis(db, issueKey);
      if (!row) { json(res, 200, { status: 'not_analyzed', issue_key: issueKey }); return; }
      json(res, 200, row);
      return;
    }

    // PUT /api/jira/analysis/:issueKey/notes — save manual investigation notes (never overwritten by AI)
    const notesMatch = path.match(/^\/api\/jira\/analysis\/([A-Z]+-\d+)\/notes$/);
    if (notesMatch && req.method === 'PUT') {
      const issueKey = notesMatch[1];
      const rawBody = await readBody(req);
      const notes = (typeof rawBody === 'object' ? rawBody?.notes : null) ?? '';
      saveJiraNotes(db, issueKey, notes);
      json(res, 200, { issueKey, notes });
      return;
    }

    // GET /api/jira/analyses — list all persisted analyses (for loading on board mount)
    if (path === '/api/jira/analyses' && req.method === 'GET') {
      const { listJiraAnalyses } = await import('./dist/db/queries.js');
      const rows = listJiraAnalyses(db);
      json(res, 200, { analyses: rows });
      return;
    }

    // POST /api/jira/analyze — 3-parallel deep analysis (code + effort + explanation)
    if (path === '/api/jira/analyze' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const parsed = parseBody(JiraAnalyzeSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const { issueKey, title, status, assignee, epic } = parsed.data;
      if (!analyzer) {
        json(res, 400, { error: 'AI is not available — ANTHROPIC_API_KEY is not set.' });
        return;
      }

      // GAP-2: 409 per-key in-flight guard.
      // Two layers: (a) DB row pending — survives bridge restart, prevents
      // re-trigger storms when the in-memory Set was reset; (b) in-memory
      // Set — catches same-process double-clicks before DB write lands.
      const existingRow = loadJiraAnalysis(db, issueKey);
      if (existingRow?.status === 'pending') {
        json(res, 409, { error: 'Analysis already in progress for this issue (DB pending — wait or restart bridge to reap)' });
        return;
      }
      if (analyzeInProgress.has(issueKey)) {
        json(res, 409, { error: 'Analysis already in progress for this issue' });
        return;
      }
      analyzeInProgress.add(issueKey);

      // Mark as pending immediately so UI can show "Analyzing…" right away
      saveJiraAnalysis(db, issueKey, { status: 'pending' });

      // Return immediately — client polls via GET /api/jira/analysis/:key
      json(res, 202, { issueKey, status: 'pending' });

      // Fetch full ticket detail from MCP for richer prompt context
      let ticketDescription = '';
      let ticketComments = [];
      let ticketLabels = [];
      let ticketPriority = null;
      let ticketIssueType = null;
      try {
        const { McpClient } = await import('./dist/fetcher/sources/mcp-oauth-client.js');
        const mcpClient = new McpClient(db, getJiraMcpClientName(), process.env.JIRA_MCP_URL ?? 'https://jira.example.com/mcp' /* config-driven — set JIRA_MCP_URL env var */);
        const raw = await mcpClient.callTool('jira_get_issue', { issue_key: issueKey, fields: 'summary,status,assignee,description,comment,issuetype,priority,labels,reporter', comment_limit: 10 });
        const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const f = p?.fields || p;
        if (f?.key || f?.summary) {
          ticketDescription = (typeof f.description === 'string' ? f.description : '').slice(0, 2000);
          ticketLabels = Array.isArray(f.labels) ? f.labels : [];
          ticketPriority = f.priority?.name ?? null;
          ticketIssueType = f.issue_type?.name ?? f.issuetype?.name ?? null;
          const rawComments = f.comments ?? f.comment?.comments ?? [];
          ticketComments = rawComments.slice(0, 5).map(c => ({
            author: c.author?.display_name ?? c.author?.displayName ?? 'Unknown',
            body: (typeof c.body === 'string' ? c.body : '').slice(0, 500),
            created: c.created ?? '',
          }));
        }
      } catch { /* non-fatal — proceed with what we have */ }

      // Build rich ticket context block used in all prompts
      const ticketMeta = [
        `Key: ${issueKey}`,
        `Type: ${ticketIssueType ?? 'Issue'}`,
        `Title: ${title}`,
        `Status: ${status || 'Unknown'}`,
        `Priority: ${ticketPriority ?? 'Unknown'}`,
        `Assignee: ${assignee ?? 'Unassigned'}`,
        epic ? `Epic: ${epic}` : null,
        ticketLabels.length > 0 ? `Labels: ${ticketLabels.join(', ')}` : null,
      ].filter(Boolean).join('\n');

      const descriptionBlock = ticketDescription
        ? `\n\n## Description\n${ticketDescription}`
        : '';

      const commentsBlock = ticketComments.length > 0
        ? `\n\n## Recent Comments\n${ticketComments.map(c => `[${c.author}]: ${c.body}`).join('\n---\n')}`
        : '';

      const ticketContext = `## Ticket\n${ticketMeta}${descriptionBlock}${commentsBlock}`;

      // 0. Extract and fetch linked documents from ticket description + comments
      let linkedContext = [];
      let linkedContentJson = null;
      try {
        const textsToScan = [ticketDescription, ...ticketComments.map(c => c.body)];
        const links = extractLinks(textsToScan, issueKey, 5);
        if (links.length > 0) {
          const { McpClient } = await import('./dist/fetcher/sources/mcp-oauth-client.js');
          const mcpClient = new McpClient(db, getJiraMcpClientName(), process.env.JIRA_MCP_URL ?? 'https://jira.example.com/mcp' /* config-driven — set JIRA_MCP_URL env var */);
          const ghMcp = new GitHubMcpClient(db);
          const fetcher = new LinkFetcher({
            db,
            jiraMcpCallTool: (tool, args) => mcpClient.callTool(tool, args),
            githubMcpCallTool: (tool, args) => ghMcp.callTool(tool, args),
          });
          const fetched = await fetcher.fetchAll(links);
          const successful = fetched.filter(f => f.strategy !== 'failed' && f.content.length > 0);
          linkedContentJson = JSON.stringify(successful);
          linkedContext = successful.map(f => ({
            source: 'linked_document',
            title: `[${f.type}] ${f.url}`,
            content: `<linked_document source="${f.type}" url="${f.url}" strategy="${f.strategy}">\n${f.content}\n</linked_document>`,
            url: f.url,
            author: '',
            timestamp: f.fetchedAt,
          }));

          // Knowledge indexing: persist internal docs (>500 chars) into messages for FTS5 enrichment
          const { createHash } = await import('node:crypto');
          db.prepare(`INSERT OR IGNORE INTO topics (name, created_at) VALUES ('jira-linked-docs', datetime('now'))`).run();
          const linkedTopicRow = db.prepare(`SELECT id FROM topics WHERE name = 'jira-linked-docs'`).get();
          if (linkedTopicRow) {
            for (const f of successful) {
              if (f.content.length > 500 && (f.type === 'confluence' || f.type === 'jira')) {
                const sourceId = 'linked_doc_' + createHash('sha256').update(f.url).digest('hex').slice(0, 16);
                db.prepare(`INSERT OR IGNORE INTO messages (topic_id, source, source_id, subject, content, author, timestamp)
                  VALUES (?, 'linked_doc', ?, ?, ?, '', ?)`
                ).run(linkedTopicRow.id, sourceId, `[${f.type}] ${f.url}`, f.content, f.fetchedAt || new Date().toISOString());
              }
            }
          }

          // MemPalace enrichment: write (issueKey, 'references', url) triples
          if (palaceClient && palaceClient.isConnected) {
            for (const f of successful) {
              palaceClient.kgAdd(issueKey, 'references', f.url, new Date().toISOString().slice(0, 10)).catch(() => {});
            }
          }
        }
      } catch (linkErr) {
        process.stderr.write(`[analyze] link-fetch non-fatal: ${linkErr.message}\n`);
      }

      // 1. Build code context via ResearchEngine (ADR-020 Phase 3) with shallow grep fallback
      const stopWords = new Set(['the','a','an','is','are','was','in','on','at','to','for','of','and','or','with','not','it','be','do','does','this','that','its','by','from','when','should','will','can','has','have','after','before','than','but','also','into','over','more','some','such','each','been','their','there','then','than','about']);
      const keywords = title.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w)).slice(0, 6);

      let codeFiles = [];
      const codeContext = [];

      // Try ResearchEngine first for deeper context
      try {
        const searchPaths = Object.fromEntries(REPOS.map(r => [r.name, r.localPath]).filter(([,p]) => p));
        const engine = new ResearchEngine(db, { db, repoPaths: searchPaths, searchPaths, ownershipMap: DEFAULT_OWNERSHIP_MAP });
        const researchResult = await engine.investigate({
          question: `What code paths and components are affected by: ${title}`,
          tier: 2,
          additionalContext: [ticketDescription, ...ticketComments.slice(0, 3).map(c => c.body)].join('\n').slice(0, 2000),
        });
        if (researchResult.answer && researchResult.confidence >= 0.3) {
          codeContext.push({
            source: 'code',
            title: 'Research Engine (code analysis)',
            content: researchResult.answer,
            author: 'research-engine',
            timestamp: new Date().toISOString(),
          });
          codeFiles = researchResult.filesExamined || [];
          await enrichKnowledgeFromResearch(db, palaceClient, `${issueKey}: ${title}`, researchResult);
        }
        process.stderr.write(`[analyze-research] ${issueKey} tier=${engine.classifyTier(title)} conf=${researchResult.confidence.toFixed(2)} ms=${researchResult.durationMs}\n`);
      } catch (researchErr) {
        process.stderr.write(`[analyze-research] fallback to grep: ${researchErr?.message?.slice(0, 80)}\n`);
      }

      // Fallback: shallow grep if ResearchEngine found nothing
      if (codeContext.length === 0 && keywords.length > 0) {
        const safeKeywords = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const rgQuery = safeKeywords.join('|');
        try {
          const rawFilesOutput = execFileSync(
            'rg', ['-l', '-i', '--max-count', '1', '-t', 'ts', rgQuery, PRIMARY_REPO_PATH],
            { encoding: 'utf8', timeout: 15_000 }
          );
          const rawFiles = rawFilesOutput.split('\n').filter(Boolean).slice(0, 10);
          codeFiles = rawFiles.map(f => f.replace(PRIMARY_REPO_PATH + '/', ''));

          for (const file of rawFiles) {
            try {
              const matchOutput = execFileSync(
                'rg', ['-n', '-i', '--max-count', '1', rgQuery, file],
                { encoding: 'utf8', timeout: 5_000 }
              );
              const lineNum = parseInt(matchOutput.split(':')[0]) || 1;
              const allLines = readFileSync(file, 'utf8').split('\n');
              const start = Math.max(0, lineNum - 40);
              const end = Math.min(allLines.length, lineNum + 100);
              const snippet = allLines.slice(start, end).join('\n');
              const relPath = file.replace(PRIMARY_REPO_PATH + '/', '');
              codeContext.push({
                source: 'code',
                title: relPath,
                content: `// ${relPath} (lines ${start + 1}–${end})\n${snippet}`,
                author: '',
                timestamp: '',
              });
            } catch { /* skip */ }
          }
        } catch { /* rg not found or no matches */ }
      }

      // Pull Jira DB messages for this ticket
      const dbRows = db.prepare(
        `SELECT source, source_id, subject, content, author, timestamp FROM messages WHERE source = 'jira' AND source_id LIKE ? ORDER BY timestamp DESC LIMIT 5`
      ).all(`${issueKey}%`);
      const dbContext = dbRows.map(r => ({
        source: 'jira', title: r.subject || r.source_id,
        content: r.content, author: r.author, timestamp: r.timestamp,
      }));

      // Add the ticket itself as a context item so chatWithContext never sees "No relevant information"
      const ticketContextItem = {
        source: 'jira',
        title: `${issueKey}: ${title}`,
        content: ticketContext,
        author: assignee ?? '',
        timestamp: '',
      };
      const existingNotes = loadJiraAnalysis(db, issueKey)?.notes ?? null;
      const notesContextItem = existingNotes ? {
        source: 'notes',
        title: `Investigation notes for ${issueKey}`,
        content: existingNotes,
        author: '',
        timestamp: '',
      } : null;
      const allContext = [ticketContextItem, ...dbContext, ...codeContext, ...linkedContext, ...(notesContextItem ? [notesContextItem] : [])];

      // EP-67: Claude Code deep research (CostGate → PromptEvolver → Runner → Adapter)
      // REDUNDANCY-001: CostGate is now deterministic; ANTHROPIC_KEY only needed for
      // the actual research call below, not the gate decision.
      let claudeCodeContext = [];
      if (ANTHROPIC_KEY) {
        try {
          const codeItemCount = codeContext.length;
          const gateResult = await costGate.evaluate({
            triggerType: 'jira_analyze',
            question: title,
            existingContextCount: allContext.length,
            existingCodeItems: codeItemCount,
            complexitySignals: ticketLabels,
          });
          if (gateResult.approved) {
            const built = await promptEvolver.buildPrompt('jira_analyze', {
              triggerContext: ticketContext,
              researchQuestion: `What code paths are affected by this ticket? Key: ${issueKey}, Title: ${title}`,
              repoList: ALL_REPOS.join(', '),
              dynamicInstructions: 'Focus on the component mentioned in the ticket.',
            });
            if (built) {
              const inputHash = computeInputHash(title, ALL_REPOS);
              const cached = getCachedResearch(db, inputHash);
              if (cached) {
                const cachedResult = JSON.parse(cached.result);
                claudeCodeContext = adaptToContextItems(cachedResult);
                // Cached path doesn't consume budget — we'd pay $0.
              } else {
                const result = await claudeCodeRunner.execute({ prompt: built.prompt, repos: ALL_REPOS });
                if (result) {
                  claudeCodeContext = adaptToContextItems(result);
                  upsertResearch(db, {
                    inputHash, triggerType: 'jira_analyze', question: title,
                    repos: JSON.stringify(ALL_REPOS), templateId: built.templateId,
                    result: JSON.stringify(result), confidence: result.confidence,
                    tokensUsed: result.tokensUsed, costUsd: result.costUsd,
                    latencyMs: result.durationMs, model: result.model,
                  });
                  qualityScorer?.score(result, built.templateId, title).catch(() => {});
                  costGate.recordCall(); // REDUNDANCY-001: count this against today's budget
                }
              }
              allContext.push(...claudeCodeContext);
            }
          }
        } catch (ccErr) {
          process.stderr.write(`[analyze] claude-code non-fatal: ${ccErr.message}\n`);
        }
      }

      // Rich prompts — ticket detail is in allContext[0] (ticketContextItem), so keep prompts focused
      const analysisPrompt = `Analyse the Jira ticket shown in the context above.

1. **What is being asked** — summarise the technical requirement or bug in one paragraph.
2. **Implementation approach** — how would you implement this? List the specific services, files, or components likely involved based on the ticket description.
3. **Step-by-step plan** — concrete ordered steps a developer would follow.
4. **Risks & edge cases** — what could go wrong or expand scope.

If no code files are in the context, reason from the ticket description alone and state that clearly.`;

      const effortPrompt = `Estimate the development effort for the Jira ticket in the context above.

1. **Complexity** — Low / Medium / High with a one-sentence justification.
2. **Time estimate** — realistic range (e.g. 0.5d / 1–2d / 1 sprint).
3. **Work breakdown** — bullet list of actual work items from the description.
4. **Dependencies** — prerequisite work, external services, or approvals.
5. **Scope risks** — specific things in the description or comments that could expand scope.`;

      const explanationPrompt = `Explain the Jira ticket in the context above in plain language for a teammate who hasn't seen it.

1. **What** — one paragraph summarising what this ticket asks for.
2. **Why it matters** — the business or technical impact if not done.
3. **Who is affected** — users, services, or teams impacted.
4. **How it would be done** — a brief non-technical overview of the approach.
5. **Open questions** — anything unclear that needs clarification before starting.`;

      // Query cycle time baseline + past learnings for richer proposeSolution context (GAP-2 fix)
      let cycleTimeBaseline = null;
      let pastLearnings = [];
      try { cycleTimeBaseline = keywords.length > 0 ? getCycleTimesForSimilarTickets(db, keywords) : null; } catch { /* non-fatal */ }
      try { pastLearnings = keywords.length > 0 ? findSimilarLearnings(db, keywords, 3) : []; } catch { /* non-fatal */ }

      // Run 5 parallel AI calls (3 text + solution proposal + code impact), save each as it completes
      const runAll = async () => {
        const [analysisResult, effortResult, explanationResult, solutionResult, codeImpactResult] = await Promise.allSettled([
          analyzer.chatWithContext([], analysisPrompt, allContext, undefined, 2048),
          analyzer.chatWithContext([], effortPrompt, allContext, undefined, 2048),
          analyzer.chatWithContext([], explanationPrompt, allContext, undefined, 2048),
          analyzer.proposeSolution({ issueKey, title, status: status || 'Unknown', assignee: assignee ?? null, codeContext: allContext, cycleTimeBaseline, pastLearnings }),
          analyzer.analyzeCodeImpact({ issueKey, title, files: codeFiles }),
        ]);

        // Serialize solution proposal to JSON string for storage
        let solutionJson = null;
        if (solutionResult.status === 'fulfilled') {
          try { solutionJson = JSON.stringify(solutionResult.value); } catch { /* ignore */ }
        }

        // Serialize code impact to JSON string for storage
        let codeImpactJson = null;
        if (codeImpactResult.status === 'fulfilled') {
          try { codeImpactJson = JSON.stringify(codeImpactResult.value); } catch { /* ignore */ }
        }

        saveJiraAnalysis(db, issueKey, {
          analysis: analysisResult.status === 'fulfilled' ? analysisResult.value.reply : `Error: ${analysisResult.reason?.message ?? 'failed'}`,
          effort: effortResult.status === 'fulfilled' ? effortResult.value.reply : `Error: ${effortResult.reason?.message ?? 'failed'}`,
          explanation: explanationResult.status === 'fulfilled' ? explanationResult.value.reply : `Error: ${explanationResult.reason?.message ?? 'failed'}`,
          solution: solutionJson,
          code_impact: codeImpactJson,
          linked_content: linkedContentJson,
          status: 'done',
        });
      };
      // Tier 1 (T1.2): hard 5-minute ceiling on runAll. Anthropic 5xx, MCP
      // hang, ResearchEngine wedge, or claudeCodeRunner stall would
      // previously leave the row 'pending' forever. Promise.race ensures
      // one branch always wins — timeout rejection lands in the same .catch
      // that flips status='failed' so the UI's polling loop terminates.
      const ANALYZE_TIMEOUT_MS = Number(process.env.JIRA_ANALYZE_TIMEOUT_MS) || 5 * 60 * 1000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Analysis timed out after ${Math.round(ANALYZE_TIMEOUT_MS / 1000)}s`)),
          ANALYZE_TIMEOUT_MS,
        ),
      );
      Promise.race([runAll(), timeoutPromise]).catch(err => {
        process.stderr.write(`[analyze] runAll failed for ${issueKey}: ${err.message}\n`);
        saveJiraAnalysis(db, issueKey, {
          analysis: `Analysis failed: ${err.message}`,
          status: 'failed',
        });
      }).finally(() => analyzeInProgress.delete(issueKey));
      return;
    }

    // POST /api/jira/investigate — ReAct-based investigation (regression bugs)
    if (path === '/api/jira/investigate' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const parsed = parseBody(JiraInvestigateSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }

      const { issueKey, title, status, assignee, description, createdAt } = parsed.data;

      if (!analyzer) { json(res, 400, { error: 'AI not available' }); return; }

      // Return 409 if investigation already in progress
      const existing = getInvestigationSession(db, issueKey);
      if (existing?.status === 'running') {
        json(res, 409, { error: 'Investigation already in progress' });
        return;
      }

      // Return 202 immediately — client polls GET /api/jira/investigation/:key
      json(res, 202, { issueKey, status: 'running' });

      // Run investigation asynchronously
      (async () => {
        const { InvestigationOrchestrator } = await import('./dist/intelligence/investigation-orchestrator.js');

        // [EP-58] Use shared PalaceClient v2 instance (persistent process)
        const palace = palaceClient;

        const orchestratedRepoPaths = Object.fromEntries(REPOS.map(r => [r.name, r.localPath]).filter(([,p]) => p));
        const orchestrator = new InvestigationOrchestrator(
          analyzer.client,
          db,
          // repoPaths: live git checkouts — derived from configured repos (wi.config.json)
          orchestratedRepoPaths,
          DEFAULT_OWNERSHIP_MAP,
          // searchPaths: derived from configured repos
          orchestratedRepoPaths,
          palace   // 6th param: optional PalaceClient (Wave 5)
        );
        orchestrator.investigate({ issueKey, title, status, assignee: assignee ?? null, description, createdAt })
          .catch(err => process.stderr.write(`[investigate] failed: ${err.message}\n`));
      })();
      return;
    }

    // GET /api/jira/investigation/:key — poll for results + streaming trace
    const investigationMatch = path.match(/^\/api\/jira\/investigation\/([^/]+)$/);
    if (investigationMatch && req.method === 'GET') {
      const issueKey = investigationMatch[1];
      const session = getInvestigationSession(db, issueKey);
      if (!session) { json(res, 404, { error: 'No investigation found for this key' }); return; }
      json(res, 200, {
        issueKey:    session.issue_key,
        status:      session.status,
        reactTrace:  JSON.parse(session.react_trace ?? '[]'),
        report:      session.report_json ? JSON.parse(session.report_json) : null,
        startedAt:   session.started_at,
        completedAt: session.completed_at,
      });
      return;
    }

    // GET /api/jira/ticket/:key/linked — EP-48 GAP-1: linked issues
    const linkedMatch = path.match(/^\/api\/jira\/ticket\/([^/]+)\/linked$/);
    if (linkedMatch && req.method === 'GET') {
      const issueKey = linkedMatch[1];
      if (!/^[A-Z]+-\d+$/.test(issueKey)) { json(res, 400, { error: 'Invalid issue key' }); return; }
      try {
        const session = getBrowserSession();
        const links = await withLinkedIssuesLock(async () => {
          const { JiraBrowserConnector } = await import('./dist/fetcher/sources/jira-browser.js');
          const connector = new JiraBrowserConnector(session);
          return connector.scrapeLinkedIssues(issueKey);
        });
        json(res, 200, { links });
      } catch (err) {
        json(res, 500, { error: String(err?.message ?? err) });
      }
      return;
    }

    // POST /api/jira/ticket/:key/draft-pr — EP-48-4: create a draft PR via gh CLI
    const draftPrMatch = path.match(/^\/api\/jira\/ticket\/([^/]+)\/draft-pr$/);
    if (draftPrMatch && req.method === 'POST') {
      const issueKey = draftPrMatch[1];
      if (!/^[A-Z]+-\d+$/.test(issueKey)) { json(res, 400, { error: 'Invalid issue key' }); return; }
      if (!ghAvailable) { json(res, 503, { error: 'gh CLI not available on this machine' }); return; }
      const rawBody = await readBody(req);
      const parsed = parseBody(DraftPrSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const { title, prBody, repo } = parsed.data;
      try {
        const args = ['pr', 'create', '--draft', '--title', title, '--body', prBody || ''];
        if (repo) { args.push('--repo', repo); }
        const output = execFileSync('gh', args, { encoding: 'utf8', cwd: PRIMARY_REPO_PATH });
        json(res, 200, { url: output.trim() });
      } catch (err) {
        json(res, 500, { error: String(err?.message ?? err) });
      }
      return;
    }

    // PUT /api/jira/investigation/:key/outcome — record actual fix after user resolves bug (Phase 56)
    const outcomeMatch = path.match(/^\/api\/jira\/investigation\/([^/]+)\/outcome$/);
    if (outcomeMatch && req.method === 'PUT') {
      const issueKey = outcomeMatch[1];
      if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(issueKey)) { json(res, 400, { error: 'Invalid issue key' }); return; }
      const rawBody = await readBody(req);
      const parsed = parseBody(z.object({
        actualRootCause: z.enum(['code-change', 'dep-upgrade', 'config-change', 'external-system', 'unknown']),
        actualFixOwner: z.string().optional(),
      }), rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      try {
        resolveHypothesisAccuracy(db, issueKey, {
          rootCause: parsed.data.actualRootCause,
          fixOwner: parsed.data.actualFixOwner,
        });
        json(res, 200, { ok: true });
      } catch (err) {
        console.error('[investigation] outcome error:', err);
        json(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/jira/brain/stats — learning brain metrics (Phase 56)
    if (path === '/api/jira/brain/stats' && req.method === 'GET') {
      try {
        const stats = getBrainStats(db);
        json(res, 200, stats);
      } catch (err) {
        console.error('[brain] stats error:', err);
        json(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/jira/brain/refresh-knowledge — manual stale re-index trigger (Phase 56)
    if (path === '/api/jira/brain/refresh-knowledge' && req.method === 'POST') {
      try {
        const count = await knowledgeIndexer.refreshStaleEntries(db);
        json(res, 200, { refreshed: count });
      } catch (err) {
        console.error('[brain] refresh error:', err);
        json(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/chat (EP-24)
    if (path === '/api/chat' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const parsed = parseBody(ChatSchema, rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const { message, history, context: pageContext, injectedContext, mode: bodyMode, conversationId } = parsed.data;
      // Strip empty-content messages — Claude API rejects them
      const cleanHistory = history.filter(h => h.content?.trim());

      // ── 78a-04 / Task 3: mode detection runs FIRST, before any context build ──
      // Pull last 3 user turns from chat_messages for history-aware persistence.
      let priorTurns = [];
      try {
        const priorRows = db.prepare(
          `SELECT mode, json_extract(metadata, '$.confidence') AS confidence
           FROM chat_messages
           WHERE conversation_id = ? AND role = 'user' AND mode IS NOT NULL
           ORDER BY ts DESC LIMIT 3`
        ).all(conversationId);
        priorTurns = priorRows
          .filter(r => r.mode === 'work' || r.mode === 'life')
          .map(r => ({
            mode: r.mode,
            confidence: typeof r.confidence === 'number' ? r.confidence : 0,
          }));
      } catch {
        // chat_messages table missing (pre-v57 DB) — skip persistence-aware
        // detection. Detector's history is optional.
      }

      const manualMode = (bodyMode === 'work' || bodyMode === 'life') ? bodyMode : undefined;
      const detection = detectMode({
        message,
        history: priorTurns,
        manualMode,
      });

      // Helpers for persistence — defined early so AMBIGUOUS short-circuit can
      // reuse them.
      const persistChatModes = () => {
        try {
          db.prepare(`
            INSERT INTO chat_modes (conversation_id, manual_mode, last_detected, last_signals, last_confidence, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id) DO UPDATE SET
              manual_mode = excluded.manual_mode,
              last_detected = excluded.last_detected,
              last_signals = excluded.last_signals,
              last_confidence = excluded.last_confidence,
              updated_at = excluded.updated_at
          `).run(
            conversationId,
            manualMode ?? null,
            detection.mode,
            JSON.stringify(detection.signals),
            detection.confidence,
            Date.now(),
          );
        } catch (err) {
          process.stderr.write(`[chat] chat_modes UPSERT failed: ${err?.message?.slice(0, 100) ?? 'unknown'}\n`);
        }
      };
      const persistChatMessage = (role, content, extraMeta = {}) => {
        try {
          db.prepare(`
            INSERT INTO chat_messages (conversation_id, role, content, mode, private_turn, ts, metadata)
            VALUES (?, ?, ?, ?, 0, ?, ?)
          `).run(
            conversationId,
            role,
            content,
            detection.mode,
            Date.now(),
            JSON.stringify({
              signals: detection.signals,
              modeSource: detection.modeSource,
              confidence: detection.confidence,
              ...extraMeta,
            }),
          );
        } catch (err) {
          process.stderr.write(`[chat] chat_messages INSERT failed: ${err?.message?.slice(0, 100) ?? 'unknown'}\n`);
        }
      };

      // ── AMBIGUOUS short-circuit (CHAT-05) ──
      // No Anthropic call. Persist user + assistant rows tagged 'ambiguous';
      // return the clarifyingPrompt directly. Verifiable via zero token usage.
      if (detection.mode === 'ambiguous') {
        persistChatModes();
        persistChatMessage('user', message);
        persistChatMessage('assistant', detection.clarifyingPrompt ?? '', { ambiguous: true });
        json(res, 200, {
          reply: detection.clarifyingPrompt ?? '',
          sources: [],
          suggestedFollowUps: [],
          detectedMode: 'ambiguous',
          modeSource: detection.modeSource,
          modeSignals: detection.signals,
        });
        return;
      }

      if (!analyzer) {
        // Persist user + assistant turns even on the no-key path so telemetry
        // / chat history isn't blank.
        persistChatModes();
        persistChatMessage('user', message);
        const fallbackReply = 'AI is not available — ANTHROPIC_API_KEY is not set.';
        persistChatMessage('assistant', fallbackReply);
        json(res, 200, {
          reply: fallbackReply,
          sources: [],
          suggestedFollowUps: [],
          detectedMode: detection.mode,
          modeSource: detection.modeSource,
          modeSignals: detection.signals,
        });
        return;
      }

      // ── Persona system block (CHAT-04 / D-78a-07) ──
      // Pure in-process call. PersonaMode 'work'|'life' map directly; the
      // 'mixed' branch is reserved for 78c.
      let personaBlock = null;
      try {
        const personaResult = await getPersonaForMode({
          db,
          user: 'maaz',
          mode: detection.mode === 'work' ? 'work' : 'life',
        });
        personaBlock = {
          type: 'text',
          text: personaResult.systemPrompt,
          cache_control: { type: 'ephemeral' },
        };
      } catch (personaErr) {
        process.stderr.write(`[chat] persona synthesis failed (non-fatal): ${personaErr?.message?.slice(0, 100) ?? 'unknown'}\n`);
      }

      // EP-59: Structured entity extraction replaces naive keyword filtering
      const entities = extractEntities(message, knownPeopleNames);
      const keywords = [
        ...entities.jiraKeys,
        ...entities.flags,
        ...entities.people.flatMap(p => p.split(/\s+/).filter(w => w.length >= 3)),
      ];
      const ftsQuery = keywords.slice(0, 5).map(k => k.replace(/"/g, '""')).join(' OR ');

      // ── Phase 79-03: unconditional preflight recall (runs BEFORE verb-gate) ──
      let preflightContextBlock = '';
      try {
        const { buildPreflightContext } = await import('./dist/services/brain/preflight-recall.js');
        preflightContextBlock = await buildPreflightContext({
          db,
          message,
          palace: palaceClient,
        });
      } catch (preflightErr) {
        process.stderr.write(`[chat] preflight failed: ${preflightErr?.message?.slice(0, 120) ?? 'unknown'}\n`);
      }

      let contextItems = [];

      // ── 78a-04 / CHAT-03: mode-scoped memory recall (top-5) ──
      // WORK → use the 6 existing palace wings; LIFE → empty (life wing ships
      // in 78c, until then LIFE recall is intentionally narrow).
      const WORK_WINGS = ['topics', 'conversations', 'meetings', 'entities', 'decisions', 'relationships'];
      const recallWings = detection.mode === 'work' ? WORK_WINGS : [];
      try {
        const recalled = await brainRecallMemory({
          db,
          pattern: message,
          palace: palaceClient,
          wings: recallWings,
          limit: 5,
        });
        for (const r of recalled) {
          contextItems.push({
            source: `recall-${r.source}`,
            title: `Recalled (${r.source}, score ${r.score.toFixed(2)})`,
            content: r.snippet,
            timestamp: r.created_at,
          });
        }
      } catch (recallErr) {
        // recallMemory throws InvalidRecallArgsError on empty pattern only;
        // upstream guards against that. Anything else is non-fatal.
        process.stderr.write(`[chat] mode-scoped recall failed: ${recallErr?.message?.slice(0, 100) ?? 'unknown'}\n`);
      }

      // Unified Brain snapshot — same recall path as GET /api/brain/context (ADR-024 §6b).
      // General chat previously skipped this and felt "memory-less".
      try {
        const { buildBrainContext } = await import('./dist/services/brain/context-builder.js');
        const { brainContextToContextItems } = await import('./dist/services/brain/brain-context-items.js');
        const brainCtx = await buildBrainContext(db, BRAIN_USER, { palace: palaceClient });
        contextItems.push(...brainContextToContextItems(brainCtx));
      } catch (brainCtxErr) {
        process.stderr.write(`[chat] brain context failed: ${brainCtxErr?.message?.slice(0, 100) ?? 'unknown'}\n`);
      }

      let workContextResult = { items: [], gaps: [], hasData: false };
      try {
        const {
          fetchWorkContextForChat,
          buildDataGapReply,
          shouldOfferSync,
        } = await import('./dist/services/chat-work-context.js');
        workContextResult = fetchWorkContextForChat(db, message);
        contextItems.push(...workContextResult.items);

        if (shouldOfferSync(workContextResult, message)) {
          const lastSyncRow = db.prepare('SELECT MAX(last_synced_at) AS ts FROM sync_state').get();
          const teamsCountRow = db
            .prepare("SELECT COUNT(*) AS n FROM messages WHERE source = 'teams'")
            .get();
          const followUps = syncProgress.running
            ? ['Check sync status', 'Open setup guide']
            : ['Run sync now', "I'll wait — ask again after sync"];
          // 78a-04: persist + tag this short-circuit reply too — telemetry
          // (CHAT-09) reads from chat_messages and would otherwise miss the
          // sync-needed turns.
          const dataGapReply = buildDataGapReply(workContextResult.gaps, {
            syncRunning: syncProgress.running,
            browserConfigured: !!process.env.BROWSER_PROFILE_PATH,
            lastSyncAt: lastSyncRow?.ts ?? null,
            teamsMessageCount: teamsCountRow?.n ?? 0,
          });
          persistChatModes();
          persistChatMessage('user', message);
          persistChatMessage('assistant', dataGapReply, { dataGap: true });
          json(res, 200, {
            reply: dataGapReply,
            sources: [],
            suggestedFollowUps: followUps,
            needsSync: true,
            gaps: workContextResult.gaps,
            detectedMode: detection.mode,
            modeSource: detection.modeSource,
            modeSignals: detection.signals,
          });
          return;
        }
      } catch (teamsCtxErr) {
        process.stderr.write(`[chat] work context failed: ${teamsCtxErr?.message?.slice(0, 100) ?? 'unknown'}\n`);
      }

      if (ftsQuery) {
        try {
          const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
          const msgRows = db.prepare(`
            SELECT m.id, m.source, m.source_id, m.subject, m.content, m.author, m.timestamp
            FROM messages_fts JOIN messages m ON messages_fts.rowid = m.id
            WHERE messages_fts MATCH ? AND m.timestamp >= ?
            ORDER BY bm25(messages_fts) LIMIT 20
          `).all(ftsQuery, since);

          const meetRows = db.prepare(`
            SELECT mt.id, mt.title, mt.chat_name, mt.summary, mt.topics, mt.decisions, mt.date
            FROM meetings_fts JOIN meetings mt ON meetings_fts.rowid = mt.id
            WHERE meetings_fts MATCH ? AND mt.date >= ?
            ORDER BY bm25(meetings_fts) LIMIT 10
          `).all(ftsQuery, since.slice(0, 10));

          // Also try direct Jira key match if message mentions an issue key
          const jiraKeyMatch = message.match(/\b([A-Z]+-\d+)\b/);
          let jiraRows = [];
          if (jiraKeyMatch) {
            jiraRows = db.prepare(
              `SELECT id, source, source_id, subject, content, author, timestamp FROM messages WHERE source_id LIKE ? LIMIT 5`
            ).all(`%${jiraKeyMatch[1]}%`);
          }

          const allMsgs = [...msgRows, ...jiraRows].slice(0, 30);
          contextItems = [
            ...allMsgs.map(m => ({
              source: m.source,
              title: m.subject || m.content.slice(0, 60),
              content: m.content,
              author: m.author,
              timestamp: m.timestamp,
            })),
            ...meetRows.map(m => ({
              source: 'teams',
              title: m.title || m.chat_name || 'Meeting',
              content: [m.summary, m.topics, m.decisions].filter(Boolean).join('\n'),
              timestamp: m.date,
            })),
          ];
        } catch {
          // FTS not available — proceed with empty context
        }
      }

      // Fix BUG-36: enrich with codebase_knowledge (architecture docs indexed by KnowledgeIndexer)
      if (ftsQuery) {
        try {
          const knowledgeKeywords = keywords.length > 0 ? keywords.slice(0, 4) : message.toLowerCase().split(/\W+/).filter(w => w.length >= 4).slice(0, 4);
          const knowledgeConditions = knowledgeKeywords.map(() => `(instr(lower(title), ?) > 0 OR instr(lower(content), ?) > 0)`).join(' OR ');
          const knowledgeParams = knowledgeKeywords.flatMap(k => [k.toLowerCase(), k.toLowerCase()]);
          const knowledgeRows = knowledgeConditions
            ? db.prepare(`
                SELECT title, content, area, type FROM codebase_knowledge
                WHERE repo = ? AND (${knowledgeConditions})
                LIMIT 5
              `).all(PRIMARY_REPO_NAME, ...knowledgeParams)
            : [];
          for (const row of knowledgeRows) {
            contextItems.push({
              source: 'code',
              title: `[${PRIMARY_REPO_NAME}/${row.area}] ${row.title}`,
              content: row.content,
              author: '',
              timestamp: '',
            });
          }
        } catch { /* codebase_knowledge not yet populated */ }
      }

      // ADR-020: Code search triggers for ANY code-related question (removed Jira key gate)
      const needsCodeSearch = /\b(how|where|what|which|why|trace|call|function|component|file|import|module|class|hook|endpoint|api|route|handler|service)\b/i.test(message) &&
        !/\b(my action items|my issues|daily digest|what meetings|calendar|summarize|summarise|status update|teams activity|teams messages)\b/i.test(message);
      const codeItems = [];
      if (needsCodeSearch) {
        try {
          const codeStopWords = new Set(['what','who','when','where','how','why','the','a','an','is','are','was','in','on','at','to','for','of','and','or','with','about','me','my','have','has','that','this','it','be','do','does','did','which','should','would','can','will','from','into','they','their']);
          // Always prefer injectedContext (ticket title) for domain keywords — it's more specific than the message
          const keywordSource = injectedContext || message;
          // Also strip the Jira project prefix (e.g. "proj", "ams") — it's noise for code search
          const jiraPrefixMatch = message.match(/\b([A-Z]+-\d+)\b/);
          const jiraPrefix = jiraPrefixMatch ? jiraPrefixMatch[1].split('-')[0].toLowerCase() : '';
          const codeKeywords = [...new Set(
            keywordSource.toLowerCase().split(/\W+/).filter(w =>
              w.length >= 3 && !codeStopWords.has(w) && !/^\d+$/.test(w) &&
              !/^[a-z]{2,4}-\d+$/.test(w) && w !== jiraPrefix
            )
          )].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 4);
          // Prefer domain-specific keywords: filter out overly generic programming terms
          const genericTerms = new Set(['frontend','backend','function','component','service','module','class','hook','call','search','file','code','route','handler','endpoint','import','method','operations','repo','codebase']);
          const specificKws = codeKeywords.filter(k => !genericTerms.has(k));
          const orderedKws = specificKws.length > 0 ? [...specificKws, ...codeKeywords.filter(k => genericTerms.has(k))] : codeKeywords;
          if (orderedKws.length > 0) {
            const escapedKws = orderedKws.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            const primaryKw = escapedKws[0];
            const compoundQuery = escapedKws.length >= 2
              ? `${primaryKw}.*${escapedKws[1]}|${escapedKws[1]}.*${primaryKw}`
              : primaryKw;
            const fallbackQuery = primaryKw;
            let rawFilesOutput;
            try {
              rawFilesOutput = execFileSync(
                'grep', ['-rl', '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.jsx',
                  '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude-dir=build',
                  '--exclude-dir=.git', '--exclude-dir=.claude', '--exclude-dir=playwright', '--exclude-dir=reports', '--exclude-dir=.turbo', '--exclude-dir=docs',
                  '-iE', compoundQuery, PRIMARY_REPO_PATH],
                { encoding: 'utf8', timeout: 15_000 }
              );
            } catch {
              try {
                rawFilesOutput = execFileSync(
                  'grep', ['-rl', '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.jsx',
                    '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude-dir=build',
                    '--exclude-dir=.git', '--exclude-dir=.claude', '--exclude-dir=playwright', '--exclude-dir=reports', '--exclude-dir=.turbo', '--exclude-dir=docs',
                    '-iE', fallbackQuery, PRIMARY_REPO_PATH],
                  { encoding: 'utf8', timeout: 15_000 }
                );
              } catch { rawFilesOutput = ''; }
            }
            const pathCompound = orderedKws.slice(0, 2).join('-');
            let dirFiles = [];
            try {
              const baseArgs = [PRIMARY_REPO_PATH, '-path', `*/${pathCompound}/*`,
                '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*',
                '-not', '-name', '*.test.*', '-not', '-name', '*.spec.*',
                '-not', '-name', '*.mock.*', '-not', '-name', '*.stories.*'];
              const tsOut = execFileSync('find', [...baseArgs, '-name', '*.ts'], { encoding: 'utf8', timeout: 5_000 });
              const tsxOut = execFileSync('find', [...baseArgs, '-name', '*.tsx'], { encoding: 'utf8', timeout: 5_000 });
              dirFiles = [...tsOut.split('\n'), ...tsxOut.split('\n')].filter(Boolean).slice(0, 4);
            } catch { /* no such directory */ }
            const allCandidates = (rawFilesOutput || '').split('\n').filter(Boolean);
            const dirFileSet = new Set(dirFiles);
            const codeFiles = [
              ...dirFiles,
              ...allCandidates.filter(f => !dirFileSet.has(f) && f.includes(pathCompound)),
              ...allCandidates.filter(f => !dirFileSet.has(f) && !f.includes(pathCompound)),
            ].slice(0, 6);
            const combinedQuery = fallbackQuery;
            for (const file of codeFiles) {
              try {
                const allLines = readFileSync(file, 'utf8').split('\n');
                let lineNum = 1;
                try {
                  const matchOutput = execFileSync(
                    'grep', ['-n', '-iE', '--max-count=1', combinedQuery, file],
                    { encoding: 'utf8', timeout: 5_000 }
                  );
                  lineNum = parseInt(matchOutput.split(':')[0]) || 1;
                } catch { /* no match — use top of file */ }
                const start = Math.max(0, lineNum - 5);
                const end = Math.min(allLines.length, lineNum + 70);
                const snippet = allLines.slice(start, end).join('\n');
                const relPath = file.replace(PRIMARY_REPO_PATH + '/', '');
                codeItems.push({
                  source: 'code',
                  title: relPath,
                  content: `// ${relPath} (lines ${start + 1}–${end})\n${snippet}`,
                  author: '',
                  timestamp: '',
                });
              } catch { /* skip unreadable file */ }
            }
          }
        } catch (grepErr) {
          process.stderr.write(`[chat-code-search] grep failed: ${grepErr?.message?.slice(0, 80) ?? 'unknown'}\n`);
        }
      }

      // ADR-020: ResearchEngine — proactive for deep questions, fallback for shallow grep misses
      let researchPerformed = false;
      let researchTrace = null;
      const deepResearch = needsDeepResearch(message, contextItems);
      if (deepResearch || (needsCodeSearch && codeItems.length === 0)) {
        try {
          const cached = findCachedResearch(db, message);
          if (cached && cached.confidence >= 0.5) {
            codeItems.push({
              source: 'code',
              title: 'Research Engine (cached)',
              content: cached.answer_summary,
              author: 'research-engine',
              timestamp: cached.last_used_at,
            });
            researchPerformed = true;
          } else {
            const searchPaths = Object.fromEntries(REPOS.map(r => [r.name, r.localPath]).filter(([,p]) => p));
            const engine = new ResearchEngine(db, {
              db,
              repoPaths: searchPaths,
              searchPaths,
              ownershipMap: DEFAULT_OWNERSHIP_MAP,
            });
            const result = await engine.investigate({
              question: message,
              additionalContext: injectedContext || undefined,
            });
            researchPerformed = true;
            researchTrace = { iterations: result.iterations, confidence: result.confidence, durationMs: result.durationMs };
            if (result.answer && result.confidence >= 0.3) {
              codeItems.push({
                source: 'code',
                title: 'Research Engine',
                content: result.answer,
                author: 'research-engine',
                timestamp: new Date().toISOString(),
              });
              const findingId = saveResearchFinding(db, message, result, 'claude-haiku-latest');
              if (findingId > 0) {
                saveReferences(db, findingId, result.filesExamined, result.searchesPerformed);
                if (result.confidence >= 0.6) {
                  indexFindingAsMessage(db, message, result.answer);
                }
              }
              await enrichKnowledgeFromResearch(db, palaceClient, message, result);
            } else if (result.blockerReport) {
              codeItems.push({
                source: 'code',
                title: 'Research Engine (low confidence)',
                content: result.blockerReport,
                author: 'research-engine',
                timestamp: new Date().toISOString(),
              });
            }
            process.stderr.write(`[research-engine] q="${message.slice(0, 60)}" tier=${engine.classifyTier(message)} iters=${result.iterations} conf=${result.confidence.toFixed(2)} ms=${result.durationMs} proactive=${deepResearch}\n`);
          }
        } catch (researchErr) {
          process.stderr.write(`[research-engine] error: ${researchErr?.message?.slice(0, 100) ?? 'unknown'}\n`);
        }
      }

      if (injectedContext) {
        contextItems.unshift({ source: 'jira', title: 'Referenced Jira Tickets', content: injectedContext, timestamp: new Date().toISOString() });
      }
      // Prepend code items so they aren't pushed off the sources[:5] cap by FTS results
      contextItems.unshift(...codeItems);

      // EP-67: Claude Code research for complex code questions with insufficient grep results
      // REDUNDANCY-001: gate is deterministic budget check; ANTHROPIC_KEY only needed for the call.
      if (needsCodeSearch && codeItems.length === 0 && ANTHROPIC_KEY) {
        try {
          const gateResult = await costGate.evaluate({
            triggerType: 'chat',
            question: message,
            existingContextCount: contextItems.length,
            existingCodeItems: codeItems.length,
            complexitySignals: entities.flags,
          });
          if (gateResult.approved) {
            const built = await promptEvolver.buildPrompt('chat', {
              triggerContext: message,
              researchQuestion: message,
              repoList: ALL_REPOS.join(', '),
            });
            if (built) {
              const inputHash = computeInputHash(message, ALL_REPOS);
              const cached = getCachedResearch(db, inputHash);
              if (cached) {
                const cachedResult = JSON.parse(cached.result);
                contextItems.unshift(...adaptToContextItems(cachedResult));
                // Cached path — no budget consumed
              } else {
                const result = await claudeCodeRunner.execute({ prompt: built.prompt, repos: ALL_REPOS });
                if (result) {
                  contextItems.unshift(...adaptToContextItems(result));
                  upsertResearch(db, {
                    inputHash, triggerType: 'chat', question: message,
                    repos: JSON.stringify(ALL_REPOS), templateId: built.templateId,
                    result: JSON.stringify(result), confidence: result.confidence,
                    tokensUsed: result.tokensUsed, costUsd: result.costUsd,
                    latencyMs: result.durationMs, model: result.model,
                  });
                  qualityScorer?.score(result, built.templateId, message).catch(() => {});
                  costGate.recordCall(); // REDUNDANCY-001: count against today's budget
                }
              }
            }
          }
        } catch (ccErr) {
          process.stderr.write(`[chat] claude-code non-fatal: ${ccErr.message}\n`);
        }
      }

      // EP-59: Palace search in parallel (59-C6: 500ms timeout)
      const palaceTimeout = (promise) => Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(''), 500))
      ]);

      const [palaceSearchRaw, palaceKgRaw, palaceTraversalRaw, embeddingList] = await Promise.all([
        palaceClient ? palaceTimeout(palaceClient.search(message, undefined, 5)) : Promise.resolve(''),
        palaceClient && entities.jiraKeys.length > 0
          ? palaceTimeout(palaceClient.kgQuery(entities.jiraKeys[0]))
          : Promise.resolve(''),
        // EP-59: KG traversal for multi-hop answers (59-C5)
        palaceClient && (entities.jiraKeys.length > 0 || entities.flags.length > 0 || entities.people.length > 0)
          ? palaceTimeout(palaceClient.traverse(
              entities.jiraKeys[0] || entities.flags[0] || entities.people[0]
            ))
          : Promise.resolve(''),
        // post-graphify step 2: pure-semantic 5th lane, parallel for latency budget
        embeddingsRankList(message, db, 25),
      ]);

      // Convert palace results to ContextItem[]
      const palaceContextItems = [];
      if (palaceSearchRaw) {
        try {
          const palaceResults = JSON.parse(palaceSearchRaw);
          // Cap palace context at ~2000 tokens (~500 chars per item, ~4 items) per 59-C8
          const cappedResults = Array.isArray(palaceResults) ? palaceResults.slice(0, 4) : [];
          for (const r of cappedResults) {
            palaceContextItems.push({
              source: 'palace-search',
              title: r.label || r.room || 'Palace Memory',
              content: (r.content || '').slice(0, 500),
              timestamp: r.created_at || r.createdAt,
              metadata: { wing: r.wing, room: r.room, drawerId: r.id },
            });
          }
        } catch { /* palace returned non-JSON — ignore */ }
      }
      if (palaceKgRaw) {
        try {
          const kgResult = JSON.parse(palaceKgRaw);
          const triples = Array.isArray(kgResult) ? kgResult : (kgResult.triples || []);
          if (triples.length > 0) {
            palaceContextItems.push({
              source: 'palace-kg',
              title: `KG: ${entities.jiraKeys[0]} relationships`,
              content: triples.slice(0, 10).map(t => `${t.subject} ${t.predicate} ${t.object}`).join('; '),
              metadata: { wing: 'kg', drawerId: entities.jiraKeys[0] },
            });
          }
        } catch { /* KG returned non-JSON — ignore */ }
      }

      // EP-59: Convert traversal paths to ContextItem (59-C5)
      if (palaceTraversalRaw) {
        const paths = parseTraversalPaths(palaceTraversalRaw);
        const formatted = formatTraversalAsText(paths);
        if (formatted) {
          palaceContextItems.push({
            source: 'palace-graph',
            title: `KG Traversal: ${entities.jiraKeys[0] || entities.flags[0] || entities.people[0]}`,
            content: formatted,
            metadata: { wing: 'kg', type: 'traversal' },
          });
        }
      }

      // Record palace hit rate
      if (palaceClient) {
        palaceClient.recordQuery(palaceContextItems.length > 0);
      }

      // EP-59 + post-graphify step 2: RRF fusion across 5 lanes
      const ftsRankList = [...contextItems]; // existing FTS-sourced items (already in rank order)
      const palaceSearchList = palaceContextItems.filter(i => i.source === 'palace-search');
      const palaceKgList = palaceContextItems.filter(i => i.source === 'palace-kg');
      const palaceGraphList = palaceContextItems.filter(i => i.source === 'palace-graph');
      const embeddingRankList = Array.isArray(embeddingList) ? embeddingList : [];

      // Fuse all rank lists using RRF with k=60
      const fusedItems = rrfFuse([ftsRankList, palaceSearchList, palaceKgList, palaceGraphList, embeddingRankList]);

      // Rank fused items by relevance + recency before passing to AI
      const rankedItems = rankContextItems(fusedItems);

      // EP-59 + post-graphify: Retrieval instrumentation (now includes embeddingHits)
      process.stderr.write(`[retrieval] ${JSON.stringify({
        handler: 'general-chat',
        query: message.slice(0, 100),
        entities: {
          jiraKeys: entities.jiraKeys.length,
          people: entities.people.length,
          flags: entities.flags.length,
          files: entities.files.length,
        },
        ftsHits: ftsRankList.length,
        palaceSearchHits: palaceSearchList.length,
        palaceKgHits: palaceKgList.length,
        palaceGraphHits: palaceGraphList.length,
        embeddingHits: embeddingRankList.length,
        fusedTotal: fusedItems.length,
        rankedTotal: rankedItems.length,
        topSources: rankedItems.slice(0, 5).map(i => i.source),
      })}\n`);

      // 78a-04: pass the persona system block as cached extraSystemBlocks. The
      // analyzer prepends it ahead of the existing chat system prompt so the
      // first call seeds the prompt cache and the second turn (same mode) hits
      // it. Surfaces `usage` so we can record cache_read_input_tokens in the
      // chat_messages metadata for smoke § 17.6 verification.
      const extraSystemBlocks = personaBlock ? [personaBlock] : undefined;
      // Phase 79-03: prepend preflight recall block as a leading context item.
      const preflightItems = preflightContextBlock
        ? [{ source: 'preflight-recall', title: 'Prior context (auto-recalled)', content: preflightContextBlock, timestamp: new Date().toISOString() }]
        : [];
      const { reply, suggestedFollowUps, usage } = await analyzer.chatWithContext(cleanHistory, message, [...preflightItems, ...rankedItems], undefined, 2048, extraSystemBlocks);
      const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
      const cached = cacheReadTokens > 0;

      // 78a-04 / persistence: UPSERT chat_modes + INSERT user/assistant rows.
      persistChatModes();
      persistChatMessage('user', message);
      persistChatMessage('assistant', reply, { cached, cacheReadTokens });

      // If the message mentions a Jira key, persist to notebook_chat_history so
      // the Jira board can show it as a cached answer on the ticket row.
      const jiraKeyMatch = message.match(/\b([A-Z]+-\d+)\b/);
      if (jiraKeyMatch) {
        const projectKey = jiraKeyMatch[1].split('-')[0];
        try {
          saveNotebookChatEntry(db, projectKey, message.trim(), reply);
        } catch {
          // Non-fatal — best effort
        }
      }

      // EP-59: Build sources array for provenance UI
      const sources = rankedItems.slice(0, 10).map((item) => ({
        type: item.source,
        title: item.title,
        url: item.url || (item.metadata?.drawerId ? `/api/palace/drawer/${encodeURIComponent(item.metadata.drawerId)}` : undefined),
        wing: item.metadata?.wing || undefined,
        room: item.metadata?.room || undefined,
        drawerId: item.metadata?.drawerId || undefined,
      }));

      // Detect "create PR" / "draft PR" intent — build GitHub URL and append to reply
      const createPRIntent = /\b(create|draft|open|make|generate)\s+(a\s+)?(draft\s+)?pr\b/i.test(message);
      if (createPRIntent) {
        // Find Jira key from the current message, or scan conversation history
        const allConversationText = [message, ...history.map(h => h.content)].join(' ');
        const prKeyMatch = allConversationText.match(/\b([A-Z]+-\d+)\b/);
        if (prKeyMatch) {
          const prKey = prKeyMatch[1];
          // Extract a PR title from the first heading in the reply, or use a default
          const headingMatch = reply.match(/^#{1,3}\s+(.+)$/m);
          const prTitle = `[${prKey}] ${headingMatch?.[1]?.trim() ?? 'Fix for ' + prKey}`.slice(0, 100);
          const prBody = `## Summary\n\n${reply.slice(0, 2000)}\n\n## Jira Ticket\n\nResolves ${prKey}`;
          const primaryRepo = REPOS[0];
          const slug = primaryRepo?.githubSlug || 'owner/workspace';
          const [org, repo] = slug.split('/');
          const defaultBranch = primaryRepo?.defaultBranch || 'main';
          const githubUrl = `${getGitHubCompareUrl(org, repo, defaultBranch, '')}?quick_pull=1&title=${encodeURIComponent(prTitle)}&body=${encodeURIComponent(prBody)}`;
          const replyWithPR = reply + `\n\n---\n\n**[Open Draft PR on GitHub →](${githubUrl})**`;
          json(res, 200, {
            reply: replyWithPR,
            sources,
            suggestedFollowUps,
            researchPerformed,
            researchTrace,
            detectedMode: detection.mode,
            modeSource: detection.modeSource,
            modeSignals: detection.signals,
          });
          return;
        }
      }

      json(res, 200, {
        reply,
        sources,
        suggestedFollowUps,
        researchPerformed,
        researchTrace,
        detectedMode: detection.mode,
        modeSource: detection.modeSource,
        modeSignals: detection.signals,
      });
      return;
    }

    // GET /api/calendar/upcoming (EP-25)
    if (path === '/api/calendar/upcoming' && req.method === 'GET') {
      const days = parseInt(url.searchParams.get('days') || '7');
      const latestScrape = getLatestCalendarScrapeTime(db, days);
      const isStale = !latestScrape ||
        new Date(latestScrape).getTime() < Date.now() - CALENDAR_TTL_MS;
      if (isStale) {
        // Block on first load (no cached data); fire-and-forget when stale data exists
        if (!latestScrape) {
          await scrapeAndSaveCalendar();
        } else {
          scrapeAndSaveCalendar();
        }
      }
      const events = getUpcomingEvents(db, days);
      // pre_brief column included via SELECT * (added in migration 13→14)
      json(res, 200, { events, count: events.length });
      return;
    }

    // GET /api/calendar/events/:id/context (EP-51-1)
    const calendarContextMatch = path.match(/^\/api\/calendar\/events\/(\d+)\/context$/);
    if (calendarContextMatch && req.method === 'GET') {
      const eventId = parseInt(calendarContextMatch[1]);
      const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId);
      if (!event) { json(res, 404, { error: 'Event not found' }); return; }
      const context = buildMeetingContext(db, event);
      json(res, 200, context);
      return;
    }

    // POST /api/calendar/events/:id/regenerate-brief (EP-15-4)
    const regenerateBriefMatch = path.match(/^\/api\/calendar\/events\/(\d+)\/regenerate-brief$/);
    if (regenerateBriefMatch && req.method === 'POST') {
      if (!anthropicApiKey) { json(res, 400, { error: 'ANTHROPIC_API_KEY not set' }); return; }
      const eventId = parseInt(regenerateBriefMatch[1]);
      const evRow = db.prepare(`SELECT id, title, attendees, start_time FROM calendar_events WHERE id = ?`).get(eventId);
      if (!evRow) { json(res, 404, { error: 'Event not found' }); return; }
      try {
        const { generatePreBrief } = await import('./dist/services/analyzer.js');
        const hoursAway = (new Date(evRow.start_time) - new Date()) / 3600000;
        const keywords = evRow.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3).slice(0, 5);
        const ftsQuery = keywords.map(k => k.replace(/"/g, '""')).join(' OR ');
        let contextItems = [];
        if (ftsQuery) {
          try {
            const rows = db.prepare(`SELECT m.subject, m.content FROM messages_fts JOIN messages m ON messages_fts.rowid = m.id WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT 15`).all(ftsQuery);
            contextItems = rows.map(r => ({ subject: r.subject || evRow.title, content: r.content }));
          } catch { /* FTS not available */ }
        }
        const brief = await generatePreBrief(evRow.title, evRow.attendees || '', Math.max(hoursAway, 0), contextItems, anthropicApiKey);
        db.prepare(`UPDATE calendar_events SET pre_brief = ? WHERE id = ?`).run(brief, eventId);
        json(res, 200, { brief, generatedAt: new Date().toISOString() });
      } catch (err) { json(res, 500, { error: err.message }); }
      return;
    }

    // GET /api/alerts (EP-15-2)
    if (path === '/api/alerts' && req.method === 'GET') {
      if (!alertCache.generatedAt) generateAlerts();
      json(res, 200, alertCache);
      return;
    }

    // GET /api/workload (EP-15-3)
    if (path === '/api/workload' && req.method === 'GET') {
      if (!workloadCache.generatedAt) generateWorkload();
      json(res, 200, workloadCache);
      return;
    }

    // GET /api/morning-brief (EP-15-5)
    if (path === '/api/morning-brief' && req.method === 'GET') {
      const forceRefresh = url.searchParams.get('refresh') === 'true';
      const today = new Date().toISOString().slice(0, 10);
      const cached = getCachedDigest(db, '__morning_brief__', today);
      if (cached && !forceRefresh) {
        try { json(res, 200, { ...JSON.parse(cached.markdown), cached: true }); }
        catch { json(res, 200, { cached: true, date: today, generatedAt: cached.generated_at }); }
        return;
      }
      if (!anthropicApiKey) { json(res, 400, { error: 'ANTHROPIC_API_KEY not set' }); return; }

      if (!alertCache.generatedAt) generateAlerts();
      if (!workloadCache.generatedAt) generateWorkload();

      const priorities = db.prepare(`SELECT a.id, a.title, a.assignee, a.status, a.due_date FROM action_items a WHERE a.status != 'completed' ORDER BY CASE WHEN a.due_date < date('now') THEN 0 ELSE 1 END, a.due_date ASC NULLS LAST LIMIT 5`).all();
      const calEvents = db.prepare(`SELECT id, title, start_time, end_time, pre_brief FROM calendar_events WHERE date(start_time) = ? ORDER BY start_time ASC`).all(today);
      const jiraOpened = db.prepare(`SELECT COUNT(*) as cnt FROM messages WHERE source = 'jira' AND timestamp >= datetime('now', '-1 day')`).get()?.cnt ?? 0;
      const sprintDelta = { opened: jiraOpened, closed: 0, net: jiraOpened };

      let summary = '';
      try {
        const dailyCached = getCachedDigest(db, '__daily_summary__', today);
        if (dailyCached) {
          summary = dailyCached.markdown;
        } else {
          const { generateDailySummary: genSummary } = await import('./dist/tools/daily-summary.js');
          const result = await genSummary(db, { date: today, refresh: false }, anthropicApiKey);
          summary = result.markdown;
          saveDigest(db, '__daily_summary__', today, result.markdown, new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19));
        }
      } catch { summary = ''; }

      const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      const intensityEmoji = { intense: '🔴', active: '🟡', calm: '🟢' };
      const slackLines = [`*🌅 Morning Brief — ${dayName}*`, '━━━━━━━━━━━━━━━━━━━━━'];
      const summaryLine = summary.replace(/[#*`]/g, '').split('\n').find(l => l.trim().length > 20) || '';
      if (summaryLine) slackLines.push(`*Yesterday:* ${summaryLine.trim().slice(0, 200)}`);
      const critical = alertCache.alerts.filter(a => a.severity === 'critical');
      if (critical.length > 0) slackLines.push(`*🔴 Overdue:* ${critical.map(a => a.title).join(' • ')}`);
      if (workloadCache.topics.length > 0) slackLines.push(`*📊 Workload:* ${workloadCache.topics.map(t => `${t.name} ${intensityEmoji[t.intensity] || '⚪'} ${t.intensity}`).join(' • ')}`);
      if (calEvents.length > 0) slackLines.push(`*📅 Today:* ${calEvents.map(e => `${e.title} at ${e.start_time.slice(11, 16)}`).join(' • ')}`);
      if (sprintDelta.net !== 0) slackLines.push(`*⚠️ Sprint:* +${sprintDelta.opened} tickets (${sprintDelta.net > 0 ? 'backlog growing' : 'backlog shrinking'})`);

      // Phase 88-2: learning feedback — decisions closed yesterday
      try {
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const learningStats = db.prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS succeeded,
            SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN outcome = 'expired' THEN 1 ELSE 0 END) AS expired
          FROM brain_decisions
          WHERE date(outcome_recorded_at / 1000, 'unixepoch') = ?
        `).get(yesterday);
        if (learningStats && learningStats.total > 0) {
          const closeRate = Math.round((learningStats.succeeded / learningStats.total) * 100);
          slackLines.push(`*🧠 Learning feedback:* ${learningStats.succeeded}/${learningStats.total} decisions confirmed (${closeRate}% success rate)`);
        }
      } catch { /* non-fatal */ }

      slackLines.push('━━━━━━━━━━━━━━━━━━━━━');

      const briefResult = await withStaleFallback(
        async () => {
          const brief = { date: today, cached: false, generatedAt: new Date().toISOString(), sections: { summary, alerts: alertCache.alerts, workload: workloadCache.topics, calendar: calEvents, priorities, sprintDelta }, slackMarkdown: slackLines.join('\n') };
          saveDigest(db, '__morning_brief__', today, JSON.stringify(brief), new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19));
          return brief;
        },
        () => { const c = getCachedDigest(db, '__morning_brief__', today); if (!c) return null; try { return JSON.parse(c.markdown); } catch { return null; } },
        'morning-brief'
      );
      if (briefResult.stale) {
        json(res, 200, { ...briefResult.data, stale: true, stale_reason: briefResult.stale_reason });
      } else {
        json(res, 200, briefResult.data);
      }
      return;
    }

    // ── EP-33: Data Quality ────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/data-quality') {
      const status = (url.searchParams.get('status') === 'resolved' ? 'resolved' : 'open');
      const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit'), 10) : 50;
      const issues = listDataQualityIssues(db, { status, limit: isNaN(limit) ? 50 : limit });
      json(res, 200, { issues });
      return;
    }
    const dqResolveMatch = req.method === 'POST' && path.match(/^\/api\/data-quality\/([^/]+)\/resolve$/);
    if (dqResolveMatch) {
      const id = parseInt(dqResolveMatch[1], 10);
      if (isNaN(id)) { json(res, 400, { error: 'Invalid id' }); return; }
      resolveDataQualityIssue(db, id);
      json(res, 200, { ok: true });
      return;
    }

    // ── EP-35: Action Item Confidence Triage ──────────────────────────────
    // REFACTOR-001 (2026-05-21): /api/action-items/pending-review moved to src/routes/action-items.ts
    const aiConfirmMatch = req.method === 'POST' && path.match(/^\/api\/action-items\/([^/]+)\/confirm$/);
    if (aiConfirmMatch) {
      const id = parseInt(aiConfirmMatch[1], 10);
      if (isNaN(id)) { json(res, 400, { error: 'Invalid id' }); return; }
      confirmActionItem(db, id);
      json(res, 200, { ok: true });
      return;
    }
    const aiDismissMatch = req.method === 'POST' && path.match(/^\/api\/action-items\/([^/]+)\/dismiss$/);
    if (aiDismissMatch) {
      const id = parseInt(aiDismissMatch[1], 10);
      if (isNaN(id)) { json(res, 400, { error: 'Invalid id' }); return; }
      dismissActionItem(db, id);
      json(res, 200, { ok: true });
      return;
    }

    // ── EP-39: Cross-Topic Relationships ──────────────────────────────────
    if (req.method === 'POST' && path === '/api/relationships/detect') {
      const { detectJiraOverlaps, detectSharedPeople, saveRelationships } = await import('./dist/tools/relationship-detector.js');
      const all = [...detectJiraOverlaps(db), ...detectSharedPeople(db)];
      saveRelationships(db, all);
      json(res, 200, { detected: all.length, relationships: all });
      return;
    }
    if (req.method === 'GET' && path === '/api/relationships') {
      const rels = db.prepare(`
        SELECT topic_a, topic_b, relationship_type as type, strength, evidence, detected_at
        FROM topic_relationships ORDER BY strength DESC LIMIT 50
      `).all();
      json(res, 200, { relationships: rels });
      return;
    }
    const relMatch = req.method === 'GET' && path.match(/^\/api\/relationships\/([^/]+)$/);
    if (relMatch) {
      const topicName = decodeURIComponent(relMatch[1]);
      const { getRelationshipsForTopic } = await import('./dist/tools/relationship-detector.js');
      const relationships = getRelationshipsForTopic(db, topicName);
      json(res, 200, { topicName, relationships });
      return;
    }

    // ── EP-38: Weekly Pattern Analysis ────────────────────────────────────
    if (req.method === 'GET' && path === '/api/weekly-report') {
      const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
      const cacheKey = '__weekly_report__';
      const today = new Date().toISOString().slice(0, 10);
      const cached = getCachedDigest(db, cacheKey, today);
      if (cached) {
        try { json(res, 200, { ...JSON.parse(cached.markdown), cached: true }); return; } catch { /* fall through */ }
      }
      // Gather stats
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const totalMessages = db.prepare('SELECT COUNT(*) as n FROM messages WHERE timestamp >= ?').get(sevenDaysAgo)?.n ?? 0;
      const totalMeetings = db.prepare('SELECT COUNT(*) as n FROM meetings WHERE date >= ?').get(sevenDaysAgo.slice(0, 10))?.n ?? 0;
      const totalActionItems = db.prepare("SELECT COUNT(*) as n FROM action_items WHERE status = 'pending'").get()?.n ?? 0;
      const topicsActive = db.prepare('SELECT COUNT(DISTINCT topic_id) as n FROM messages WHERE timestamp >= ?').get(sevenDaysAgo)?.n ?? 0;
      const topTopics = db.prepare(`
        SELECT t.name, COUNT(m.id) as msg_count
        FROM messages m JOIN topics t ON m.topic_id = t.id
        WHERE m.timestamp >= ?
        GROUP BY t.id ORDER BY msg_count DESC LIMIT 5
      `).all(sevenDaysAgo);
      const stats = { totalMessages, totalMeetings, totalActionItems, topicsActive, topTopics };
      const report = await generateWeeklyReport(stats, apiKey);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      saveDigest(db, cacheKey, today, JSON.stringify({ ...report, generatedAt: new Date().toISOString() }), expiresAt);
      json(res, 200, { ...report, generatedAt: new Date().toISOString(), cached: false, stats });
      return;
    }

    // ── System Health summary ──────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/system-health') {
      const openIssues    = db.prepare("SELECT COUNT(*) as n FROM data_quality WHERE resolved_at IS NULL").get()?.n ?? 0;
      const errorIssues   = db.prepare("SELECT COUNT(*) as n FROM data_quality WHERE resolved_at IS NULL AND severity='error'").get()?.n ?? 0;
      const pendingItems  = db.prepare("SELECT COUNT(*) as n FROM action_items WHERE status='pending_review'").get()?.n ?? 0;
      const relCount      = db.prepare("SELECT COUNT(*) as n FROM topic_relationships").get()?.n ?? 0;
      const embeddedCount = db.prepare("SELECT COUNT(*) as n FROM message_embeddings").get()?.n ?? 0;
      const { checkOllamaAvailable } = await import('./dist/services/embedder.js');
      const embeddingEnabled = await checkOllamaAvailable();
      const lastSync      = db.prepare("SELECT started_at FROM ingestion_log ORDER BY started_at DESC LIMIT 1").get()?.started_at ?? null;
      // OP-5 / A-2: roll up agent health
      const agents = getAgentHealthSnapshot();
      let heartbeatAgents = [];
      try {
        const { readHeartbeatStatus } = await import('./dist/services/cypher/heartbeat.js');
        const hb = readHeartbeatStatus(db);
        heartbeatAgents = hb.agents;
      } catch {
        // heartbeat table may not exist yet — degrade gracefully
      }
      for (const agent of agents) {
        const hb = heartbeatAgents.find(h => h.name === agent.name);
        if (hb) {
          agent.lastHeartbeatSeen = hb.lastSeen;
          agent.heartbeatAgeSec = hb.ageSec;
          agent.heartbeatPhase = hb.phase;
        } else {
          agent.lastHeartbeatSeen = null;
          agent.heartbeatAgeSec = null;
          agent.heartbeatPhase = null;
        }
      }
      const agentSummary = agents.reduce((acc, a) => {
        acc[a.status] = (acc[a.status] || 0) + 1; return acc;
      }, {});

      // ADR-027 v2 item #4: codeGraph health block. Surfaces staleness so a
      // smoke check (or human dashboard) can gate on whether the indexer has
      // run recently. Without this, staleness is invisible from the bridge
      // surface — the v1 implementation had no way to observe it.
      const cgRepos = REPOS.map(r => r.name); // derived from configured repos (wi.config.json)
      const cgPerRepo = {};
      let cgLastIndexedAt = null;
      let cgLastFullSweepAt = null;
      for (const r of cgRepos) {
        const row = db.prepare(
          `SELECT last_synced_at, last_message_count FROM sync_state WHERE topic_id = ? AND source = ?`
        ).get('0', `code-graph-${r}`);
        const rowCount = db.prepare(`SELECT COUNT(*) as n FROM code_graph WHERE repo = ?`).get(r)?.n ?? 0;
        cgPerRepo[r] = {
          last_synced_at: row?.last_synced_at ?? null,
          row_count: rowCount,
        };
        if (row?.last_synced_at && (!cgLastIndexedAt || row.last_synced_at > cgLastIndexedAt)) {
          cgLastIndexedAt = row.last_synced_at;
        }
      }
      const fullSweepRow = db.prepare(
        `SELECT last_synced_at FROM sync_state WHERE topic_id = ? AND source = ?`
      ).get('0', 'code-graph:scheduler:full_due_at');
      // The scheduler stores the NEXT due_at; subtract one week to recover
      // the most recent fired-at. This is approximate but adequate for staleness.
      cgLastFullSweepAt = fullSweepRow?.last_synced_at
        ? new Date(Date.parse(fullSweepRow.last_synced_at) - 7 * 24 * 60 * 60 * 1000).toISOString()
        : null;
      const stalenessHours = cgLastIndexedAt
        ? Math.round((Date.now() - Date.parse(cgLastIndexedAt)) / 3_600_000)
        : null;
      const last24hCutoff = Date.now() - 24 * 60 * 60 * 1000;
      const busyRejections24h = getCodeGraphBusyRejections().filter(r => r.ts >= last24hCutoff).length;
      const cgAgent = agents.find(a => a.name === 'CodeGraphIndexer');

      // ── 78a-04 / Task 4 (CHAT-09): chat mode telemetry ───────────────────
      // mode_detection_override_rate = manual_count / total over rolling 7d.
      // Empty denominator → 0 (never NaN, never undefined per CONTEXT.md).
      // chat_messages may be missing on a pre-v57 DB — degrade gracefully.
      let chatBlock = { mode_detection_override_rate: 0, mode_source_count: { auto: 0, manual: 0 } };
      try {
        const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const autoCount = db.prepare(
          `SELECT COUNT(*) AS n FROM chat_messages
           WHERE ts >= ? AND json_extract(metadata, '$.modeSource') = 'auto'`
        ).get(sinceMs)?.n ?? 0;
        const manualCount = db.prepare(
          `SELECT COUNT(*) AS n FROM chat_messages
           WHERE ts >= ? AND json_extract(metadata, '$.modeSource') = 'manual'`
        ).get(sinceMs)?.n ?? 0;
        const total = autoCount + manualCount;
        const rate = total === 0 ? 0 : manualCount / total;
        chatBlock = {
          mode_detection_override_rate: rate,
          mode_source_count: { auto: autoCount, manual: manualCount },
        };
      } catch {
        // chat_messages missing (pre-v57 DB) — keep zero defaults.
      }

      json(res, 200, {
        dataQuality: { open: openIssues, errors: errorIssues },
        actionTriage: { pending: pendingItems },
        relationships: { total: relCount },
        embeddings: { enabled: embeddingEnabled, indexed: embeddedCount },
        agents: { total: agents.length, byStatus: agentSummary, items: agents },
        codeGraph: {
          agent_status: cgAgent?.status ?? 'missing',
          last_indexed_at: cgLastIndexedAt,
          last_full_sweep_at: cgLastFullSweepAt,
          staleness_hours: stalenessHours,
          busy_rejections_24h: busyRejections24h,
          per_repo: cgPerRepo,
        },
        // ADR-030 Phase A: bugs aggregate health.
        bugs: buildBugsHealthBlock(db, deriveInvestigatorStatus(), deriveResolverStatus()),
        // 78a-04 / CHAT-09: chat mode telemetry.
        chat: chatBlock,
        lastSync,
      });
      return;
    }

    // ── Agents-only health endpoint (OP-5 / A-2) ───────────────────────────
    if (req.method === 'GET' && path === '/api/agents/health') {
      const agents = getAgentHealthSnapshot();
      let heartbeatAgents = [];
      try {
        const { readHeartbeatStatus } = await import('./dist/services/cypher/heartbeat.js');
        const hb = readHeartbeatStatus(db);
        heartbeatAgents = hb.agents;
      } catch {
        // heartbeat table may not exist yet — degrade gracefully
      }
      for (const agent of agents) {
        const hb = heartbeatAgents.find(h => h.name === agent.name);
        if (hb) {
          agent.lastHeartbeatSeen = hb.lastSeen;
          agent.heartbeatAgeSec = hb.ageSec;
          agent.heartbeatPhase = hb.phase;
        } else {
          agent.lastHeartbeatSeen = null;
          agent.heartbeatAgeSec = null;
          agent.heartbeatPhase = null;
        }
      }
      json(res, 200, { agents });
      return;
    }

    // ── Prompt management — A-9: rollback story for self-evolving prompts ──
    // GET /api/prompts?trigger_type=chat       — list all versions for a trigger type
    // POST /api/prompts/rollback               — body: { trigger_type, version }
    //   makes the requested (trigger_type, version) the active one; deactivates others.
    if (req.method === 'GET' && path === '/api/prompts') {
      const triggerType = url.searchParams.get('trigger_type');
      const rows = triggerType
        ? db.prepare(`SELECT id, trigger_type, version, is_active, ab_weight, evolution_source,
                             parent_version, invocation_count, deprecated_at, created_at,
                             substr(template, 1, 200) AS template_preview
                      FROM prompt_templates
                      WHERE trigger_type = ?
                      ORDER BY version DESC`).all(triggerType)
        : db.prepare(`SELECT id, trigger_type, version, is_active, ab_weight, evolution_source,
                             parent_version, invocation_count, deprecated_at, created_at
                      FROM prompt_templates
                      ORDER BY trigger_type, version DESC`).all();
      json(res, 200, { templates: rows, trigger_type: triggerType });
      return;
    }
    if (req.method === 'POST' && path === '/api/prompts/rollback') {
      const rawBody = await readBody(req);
      const parsed = parseBody(z.object({
        trigger_type: z.string().min(1),
        version: z.number().int().positive(),
      }), rawBody);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const { trigger_type, version } = parsed.data;
      const target = db.prepare(`SELECT id FROM prompt_templates WHERE trigger_type = ? AND version = ?`)
        .get(trigger_type, version);
      if (!target) { json(res, 404, { error: 'template_not_found', trigger_type, version }); return; }
      const txn = db.transaction(() => {
        db.prepare(`UPDATE prompt_templates SET is_active = 0 WHERE trigger_type = ?`).run(trigger_type);
        db.prepare(`UPDATE prompt_templates
                    SET is_active = 1, ab_weight = 1, deprecated_at = NULL
                    WHERE id = ?`).run(target.id);
      });
      txn();
      process.stderr.write(`[prompts] rollback: ${trigger_type} → v${version} (id=${target.id})\n`);
      json(res, 200, {
        ok: true,
        trigger_type,
        active_version: version,
        rolled_back_at: new Date().toISOString(),
      });
      return;
    }

    // ── Ingestion log ─────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/ingestion-log') {
      const limit = url.searchParams.get('limit') ? Math.min(parseInt(url.searchParams.get('limit'), 10) || 20, 100) : 20;
      const logs = db.prepare('SELECT * FROM ingestion_log ORDER BY started_at DESC LIMIT ?').all(limit);
      json(res, 200, { logs });
      return;
    }

    // ── EP-43: Code Graph endpoints ───────────────────────────────────────────

    // POST /api/knowledge/ingest — cross-repo knowledge event capture
    if (path === '/api/knowledge/ingest' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const body = parseBody(z.object({
        repo: z.string().min(1),
        file: z.string().min(1),
        event: z.string().optional().default('edit'),
        timestamp: z.string().optional(),
      }), rawBody);
      if (!body.ok) { json(res, 400, { error: body.error }); return; }

      const { repo, file, event, timestamp } = body.data;
      const ts = timestamp || new Date().toISOString();

      db.prepare(
        'INSERT INTO knowledge_events (repo, file_path, event_type, timestamp) VALUES (?, ?, ?, ?)'
      ).run(repo, file, event, ts);

      if (palaceClient && palaceClient.isConnected) {
        palaceClient.kgAdd(repo, 'file-edited', file, ts).catch(() => {});
      }

      json(res, 201, { ok: true, repo, file, event, timestamp: ts });
      return;
    }

    // GET /api/knowledge/events?repo=<repoName>&limit=50
    if (path === '/api/knowledge/events' && req.method === 'GET') {
      const repo = url.searchParams.get('repo');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const rows = repo
        ? db.prepare('SELECT * FROM knowledge_events WHERE repo = ? ORDER BY timestamp DESC LIMIT ?').all(repo, limit)
        : db.prepare('SELECT * FROM knowledge_events ORDER BY timestamp DESC LIMIT ?').all(limit);
      json(res, 200, { events: rows, total: rows.length });
      return;
    }
    // GET /api/code-graph/blast-radius?repo=<repoName>&file=src/auth/login.ts
    if (path === '/api/code-graph/blast-radius' && req.method === 'GET') {
      const repo = url.searchParams.get('repo');
      const file = url.searchParams.get('file');
      if (!repo || !file) { json(res, 400, { error: 'repo and file required' }); return; }
      const nodes = getBlastRadius(db, repo, file);
      const crossRepoImpact = nodes.some(n => n.repo !== repo);
      json(res, 200, { nodes, crossRepoImpact });
      return;
    }

    // GET /api/code-graph/test-coverage?files[]=<repoName>:src/auth/login.ts
    if (path === '/api/code-graph/test-coverage' && req.method === 'GET') {
      const rawFiles = url.searchParams.getAll('files[]');
      const changedFiles = rawFiles.map(f => {
        const [repo, ...rest] = f.split(':');
        return { repo, file: rest.join(':') };
      });
      const testFiles = getTestCoverage(db, changedFiles);
      const config = new ConfigManager();
      const repos = config.getRepos();
      const firstRepo = changedFiles[0]?.repo;
      const repoConfig = repos.find(r => r.name === firstRepo);
      json(res, 200, { testFiles, command: repoConfig ? `cd ${repoConfig.localPath} && ${repoConfig.testCmd}` : null });
      return;
    }

    // GET /api/code-graph/owners?repo=<repoName>&file=src/auth/login.ts
    if (path === '/api/code-graph/owners' && req.method === 'GET') {
      const repo = url.searchParams.get('repo');
      const file = url.searchParams.get('file');
      if (!repo || !file) { json(res, 400, { error: 'repo and file required' }); return; }
      const owners = getFileOwners(db, repo, file);
      json(res, 200, { owners });
      return;
    }

    // POST /api/code-graph/index  body: { repo: '<repoName>' | 'all', mode?: 'incremental' | 'full' }
    //
    // **Default is INCREMENTAL** (2026-06-24). The previous default was a
    // full sweep, which parsed the entire repo (~48k files / ~480k edges /
    // ~5min for the primary repo) regardless of whether anything had actually
    // changed. With the worker_threads migration the bridge stays
    // responsive while it runs, but the work itself is mostly wasted on
    // a healthy repo — almost all files are unchanged hour-over-hour.
    //
    // Smart routing:
    //   - mode='incremental' (default): read sync_state.last_synced_at for
    //     the repo, call indexer.indexChangedSince(sinceMs). The worker walks
    //     mtime, parses only changed files (typically 0–10 vs 48,024). Peak
    //     RSS drops from ~1.4GB (full sweep) to ~50MB (a handful of files).
    //   - mode='full': force a full sweep (delete all rows for the repo, then
    //     reindex). Use when the graph is suspected corrupted, ref types
    //     have changed in the extractor, or you want to clear deletions
    //     that the mtime-walk can't detect.
    //   - Auto-promote: if no sync_state row exists yet (first-ever index
    //     for this repo), incremental falls back to full automatically —
    //     `sinceMs=0` would walk every file anyway, so we route through
    //     the full path which also writes the sync_state checkpoint.
    if (path === '/api/code-graph/index' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const body = parseBody(
        z.object({
          repo: z.string(),
          mode: z.enum(['incremental', 'full']).optional(),
        }),
        rawBody,
      );
      if (!body.ok) { json(res, 400, { error: body.error }); return; }
      const { repo } = body.data;
      const requestedMode = body.data.mode ?? 'incremental';

      // ADR-027 v2 item #3: atomically claim the lock(s) BEFORE writing the
      // 202. The previous shape (busy-check → 202 → withCodeGraphLock) had a
      // race window: two concurrent POSTs could both pass the check, both
      // return 202, and the second's lock-acquire would throw with no caller
      // to receive the error. Now: tryAcquireCodeGraphLock claims all-or-none
      // synchronously; busy 409s come back deterministically.
      const targetRepoNames = repo === 'all' ? REPOS.map(r => r.name) : [repo];
      const acquired = tryAcquireCodeGraphLock(targetRepoNames);
      if (!acquired.ok) {
        recordCodeGraphBusyRejection(acquired.busy);
        json(res, 409, { error: 'code-graph busy', repo: acquired.busy });
        return;
      }
      // From this point we OWN the lock(s); release in .finally below.
      json(res, 202, { status: 'indexing', repo, mode: requestedMode });
      const config = new ConfigManager();
      const repos = config.getRepos();
      const indexer = new CodeIndexer(db, repos);
      const targetRepos = repo === 'all' ? repos.map(r => r.name) : [repo];

      // Resolve effective mode per repo: 'incremental' auto-promotes to
      // 'full' when there's no sync_state checkpoint (first-ever index).
      const resolveMode = (rn) => {
        if (requestedMode === 'full') return 'full';
        const row = db.prepare(
          `SELECT last_synced_at FROM sync_state WHERE topic_id = ? AND source = ?`,
        ).get('0', `code-graph-${rn}`);
        if (!row || !row.last_synced_at) return 'full'; // never indexed → full
        return 'incremental';
      };

      Promise.all(targetRepos.map(rn => {
        const effectiveMode = resolveMode(rn);
        if (effectiveMode === 'full') {
          return withCodeGraphIndexDeadline(indexer.indexRepo(rn), `indexRepo ${rn}`)
            .then(r => ({ ...r, __mode: 'full', repo: rn }))
            .catch(err => ({ __error: err, repo: rn }));
        }
        const row = db.prepare(
          `SELECT last_synced_at FROM sync_state WHERE topic_id = ? AND source = ?`,
        ).get('0', `code-graph-${rn}`);
        const sinceMs = row && row.last_synced_at ? Date.parse(row.last_synced_at) : 0;
        return withCodeGraphIndexDeadline(
          indexer.indexChangedSince(rn, sinceMs),
          `indexChangedSince ${rn}`,
        )
          .then(r => ({ ...r, __mode: 'incremental', repo: rn }))
          .catch(err => ({ __error: err, repo: rn }));
      }))
        .then(results => {
          for (const r of results) {
            if (r && r.__error) {
              persistError('code-graph-index', r.__error.message, { repo: r.repo });
              continue;
            }
            const logId = startIngestionLog(db, { source: `code-graph-${r.repo}`, topic_name: r.repo });
            // Both result shapes carry edgesAdded; full has filesIndexed,
            // incremental has filesProcessed. Use whichever is present.
            const filesCount = r.filesIndexed ?? r.filesProcessed ?? 0;
            finishIngestionLog(db, logId, { records_fetched: filesCount, records_inserted: r.edgesAdded });
          }
        })
        .catch(err => persistError('code-graph-index', err.message, { repo }))
        .finally(() => releaseCodeGraphLock(targetRepoNames));
      return;
    }

    // POST /api/code-graph/index/stream  body: { repo, mode? }
    //
    // SSE variant of /api/code-graph/index that streams worker progress
    // events so callers (UI, CLI) can show a live progress bar during a
    // long full sweep. Mirrors the schema of /api/wi/dispatch/stream.
    //
    // SSE events:
    //   event: started   data: { repo, mode, targets: ['<repoName>', ...] }
    //   event: progress  data: { repo, filesDone, filesTotal, ratio }
    //   event: result    data: { repo, mode, filesIndexed?|filesProcessed, edgesAdded, durationMs }
    //   event: error     data: { repo, message }
    //   event: done      data: { ok: boolean }
    //
    // Lock semantics match the non-streaming POST — atomic claim of all
    // target repos up front, deterministic 409 on busy. Worker progress
    // events flow through `IndexProgressOptions.onProgress` which the
    // refactored CodeIndexer (2026-06-24) plumbs through the worker_threads
    // message channel.
    if (path === '/api/code-graph/index/stream' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const body = parseBody(
        z.object({
          repo: z.string(),
          mode: z.enum(['incremental', 'full']).optional(),
        }),
        rawBody,
      );
      if (!body.ok) { json(res, 400, { error: body.error }); return; }
      const { repo } = body.data;
      const requestedMode = body.data.mode ?? 'incremental';

      const targetRepoNames = repo === 'all' ? REPOS.map(r => r.name) : [repo];
      const acquired = tryAcquireCodeGraphLock(targetRepoNames);
      if (!acquired.ok) {
        recordCodeGraphBusyRejection(acquired.busy);
        json(res, 409, { error: 'code-graph busy', repo: acquired.busy });
        return;
      }
      // We own the lock — switch to SSE mode.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(res._corsHeaders || {}),
      });
      res.flushHeaders?.();
      res.write('retry: 3000\n\n');

      const send = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
        catch { /* client disconnected */ }
      };
      const keepAlive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 15_000);

      const config = new ConfigManager();
      const repos = config.getRepos();
      const indexer = new CodeIndexer(db, repos);
      const targetRepos = repo === 'all' ? repos.map(r => r.name) : [repo];

      const resolveMode = (rn) => {
        if (requestedMode === 'full') return 'full';
        const row = db.prepare(
          `SELECT last_synced_at FROM sync_state WHERE topic_id = ? AND source = ?`,
        ).get('0', `code-graph-${rn}`);
        if (!row || !row.last_synced_at) return 'full';
        return 'incremental';
      };

      send('started', { repo, mode: requestedMode, targets: targetRepos });

      (async () => {
        let anyError = false;
        try {
          // Serialize per-repo so progress events are coherent and the
          // bridge isn't running two workers at once (each worker is one
          // CPU). Could parallelise later — the lock module is already
          // multi-repo-safe — but serial keeps the UX simple for now.
          for (const rn of targetRepos) {
            const effectiveMode = resolveMode(rn);
            try {
              if (effectiveMode === 'full') {
                const result = await withCodeGraphIndexDeadline(
                  indexer.indexRepo(rn, {
                    onProgress: (p) => send('progress', { repo: rn, ...p }),
                  }),
                  `indexRepo ${rn}`,
                );
                send('result', { ...result, __mode: 'full' });
                const logId = startIngestionLog(db, { source: `code-graph-${rn}`, topic_name: rn });
                finishIngestionLog(db, logId, { records_fetched: result.filesIndexed, records_inserted: result.edgesAdded });
              } else {
                const row = db.prepare(
                  `SELECT last_synced_at FROM sync_state WHERE topic_id = ? AND source = ?`,
                ).get('0', `code-graph-${rn}`);
                const sinceMs = row && row.last_synced_at ? Date.parse(row.last_synced_at) : 0;
                const result = await withCodeGraphIndexDeadline(
                  indexer.indexChangedSince(rn, sinceMs, {
                    onProgress: (p) => send('progress', { repo: rn, ...p }),
                  }),
                  `indexChangedSince ${rn}`,
                );
                send('result', { ...result, __mode: 'incremental' });
                const logId = startIngestionLog(db, { source: `code-graph-${rn}`, topic_name: rn });
                finishIngestionLog(db, logId, { records_fetched: result.filesProcessed, records_inserted: result.edgesAdded });
              }
            } catch (err) {
              anyError = true;
              send('error', { repo: rn, message: (err && err.message) || String(err) });
              persistError('code-graph-index', (err && err.message) || String(err), { repo: rn });
            }
          }
        } finally {
          send('done', { ok: !anyError });
          clearInterval(keepAlive);
          releaseCodeGraphLock(targetRepoNames);
          try { res.end(); } catch {}
        }
      })();
      return;
    }

    // ── EP-44: PR Intelligence endpoints ─────────────────────────────────────

    // GET /api/pr/list?repo=<repoName>&state=open
    // REFACTOR-001 (2026-05-21): /api/pr/list moved to src/routes/pr.ts

    // REFACTOR-001 (2026-05-21): /api/pr/review moved to src/routes/pr.ts

    // REFACTOR-001 (2026-05-21): /api/pr/{enrich,create,post-review,commits,watch[GET/POST/DELETE],watched-summary} moved to src/routes/pr.ts

    // ── EP-45: Teammates endpoints ────────────────────────────────────────────
    // GET /api/teammates
    if (path === '/api/teammates' && req.method === 'GET') {
      const members = getAllMembers(db);
      const result = members.map(m => {
        const profile = m.marked ? getMemberProfile(db, m.id) : null;
        return {
          ...m,
          notes: undefined, // never expose notes to UI
          profile: profile ? {
            summary: profile.summary,
            activity_level: profile.activity_level,
            activity_score: profile.activity_score,
            workload_signal: profile.workload_signal,
            domains: JSON.parse(profile.domains || '[]'),
            jira_open_count: profile.jira_open_count,
            jira_overdue_count: profile.jira_overdue_count,
            top_topics: JSON.parse(profile.top_topics || '[]'),
            last_updated: profile.last_updated,
          } : null,
        };
      });
      json(res, 200, result);
      return;
    }

    // POST /api/teammates  body: { name, email?, github_handle?, jira_username?, teams_display_name? }
    if (path === '/api/teammates' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const body = parseBody(z.object({
        name: z.string().min(1),
        email: z.string().optional(),
        github_handle: z.string().optional(),
        jira_username: z.string().optional(),
        teams_display_name: z.string().optional(),
      }), rawBody);
      if (!body.ok) { json(res, 400, { error: body.error }); return; }
      const id = addTeamMember(db, {
        name: body.data.name,
        email: body.data.email ?? null,
        github_handle: body.data.github_handle ?? null,
        jira_username: body.data.jira_username ?? null,
        teams_display_name: body.data.teams_display_name ?? null,
        marked: 0,
        notes: null,
      });
      // Build aliases for the new member (background)
      buildAliasesForMember(db, id).catch(err =>
        process.stderr.write(`[Teammates] alias build failed: ${err.message}\n`)
      );
      json(res, 201, { id });
      return;
    }

    // PATCH /api/teammates/:id/mark  body: { marked: boolean }
    const markMatch = path.match(/^\/api\/teammates\/(\d+)\/mark$/);
    if (markMatch && req.method === 'PATCH') {
      const id = parseInt(markMatch[1], 10);
      const rawBody = await readBody(req);
      const body = parseBody(z.object({ marked: z.boolean() }), rawBody);
      if (!body.ok) { json(res, 400, { error: body.error }); return; }
      markMember(db, id, body.data.marked);
      // If marking, immediately rebuild aliases + trigger profile build (background)
      if (body.data.marked && analyzer) {
        buildAliasesForMember(db, id)
          .then(() => buildOrUpdateMemberProfile(db, id, analyzer))
          .catch(err => process.stderr.write(`[Teammates] mark+build failed: ${err.message}\n`));
      }
      json(res, 200, { ok: true });
      return;
    }

    // GET /api/teammates/:id/profile
    const profileMatch = path.match(/^\/api\/teammates\/(\d+)\/profile$/);
    if (profileMatch && req.method === 'GET') {
      const id = parseInt(profileMatch[1], 10);
      const member = getTeamMember(db, id);
      if (!member) { json(res, 404, { error: 'Not found' }); return; }
      if (!member.marked) { json(res, 404, { error: 'Member not marked for profiling' }); return; }
      const profile = getMemberProfile(db, id);
      if (!profile) { json(res, 404, { error: 'Profile not yet built' }); return; }
      json(res, 200, {
        member: { ...member, notes: undefined },
        profile: {
          ...profile,
          domains: JSON.parse(profile.domains || '[]'),
          top_topics: JSON.parse(profile.top_topics || '[]'),
          code_files_owned: JSON.parse(profile.code_files_owned || '[]'),
        },
      });
      return;
    }

    // DELETE /api/teammates/:id  (soft-delete)
    const memberMatch = path.match(/^\/api\/teammates\/(\d+)$/);
    if (memberMatch && req.method === 'DELETE') {
      const id = parseInt(memberMatch[1], 10);
      softDeleteMember(db, id);
      json(res, 200, { ok: true });
      return;
    }

    // GET /api/teammates/expert?repo=<repoName>&file=src/auth/login.ts
    if (path === '/api/teammates/expert' && req.method === 'GET') {
      const repo = url.searchParams.get('repo') ?? '';
      const file = url.searchParams.get('file') ?? '';
      if (!file) { json(res, 400, { error: 'file required' }); return; }
      const candidates = getExpertCandidates(db, repo, file);
      if (candidates.length === 0) { json(res, 200, { member: null, reasoning: 'No commit data available' }); return; }
      if (!analyzer || candidates.length === 1) {
        json(res, 200, { member: { ...candidates[0].member, notes: undefined }, reasoning: `${candidates[0].commitCount} commits to this file` });
        return;
      }
      // Haiku rerank
      const ranked = await analyzer.rankReviewers(file, candidates);
      const best = candidates[ranked.bestIndex >= 0 ? ranked.bestIndex : 0];
      json(res, 200, { member: { ...best.member, notes: undefined }, reasoning: ranked.reasoning });
      return;
    }

    // POST /api/teammates/sync  (background profile rebuild for all marked members)
    if (path === '/api/teammates/sync' && req.method === 'POST') {
      if (!analyzer) { json(res, 503, { error: 'Analyzer not available' }); return; }
      const members = getMarkedMembers(db);
      Promise.allSettled(members.map(m => buildOrUpdateMemberProfile(db, m.id, analyzer)))
        .catch(err => process.stderr.write(`[Teammates] sync error: ${err.message}\n`));
      json(res, 202, { ok: true, count: members.length });
      return;
    }

  // GET /api/events — SSE stream: drains proactive_queue and forwards events to browser
  if (path === '/api/events' && req.method === 'GET') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // OP-4: SSE needs CORS headers too — EventSource respects them.
    for (const [k, v] of Object.entries(res._corsHeaders || {})) res.setHeader(k, v);
    res.flushHeaders();

    // Tell browser to reconnect after 3s on disconnect
    res.write('retry: 3000\n\n');

    // Drain unread queue rows every 2s and forward as SSE events
    const drainInterval = setInterval(() => {
      try {
        db.prepare(`DELETE FROM proactive_queue WHERE created_at < datetime('now', '-24 hours')`).run();
        const rows = db.prepare(
          `SELECT id, agent, type, payload, created_at
           FROM proactive_queue
           WHERE read_at IS NULL
           ORDER BY id ASC
           LIMIT 20`
        ).all();
        for (const row of rows) {
          if (!res.writable) break; // WR-01/02: stop if socket already closed
          let payload;
          try { payload = JSON.parse(row.payload); } catch { continue; }
          const event = {
            id: row.id,
            agent: row.agent,
            type: row.type,
            title: payload.title,
            body: payload.body,
            action_url: payload.action_url,
            decision_id: payload.decision_id ?? null,
            created_at: row.created_at,
          };
          try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            db.prepare(`UPDATE proactive_queue SET read_at = datetime('now') WHERE id = ?`).run(row.id);
          } catch (_writeErr) {
            break; // socket closed mid-drain; leave rows unread for next reconnect
          }
        }
      } catch (_err) {
        // DB error during drain — skip this tick, connection stays alive
      }
    }, 2_000);

    // Keep-alive comment every 30s to prevent proxy/browser timeout
    const keepAliveInterval = setInterval(() => {
      if (res.writable) res.write(': keep-alive\n\n'); // WR-02: guard against post-close tick
    }, 30_000);

    // Clear both intervals when client disconnects
    req.on('close', () => {
      clearInterval(drainInterval);
      clearInterval(keepAliveInterval);
    });

    return; // keep connection open — do NOT call res.end()
  }

    // GET /api/research/stats — EP-67 prompt evolution stats
    if (path === '/api/research/stats' && req.method === 'GET') {
      try {
        const stats = getResearchStats(db);
        json(res, 200, stats);
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return;
    }

    // GET /api/research/evolution — EP-67 per-trigger-type template version stats
    if (path === '/api/research/evolution' && req.method === 'GET') {
      try {
        const triggers = ['jira_analyze', 'chat', 'investigate', 'alert'];
        const evolution = {};
        for (const t of triggers) {
          const rows = db.prepare(`
            SELECT version, is_active, ab_weight, avg_quality_score, invocation_count, evolution_source, promoted_at, deprecated_at, created_at
            FROM prompt_templates WHERE trigger_type = ? ORDER BY version DESC
          `).all(t);
          evolution[t] = { activeVersion: rows.find(r => r.is_active === 1)?.version ?? null, versions: rows };
        }
        json(res, 200, evolution);
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return;
    }

    // POST /api/research/feedback — EP-67 thumbs up/down on research results
    if (path === '/api/research/feedback' && req.method === 'POST') {
      const rawBody = await readBody(req);
      let body;
      try { body = JSON.parse(rawBody); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
      const { researchId, feedback } = body;
      if (!researchId || (feedback !== 1 && feedback !== -1)) {
        json(res, 400, { error: 'researchId and feedback (1 or -1) required' });
        return;
      }
      try {
        updateOutcomeFeedback(db, researchId, feedback);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return;
    }

    // GET /api/research/findings?question=<title> — EP-67 get research findings for a ticket
    if (path === '/api/research/findings' && req.method === 'GET') {
      const question = url.searchParams.get('question');
      if (!question) { json(res, 400, { error: 'question parameter required' }); return; }
      try {
        const row = getResearchByQuestion(db, question);
        if (!row) { json(res, 200, { findings: [], researchId: null }); return; }
        const parsed = JSON.parse(row.result);
        const findings = (parsed.findings || parsed.items || []).map(f => ({
          title: f.title || f.summary || '',
          explanation: f.explanation || f.detail || f.content || '',
          relevantFiles: f.relevantFiles || f.files || [],
          confidence: f.confidence || row.confidence || 0,
        }));
        json(res, 200, { findings, researchId: row.id });
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[API Error]', err);
    persistError('web-server', err instanceof Error ? err.message : String(err), {
      path: path,
      stack: err instanceof Error ? err.stack : undefined,
      severity: 'error',
    });
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

// Module-level reference so SIGINT/SIGTERM handlers can call changeWatcher.stop()
let changeWatcher = null;

// ── Phase 71-03: Proactive brain decision scan (ADR-024 Pillar 4) ──────────
// Module-level handle stored at startup so SIGINT/SIGTERM can clearInterval
// and let the Node event loop exit cleanly. Started after server.listen()
// so the bridge has finished binding the port before background work fires.
let proactiveBrainScan = null;

// 'exit' fires regardless of which path triggered termination — including the
// SIGTERM handler in dist/db/connection.js that runs before our handler and
// calls process.exit() synchronously. Registering on 'exit' guarantees the
// proactive scan log line lands even when another handler exits first.
let proactiveBrainScanStopped = false;
function stopProactiveBrainScanOnce() {
  if (!proactiveBrainScanStopped && proactiveBrainScan) {
    proactiveBrainScan.stop();
    try { fs.writeSync(2, '[brain] proactive scan stopped\n'); } catch {}
    proactiveBrainScanStopped = true;
  }
}
process.on('exit', stopProactiveBrainScanOnce);

process.on('SIGINT', () => {
  if (changeWatcher) changeWatcher.stop();
  stopProactiveBrainScanOnce();
  closeDatabase();
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (changeWatcher) changeWatcher.stop();
  stopProactiveBrainScanOnce();
  closeDatabase();
  process.exit(0);
});

server.listen(PORT, async () => {
  console.log(`Work Intelligence API bridge running at http://localhost:${PORT}`);
  console.log(`Anthropic: ${anthropicApiKey ? '✓ connected' : '✗ no key'}`);
  console.log(`Browser:   ${process.env.BROWSER_PROFILE_PATH ? '✓ configured' : '✗ BROWSER_PROFILE_PATH not set'}`);
  console.log(`GitHub:    ${isGitHubMcpConfigured() ? '✓ configured (MCP PAT)' : '✗ not configured'}`);

  // ADR-040 commit 4 (2026-07-06): auto-register skills from
  // ~/.claude/skills/work-intelligence/ that aren't already in the
  // hardcoded TOOL_CATALOG. Closes the "17 missing skills" gap from
  // GAP-001. Best-effort — failures log and do not block boot.
  // Distinct from the pre-existing phase-82b discoverSkills scanner
  // (skill-discovery.ts) which populates skill_catalog for priors.
  try {
    const { TOOL_CATALOG: catalog } = await import('./dist/services/cypher/tool-catalog.js');
    const { autoRegisterMissingSkills } = await import('./dist/services/cypher/skill-autoregister.js');
    const added = autoRegisterMissingSkills(catalog);
    console.log(`[skill-autoregister] added ${added} skills; catalog size = ${catalog.length}`);
  } catch (err) {
    console.warn(`[skill-autoregister] failed: ${(err && err.message) || err}`);
  }

  // /dream nightly memory-consolidation scheduler (in-process, 07:00 local +
  // boot catch-up). Generates a read-only proposal report; apply is human-gated
  // via the /dream page or wi-dream-apply. Disable with DREAM_SCHEDULER_DISABLED=1.
  try {
    startDreamScheduler(db, anthropicApiKey);
  } catch (err) {
    process.stderr.write(`[dream] scheduler start failed: ${(err && err.message) || err}\n`);
  }

  // Tier 1 (T1.1): reap orphaned jira_analysis rows left in 'pending' by a
  // prior bridge crash/restart. Without this, the polling UI gets
  // status='pending' forever for any analyse that was in flight when the
  // bridge died. We flip them to 'failed' with a clear note so the user
  // knows to re-trigger. Idempotent — does nothing on a clean boot.
  try {
    const reapResult = db.prepare(
      `UPDATE jira_analysis
         SET status = 'failed',
             analysis = COALESCE(analysis, '') ||
                        CASE WHEN COALESCE(analysis, '') = '' THEN '' ELSE '\n\n---\n' END ||
                        'Analysis was orphaned by a bridge restart. Click Re-analyse to try again.'
       WHERE status = 'pending'`,
    ).run();
    if (reapResult.changes > 0) {
      process.stderr.write(`[boot-reap] flipped ${reapResult.changes} orphaned pending jira_analysis rows → failed\n`);
    }
  } catch (reapErr) {
    process.stderr.write(`[boot-reap] non-fatal: ${reapErr.message}\n`);
  }

  // Start the proactive brain scan cron. Lazy-imported to match the rest of
  // the brain wiring in this file. Failure is non-fatal — the bridge still
  // serves API traffic without proactive pushes.
  try {
    const { startProactiveScan } = await import('./dist/services/brain/proactive-scan.js');
    proactiveBrainScan = startProactiveScan(db);
    process.stderr.write('[brain] proactive scan started (30min interval)\n');
  } catch (err) {
    process.stderr.write(`[brain] proactive scan failed to start: ${err && err.message ? err.message : err}\n`);
  }

  // Phase 79-08: Boot-time vault indexing + chokidar watcher for the obsidian_notes
  // recall lane. Runs immediately at bridge startup so the 6th lane is live from
  // t=0 — previously this only fired inside runFullSync (15 min after boot).
  // Non-fatal on failure; the other 5 recall lanes carry the load if OBSIDIAN_VAULT_PATH
  // is unset or the vault path is unreadable.
  if (process.env.OBSIDIAN_VAULT_PATH) {
    try {
      indexVault(db, process.env.OBSIDIAN_VAULT_PATH);
      const stopVaultWatcher = watchVault(db, process.env.OBSIDIAN_VAULT_PATH);
      process.once('SIGTERM', stopVaultWatcher);
      process.once('SIGINT', stopVaultWatcher);
    } catch (err) {
      process.stderr.write(`[vault-indexer] boot scan/watcher failed: ${err && err.message ? err.message : err}\n`);
    }
  }
});

// ── EP-15-1: Auto-sync loop ────────────────────────────────────────────────
// Runs every SYNC_INTERVAL_MS (default 15 min). Uses scheduleNextSync() recursion
// so we wait for each sync to finish before starting the timer — no overlaps.
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS) || 15 * 60 * 1000;

function scheduleNextSync() {
  setTimeout(async () => {
    if (!syncProgress.running) {
      process.stderr.write(`[AutoSync] Starting scheduled sync\n`);
      await runFullSync();
      // generateAlerts() and generateWorkload() are called inside runFullSync
    } else {
      process.stderr.write(`[AutoSync] Skipped — sync already in progress\n`);
    }
    await checkEndedMeetings().catch(err =>
      process.stderr.write(`[AutoSync] checkEndedMeetings error: ${err.message}\n`)
    );
    // Prune expired web_cache entries (EP-66 link fetcher cache)
    try {
      const { pruneExpiredCache } = await import('./dist/db/queries/web-cache.js');
      const pruned = pruneExpiredCache(db);
      if (pruned > 0) process.stderr.write(`[AutoSync] Pruned ${pruned} expired web_cache entries\n`);
    } catch (e) { /* non-fatal */ }
    scheduleNextSync(); // re-schedule after completion (or skip) — never overlaps
  }, SYNC_INTERVAL_MS);
}

// No automatic startup sync — first sync fires after SYNC_INTERVAL_MS (default 1h),
// or can be triggered manually via POST /api/sync/all or by the macOS watchers (EP-16).
// This avoids hammering the browser connector every time the server restarts.
scheduleNextSync();

// Seed alerts and workload from existing DB data immediately on boot (no AI, no browser)
generateAlerts();
generateWorkload();

process.stderr.write(`[AutoSync] Loop started — first auto-sync in ${SYNC_INTERVAL_MS / 60000}m | trigger manually: POST /api/sync/all\n`);

// ── EP-58: Persistent PalaceClient v2 (shared instance) ──
if (process.env.MEMPALACE_PATH) {
  (async () => {
    try {
      const { PalaceClient } = await import('./dist/intelligence/palace-client.js');
      palaceClient = new PalaceClient(process.env.MEMPALACE_PATH);

      // Create MemoryEnricher (uses Anthropic client for Haiku NER if available)
      const { MemoryEnricher } = await import('./dist/intelligence/memory-enricher.js');
      memoryEnricher = new MemoryEnricher(palaceClient, analyzer?.client ?? undefined, db);

      // Run seeder with shared client
      const { runPalaceSeeder } = await import('./dist/intelligence/palace-seeder.js');
      const result = await runPalaceSeeder(process.env.MEMPALACE_PATH, OPERATIONS_PATH, palaceClient);
      process.stdout.write(`[palace] booted — seeder: ${result.flagsProcessed} flags, ${result.triplesWritten} triples\n`);

      // EP-59: Gate check — warn if palace has fewer than 50 drawers (59-C9)
      try {
        const statusRaw = await palaceClient.callToolRaw('mempalace_status', {});
        if (statusRaw) {
          const status = JSON.parse(statusRaw);
          const drawerCount = status.total_drawers || status.totalDrawers || 0;
          if (drawerCount < 50) {
            process.stderr.write(`[ep59-gate] WARNING: Palace has ${drawerCount} drawers (recommended: >50 for quality recall). Chat will still use palace but results may be sparse.\n`);
          } else {
            process.stderr.write(`[ep59-gate] Palace gate passed: ${drawerCount} drawers available for recall.\n`);
          }
        }
      } catch (gateErr) {
        process.stderr.write(`[ep59-gate] Could not check drawer count: ${gateErr.message}\n`);
      }

      // EP-60: Watch Obsidian vault for real-time annotation updates
      if (process.env.OBSIDIAN_VAULT_PATH) {
        const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
        const annotationDebounce = new Map(); // filePath -> timeout
        try {
          fs.watch(vaultPath, { recursive: true }, (eventType, filename) => {
            if (!filename || !filename.endsWith('.md')) return;
            const fullPath = path.join(vaultPath, filename);

            // 2s debounce per file
            const existing = annotationDebounce.get(fullPath);
            if (existing) clearTimeout(existing);
            annotationDebounce.set(fullPath, setTimeout(async () => {
              annotationDebounce.delete(fullPath);
              try {
                const annotations = extractVaultAnnotations(vaultPath);
                const changed = annotations.find(a => a.filePath === fullPath);
                if (changed && palaceClient && palaceClient.isConnected) {
                  await palaceClient.addDrawer('annotations', changed.topicName, changed.content, changed.filePath);
                  const entities = extractEntities(changed.content, knownPeopleNames);
                  for (const key of entities.jiraKeys) {
                    await palaceClient.kgAdd(key, 'human-annotated', changed.content.slice(0, 200), new Date().toISOString().slice(0, 10));
                  }
                  await palaceClient.diaryWrite('annotation-sync',
                    `Real-time sync: ${changed.topicName} (${changed.isNew ? 'new' : 'updated'})`,
                    changed.topicName
                  );
                  process.stderr.write(`[annotation-watch] Synced ${changed.topicName}\n`);
                }
              } catch (err) {
                if (err.code === 'ENOENT') {
                  // Obsidian atomic rename — retry once after 100ms
                  setTimeout(async () => {
                    try {
                      const annotations = extractVaultAnnotations(vaultPath);
                      const retry = annotations.find(a => a.filePath === fullPath);
                      if (retry && palaceClient && palaceClient.isConnected) {
                        await palaceClient.addDrawer('annotations', retry.topicName, retry.content, retry.filePath);
                        process.stderr.write(`[annotation-watch] Retry synced ${retry.topicName}\n`);
                      }
                    } catch { /* give up silently */ }
                  }, 100);
                } else {
                  process.stderr.write(`[annotation-watch] ${err.message}\n`);
                }
              }
            }, 2000));
          });
          process.stderr.write(`[annotation-watch] Watching ${vaultPath} for annotation changes\n`);
        } catch (err) {
          process.stderr.write(`[annotation-watch] Could not watch vault: ${err.message}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[palace] boot failed: ${err.message}\n`);
    }
  })();
}

// ── EP-16-4: macOS event-driven watchers ──────────────────────────────────

function sendMacNotification(title, body) {
  try {
    execFileSync('osascript', ['-e',
      `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`
    ], { timeout: 3000 });
  } catch { /* best-effort */ }
}

// ── EP-50: Board tab fetch helpers ───────────────────────────

async function _fetchBoardTab(tab) {
  const _activeSprintRow = db.prepare('SELECT * FROM sprint_config WHERE active = 1 LIMIT 1').get();
  // config-driven — set JIRA_PROJECT_KEY env var
  const _activeSprint = _activeSprintRow ?? { sprint_name: 'Unknown', project_key: DEFAULT_JIRA_PROJECT, start_date: null, end_date: null };
  const cache = boardCache[tab];
  const rawUsername = process.env.JIRA_MY_USERNAME || '';
  // Validate username to prevent JQL injection — allow only alphanumeric, dots, hyphens, underscores, @ signs
  if (rawUsername && !/^[\w.@-]+$/.test(rawUsername)) {
    process.stderr.write(`[board] JIRA_MY_USERNAME contains invalid characters — rejecting to prevent JQL injection\n`);
    cache.isRefreshing = false;
    const result = { sprint: sprintMeta, issues: [], cachedAt: null, isRefreshing: false, dataSource: 'unknown', missingConfig: true };
    cache.data = result;
    return result;
  }
  const username = rawUsername;

  try {
    let rawIssues = []; // parsed EnhancedIssue objects from fetch stage
    let dataSource = 'mcp';

    // ── STAGE 1: FETCH ────────────────────────────────────────────────────────
    // Primary: Jira MCP. Fallback: browser scraper (JiraAutoAdapter).
    let mcpFailed = false;
    try {
      const { McpClient } = await import('./dist/fetcher/sources/mcp-oauth-client.js');
      const jiraClient = new McpClient(db, getJiraMcpClientName(), process.env.JIRA_MCP_URL ?? 'https://jira.example.com/mcp' /* config-driven — set JIRA_MCP_URL env var */);

      if (tab === 'mine') {
        if (!username) {
          cache.isRefreshing = false;
          const result = { sprint: sprintMeta, issues: [], cachedAt: null, isRefreshing: false, dataSource: 'unknown', missingConfig: true };
          cache.data = result;
          return result;
        }
        // Two parallel JQL calls to classify sprint context
        // Username is double-quoted in JQL for safety (JQL requires quotes around account IDs)
        const [sprintResult, nonSprintResult] = await Promise.allSettled([
          jiraClient.callTool('jira_search', {
            jql: `project = ${DEFAULT_JIRA_PROJECT} AND assignee = "${username}" AND sprint in openSprints() ORDER BY updated DESC`,
            fields: 'summary,status,priority,issuetype,labels,assignee,updated',
            limit: 50,
          }),
          jiraClient.callTool('jira_search', {
            jql: `project = ${DEFAULT_JIRA_PROJECT} AND assignee = "${username}" AND statusCategory != Done AND sprint not in openSprints() ORDER BY updated DESC`,
            fields: 'summary,status,priority,issuetype,labels,assignee,updated',
            limit: 50,
          }),
        ]);

        const sprintIssues = sprintResult.status === 'fulfilled'
          ? _parseJiraSearchResult(sprintResult.value, 'current_sprint', _activeSprint.sprint_name)
          : [];
        const nonSprintIssues = nonSprintResult.status === 'fulfilled'
          ? _parseJiraSearchResult(nonSprintResult.value, 'backlog', null)
          : [];

        rawIssues = [...sprintIssues, ...nonSprintIssues];

        if (sprintResult.status === 'fulfilled' && !sprintMeta) {
          // TODO(WR-50-1): Sprint name and dates are hardcoded because the Jira MCP does not
          // return customfield_10020 (sprint field) — see ADR-009 and memory/project_jira_mcp.md.
          // Update name/start/end manually at each sprint boundary until the MCP exposes sprint data.
          // total is derived from the actual sprint issue count, not hardcoded.
          sprintMeta = { name: _activeSprint.sprint_name, start: _activeSprint.start_date, end: _activeSprint.end_date, total: sprintIssues.length };
        }

      } else if (tab === 'sprint') {
        const result = await jiraClient.callTool('jira_search', {
          jql: `project = ${DEFAULT_JIRA_PROJECT} AND sprint in openSprints() ORDER BY assignee ASC, priority ASC`,
          fields: 'summary,status,priority,issuetype,labels,assignee,updated',
          limit: 200,
        });
        rawIssues = _parseJiraSearchResult(result, 'current_sprint', _activeSprint.sprint_name);
        if (!sprintMeta) {
          // TODO(WR-50-1): Sprint name/dates hardcoded — MCP does not expose customfield_10020.
          // Update at sprint boundary. total is derived dynamically from query result.
          sprintMeta = { name: _activeSprint.sprint_name, start: _activeSprint.start_date, end: _activeSprint.end_date, total: rawIssues.length };
        }

      } else { // all
        const result = await jiraClient.callTool('jira_search', {
          jql: `project = ${DEFAULT_JIRA_PROJECT} AND updated >= -30d ORDER BY updated DESC`,
          fields: 'summary,status,priority,issuetype,labels,assignee,updated',
          limit: 100,
        });
        rawIssues = _parseJiraSearchResult(result, 'backlog', null);
      }

    } catch (mcpErr) {
      process.stderr.write(`[board] MCP fetch failed (${tab}): ${mcpErr.message} — falling back to browser scraper\n`);
      mcpFailed = true;
      dataSource = 'browser';

      // Browser fallback: use JiraAutoAdapter (respects JIRA_SOURCE env var)
      try {
        const session = getBrowserSession();
        const { createJiraDataSource } = await import('./dist/fetcher/sources/jira-adapter.js');
        const connector = createJiraDataSource(session, 'browser');
        const boardUrl = getJiraBoardUrl() || 'https://jira.example.com/secure/RapidBoard.jspa?rapidView=0&projectKey=PROJ'; // config-driven via wi.config.json (jira.boardUrl)
        const messages = await connector.fetchMessages({ boardUrl });
        rawIssues = messages
          .filter(m => m.metadata?.jira)
          .map(m => {
            const jira = m.metadata.jira;
            const key = jira.issueKey ?? m.id;
            const sprintCtx = tab === 'sprint' ? 'current_sprint' : 'backlog';
            return {
              key,
              title: (m.subject ?? m.content.slice(0, 80)).replace(/^\[[\w-]+\]\s*/, ''),
              status: jira.status ?? 'Unknown',
              assignee: jira.assignee?.name ?? null,
              priority: jira.priority ?? null,
              epicKey: jira.epicKey ?? null,
              epicName: jira.epicName ?? null,
              issueType: jira.issueType ?? null,
              labels: Array.isArray(jira.labels) ? jira.labels : [],
              updatedAt: (m.modifiedAt ?? m.createdAt).toISOString(),
              url: getJiraBrowseUrl(key),
              sprintContext: sprintCtx,
              sprintName: tab === 'sprint' ? _activeSprint.sprint_name : null,
            };
          });
        process.stderr.write(`[board] browser fallback fetched ${rawIssues.length} issues for tab=${tab}\n`);
      } catch (browserErr) {
        process.stderr.write(`[board] browser fallback also failed (${tab}): ${browserErr.message}\n`);
        // Both sources failed — return stale DB data if available, else propagate error
        const listName = `board_${tab}`;
        const dbRows = loadBoardIssues(db, listName);
        if (dbRows.length > 0) {
          process.stderr.write(`[board] serving ${dbRows.length} stale DB rows for tab=${tab}\n`);
          const issues = dbRows.map(r => ({
            key: r.key, title: r.title, status: r.status, assignee: r.assignee,
            priority: r.priority, epicKey: r.epic_key, epicName: r.epic_name,
            issueType: r.issue_type, labels: _parseLabels(r.labels),
            updatedAt: r.updated_at, url: r.url,
            sprintContext: r.sprint_context, sprintName: r.sprint_name,
          }));
          const now = new Date().toISOString();
          cache.data = { sprint: sprintMeta, issues, cachedAt: now, isRefreshing: false, dataSource: 'db_stale' };
          cache.cachedAt = now;
          cache.isRefreshing = false;
          return cache.data;
        }
        cache.isRefreshing = false;
        cache.lastFailedAt = Date.now();
        throw new Error(`Both MCP and browser fetch failed: ${mcpErr.message} / ${browserErr.message}`);
      }
    }

    // ── STAGE 2: PROCESS — upsert into jira_issues ────────────────────────────
    const listName = `board_${tab}`;
    if (rawIssues.length > 0) {
      try {
        saveBoardIssues(db, listName, rawIssues.map(i => ({
          key: i.key,
          title: i.title,
          status: i.status,
          assignee: i.assignee ?? null,
          priority: i.priority ?? null,
          epic_key: i.epicKey ?? null,
          epic_name: i.epicName ?? null,
          updated_at: i.updatedAt,
          url: i.url,
          sprint_context: i.sprintContext,
          sprint_name: i.sprintName ?? null,
          issue_type: i.issueType ?? null,
          labels: JSON.stringify(Array.isArray(i.labels) ? i.labels : []),
          data_source: dataSource,
        })));
        process.stderr.write(`[board] persisted ${rawIssues.length} issues to jira_issues (list=${listName})\n`);
      } catch (dbErr) {
        process.stderr.write(`[board] DB upsert failed — serving in-memory data: ${dbErr.message}\n`);
      }

      // Auto-import sprint teammates (non-blocking, sprint tab only)
      if (tab === 'sprint') {
        _autoImportSprintTeammates(rawIssues).catch(e => process.stderr.write(`[board] teammate sync failed: ${e.message}\n`));
      }

      // Detect status transitions (EP-42-2, non-blocking)
      for (const issue of rawIssues) {
        try {
          const projectKey = issue.key.split('-')[0] ?? 'UNKNOWN';
          const last = getLastTransition(db, issue.key);
          if (last?.to_status !== issue.status) {
            recordTransition(db, issue.key, projectKey, last?.to_status ?? null, issue.status);
          }
        } catch { /* non-fatal */ }
      }
    }

    // ── STAGE 3: PROPOSE — read from DB ──────────────────────────────────────
    const dbRows = loadBoardIssues(db, listName);
    const issues = dbRows.map(r => ({
      key: r.key,
      title: r.title,
      status: r.status,
      assignee: r.assignee,
      priority: r.priority,
      epicKey: r.epic_key,
      epicName: r.epic_name,
      issueType: r.issue_type,
      labels: _parseLabels(r.labels),
      updatedAt: r.updated_at,
      url: r.url,
      sprintContext: r.sprint_context,
      sprintName: r.sprint_name,
    }));

    const now = new Date().toISOString();
    cache.data = { sprint: sprintMeta, issues, cachedAt: now, isRefreshing: false, dataSource };
    cache.cachedAt = now;
    cache.isRefreshing = false;
    return cache.data;

  } catch (err) {
    cache.isRefreshing = false;
    cache.lastFailedAt = Date.now(); // numeric ms epoch — consistent with refreshStartedAt (WR-50-5)
    throw err;
  }
}

function _parseLabels(labelsJson) {
  if (!labelsJson) return [];
  try {
    const parsed = JSON.parse(labelsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _parseJiraSearchResult(rawResult, sprintContext, sprintName) {
  const issues = [];
  try {
    const parsed = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
    const items = parsed?.issues || parsed?.result?.issues || (Array.isArray(parsed) ? parsed : []);
    for (const issue of items) {
      // Jira MCP returns flat fields directly on issue (summary, status, issue_type, etc.)
      // Legacy browser scraper returns nested under issue.fields — support both formats
      const f = issue.fields || {};
      const summary = issue.summary || f.summary || '';
      const status = issue.status?.name || f.status?.name || '';
      const assignee = issue.assignee?.display_name || issue.assignee?.displayName || f.assignee?.displayName || null;
      const priority = issue.priority?.name || f.priority?.name || null;
      const issueType = issue.issue_type?.name || f.issuetype?.name || null;
      const labels = Array.isArray(issue.labels) ? issue.labels : (Array.isArray(f.labels) ? f.labels : []);
      const updatedAt = issue.updated || f.updated || '';
      const epicKey = issue.epic?.key || f.epic?.key || null;
      const epicName = issue.epic?.fields?.summary || f.epic?.fields?.summary || null;
      issues.push({
        key: issue.key,
        title: summary,
        status,
        assignee,
        priority,
        epicKey,
        epicName,
        issueType,
        labels,
        updatedAt,
        url: getJiraBrowseUrl(issue.key),
        sprintContext,
        sprintName,
      });
    }
  } catch (e) {
    process.stderr.write(`[board] parse error: ${e.message}\n`);
  }
  return issues;
}

async function _autoImportSprintTeammates(issues) {
  if (!issues || issues.length === 0) return 0;
  const seen = new Set();
  let inserted = 0;
  const jiraUsername = process.env.JIRA_MY_USERNAME || '';

  for (const issue of issues) {
    if (!issue.assignee || seen.has(issue.assignee)) continue;
    seen.add(issue.assignee);
    if (issue.assignee === jiraUsername) continue; // skip self
    try {
      const result = db.prepare(
        `INSERT OR IGNORE INTO team_members (name, jira_username, marked) VALUES (?, ?, 0)`
      ).run(issue.assignee, issue.assignee);
      if (result.changes > 0) inserted++;
    } catch (e) {
      process.stderr.write(`[board] teammate insert error: ${e.message}\n`);
    }
  }
  return inserted;
}

// ── OP-5 / A-2: per-agent isolation ─────────────────────────────────────────
// Each agent is started in its own try/catch. A failure in one (e.g. stale
// dist/, missing API key) no longer kills the others. Health is published to
// agentHealth and surfaced at GET /api/agents/health.
setTimeout(async () => {

  // ── Outlook + Teams badge watchers ───────────────────────────────────────
  registerAgent('OutlookWatcher');
  registerAgent('TeamsBadgeWatcher');
  try {
    const { OutlookWatcher, getTeamsBadgeCount } = await import('./dist/fetcher/sources/outlook-watcher.js');

    const outlookWatcher = new OutlookWatcher(async (event) => {
      await withAgentTick('OutlookWatcher', async () => {
        watcherState.lastTriggerAt = new Date().toISOString();
        watcherState.triggerCount++;
        if (event.type === 'jira') {
          watcherState.lastTriggerReason = `Jira email: ${event.jiraProjectKeys.join(', ')}`;
          sendMacNotification('Work Intelligence', `New Jira activity: ${event.jiraProjectKeys.join(', ')}`);
          await runTargetedJiraSync(event.jiraProjectKeys);
        } else if (event.type === 'email') {
          watcherState.lastTriggerReason = 'New email';
          sendMacNotification('Work Intelligence', 'New email — syncing');
          await runEmailSync();
        }
        generateAlerts();
        watcherState.lastOutlookCheck = new Date().toISOString();
      });
    });
    watcherState.outlookEnabled = outlookWatcher.start();
    if (watcherState.outlookEnabled) markAgentReady('OutlookWatcher');
    else markAgentDisabled('OutlookWatcher', 'HxStore.hxd not found or not readable');

    const TEAMS_POLL_MS = Number(process.env.TEAMS_POLL_MS) || 60_000;
    let lastTeamsBadge = getTeamsBadgeCount();
    watcherState.teamsEnabled = lastTeamsBadge !== -1;
    if (watcherState.teamsEnabled) markAgentReady('TeamsBadgeWatcher');
    else markAgentDisabled('TeamsBadgeWatcher', 'Teams not running or no accessibility permissions');

    setInterval(() => withAgentTick('TeamsBadgeWatcher', async () => {
      const current = getTeamsBadgeCount();
      watcherState.lastTeamsCheck = new Date().toISOString();
      if (current === -1) return;
      if (current > lastTeamsBadge) {
        const delta = current - lastTeamsBadge;
        process.stderr.write(`[TeamsBadge] Badge increased by ${delta} — triggering Teams sync\n`);
        watcherState.lastTriggerAt = new Date().toISOString();
        watcherState.lastTriggerReason = `Teams: ${delta} new message${delta > 1 ? 's' : ''}`;
        watcherState.triggerCount++;
        sendMacNotification('Work Intelligence', `${delta} new Teams message${delta > 1 ? 's' : ''} — syncing`);
        await runTargetedTeamsSync();
        generateAlerts();
      }
      lastTeamsBadge = current;
    }), TEAMS_POLL_MS);
  } catch (err) {
    markAgentCrashed('OutlookWatcher', err);
    markAgentCrashed('TeamsBadgeWatcher', err);
  }

  // ── ChangeWatcher (CDC) ──────────────────────────────────────────────────
  registerAgent('ChangeWatcher');
  let _orchestratorReady = false;
  try {
    const { ChangeWatcher } = await import('./dist/services/change-watcher.js');
    changeWatcher = new ChangeWatcher(db, Number(process.env.CHANGE_WATCHER_MS) || 100);
    changeWatcher.start();
    markAgentReady('ChangeWatcher');
    process.stderr.write('[ChangeWatcher] Started — polling changes_log every 100ms\n');
  } catch (err) {
    markAgentCrashed('ChangeWatcher', err);
  }

  // ── OrchestratorAgent (CDC subscribers) ──────────────────────────────────
  registerAgent('OrchestratorAgent');
  try {
    if (!changeWatcher) throw new Error('ChangeWatcher unavailable — cannot subscribe');
    const { OrchestratorAgent } = await import('./dist/services/orchestrator-agent.js');
    const orchestrator = new OrchestratorAgent(db, process.env.ANTHROPIC_API_KEY || '');
    changeWatcher.on('new-message', (event) =>
      withAgentTick('OrchestratorAgent', () => orchestrator.handleNewMessage(event.rowId)));
    changeWatcher.on('jira-update', (event) =>
      withAgentTick('OrchestratorAgent', () => orchestrator.handleJiraUpdate(event.rowId, event.operation)));
    changeWatcher.on('calendar-change', (event) =>
      withAgentTick('OrchestratorAgent', () => orchestrator.handleCalendarChange(event.rowId)));
    _orchestratorReady = true;
    markAgentReady('OrchestratorAgent');
    process.stderr.write('[OrchestratorAgent] Subscribed to new-message, jira-update, calendar-change events\n');
  } catch (err) {
    markAgentCrashed('OrchestratorAgent', err);
  }
  void _orchestratorReady; // reserved for future cross-agent gating

  // ── MeetingPrepAgent (5-min poll) ────────────────────────────────────────
  registerAgent('MeetingPrepAgent');
  try {
    const MEETING_PREP_INTERVAL_MS = 5 * 60 * 1000;
    const MEETING_PREP_WINDOW_START = 50;
    const MEETING_PREP_WINDOW_END   = 70;
    const MEETING_PREP_DEDUP_MIN    = 90;

    setInterval(() => withAgentTick('MeetingPrepAgent', async () => {
      const upcoming = db.prepare(`
        SELECT id, source_id, title, start_time, attendees
        FROM calendar_events
        WHERE start_time >= datetime('now', '+${MEETING_PREP_WINDOW_START} minutes')
          AND start_time <= datetime('now', '+${MEETING_PREP_WINDOW_END} minutes')
      `).all();

      for (const event of upcoming) {
        if (!event.source_id) {
          process.stderr.write(`[MeetingPrep] Skipping event id=${event.id} — null source_id\n`);
          continue;
        }
        const existing = db.prepare(`
          SELECT id FROM proactive_queue
          WHERE agent = 'meeting-prep' AND source_id = ?
            AND created_at >= datetime('now', '-${MEETING_PREP_DEDUP_MIN} minutes')
        `).get(event.source_id);
        if (existing) continue;

        const context = buildMeetingContext(db, event);
        const contextSummary = [
          ...context.recentMessages.slice(0, 5).map(m => m.content.slice(0, 200)),
          ...context.pastMeetings.slice(0, 2).map(m => m.summary || m.title || ''),
        ].filter(Boolean).join('\n\n');

        const hoursAway = (new Date(event.start_time).getTime() - Date.now()) / 3_600_000;
        const contextItems = contextSummary
          ? [{ subject: event.title, content: contextSummary }]
          : [];
        const apiKey = process.env.ANTHROPIC_API_KEY || '';
        const { generatePreBrief } = await import('./dist/services/analyzer.js');
        const brief = await generatePreBrief(
          event.title, event.attendees || '', hoursAway, contextItems, apiKey,
          process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-latest',
        );
        const payload = JSON.stringify({
          title: `Meeting prep: ${event.title}`,
          body: brief,
          action_url: `/api/calendar/events/${event.id}/context`,
        });
        db.prepare(`INSERT INTO proactive_queue (agent, source_id, type, payload)
                    VALUES ('meeting-prep', ?, 'meeting-prep', ?)`).run(event.source_id, payload);
        process.stderr.write(`[MeetingPrep] Queued brief for: ${event.title}\n`);
      }
    }), MEETING_PREP_INTERVAL_MS);
    markAgentReady('MeetingPrepAgent');
  } catch (err) {
    markAgentCrashed('MeetingPrepAgent', err);
  }

  // ── CorrelationAgent (5-min gate poll, nightly digest) ───────────────────
  registerAgent('CorrelationAgent');
  try {
    const CORRELATION_INTERVAL_MS = 5 * 60 * 1000;
    // A-4 (fixed): UTC throughout. cache_key uses utcDayIso() so the schedule
    // gate must match. Previously this used local-time getHours() which would
    // skip a day or fire twice across DST boundaries.
    // CORRELATION_HOUR is interpreted as UTC. Default 06:00 UTC ≈ 08:00 CEST / 07:00 CET.
    const CORRELATION_HOUR = parseInt(process.env.CORRELATION_HOUR || '6', 10);

    const lastCorrelation = db.prepare(`
      SELECT created_at FROM proactive_queue WHERE agent = 'CorrelationAgent'
      ORDER BY created_at DESC LIMIT 1
    `).get();
    const correlationStale = !lastCorrelation ||
      (Date.now() - new Date(lastCorrelation.created_at + 'Z').getTime()) > 24 * 60 * 60 * 1000;

    async function runCorrelationAgentTick() {
      if (!palaceClient || !palaceClient.isConnected) return;
      const apiKey = process.env.ANTHROPIC_API_KEY || '';
      if (!apiKey) return;
      const { CorrelationAgent } = await import('./dist/services/correlation-agent.js');
      const agent = new CorrelationAgent(db, palaceClient, apiKey);
      if (agent.isDuplicateWithin24h()) return;
      const digest = await agent.generateDigest();
      if (!digest) return;
      const pairSummary = digest.pairs.slice(0, 3).map(p => `• ${p.topic_a} ↔ ${p.topic_b}`).join('\n');
      const payload = JSON.stringify({
        title: `Nightly correlation: ${digest.pairs.length} topic link${digest.pairs.length !== 1 ? 's' : ''} found`,
        body: pairSummary || 'See full digest for details.',
        pairs: digest.pairs,
        generated_at: digest.generated_at,
      });
      const sourceId = `correlation-${digest.generated_at.slice(0, 10)}`;
      db.prepare(`INSERT INTO proactive_queue (agent, source_id, type, payload)
                  VALUES ('CorrelationAgent', ?, 'nightly_digest', ?)`).run(sourceId, payload);
      process.stderr.write(`[CorrelationAgent] Queued nightly digest: ${digest.pairs.length} pairs\n`);
    }

    if (correlationStale) {
      withAgentTick('CorrelationAgent', runCorrelationAgentTick);
    }
    setInterval(() => withAgentTick('CorrelationAgent', async () => {
      const currentUtcHour = new Date().getUTCHours();
      if (currentUtcHour !== CORRELATION_HOUR) return;
      await runCorrelationAgentTick();
    }), CORRELATION_INTERVAL_MS);
    markAgentReady('CorrelationAgent');
  } catch (err) {
    markAgentCrashed('CorrelationAgent', err);
  }

  // ── Prompt Evolution (every 6h) ──────────────────────────────────────────
  registerAgent('PromptEvolution');
  try {
    const PROMPT_EVOLUTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
    setInterval(() => withAgentTick('PromptEvolution', async () => {
      if (!ANTHROPIC_KEY) return;
      const triggerTypes = OPRO_SWEEP_TRIGGER_TYPES;
      for (const tt of triggerTypes) {
        try {
          await runOPRO(db, tt, ANTHROPIC_KEY);
          checkABPromotion(db, tt);
        } catch (err) {
          process.stderr.write(`[PromptEvolution] ${tt}: ${err.message}\n`);
        }
      }
      process.stderr.write(`[PromptEvolution] Cycle complete for ${triggerTypes.length} trigger types\n`);
    }), PROMPT_EVOLUTION_INTERVAL_MS);
    markAgentReady('PromptEvolution');
  } catch (err) {
    markAgentCrashed('PromptEvolution', err);
  }

  // ── Research cache pruning (every sync tick) ────────────────────────────
  registerAgent('ResearchCachePrune');
  try {
    setInterval(() => withAgentTick('ResearchCachePrune', async () => {
      const pruned = pruneExpiredResearch(db);
      if (pruned > 0) process.stderr.write(`[ResearchCache] Pruned ${pruned} expired entries\n`);
    }), SYNC_INTERVAL_MS);
    markAgentReady('ResearchCachePrune');
  } catch (err) {
    markAgentCrashed('ResearchCachePrune', err);
  }

  // ── Code-graph indexer (60s heartbeat + persisted due_at) ────────────────
  // ADR-027 v2 item #2: replaces the v1 4-hour setInterval + in-tick getDay()
  // gate, which would never fire on most boots because the 4h tick rarely
  // landed in a Sunday 03:00–03:30 window. Now: a 60s dispatcher reads two
  // persisted UTC timestamps from sync_state and runs the work-class that's
  // due. Wall-clock-aligned; the headline Sunday sweep actually fires.
  //
  // Sentinel rows in sync_state (topic_id='0'):
  //   source='code-graph:scheduler:incremental_due_at' → ISO UTC timestamp
  //   source='code-graph:scheduler:full_due_at'        → ISO UTC timestamp
  //
  // Pure ts-morph + SQLite — independent of BrowserSession, so the
  // Teams-blocks-Outlook sync queue hang cannot starve it.
  //
  // ADR-027 v2 item #5: CODE_GRAPH_INDEX_DISABLED=1 short-circuits the agent
  // registration entirely. Useful for the rare case where indexing is wedged
  // and the operator wants to inspect state without it racing manual probes.
  if (process.env.CODE_GRAPH_INDEX_DISABLED === '1') {
    process.stderr.write('[CodeGraphIndexer] disabled via CODE_GRAPH_INDEX_DISABLED=1 — agent not registered\n');
  } else {
  registerAgent('CodeGraphIndexer');
  try {
    const CODE_GRAPH_INTERVAL_MS = Number(process.env.CODE_GRAPH_INTERVAL_MS) || 60 * 60 * 1000; // 1h default (smaller than v1's 4h — heartbeat means we can poll more often)
    const CODE_GRAPH_HEARTBEAT_MS = 60 * 1000;
    const CODE_GRAPH_REPOS = REPOS.map(r => r.name); // derived from configured repos (wi.config.json)

    // Compute the next Sunday 03:17 UTC strictly greater than `now`. UTC, not
    // local — CorrelationAgent already paid for a DST incident; CodeGraphIndexer
    // inherits the wall-clock target without timezone surprises.
    //
    // Implementation extracted to src/services/code-graph/scheduler.ts so the
    // wall-clock semantics can be unit-tested without booting the bridge —
    // tests/code-graph/scheduler.test.ts fast-forwards 4 boot times × 6
    // weekdays (= 24 boot scenarios) and asserts the Sunday-sweep fires
    // exactly once per week. Closes ADR-027 v2 Path B item #2.

    const readDueAt = (kind) => {
      const row = db.prepare(
        `SELECT last_synced_at FROM sync_state WHERE topic_id = ? AND source = ?`
      ).get('0', `code-graph:scheduler:${kind}_due_at`);
      return row && row.last_synced_at ? new Date(row.last_synced_at) : null;
    };
    const writeDueAt = (kind, when) => {
      db.prepare(`
        INSERT INTO sync_state (topic_id, source, last_synced_at, last_message_count)
          VALUES (?, ?, ?, 0)
          ON CONFLICT(topic_id, source) DO UPDATE SET
            last_synced_at = excluded.last_synced_at
      `).run('0', `code-graph:scheduler:${kind}_due_at`, when.toISOString());
    };

    // Initialize due_at rows on first boot. Incremental: now (run immediately
    // after the 30s warmup); Full: next Sunday 03:17 UTC.
    const bootNow = new Date();
    if (!readDueAt('incremental')) {
      writeDueAt('incremental', new Date(bootNow.getTime() + 30_000));
    }
    if (!readDueAt('full')) {
      writeDueAt('full', nextSunday0317UTC(bootNow));
    }

    const runIncremental = async () => {
      const config = new ConfigManager();
      const repos = config.getRepos();
      const indexer = new CodeIndexer(db, repos);
      for (const repoName of CODE_GRAPH_REPOS) {
        const repoCfg = repos.find(r => r.name === repoName);
        if (!repoCfg) {
          process.stderr.write(`[CodeGraphIndexer] Skipping ${repoName}: no config\n`);
          continue;
        }
        if (isCodeGraphBusy(repoName)) {
          process.stderr.write(`[CodeGraphIndexer] Skipping ${repoName}: busy\n`);
          continue;
        }
        try {
          await withCodeGraphLock(repoName, async () => {
            const row = db.prepare(
              `SELECT last_synced_at FROM sync_state WHERE topic_id = ? AND source = ?`
            ).get('0', `code-graph-${repoName}`);
            const sinceMs = row && row.last_synced_at ? Date.parse(row.last_synced_at) : 0;
            const result = await withCodeGraphIndexDeadline(
              indexer.indexChangedSince(repoName, sinceMs),
              `indexChangedSince ${repoName}`,
            );
            if (result.filesProcessed > 0) {
              process.stderr.write(`[CodeGraphIndexer] ${repoName} incremental: files=${result.filesProcessed} +${result.edgesAdded}/-${result.edgesRemoved} ${result.durationMs}ms\n`);
            }
          });
        } catch (err) {
          process.stderr.write(`[CodeGraphIndexer] ${repoName} incremental failed: ${err.message}\n`);
        }
      }
    };

    const runFullSweep = async () => {
      const config = new ConfigManager();
      const repos = config.getRepos();
      const indexer = new CodeIndexer(db, repos);
      // 2026-06-24 — smarten the Sunday cron. The pre-2026-06-24 behaviour
      // was "always do a full sweep on the wall-clock Sunday tick", which
      // re-parses every file in configured repos (~48k files, ~5min wall) even when
      // nothing has changed since the previous incremental tick an hour
      // ago. The cron now skips repos whose last_synced_at is fresher than
      // SUNDAY_FULL_SWEEP_FRESHNESS_MS (default 7d) — anything fresher than
      // that has been kept current by the hourly incremental and a full
      // sweep is wasted work. Set CODE_GRAPH_SUNDAY_FORCE=1 to bypass the
      // freshness check (manual operator override).
      const FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;
      const force = process.env.CODE_GRAPH_SUNDAY_FORCE === '1';
      for (const repoName of CODE_GRAPH_REPOS) {
        const repoCfg = repos.find(r => r.name === repoName);
        if (!repoCfg) continue;
        if (isCodeGraphBusy(repoName)) {
          process.stderr.write(`[CodeGraphIndexer] Sunday sweep skipping ${repoName}: busy\n`);
          continue;
        }
        if (!force) {
          const row = db.prepare(
            `SELECT last_synced_at FROM sync_state WHERE topic_id = ? AND source = ?`,
          ).get('0', `code-graph-${repoName}`);
          if (row && row.last_synced_at) {
            const ageMs = Date.now() - Date.parse(row.last_synced_at);
            if (ageMs >= 0 && ageMs < FRESHNESS_MS) {
              process.stderr.write(
                `[CodeGraphIndexer] Sunday sweep skipping ${repoName}: fresh (age=${Math.round(ageMs / 3600_000)}h < 7d). ` +
                `Override with CODE_GRAPH_SUNDAY_FORCE=1.\n`,
              );
              continue;
            }
          }
        }
        try {
          await withCodeGraphLock(repoName, async () => {
            const result = await withCodeGraphIndexDeadline(
              indexer.indexRepo(repoName),
              `indexRepo ${repoName} (Sunday sweep)`,
            );
            process.stderr.write(`[CodeGraphIndexer] ${repoName} Sunday sweep: files=${result.filesIndexed} edges=${result.edgesAdded} ${result.durationMs}ms\n`);
          });
        } catch (err) {
          process.stderr.write(`[CodeGraphIndexer] ${repoName} Sunday sweep failed: ${err.message}\n`);
        }
      }
    };

    // Heartbeat dispatcher — chooses at most one work-class per tick. Full
    // sweep wins ties because a Sunday tick is a hard wall-clock deadline.
    const dispatcher = async () => {
      const now = new Date();
      const fullDueAt = readDueAt('full');
      const incrementalDueAt = readDueAt('incremental');

      if (fullDueAt && now.getTime() >= fullDueAt.getTime()) {
        await runFullSweep();
        writeDueAt('full', nextSunday0317UTC(now));
        return;
      }
      if (incrementalDueAt && now.getTime() >= incrementalDueAt.getTime()) {
        await runIncremental();
        writeDueAt('incremental', new Date(now.getTime() + CODE_GRAPH_INTERVAL_MS));
      }
    };

    setInterval(() => withAgentTick('CodeGraphIndexer', dispatcher), CODE_GRAPH_HEARTBEAT_MS);
    markAgentReady('CodeGraphIndexer');
  } catch (err) {
    markAgentCrashed('CodeGraphIndexer', err);
  }
  } // end CODE_GRAPH_INDEX_DISABLED guard

  // ── ADR-030 Phase B (Plan 75-04): BugInvestigatorAgent ────────────────────
  // Killswitch via BUG_INVESTIGATOR_ENABLED. Polls every
  // BUG_INVESTIGATOR_INTERVAL_MS (default 5 min) for status='new' bugs that
  // aren't bug-investigator self-noise and have investigation_attempts < 3.
  // Calls Anthropic through the bug-investigator bucket; writes a
  // bug_investigations row; flips bugs.status to 'proposed'.
  if (process.env.BUG_INVESTIGATOR_ENABLED === '0') {
    process.stderr.write('[Bugs] BugInvestigatorAgent disabled via BUG_INVESTIGATOR_ENABLED=0 — agent not registered\n');
  } else if (!analyzer) {
    process.stderr.write('[Bugs] BugInvestigatorAgent skipped — no ANTHROPIC_API_KEY (analyzer is null)\n');
  } else {
    registerAgent('BugInvestigatorAgent');
    try {
      const { BugInvestigatorAgent, createBucketAwareDecideFn } = await import('./dist/intelligence/bug-investigator-agent.js');
      const { bucketCallParams } = await import('./dist/services/model-config.js');
      const intervalMs = Number(process.env.BUG_INVESTIGATOR_INTERVAL_MS) || 5 * 60 * 1000;
      const maxPerHour = Number(process.env.BUG_INVESTIGATOR_MAX_PER_HOUR) || 10;
      // analyzer.client is a private — we re-use its construction by pulling
      // the client off via a lightweight accessor. AIAnalyzer holds the same
      // beta.promptCaching surface we need.
      const investigatorClient = analyzer.getClient();
      const decideFn = createBucketAwareDecideFn(investigatorClient, db, bucketCallParams);
      const investigator = new BugInvestigatorAgent({
        db, palaceClient, bridgeBaseUrl: process.env.BRIDGE_BASE_URL || 'http://localhost:3132',
        decideFn, maxPerHour,
      });
      // First tick after 30s so the bridge boots cleanly first; then every intervalMs.
      setTimeout(() => withAgentTick('BugInvestigatorAgent', () => investigator.tick()), 30_000);
      setInterval(() => withAgentTick('BugInvestigatorAgent', () => investigator.tick()), intervalMs);
      markAgentReady('BugInvestigatorAgent');
      process.stderr.write(`[Bugs] BugInvestigatorAgent registered (interval=${intervalMs}ms, maxPerHour=${maxPerHour})\n`);
    } catch (err) {
      markAgentCrashed('BugInvestigatorAgent', err);
    }
  }

  // ── ADR-030 Phase C (Plan 76-03): BugResolverAgent ────────────────────────
  // Killswitch via BUG_RESOLVER_ENABLED — DEFAULTS TO '0'. The user must
  // explicitly opt in. The agent does NOT poll: it ticks only when the
  // /api/bugs/:id/resolve-attempt route enqueues work via .enqueue(bugId).
  // tick() drains one item per call; we use a 1s heartbeat so the agent
  // shows up healthy in /api/agents/health and queue items get drained
  // promptly when enqueued.
  if (process.env.BUG_RESOLVER_ENABLED !== '1') {
    process.stderr.write('[Bugs] BugResolverAgent disabled (BUG_RESOLVER_ENABLED!=1) — agent not registered, /api/bugs/:id/resolve-attempt returns 400 resolver_disabled\n');
  } else {
    registerAgent('BugResolverAgent');
    try {
      const { BugResolverAgent } = await import('./dist/intelligence/bug-resolver-agent.js');
      bugResolverInstance = new BugResolverAgent({ db });
      // 1s heartbeat — drains one queue item per tick; idle when queue empty.
      setInterval(() => withAgentTick('BugResolverAgent', () => bugResolverInstance.tick()), 1000);
      markAgentReady('BugResolverAgent');
      process.stderr.write('[Bugs] BugResolverAgent registered (BUG_RESOLVER_ENABLED=1)\n');
    } catch (err) {
      markAgentCrashed('BugResolverAgent', err);
    }
  }

  // ── G6-REAPER BugReaperAgent (2026-08-06) ────────────────────────────────
  // Propose-only worker. Polls bugs table for unresolved bugs, dispatches
  // `wi-investigate` via skill-dispatch, writes proposals to `bug_proposals`.
  // Never auto-applies, handles, or mutates existing bug state.
  // Gate: BUG_REAPER_ENABLED=1 (default-off). Start: 30s delay, then every
  // BUG_REAPER_INTERVAL_MS (default 30 min).
  if (process.env.BUG_REAPER_ENABLED !== '1') {
    process.stderr.write('[BugReaper] BugReaperAgent skipped — BUG_REAPER_ENABLED!=1\n');
  } else {
    registerAgent('BugReaperAgent');
    try {
      const { BugReaperAgent } = await import('./dist/services/bug-reaper/agent.js');
      const intervalMs = Number(process.env.BUG_REAPER_INTERVAL_MS) || 30 * 60 * 1000;
      const reaperAgent = new BugReaperAgent({
        db,
        bridgeBaseUrl: process.env.BRIDGE_BASE_URL || 'http://localhost:3132',
      });
      // First tick after 30s so the bridge boots cleanly first; then every intervalMs.
      setTimeout(() => withAgentTick('BugReaperAgent', () => reaperAgent.tick()), 30_000);
      setInterval(() => withAgentTick('BugReaperAgent', () => reaperAgent.tick()), intervalMs);
      markAgentReady('BugReaperAgent');
      process.stderr.write(`[BugReaper] BugReaperAgent registered (interval=${intervalMs}ms)\n`);
    } catch (err) {
      markAgentCrashed('BugReaperAgent', err);
    }
  }

  // ── ADR-040 F2/F3 fix (2026-07-09): BoardWorkerAgent ─────────────────────
  // Ticks every BOARD_WORKER_INTERVAL_MS (default 30s). Heartbeats the
  // 4 workers, advances one `ready`→`in_progress` per tick, advances
  // one `in_progress`→`review` for cards whose Cypher session closed
  // clean, and auto-fires runPanel for cards sitting in `review`
  // without a recent panel_reviews row. Gated on
  // OUTCOME_HONEST_KANBAN_ENABLED=1 (agent no-ops when flag off).
  // Kill-switch via BOARD_WORKER_ENABLED=0 for finer control.
  //
  // BOARD_BLOCK_NOWORK_ENABLED (default 1): step 3 moves a done dispatch
  // that did zero execute-phase work (halted in SCOPE) to the Blocked lane
  // instead of advancing it to `review` — outcome-honesty, no false-positive
  // completes. Set to 0 to restore advance-regardless as a rollback lever.
  //
  // Requires the ADR-040 v90/v91/v92/v93 schema and runPanel from
  // dist/services/cypher/panel.js. Never blocks — all work is
  // sub-100ms SQLite + one runPanel call that already async-fans-out
  // to LLMs behind a cost cap.
  if (process.env.OUTCOME_HONEST_KANBAN_ENABLED !== '1') {
    process.stderr.write('[Board] BoardWorkerAgent skipped — OUTCOME_HONEST_KANBAN_ENABLED!=1\n');
  } else if (process.env.BOARD_WORKER_ENABLED === '0') {
    process.stderr.write('[Board] BoardWorkerAgent disabled via BOARD_WORKER_ENABLED=0\n');
  } else {
    // ADR-038 D3 + ADR-040 F-UI: ensure configured repos projects
    // (from wi.config.json repos list) exist so goal-classified cards never
    // hit a dangling FK. Repos are seeded from the wi.config.json configuration.
    try {
      const { seedCanonicalProjects } = await import('./dist/services/cypher/projects.js');
      seedCanonicalProjects(db);
      const seededNames = ['wi', ...REPOS.map(r => r.name)].join(', ');
      process.stderr.write(`[Board] canonical projects seeded (${seededNames})\n`);
    } catch (err) {
      process.stderr.write(`[Board] project seed failed: ${(err && err.message) || err}\n`);
    }
    registerAgent('BoardWorkerAgent');
    try {
      const { BoardWorkerAgent } = await import('./dist/intelligence/board-worker-agent.js');
      const intervalMs = Number(process.env.BOARD_WORKER_INTERVAL_MS) || 30_000;
      const boardAgent = new BoardWorkerAgent({ db });
      // First tick after 15s so the bridge boots cleanly first; then every intervalMs.
      setTimeout(() => withAgentTick('BoardWorkerAgent', () => boardAgent.tick()), 15_000);
      setInterval(() => withAgentTick('BoardWorkerAgent', () => boardAgent.tick()), intervalMs);
      markAgentReady('BoardWorkerAgent');
      process.stderr.write(`[Board] BoardWorkerAgent registered (interval=${intervalMs}ms)\n`);
    } catch (err) {
      markAgentCrashed('BoardWorkerAgent', err);
    }
  }

  // ── ADR-043 Phase 3 (Shape A) AC-A3/A4: PMAgent ──────────────────────────
  // Backlog-health tenant. NOT a worker — never picks up, dispatches, or
  // mutates intent/kanban_column. Per PM_AGENT_INTERVAL_MS (default 30s) it
  // (1) recomputes computeBacklogRank for observability (writes nothing) and
  // (2) flags stalled=1 on cards in `ready` older than PM_STALL_DAYS
  // (default 14). All sub-100ms SQLite — never blocks the event loop.
  //
  // AC-A4: gated on PM_AGENT_ENABLED=1 (default-off). Rollback = flag=0 +
  // restart. The tick re-checks the flag so a mid-run flip to 0 no-ops the
  // next tick without a restart. Dedup (Q-3) is deferred per the ADR.
  if (process.env.PM_AGENT_ENABLED !== '1') {
    process.stderr.write('[PM] PMAgent skipped — PM_AGENT_ENABLED!=1\n');
  } else {
    registerAgent('PMAgent');
    try {
      const { PMAgent } = await import('./dist/intelligence/pm-agent.js');
      const pmIntervalMs = Number(process.env.PM_AGENT_INTERVAL_MS) || 30_000;
      const stallDays = Number(process.env.PM_STALL_DAYS) || 14;
      const pmAgent = new PMAgent({ db, stallMs: stallDays * 24 * 60 * 60 * 1000 });
      // First tick after 20s (after BoardWorkerAgent's 15s) so boot is clean.
      setTimeout(() => withAgentTick('PMAgent', () => pmAgent.tick()), 20_000);
      setInterval(() => withAgentTick('PMAgent', () => pmAgent.tick()), pmIntervalMs);
      markAgentReady('PMAgent');
      process.stderr.write(
        `[PM] PMAgent registered (interval=${pmIntervalMs}ms, stall=${stallDays}d)\n`,
      );
    } catch (err) {
      markAgentCrashed('PMAgent', err);
    }
  }

  // ── ADR-038 v2.5 D6 follow-up: GC daemon ─────────────────────────────────
  // Periodic ticker that calls runGc(db) once per CYPHER_GC_INTERVAL_MS
  // (default 24h). First tick fires 60s after boot. Kill-switch via
  // CYPHER_GC_DISABLED=1 skips registration. The actual sweep logic
  // lives in src/services/cypher/gc.ts; the daemon just paces it.
  if (process.env.CYPHER_GC_DISABLED === '1') {
    process.stderr.write('[GcDaemon] disabled via CYPHER_GC_DISABLED=1 — daemon not registered\n');
  } else {
    registerAgent('GcDaemon');
    try {
      const { startGcDaemon } = await import('./dist/services/cypher/gc-daemon.js');
      const handle = startGcDaemon(db);
      markAgentReady('GcDaemon');
      process.stderr.write(`[GcDaemon] registered (intervalMs=${handle.intervalMs})\n`);
    } catch (err) {
      markAgentCrashed('GcDaemon', err);
    }
  }

  // ── ADR-032 Phase 80 wave 77a-01: Tier-0 tsconfig parser (boot-once) ─────
  // The vertical slice runs the parser ONCE at boot when the kill switch is
  // on, then sleeps. No agent ticking — Tier-0 sources change at deploy
  // time, not runtime, so a continuous heartbeat is wasteful. PERSONA-A-01
  // / A-03 / A-05 acceptance comes from this single boot run plus the
  // smoke § 17a-thin scenario that exercises a synthetic config-change.
  // INGEST is gated by a separate flag (PERSONA_MEMORY_INGEST_ENABLED) and
  // ships in 77a-04 — capture-only path is silent here.
  if (!PERSONA_MEMORY_TIER0_ENABLED) {
    process.stderr.write('[Persona] Tier-0 parser skipped — PERSONA_MEMORY_TIER0_ENABLED=0\n');
  } else {
    try {
      const { parseTsconfigRules, syncTsconfigRules } = await import('./dist/services/persona/parse-tsconfig.js');
      const repoRoot = process.cwd();
      const rules = parseTsconfigRules(repoRoot);
      // palace may be null when MEMPALACE_PATH is unset — sync writes
      // SQL-only in that case (recall.ts falls through to rule_cards rows).
      const palaceForPersona = (typeof palaceClient !== 'undefined' ? palaceClient : null);
      // Fire-and-forget — never block boot on persona writes.
      syncTsconfigRules(db, palaceForPersona, rules)
        .then((res) => {
          process.stderr.write(
            `[Persona] Tier-0 boot run: emitted=${res.emitted} retired=${res.retired} ` +
              `errors=${res.errors.length}\n`,
          );
          if (res.errors.length > 0) {
            for (const e of res.errors.slice(0, 3)) process.stderr.write(`[Persona]   - ${e}\n`);
          }
        })
        .catch((err) => {
          process.stderr.write(`[Persona] Tier-0 boot run failed: ${err && err.message ? err.message : err}\n`);
        });
    } catch (err) {
      process.stderr.write(`[Persona] Tier-0 import failed: ${err && err.message ? err.message : err}\n`);
    }
  }

  // Phase 82b: skill discovery scan. Off the boot critical path —
  // bridge serves /api/status before this completes. Default-on; flip
  // WI_SKILL_DISCOVERY=0 to skip (e.g. test rigs that mock the catalog).
  if (process.env.WI_SKILL_DISCOVERY !== '0') {
    try {
      const { discoverSkills } = await import('./dist/services/cypher/skill-discovery.js');
      // Fire-and-forget — never block boot.
      Promise.resolve()
        .then(() => discoverSkills(db))
        .then((res) => {
          process.stderr.write(
            `[skill-discovery] Scanned ${res.scanned} SKILL.md, ${res.inserted} new, ${res.updated} updated, ${res.pruned} pruned, ${res.errors.length} errors (${res.duration_ms} ms)\n`,
          );
          // Explicit line when prune fires — silent pruning is fine on a
          // healthy install, but a surprise prune on a live system means the
          // operator should look at what disappeared (disk mount blip, an
          // accidental rm, etc.). Cheap observability, expensive to add later.
          if (res.pruned > 0) {
            process.stderr.write(
              `[skill-discovery] pruned rows: ${res.pruned_names.join(', ')}\n`,
            );
          }
          if (res.errors.length > 0) {
            for (const e of res.errors.slice(0, 3)) process.stderr.write(`[skill-discovery]   - ${e.path}: ${e.error}\n`);
          }
        })
        .then(async () => {
          // v98: backfill/refresh prompt_memory (learned prompt→skill
          // recognition for the SCOPE refiner). Ollama-gated no-op when down.
          try {
            const { embedPromptMemory } = await import('./dist/services/embedder.js');
            const e = await embedPromptMemory(db);
            process.stderr.write(`[prompt-memory] embedded ${e.indexed}, skipped ${e.skipped}\n`);
          } catch (err) {
            process.stderr.write(`[prompt-memory] embed failed (non-fatal): ${err && err.message ? err.message : err}\n`);
          }
        })
        .then(async () => {
          // v101 (ADR-042 Gap 2): backfill/refresh doc_embeddings — the ADR /
          // architecture / epic corpus for Stage-1 recognition. Ollama-gated
          // no-op when down; incremental (only sha256-changed files re-embed).
          // One await embed() per file is loop-yielding I/O, so this is safe
          // fire-and-forget at boot without a worker (CLAUDE.md never-block).
          try {
            const { embedDocs } = await import('./dist/services/embedder.js');
            const d = await embedDocs(db, process.cwd());
            process.stderr.write(`[doc-embeddings] embedded ${d.indexed}, skipped ${d.skipped}, unchanged ${d.unchanged}\n`);
          } catch (err) {
            process.stderr.write(`[doc-embeddings] embed failed (non-fatal): ${err && err.message ? err.message : err}\n`);
          }
        })
        .then(async () => {
          // ADR-051 Option A § Follow-up item 3 — skill-registry drift check.
          // Compares Inventory A (SKILL_ROUTES) vs Inventory B (skill_catalog
          // wi-*), reports drift beyond the known carve-outs. Opt-out via
          // WI_SKILL_DRIFT_CHECK=0 (default ON — cheap SQL diff, no I/O).
          if (process.env.WI_SKILL_DRIFT_CHECK !== '0') {
            try {
              const { checkSkillRegistryDrift, formatDriftSummary } = await import(
                './dist/services/cypher/skill-registry-drift.js'
              );
              const report = checkSkillRegistryDrift(db);
              process.stderr.write(`${formatDriftSummary(report)}\n`);
            } catch (err) {
              process.stderr.write(
                `[skill-drift] check failed (non-fatal): ${err && err.message ? err.message : err}\n`,
              );
            }
          }
        })
        .catch((err) => {
          process.stderr.write(`[skill-discovery] scan failed: ${err && err.message ? err.message : err}\n`);
        });
    } catch (err) {
      process.stderr.write(`[skill-discovery] import failed: ${err && err.message ? err.message : err}\n`);
    }
  }

  // Final boot summary — counts by status.
  const all = getAgentHealthSnapshot();
  const summary = all.reduce((acc, a) => {
    acc[a.status] = (acc[a.status] || 0) + 1; return acc;
  }, {});
  const ADR_053_ENABLED = process.env.ADR_053_ENABLED === '1';
  process.stderr.write(`[adr-053] PM orchestration ${ADR_053_ENABLED ? 'enabled' : 'disabled'}\n`);
  process.stderr.write(`[Agents] Boot complete: ${all.length} agents — ${JSON.stringify(summary)}\n`);

  // post-graphify step 2: probe Ollama once + fire-and-forget warmup so the
  // first chat doesn't get truncated by the 2–5s cold-start inside its
  // 500ms timeout race.
  void (async () => {
    try {
      await probeEmbeddingEnabled();
      process.stderr.write(`[Embeddings] enabled=${_embeddingEnabled}\n`);
      if (_embeddingEnabled) {
        const { embed } = await import('./dist/services/embedder.js');
        embed('warmup').catch(() => {}); // fire-and-forget; never throws
      }
    } catch {
      // best effort — never crash boot on embedding probe failure
    }
  })();
}, 5_000); // 5s delay — let the server fully boot before starting watchers


