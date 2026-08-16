/**
 * Evidence-gathering library for ADR-030 Phase B (Plan 75-02).
 *
 * Composes four sources into a `BugEvidence` blob the BugInvestigatorAgent
 * (Plan 75-03) hands to the brain:
 *   1. Stack trace (top 20 lines from BugRow.context_json or the row itself)
 *   2. git log --follow --max-count=10 on the file extracted from top_frame
 *   3. /api/code-graph/blast-radius for that file
 *   4. recallMemory({ pattern: fingerprint OR error_name })
 *
 * Best-effort everywhere. Every external call is wrapped in try/catch;
 * failures degrade to empty arrays / null. The function NEVER throws — the
 * agent must always have *something* to send to the brain even if every
 * external source is offline.
 *
 * The function is "pure-ish": it does fs (via execFileSync git) and HTTP
 * (via fetch for blast-radius) but writes nothing. Test surface is the
 * same — inject mocks for both fns. The agent calls it directly without
 * mocking.
 *
 * Refs: docs/docs/adr/adr-030-self-healing-bug-loop.md § Phase B,
 *       .planning/phases/75-adr-030-phase-b-bug-investigator/PLAN.md § 75-02
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type {
  BugRow,
  BugEvidence,
  BugGitLogEntry,
  BugBlastRadius,
  BugRecallHit,
} from '../../types/bugs.js';
import { recallMemory } from '../brain/recall.js';
import type { PalaceClient } from '../../intelligence/palace-client.js';
import { getWiConfig } from '../wi-config.js';

const execFileP = promisify(execFile);

export type BugRepo = string;

export interface FileResolution {
  repo: BugRepo;
  file: string;          // path RELATIVE to the repo root
  absoluteRepoBase: string; // absolute fs path to the repo (for git -C)
}

export interface GatherEvidenceArgs {
  db: Database.Database;
  bug: BugRow;
  palaceClient: PalaceClient | null;
  /** Bridge base URL — usually `http://localhost:3132`. */
  bridgeBaseUrl: string;
  /**
   * Override the four roots used for repo resolution. Defaults match the
   * standard CLAUDE.md layout (REPO_PATH / OPERATIONS_PATH / cwd).
   */
  repoBases?: Record<string, string>;
  /** Test override — defaults to runGitLog. */
  gitLogFn?: (resolution: FileResolution) => Promise<BugGitLogEntry[]>;
  /** Test override — defaults to fetchBlastRadius. */
  blastRadiusFn?: (bridgeBaseUrl: string, repo: BugRepo, file: string) => Promise<BugBlastRadius | null>;
  /** Test override — defaults to recallSimilar. */
  recallFn?: (db: Database.Database, palace: PalaceClient | null, bug: BugRow) => Promise<BugRecallHit[]>;
}

const STACK_LINES_TO_KEEP = 20;
const GIT_LOG_MAX_COUNT = 10;
const RECALL_LIMIT_PER_PATTERN = 5;
const RECALL_FINAL_LIMIT = 5;

// ── exported helpers (testable) ─────────────────────────────────────────────

/**
 * Parse a top_frame like "src/routes/pr.ts:89" or
 * "repos/<name>/lib/foo.ts:42" into a (repo, file) pair.
 *
 * Returns null when:
 *  - top_frame is null (no application frame in the stack)
 *  - top_frame doesn't look like a file:line (e.g. "<anonymous>")
 */
export function fileFromTopFrame(
  topFrame: string | null,
  repoBases?: Record<string, string>,
): FileResolution | null {
  if (!topFrame) return null;

  // Strip the trailing :line[:col] so we get the file path.
  const m = topFrame.match(/^(.+?):\d+(?::\d+)?$/);
  const filePath = m ? m[1] : topFrame;
  if (!filePath || !filePath.includes('/')) return null;

  const bases = repoBases ?? defaultRepoBases();

  // Detect repo by prefix — scan configured repos
  let repo: BugRepo = 'work-intelligence-mcp';
  let file = filePath;
  let absoluteRepoBase = bases['wi'] ?? process.cwd();

  const prefixMatch = filePath.match(/^repos\/([^/]+)\//);
  if (prefixMatch) {
    const candidate = prefixMatch[1];
    if (bases[candidate]) {
      repo = candidate;
      file = filePath.slice(`repos/${candidate}/`.length);
      absoluteRepoBase = bases[candidate];
    }
  }

  // Defensive — leading slashes from absolute paths in the stack.
  if (file.startsWith('/')) file = file.slice(1);

  return { repo, file, absoluteRepoBase };
}

function defaultRepoBases(): Record<string, string> {
  const bases: Record<string, string> = {
    wi: process.cwd(),
    ...(process.env.REPO_PATH ? { workspace: process.env.REPO_PATH } : {}),
    ...(process.env.OPERATIONS_PATH ? { operations: process.env.OPERATIONS_PATH } : {}),
  };
  try {
    const repos = getWiConfig().repos ?? [];
    for (const r of repos) {
      if (!bases[r.name] && r.localPath) {
        bases[r.name] = r.localPath;
      }
    }
  } catch {
    // wi.config.json missing
  }
  return bases;
}

/**
 * Run `git log --follow --max-count=10` for the given file in its repo.
 * Returns [] on any error (file not in git, repo doesn't exist, git missing).
 */
export async function runGitLog(resolution: FileResolution): Promise<BugGitLogEntry[]> {
  if (!existsSync(resolution.absoluteRepoBase)) return [];
  try {
    const { stdout } = await execFileP(
      'git',
      [
        '-C', resolution.absoluteRepoBase,
        'log',
        '--follow',
        `--max-count=${GIT_LOG_MAX_COUNT}`,
        '--pretty=format:%H|%an|%aI|%s',
        '--',
        resolution.file,
      ],
      { timeout: 5000, maxBuffer: 1 * 1024 * 1024 },
    );
    return stdout
      .split('\n')
      .filter(line => line.length > 0)
      .map((line): BugGitLogEntry | null => {
        const parts = line.split('|');
        if (parts.length < 4) return null;
        return {
          sha: parts[0]!.slice(0, 12),
          author: parts[1]!,
          date: parts[2]!,
          subject: parts.slice(3).join('|'),
        };
      })
      .filter((e): e is BugGitLogEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * Fetch /api/code-graph/blast-radius for the file. Returns null on any error.
 */
export async function fetchBlastRadius(
  bridgeBaseUrl: string,
  repo: BugRepo,
  file: string,
): Promise<BugBlastRadius | null> {
  try {
    const url = new URL('/api/code-graph/blast-radius', bridgeBaseUrl);
    url.searchParams.set('repo', repo);
    url.searchParams.set('file', file);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { edges?: Array<{ ref_type: string; src_file: string; dst_file: string }> };
    const edges = Array.isArray(body.edges) ? body.edges : [];
    return { repo, file, edges, edgeCount: edges.length };
  } catch {
    return null;
  }
}

/**
 * Run two recall queries (fingerprint then error_name), merge by id,
 * return top N. Wraps recallMemory; failures degrade to [].
 */
export async function recallSimilar(
  db: Database.Database,
  palace: PalaceClient | null,
  bug: BugRow,
): Promise<BugRecallHit[]> {
  const patterns = [bug.fingerprint, bug.error_name].filter(p => p.length > 0);
  const seen = new Map<string, BugRecallHit>();

  for (const pattern of patterns) {
    try {
      const results = await recallMemory({
        db,
        // recallMemory accepts string|null|undefined for palace via cast — its
        // internal code guards on .isConnected before calling.
        palace: (palace as unknown) as Parameters<typeof recallMemory>[0]['palace'],
        pattern,
        limit: RECALL_LIMIT_PER_PATTERN,
      });
      for (const r of results) {
        const key = `${r.source}:${r.id}`;
        if (!seen.has(key)) {
          seen.set(key, {
            source: r.source,
            id: r.id,
            snippet: r.snippet,
            confidence: r.confidence,
            score: r.score,
          });
        }
      }
    } catch {
      // swallow per-pattern; the other pattern may still succeed
    }
  }

  // Sort by score desc, take top RECALL_FINAL_LIMIT.
  return [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, RECALL_FINAL_LIMIT);
}

// ── orchestrator ─────────────────────────────────────────────────────────────

/**
 * Build the BugEvidence blob for one bug. NEVER throws.
 *
 * Calls the four sources concurrently. Each source is independently
 * try/catched at the leaf; this function adds an outer catch as a final
 * safety net. The agent's contract is that gatherEvidence resolves —
 * it can resolve to a near-empty BugEvidence in the worst case.
 */
export async function gatherEvidence(args: GatherEvidenceArgs): Promise<BugEvidence> {
  const empty: BugEvidence = {
    stack: null,
    topFrame: args.bug.top_frame,
    gitLog: [],
    blastRadius: null,
    recall: [],
  };

  try {
    const stack = extractStack(args.bug);
    const resolution = fileFromTopFrame(args.bug.top_frame, args.repoBases);

    // Run the three external sources in parallel.
    const [gitLog, blastRadius, recall] = await Promise.all([
      resolution
        ? (args.gitLogFn ?? runGitLog)(resolution).catch(() => [] as BugGitLogEntry[])
        : Promise.resolve([] as BugGitLogEntry[]),
      resolution
        ? (args.blastRadiusFn ?? fetchBlastRadius)(args.bridgeBaseUrl, resolution.repo, resolution.file).catch(() => null)
        : Promise.resolve(null),
      (args.recallFn ?? recallSimilar)(args.db, args.palaceClient, args.bug).catch(() => [] as BugRecallHit[]),
    ]);

    return {
      stack,
      topFrame: args.bug.top_frame,
      gitLog,
      blastRadius,
      recall,
    };
  } catch {
    return empty;
  }
}

function extractStack(bug: BugRow): string | null {
  // Phase A captures the raw stack inside context_json when the route
  // payload included it. We don't store the stack as its own column.
  if (!bug.context_json) return null;
  try {
    const ctx = JSON.parse(bug.context_json) as { stack?: unknown };
    if (typeof ctx.stack === 'string' && ctx.stack.length > 0) {
      return ctx.stack.split('\n').slice(0, STACK_LINES_TO_KEEP).join('\n');
    }
    return null;
  } catch {
    return null;
  }
}
