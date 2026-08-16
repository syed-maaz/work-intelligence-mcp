import Anthropic from '@anthropic-ai/sdk';
import type { Database } from 'better-sqlite3';
import { bucketCallParams } from '../services/model-config.js';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  createInvestigationSession,
  appendReActTrace,
  completeInvestigation,
  getInvestigationSession,
  findSimilarInvestigation,
  getArchitectureKnowledge,
  type ReActEntry as DbReActEntry,
  type PastInvestigation,
} from '../db/queries/investigation.js';
import {
  createHypothesisAccuracy,
  upsertToolEffectiveness,
} from '../db/queries/investigation.js';
import { extractRegressionDate, type RegressionDateResult } from './regression-date-extractor.js';
import { gitLogWindow, type GitLogWindowInput } from './tools/git-log-window.js';
import { type OwnershipEntry } from './ownership-map.js';
import { dispatchResearchTool, type ToolContext } from './research-tools.js';
import { extractAndSaveBugPattern } from './pattern-extractor.js';
import { PalaceClient } from './palace-client.js';
import {
  SKILL_INVESTIGATION_JSON_SCHEMA,
  parseSkillInvestigationResult,
  type SkillInvestigationFinding,
} from './skill-output-schema.js';
import { defaultRepoName, repoDisplayNames } from './repo-names.js';

// ---------------------------------------------------------------------------
// Investigation Orchestrator — Phase 55 Wave 4 full implementation
// ---------------------------------------------------------------------------

export interface InvestigationInput {
  issueKey:        string;
  title:           string;
  description:     string;
  status:          string;
  assignee:        string | null;
  createdAt:       string;  // ISO date
  chatHypotheses?: Array<{ timestamp: string; raw: string; artifact?: string }>;
}

export interface InvestigationReport {
  // Required by completeInvestigation (InvestigationReport from db/queries)
  hypothesis:                  string;
  conclusion:                  string;
  confidence:                  number;
  ownerTeam:                   string;
  regressionDate?:             string | null;
  regressionDateConfidence?:   string;
  reportJson?:                 unknown;

  // Extended fields stored in reportJson
  rootCauseType:   string;
  isExternalDep:   boolean;
  fixOwner:        string;
  rootCause:       string;
  nextAction:  string;
  proposedFix:     string | null;
  evidence:        EvidenceEntry[];
  reactTrace:      ReActEntry[];
  issueKey:        string;
}

export interface ReActEntry {
  iteration:   number;
  thought:     string;
  tool:        string;
  toolInput:   Record<string, unknown>;
  observation: string;
}

export interface ConcludeInput {
  rootCauseType:  string;
  isExternalDep:  boolean;
  fixOwner:       string;
  confidence:     number;
  rootCause:      string;
  nextAction: string;
  proposedFix:    string | null;
  evidence:       EvidenceEntry[];
}

export interface EvidenceEntry {
  type:        string;
  description: string;
  file?:       string;
  sha?:        string;
}

// ---------------------------------------------------------------------------
// Tool definitions for Claude API
// ---------------------------------------------------------------------------

export const INVESTIGATION_TOOLS: Anthropic.Tool[] = [
  {
    name: 'git_log_window',
    description: 'Fetch git commits in a date range. ALWAYS call this first for regression bugs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:  { type: 'string', enum: repoDisplayNames(), description: 'Which repo to query' },
        since: { type: 'string', description: 'Start date YYYY-MM-DD' },
        until: { type: 'string', description: 'End date YYYY-MM-DD' },
      },
      required: ['repo', 'since', 'until'],
    },
  },
  {
    name: 'get_dep_diff',
    description: 'Compare package.json before/after a commit SHA to find dependency version changes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fromSha: { type: 'string', description: 'Parent commit SHA' },
        toSha:   { type: 'string', description: 'Commit SHA after the change' },
        repo:    { type: 'string', enum: repoDisplayNames(), description: 'Which repo' }
      },
      required: ['fromSha', 'toSha', 'repo'],
    },
  },
  {
    name: 'trace_call_graph',
    description: 'Trace the call/import graph from a starting file to find cross-repo boundaries and ownership.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:      { type: 'string', description: 'Repo name (configured repos)' },
        startFile: { type: 'string', description: 'Relative file path, e.g. apps/recommended-links/useRecommendedLinks.ts' },
        direction: { type: 'string', enum: ['callers', 'callees', 'both'], description: 'Which direction to trace' },
        maxDepth:  { type: 'number', description: 'Maximum traversal depth (default 3, max 5)' },
      },
      required: ['repo', 'startFile', 'direction', 'maxDepth'],
    },
  },
  {
    name: 'read_file',
    description: 'Read lines from a file in a repo. Use after identifying specific files via grep_code or trace_call_graph.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file:     { type: 'string', description: 'Relative file path within the repo' },
        repo:     { type: 'string', description: 'Repo name (configured repos)' },
        maxLines: { type: 'number', description: 'Max lines to read, default 400, hard cap 500' },
      },
      required: ['file', 'repo', 'maxLines'],
    },
  },
  {
    name: 'grep_code',
    description: 'Search for a regex pattern across all TypeScript files in a repo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex or literal string to search for' },
        repo:    { type: 'string', description: 'Repo to search (default: configured primary repo)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_files',
    description: 'List files/directories in a repo path. Use to discover monorepo structure before grep or read_file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:    { type: 'string', description: 'Repo name (configured repos)' },
        subPath: { type: 'string', description: 'Sub-path within repo (e.g. "components" or "components/ui-react-shell/src/models/recommend-links")' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'get_ownership',
    description: 'Look up the team that owns a file path in a repo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string', description: 'Relative file path' },
        repo: { type: 'string', description: 'Repo name (default: configured primary repo)' },
      },
      required: ['file'],
    },
  },
  {
    name: 'get_architecture',
    description: 'Retrieve architecture documentation for a specific area of the codebase.',
    input_schema: {
      type: 'object' as const,
      properties: {
        area: { type: 'string', description: 'Area name to look up (e.g. auth, api, recommended-links)' },
      },
      required: ['area'],
    },
  },
  {
    name: 'get_flag_diff',
    description: 'Show feature flag status changes in the config/infra repo between two dates. REQUIRED before concluding config-change root cause. Also useful for any regression where the timeline suggests an infrastructure or cluster configuration change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        since: { type: 'string', description: 'Start date YYYY-MM-DD (use 3 days before regression date)' },
        until: { type: 'string', description: 'End date YYYY-MM-DD (use 3 days after regression date)' },
      },
      required: ['since', 'until'],
    },
  },
  {
    name: 'call_claude_code',
    description: 'Spawn a Claude Code subprocess for deep codebase research. Use when you need cross-file reasoning, architecture tracing, or blast radius analysis that grep alone cannot answer. Budget: $0.30.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'Specific research question to investigate in the codebase' },
        focus_repo: { type: 'string', description: 'Repo to focus on (optional, defaults to all configured repos)' },
      },
      required: ['question'],
    },
  },
  {
    name: 'conclude',
    description: 'Record final investigation conclusion. Call when confidence >= 0.8 or all relevant tools exhausted.',
    input_schema: {
      type: 'object' as const,
      properties: {
        rootCauseType:  { type: 'string', enum: ['dep-upgrade', 'code-regression', 'config-change', 'external-service', 'unknown'], description: 'Classification of root cause' },
        isExternalDep:  { type: 'boolean', description: 'True if the fix belongs to an external team' },
        fixOwner:       { type: 'string', description: 'Team responsible for the fix' },
        confidence:     { type: 'number', description: '0.0 to 1.0 confidence score' },
        rootCause:      { type: 'string', description: 'Concise description of the root cause' },
        nextAction: { type: 'string', description: 'What the team should do (e.g. "escalate to external team", "fix in apps/auth", "add defensive check")' },
        proposedFix:    { type: 'string', nullable: true, description: 'Specific file + change if Saturn owns the fix, null if external team must fix' },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type:        { type: 'string', description: 'Evidence category (dep-diff, git-commit, code-read, call-graph, ownership, pattern-match)' },
              description: { type: 'string', description: 'Human-readable description of this evidence' },
              file:        { type: 'string', description: 'Relevant file path if applicable' },
              sha:         { type: 'string', description: 'Relevant commit SHA if applicable' },
            },
            required: ['type', 'description'],
          },
          description: 'List of supporting evidence entries',
        },
      },
      required: ['rootCauseType', 'isExternalDep', 'fixOwner', 'confidence', 'rootCause', 'nextAction', 'evidence'],
    },
  },
];

// ---------------------------------------------------------------------------
// Simple grep wrapper used by dispatchTool
// Uses grep -r (always available in Node's PATH) with --exclude-dir flags.
// BUG-32: rg is a Claude Code shell alias, not a real binary — execFileSync
//   gets ENOENT when spawned from Node.  Every call silently returned "No matches".
// BUG-33: repoPath must be the clean ./repos/<repo> copy, not the live
//   checkout path. The live checkout is large (node_modules) — grep
//   exceeds the 10s timeout.  ./repos/<name> was rsynced without node_modules
//   so grep finishes in <3s.
// ---------------------------------------------------------------------------

export function grepCode(pattern: string, repoPath: string): string {
  try {
    const output = execFileSync('grep', [
      '-rl',
      '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.jsx',
      '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude-dir=build',
      '--exclude-dir=coverage', '--exclude-dir=.git', '--exclude-dir=playwright',
      '--exclude-dir=reports', '--exclude-dir=.turbo',
      '--', pattern, repoPath,
    ], { encoding: 'utf8', timeout: 20_000 });
    const files = output.split('\n').filter(Boolean).slice(0, 20);
    if (files.length === 0) return `No matches in ${repoPath} for ${pattern}`;
    return `Found in ${files.length} file(s):\n${files.map(f => f.replace(repoPath + '/', '')).join('\n')}`;
  } catch (err) {
    // grep exits with code 1 when there are no matches — that is not an error
    const execErr = err as NodeJS.ErrnoException & { status?: number; stdout?: string };
    if (execErr.status === 1) return `No matches in ${repoPath} for ${pattern}`;
    return `grep error: ${execErr.message?.slice(0, 100) ?? 'unknown'}`;
  }
}

// ---------------------------------------------------------------------------
// Feature flag diff helper — used by get_flag_diff tool
// ---------------------------------------------------------------------------

interface FlagChange {
  flag:    string;
  from:    string;
  to:      string;
  date?:   string;
  author?: string;
}

function getFlagStatusDiff(repoPath: string, fromSha: string, toSha: string): FlagChange[] {
  const showFile = (sha: string): string => {
    try {
      return execFileSync('git', ['-C', repoPath, 'show', `${sha}:cluster-setup/feature-flags.yaml`],
        { encoding: 'utf8', timeout: 10_000 });
    } catch { return ''; }
  };

  const parseStatuses = (yaml: string): Map<string, string> => {
    const map = new Map<string, string>();
    let currentFlag = '';
    for (const line of yaml.split('\n')) {
      const flagMatch = line.match(/^(FF_RM_\w+):/);
      if (flagMatch) { currentFlag = flagMatch[1]; continue; }
      const statusMatch = line.match(/^\s+Status:\s+(.+)$/);
      if (statusMatch && currentFlag) { map.set(currentFlag, statusMatch[1].trim()); }
    }
    return map;
  };

  const before = parseStatuses(showFile(fromSha));
  const after  = parseStatuses(showFile(toSha));

  const changes: FlagChange[] = [];
  for (const [flag, toStatus] of after.entries()) {
    const fromStatus = before.get(flag);
    if (!fromStatus) {
      changes.push({ flag, from: '(new)', to: toStatus });
    } else if (fromStatus !== toStatus) {
      changes.push({ flag, from: fromStatus, to: toStatus });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Skill loader — reads SKILL.md from ~/.claude/skills/work-intelligence/<name>/
// Returns the body text (strips YAML frontmatter) or undefined if not found.
// ---------------------------------------------------------------------------

function loadSkillPrompt(skillName: string): string | undefined {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const skillPath = join(home, '.claude', 'skills', 'work-intelligence', skillName, 'SKILL.md');
  try {
    const raw = readFileSync(skillPath, 'utf8');
    // Strip YAML frontmatter (--- ... ---) and return the body
    const match = raw.match(/^---[\s\S]*?---\n([\s\S]*)$/);
    return match ? match[1].trim() : raw.trim();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// InvestigationOrchestrator
// ---------------------------------------------------------------------------

export class InvestigationOrchestrator {
  private readonly MAX_ITERATIONS = 8;

  // searchPaths: clean repo copies (no node_modules) used for grep + file reads.
  // repoPaths:   live git checkouts with full .git history used for git commands.
  // BUG-33: these must be separate — env checkout paths (large, with node_modules) cause
  //   grep to time out; ./repos/<name> (rsync copy, no node_modules) is fast.
  private searchPaths: Record<string, string>;

  constructor(
    private client:       Anthropic,
    private db:           Database,
    private repoPaths:    Record<string, string>,
    private ownershipMap: OwnershipEntry[],
    searchPaths?: Record<string, string>,
    private palace?:      PalaceClient
  ) {
    this.searchPaths = searchPaths ?? Object.fromEntries(
      repoDisplayNames().map(name => [name, `./repos/${name}`])
    );
  }

  async investigate(input: InvestigationInput): Promise<InvestigationReport> {
    // 1. Extract regression date
    const regDate = extractRegressionDate(input.title, input.description, input.createdAt);

    // 2. Load Layer 1 context (architecture snapshot + ownership summary)
    const architectureContext = getArchitectureKnowledge(this.db, defaultRepoName(), 2000);
    const ownershipSummary    = this.buildOwnershipSummary();

    // 3. Check for past pattern match first (skip loop if found)
    const priorMatch = findSimilarInvestigation(this.db, this.extractKeywords(input.title));
    if (priorMatch && priorMatch.confidence >= 0.75) {
      return this.buildPatternMatchReport(input, priorMatch);
    }

    // 3b. [Wave 2] Query palace for semantic recall + KG context
    const palaceContext = await this.queryPalaceMemory(input, regDate);

    // 4. Persist session as 'running'
    createInvestigationSession(this.db, input.issueKey, regDate.date, regDate.confidence);

    // 5. Build system prompt with Layer 1 knowledge + palace context
    const systemPrompt = this.buildSystemPrompt(architectureContext, ownershipSummary, input, regDate, palaceContext);

    // 6. Run ReAct loop
    // Seed an initial user message so the messages array is never empty
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: `Begin investigation of ${input.issueKey}: ${input.title}. Follow the investigation rules in the system prompt.` },
    ];
    const reactTrace: ReActEntry[] = [];
    let iteration = 0;
    let finalReport: InvestigationReport | null = null;

    try {
    while (iteration < this.MAX_ITERATIONS) {
      iteration++;

      const CALL_TIMEOUT_MS = 45_000;
      const invBucketParams = bucketCallParams(this.db, 'dispatch', 1024);
      const response = await Promise.race([
        this.client.messages.create({
          ...invBucketParams,
          system: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' },
            } as Anthropic.TextBlockParam & { cache_control: { type: 'ephemeral' } },
          ],
          tools:       INVESTIGATION_TOOLS,
          tool_choice: { type: 'auto' },
          messages,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Claude API call timed out after 45s')), CALL_TIMEOUT_MS)
        ),
      ]);

      // Extract all tool use blocks — model may call multiple tools in parallel
      const allToolUses = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
      const textBlock   = response.content.find(b => b.type === 'text')        as Anthropic.TextBlock | undefined;

      if (allToolUses.length === 0) {
        // Model produced text without tool call — treat as final answer if confident
        reactTrace.push({ iteration, thought: textBlock?.text ?? '', tool: 'none', toolInput: {}, observation: 'No tool called' });
        break;
      }

      // Dispatch all tools in parallel — every tool_use MUST have a tool_result in the next message
      const toolResults = await Promise.all(
        allToolUses.map(async (toolUse) => {
          let observation: string;
          try {
            observation = await this.dispatchTool(toolUse.name, toolUse.input);
          } catch (err) {
            observation = `Tool error: ${(err as Error).message}`;
          }
          return { toolUse, observation };
        })
      );

      // Persist trace entries for each tool call
      for (const { toolUse, observation } of toolResults) {
        reactTrace.push({
          iteration,
          thought:   textBlock?.text ?? '',
          tool:      toolUse.name,
          toolInput: toolUse.input as Record<string, unknown>,
          observation,
        });
        appendReActTrace(this.db, input.issueKey, reactTrace[reactTrace.length - 1] as DbReActEntry);
      }

      // Append to message history — assistant message + ALL tool results in one user message
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role:    'user',
        content: toolResults.map(({ toolUse, observation }) => ({
          type:        'tool_result' as const,
          tool_use_id: toolUse.id,
          content:     observation,
        })),
      });

      // Check if any conclude tool was called
      const concludeResult = toolResults.find(({ toolUse }) => toolUse.name === 'conclude');
      if (concludeResult) {
        const concludeInput = concludeResult.toolUse.input as ConcludeInput;

        // [Wave 4] Conclude gate: block config/dep/external-service without operations check
        const GATE_TYPES = ['config-change', 'dep-upgrade', 'external-service'];
        const hasOperationsCheck = reactTrace.some(e =>
          (e.tool === 'git_log_window' && (e.toolInput as Record<string, unknown>)['repo'] !== defaultRepoName()) ||
          e.tool === 'get_flag_diff'
        );

        if (GATE_TYPES.includes(concludeInput.rootCauseType) && !hasOperationsCheck) {
          // Reject conclude — remove the normal messages pushed above, then inject gate-modified versions
          messages.pop(); // remove user tool_result message (lines 438-445)
          messages.pop(); // remove assistant message (line 437)
          messages.push({ role: 'assistant', content: response.content });
          messages.push({
            role:    'user',
            content: toolResults.map(({ toolUse, observation }) => {
              if (toolUse.name === 'conclude') {
                return {
                  type:        'tool_result' as const,
                  tool_use_id: toolUse.id,
                  content:     `GATE: Cannot conclude '${concludeInput.rootCauseType}' without a config/infra repo check. ` +
                               `Call get_flag_diff(since="<regDate-3d>", until="<regDate+3d>") first, then re-conclude.`,
                };
              }
              return { type: 'tool_result' as const, tool_use_id: toolUse.id, content: observation };
            }),
          });
          // Record gate fire in trace
          reactTrace.push({
            iteration,
            thought:   'CONCLUDE GATE FIRED',
            tool:      'conclude-gate',
            toolInput: { rootCauseType: concludeInput.rootCauseType },
            observation: 'Gate rejected: no operations check found in trace',
          });
          continue; // resume loop — do NOT break
        }

        finalReport = this.buildReport(input, concludeInput, reactTrace, regDate);
        break;
      }
    }
    } catch (err) {
      const reason = (err as Error).message ?? 'Unknown error';
      process.stderr.write(`[investigate] error for ${input.issueKey}: ${reason}\n`);
      this.markFailed(input.issueKey, reason);
      throw err;
    }

    // If loop exhausted without conclude, build uncertainty report
    if (!finalReport) {
      finalReport = this.buildUncertaintyReport(input, reactTrace, regDate);
    }

    // --- Dual-engine: run skill-based investigation in parallel and synthesize ---
    // GAP-002 (2026-05-21): runSkillInvestigation now returns the typed,
    // schema-validated finding array (or null). synthesizeReports consumes
    // the structured shape directly instead of guessing fields from the
    // generic ClaudeCodeResult.findings[].title/.explanation.
    const skillFindings = await this.runSkillInvestigation(input);
    if (skillFindings) {
      finalReport = this.synthesizeReports(finalReport, skillFindings, input);
    }

    completeInvestigation(this.db, input.issueKey, finalReport);

    // [Wave 3] Write to palace — fire-and-forget
    this.writeToPalace(input, finalReport, reactTrace).catch(err =>
      process.stderr.write(`[palace-writer] failed for ${input.issueKey}: ${(err as Error).message}\n`)
    );

    // Phase 55 Wave 5 — extract reusable bug pattern if confidence is high
    extractAndSaveBugPattern(this.db, finalReport).catch(err =>
      process.stderr.write(`[pattern-extractor] failed: ${(err as Error).message}\n`)
    );

    // Phase 56 — record conclude signals (self-learning)
    const session = getInvestigationSession(this.db, input.issueKey);
    if (session) {
      recordConcludeSignals(
        this.db,
        session.id,
        input.issueKey,
        finalReport.rootCauseType,
        finalReport.fixOwner,
        reactTrace.map(e => ({ tool: e.tool, iteration: e.iteration })),
      );
    }

    return finalReport;
  }

  private async queryPalaceMemory(
    input: InvestigationInput,
    regDate: RegressionDateResult
  ): Promise<{ similarInvestigations: string; kgContext: string }> {
    if (!this.palace) return { similarInvestigations: '', kgContext: '' };

    const windowQuery = regDate.date
      ? `changes near ${regDate.date}`
      : input.title;

    const [similarInvestigations, kgContext] = await Promise.all([
      this.palace.search(`${input.title} ${input.description.slice(0, 300)}`, 'investigations', 5),
      this.palace.kgQuery(windowQuery),
    ]);

    return { similarInvestigations, kgContext };
  }

  private markFailed(issueKey: string, reason: string): void {
    try {
      this.db.prepare(`
        UPDATE investigation_sessions
        SET status = 'failed', completed_at = datetime('now'), conclusion = ?
        WHERE issue_key = ? AND status = 'running'
      `).run(reason, issueKey);
    } catch { /* non-fatal */ }
  }

  private async dispatchTool(name: string, input: unknown): Promise<string> {
    // ADR-020 Phase 4: Delegate shared tools to unified dispatchResearchTool
    const SHARED_TOOLS = ['grep_code', 'read_file', 'list_files', 'trace_call_graph', 'get_ownership', 'get_architecture'];
    if (SHARED_TOOLS.includes(name)) {
      const ctx: ToolContext = { db: this.db, repoPaths: this.repoPaths, searchPaths: this.searchPaths, ownershipMap: this.ownershipMap };
      return dispatchResearchTool(name, input, ctx);
    }

    switch (name) {
      case 'git_log_window':
        return (await gitLogWindow(input as GitLogWindowInput, this.repoPaths)).summary;

      case 'get_dep_diff': {
        const { fromSha, toSha, repo } = input as { fromSha: string; toSha: string; repo: string };
        const repoPath = this.repoPaths[repo];
        if (!repoPath) return `Unknown repo: ${repo}`;
        // BUG-34: application is a monorepo — the root package.json has only ~17 build
        // tools (turbo, eslint, etc.). All real app deps live in components/*/package.json,
        // packages/*/package.json, apps/*/package.json, services/*/package.json.
        // Diffing only the root missed e.g. @types/openui5 bump that revealed the UI5
        // version change causing JIRA-15257.  Now we diff ALL package.json files that
        // changed between the two SHAs and aggregate.
        try {
          const { execFileSync: exec } = await import('child_process');

          // List all package.json paths that exist in the commit tree
          const treeOut = exec('git', ['-C', repoPath, 'ls-tree', '-r', '--name-only', toSha],
            { encoding: 'utf8', timeout: 10_000 });
          const pkgPaths = treeOut.split('\n').filter(p =>
            p.endsWith('package.json') && !p.includes('node_modules')
          );

          type PkgJson = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
          const readPkg = (sha: string, path: string): PkgJson => {
            try {
              return JSON.parse(exec('git', ['-C', repoPath, 'show', `${sha}:${path}`], { encoding: 'utf8' })) as PkgJson;
            } catch { return {}; }
          };

          const allChanges: string[] = [];
          for (const pkgPath of pkgPaths) {
            const cur = readPkg(toSha, pkgPath);
            const prv = readPkg(fromSha, pkgPath);
            const curDeps = { ...cur.dependencies, ...cur.devDependencies };
            const prvDeps = { ...prv.dependencies, ...prv.devDependencies };
            const pkg = pkgPath.replace('/package.json', '').split('/').slice(-2).join('/');
            for (const [n, v] of Object.entries(curDeps)) {
              const prev = prvDeps[n];
              if (!prev)          allChanges.push(`[${pkg}] ${n}: added ${v}`);
              else if (prev !== v) allChanges.push(`[${pkg}] ${n}: ${prev} → ${v}`);
            }
            for (const [n] of Object.entries(prvDeps)) {
              if (!curDeps[n]) allChanges.push(`[${pkg}] ${n}: removed`);
            }
          }
          return allChanges.length === 0
            ? 'No dependency changes between these commits.'
            : allChanges.join('\n');
        } catch (err) {
          return `Could not diff dependencies: ${(err as Error).message?.slice(0, 80)}`;
        }
      }

      case 'get_flag_diff': {
        const { since, until } = input as { since: string; until: string };
        const operationsPath = this.repoPaths['operations'];
        if (!operationsPath) {
          return 'Config/infra repo not configured. Set OPERATIONS_PATH or configure via wi.config.json.';
        }
        try {
          // Find all commits touching feature-flags.yaml in the window
          const logOut = execFileSync('git', [
            '-C', operationsPath,
            'log',
            '--format=%H|%an|%aI|%s',
            `--since=${since}`, `--until=${until}`,
            '--diff-filter=M',
            '--', 'cluster-setup/feature-flags.yaml',
          ], { encoding: 'utf8', timeout: 15_000 }).trim();

          if (!logOut) {
            return `No changes to cluster-setup/feature-flags.yaml between ${since} and ${until}.`;
          }

          const results: string[] = [];
          for (const line of logOut.split('\n').filter(Boolean)) {
            const [sha, author, date, ...subjectParts] = line.split('|');
            const subject = subjectParts.join('|');
            const changes = getFlagStatusDiff(operationsPath, `${sha}^`, sha);
            if (changes.length > 0) {
              results.push(
                `Commit: ${sha.slice(0, 8)} | ${date.slice(0, 10)} | ${author}\n` +
                `  Subject: ${subject}\n` +
                `  Flag changes:\n` +
                changes.map(c => `    ${c.flag}: "${c.from}" → "${c.to}"`).join('\n')
              );
            }
          }

          return results.length > 0
            ? results.join('\n\n')
            : `Commits found in window but no flag Status fields changed.`;
        } catch (err) {
          return `get_flag_diff error: ${(err as Error).message?.slice(0, 120)}`;
        }
      }

      case 'call_claude_code': {
        const { question, focus_repo } = input as { question: string; focus_repo?: string };
        const repos = focus_repo && this.repoPaths[focus_repo]
          ? [this.repoPaths[focus_repo]]
          : Object.values(this.repoPaths);
        try {
          const { ClaudeCodeRunner } = await import('../services/claude-code-runner.js');
          const runner = new ClaudeCodeRunner(1);
          // Load the wi-code-research skill prompt so Claude Code runs with the
          // full structured research workflow instead of a bare prompt.
          const skillPrompt = loadSkillPrompt('wi-code-research');
          const result = await runner.execute({
            prompt: question,
            repos,
            maxBudget: 0.30,
            ...(skillPrompt ? { systemPrompt: skillPrompt } : {}),
          });
          if (!result || result.findings.length === 0) return 'No findings from Claude Code research.';
          return JSON.stringify(result.findings.slice(0, 3));
        } catch (err) {
          return `Claude Code research failed: ${(err as Error).message}`;
        }
      }

      case 'conclude':
        return 'Conclusion recorded.';

      default:
        return `Unknown tool: ${name}`;
    }
  }

  private buildSystemPrompt(
    architectureContext: string,
    ownershipSummary:   string,
    input:              InvestigationInput,
    regDate:            RegressionDateResult,
    palaceContext?:     { similarInvestigations: string; kgContext: string }
  ): string {
    return `You are a senior software engineer investigating a production bug in the application codebase.

## Your Role
- You OWN the application codebase (apps/, packages/, services/)
- External plugins (third-party modules, runtime services, UI framework) are owned by other teams
- Your job: find root cause and determine WHO must fix it
- If the fix belongs to another team, your team action may be "none" or "add defensive check"

## Investigation Rules
1. ALWAYS run git_log_window FIRST for regression bugs (broke on specific date).
   Run it on ALL configured repos in parallel. Config/view changes (feature flags, config) are just as likely to cause regressions as application code changes.
2. CHECK for dependency bumps BEFORE reading application code — use get_dep_diff on ALL renovate/chore(deps) commits in the window
3. TRACE from symptom to code — use list_files to discover structure before grep_code
4. CHECK ownership BEFORE proposing any fix
5. State your confidence (0.0–1.0) in your thought before calling each tool
6. Call conclude when confidence >= 0.8 OR all relevant tools exhausted
7. OPERATIONS CHECK REQUIRED: Before concluding rootCauseType of 'config-change',
   'dep-upgrade', or 'external-service' — you MUST call either:
   - git_log_window(repo='operations', ...) to check for ops-repo code changes, OR
   - get_flag_diff(...) to check for feature flag status transitions
   If you have not done either, call get_flag_diff for a ±3 day window around the
   regression date BEFORE calling conclude. This is non-negotiable.

## External Plugin Integration (IMPORTANT)
The application's recommendation feature has TWO sources of links:
1. Plugin context links (priority) — third-party plugin integration calls BuiltinSupport.init() which sets the i18n bundle. The integration layer calls .getText() on it.
2. Backend fallback — service-nodejs component (only used when plugin provides no links)
When recommendations break, check the third-party plugin first. The plugin calls framework APIs that change between versions deployed on the platform. Key files are owned by the plugin team, not in the workspace repos.

## Architecture Knowledge
${architectureContext}

## Ownership Map
${ownershipSummary}

## Ticket Under Investigation
Issue: ${input.issueKey} — ${input.title}
Status: ${input.status} | Assignee: ${input.assignee ?? 'Unassigned'}
Regression date: ${regDate.date} (confidence: ${regDate.confidence}, source: ${regDate.source})
${regDate.rawMatch ? `Date signal: "${regDate.rawMatch}"` : 'No explicit date in ticket — using estimated window'}

Description:
${input.description.slice(0, 1500)}${input.chatHypotheses?.length ? `

## User Hypotheses (from chat — investigate these first)
${input.chatHypotheses.map(h => `- [${h.timestamp}] "${h.raw}" → ${h.artifact ?? 'no artifact extracted'}`).join('\n')}` : ''}${palaceContext?.similarInvestigations || palaceContext?.kgContext ? `

## Memory Palace Context
${palaceContext.similarInvestigations ? `### Semantically Similar Past Investigations\n${palaceContext.similarInvestigations}` : ''}
${palaceContext.kgContext ? `### Infrastructure Changes Near Regression Date (±7 days)\n${palaceContext.kgContext}` : ''}` : ''}`;
  }

  private buildOwnershipSummary(): string {
    const lines = ['Key ownership boundaries:'];
    const grouped = new Map<string, string[]>();
    for (const entry of this.ownershipMap) {
      if (!grouped.has(entry.team)) grouped.set(entry.team, []);
      grouped.get(entry.team)!.push(`${entry.repo}/${entry.glob}`);
    }
    for (const [team, paths] of grouped) {
      lines.push(`- ${team}: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? '...' : ''}`);
    }
    return lines.join('\n');
  }

  // Runs the wi-investigate skill via Claude CLI subprocess.
  //
  // GAP-002 (2026-05-21): the runner is now invoked with the strict
  // SKILL_INVESTIGATION_JSON_SCHEMA contract and a validator that
  // re-checks the parsed payload through Zod. On validation failure
  // the runner returns null and we silently fall back to the ReAct
  // report — the synthesis step is only entered when the skill
  // emitted a usable structured finding.
  //
  // Returns: array of validated SkillInvestigationFinding, or null
  // if the skill was unavailable / CLI failed / contract violated.
  private async runSkillInvestigation(
    input: InvestigationInput,
  ): Promise<SkillInvestigationFinding[] | null> {
    const skillPrompt = loadSkillPrompt('wi-investigate');
    if (!skillPrompt) return null;
    try {
      const { ClaudeCodeRunner } = await import('../services/claude-code-runner.js');
      const runner = new ClaudeCodeRunner(1);
      const prompt = `Investigate bug ticket ${input.issueKey}: ${input.title}\n\n${input.description ?? ''}`;
      const raw = await runner.execute({
        prompt,
        repos: Object.values(this.repoPaths),
        maxBudget: 0.50,
        timeoutMs: 120_000,
        systemPrompt: skillPrompt,
        outputSchema: SKILL_INVESTIGATION_JSON_SCHEMA,
        // Defence in depth: the CLI may not enforce schema if the user's
        // claude binary predates --json-schema. Validate again here.
        validate: (parsed) => parseSkillInvestigationResult(parsed) !== null,
      });
      if (!raw) return null;

      // The runner stores parsed.findings on ClaudeCodeResult.findings as the
      // generic ResearchFinding[] shape (typed loosely). Run the Zod parser
      // against the original-shape object reconstructed from raw.
      // ClaudeCodeResult only kept findings/filesExamined/confidence, so we
      // re-pack the same shape; the validator will accept it iff each finding
      // has the structured contract fields.
      const reconstructed = {
        findings:      raw.findings,
        filesExamined: raw.filesExamined,
        confidence:    raw.confidence,
      };
      const validated = parseSkillInvestigationResult(reconstructed);
      return validated?.findings ?? null;
    } catch (err) {
      process.stderr.write(`[skill-investigation] failed for ${input.issueKey}: ${(err as Error).message}\n`);
      return null;
    }
  }

  // Merges ReAct engine report + structured skill findings into one final
  // report. Uses the higher-confidence root cause; merges evidence from both.
  //
  // GAP-002 (2026-05-21): consumes SkillInvestigationFinding[] (Zod-validated
  // structured contract) instead of the generic ClaudeCodeResult.findings[].
  // No more "use finding.title as the root cause" guesswork — rootCause,
  // fixOwner, confidence, evidence all come from the skill in their proper
  // typed slots.
  private synthesizeReports(
    reactReport:   InvestigationReport,
    skillFindings: SkillInvestigationFinding[],
    _input:        InvestigationInput,
  ): InvestigationReport {
    if (skillFindings.length === 0) return reactReport;

    const topFinding = skillFindings[0]!;
    const skillConfidence = topFinding.confidence;

    // Build evidence entries from the skill's structured evidence array
    const skillEvidence: EvidenceEntry[] = topFinding.evidence.map(e => ({
      type:        e.type,
      description: `[Skill] ${e.description}`,
      file:        e.file,
      sha:         e.sha,
    }));
    if (skillEvidence.length === 0) {
      // Always leave a breadcrumb so the synthesis is visible in the report
      skillEvidence.push({
        type:        'skill-finding',
        description: `[Skill] ${topFinding.rootCause}`,
      });
    }

    // Pick the root cause from whichever engine is more confident
    const useSkill = skillConfidence > reactReport.confidence;
    const merged: InvestigationReport = {
      ...reactReport,
      confidence:    Math.max(reactReport.confidence, skillConfidence),
      rootCause:     useSkill ? topFinding.rootCause : reactReport.rootCause,
      rootCauseType: useSkill ? topFinding.rootCauseType : reactReport.rootCauseType,
      fixOwner:      useSkill ? topFinding.fixOwner : reactReport.fixOwner,
      isExternalDep: useSkill ? topFinding.isExternalDep : reactReport.isExternalDep,
      conclusion:    useSkill
        ? `[Skill] ${topFinding.rootCause}\n\n[ReAct] ${reactReport.conclusion}`
        : `[ReAct] ${reactReport.conclusion}\n\n[Skill] ${topFinding.rootCause}`,
      proposedFix:   useSkill ? (topFinding.proposedFix ?? reactReport.proposedFix) : reactReport.proposedFix,
      nextAction: useSkill ? topFinding.nextAction : reactReport.nextAction,
      evidence:      [...reactReport.evidence, ...skillEvidence],
    };
    merged.reportJson = { ...merged, skillFindings };
    return merged;
  }

  private buildReport(
    input:      InvestigationInput,
    conclude:   ConcludeInput,
    reactTrace: ReActEntry[],
    regDate:    RegressionDateResult
  ): InvestigationReport {
    const report: InvestigationReport = {
      // DB fields
      hypothesis:                 `${conclude.rootCauseType} — ${conclude.fixOwner}`,
      conclusion:                 conclude.rootCause,
      confidence:                 conclude.confidence,
      ownerTeam:                  conclude.fixOwner,
      regressionDate:             regDate.date,
      regressionDateConfidence:   regDate.confidence,

      // Extended fields
      rootCauseType:  conclude.rootCauseType,
      isExternalDep:  conclude.isExternalDep,
      fixOwner:       conclude.fixOwner,
      rootCause:      conclude.rootCause,
      nextAction: conclude.nextAction,
      proposedFix:    conclude.isExternalDep ? null : (conclude.proposedFix ?? null),
      evidence:       conclude.evidence ?? [],
      reactTrace,
      issueKey:       input.issueKey,
    };
    report.reportJson = { ...report, reactTrace };
    return report;
  }

  private buildUncertaintyReport(
    input:      InvestigationInput,
    reactTrace: ReActEntry[],
    regDate:    RegressionDateResult
  ): InvestigationReport {
    const report: InvestigationReport = {
      hypothesis:               'unknown',
      conclusion:               'Investigation exhausted max iterations without reaching a conclusion.',
      confidence:               0.2,
      ownerTeam:                'unknown',
      regressionDate:           regDate.date,
      regressionDateConfidence: regDate.confidence,

      rootCauseType:  'unknown',
      isExternalDep:  false,
      fixOwner:       'unknown',
      rootCause:      'Could not determine root cause within investigation budget.',
      nextAction: 'Manual investigation required — see trace for partial findings.',
      proposedFix:    null,
      evidence:       [],
      reactTrace,
      issueKey:       input.issueKey,
    };
    report.reportJson = { ...report, reactTrace };
    return report;
  }

  private buildPatternMatchReport(
    input:      InvestigationInput,
    prior:      PastInvestigation
  ): InvestigationReport {
    const patternEvidence: EvidenceEntry = {
      type:        'pattern-match',
      description: `Matched prior investigation ${prior.issue_key} (confidence ${prior.confidence}) — ${prior.conclusion}`,
    };

    const report: InvestigationReport = {
      hypothesis:               prior.conclusion,
      conclusion:               prior.conclusion,
      confidence:               prior.confidence,
      ownerTeam:                prior.owner_team ?? 'unknown',
      regressionDate:           null,
      regressionDateConfidence: 'low',

      rootCauseType:  'unknown',
      isExternalDep:  false,
      fixOwner:       prior.owner_team ?? 'unknown',
      rootCause:      prior.conclusion,
      nextAction: 'See linked investigation for details.',
      proposedFix:    null,
      evidence:       [patternEvidence],
      reactTrace:     [],  // skipped loop
      issueKey:       input.issueKey,
    };
    report.reportJson = { ...report };
    return report;
  }

  private extractKeywords(title: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'in', 'on', 'at', 'to', 'for',
      'of', 'and', 'or', 'with', 'not', 'it', 'be', 'do', 'does', 'this',
      'that', 'its', 'by', 'from', 'when', 'should', 'will', 'can', 'has',
      'have', 'after', 'before', 'than', 'but', 'also', 'into', 'over',
      'more', 'some', 'such', 'each', 'been', 'their', 'there', 'then',
      'about', 'showing', 'not', 'no',
    ]);
    return title.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w)).slice(0, 6);
  }

  private static extractCausalEntity(report: InvestigationReport): string | null {
    const text = report.rootCause;
    // Feature flag: FF_RM_NNNNN_NAME
    const ffMatch = text.match(/\bFF_RM_\w+/);
    if (ffMatch) return ffMatch[0];
    // npm package with version: @scope/pkg@version or pkg@version
    const pkgMatch = text.match(/@?[\w-]+\/[\w-]+@[\d.]+|[\w-]+@[\d.]+/);
    if (pkgMatch) return pkgMatch[0];
    // PR reference: PR #NNN or PR#NNN
    const prMatch = text.match(/PR\s*#(\d+)/i);
    if (prMatch) return `PR-${prMatch[1]}`;
    return null;
  }

  private async writeToPalace(
    input: InvestigationInput,
    report: InvestigationReport,
    reactTrace: ReActEntry[]
  ): Promise<void> {
    if (!this.palace) return;

    const room = report.rootCauseType;

    // Serialize report as drawer content
    const drawerContent = JSON.stringify({
      issueKey:       input.issueKey,
      title:          input.title,
      rootCause:      report.rootCause,
      rootCauseType:  report.rootCauseType,
      fixOwner:       report.fixOwner,
      confidence:     report.confidence,
      regressionDate: report.regressionDate,
      nextAction: report.nextAction,
      evidence:       report.evidence,
    }, null, 2);

    // Productive tools: tools whose name appears in any evidence description
    const evidenceText = report.evidence.map(e => e.description + ' ' + (e.file ?? '')).join(' ');
    const allTools = reactTrace.filter(e => e.tool !== 'none' && e.tool !== 'conclude');
    const productiveTools = [...new Set(allTools.filter(e => evidenceText.includes(e.tool)).map(e => e.tool))];
    const deadEndTools    = [...new Set(allTools.filter(e => !productiveTools.includes(e.tool)).map(e => e.tool))];

    const diaryEntry = [
      `Issue: ${input.issueKey} | ${report.rootCauseType} | confidence: ${report.confidence}`,
      `Root cause: ${report.rootCause.slice(0, 200)}`,
      `Productive: ${productiveTools.join(', ') || 'none'}`,
      `Dead ends:  ${deadEndTools.join(', ') || 'none'}`,
      `Fix owner: ${report.fixOwner}`,
    ].join('\n');

    // Identify causal entity for KG triple
    const causalEntity = InvestigationOrchestrator.extractCausalEntity(report);

    // Persist full payload to SQLite for palace rebuild (B3)
    const palacePayload = JSON.stringify({
      room,
      drawerContent,
      diaryEntry,
      causalEntity,
      regressionDate: report.regressionDate,
    });
    try {
      this.db.prepare(
        `UPDATE investigation_sessions SET palace_payload = ? WHERE issue_key = ?`
      ).run(palacePayload, input.issueKey);
    } catch (err) {
      process.stderr.write(`[palace-writer] SQLite persist failed for ${input.issueKey}: ${(err as Error).message}\n`);
    }

    // Run drawer write + diary in parallel; KG triple separately (needs causal entity check)
    await Promise.all([
      this.palace.addDrawer('investigations', room, drawerContent, input.issueKey),
      this.palace.diaryWrite('investigator', diaryEntry, input.issueKey),
    ]);

    // Write KG triple if we can identify a causal entity
    if (causalEntity && report.regressionDate) {
      await this.palace.kgAdd(causalEntity, 'caused-regression', input.issueKey, report.regressionDate);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 56 — recordConcludeSignals (kept from original stub)
// ---------------------------------------------------------------------------

/**
 * Entry in the ReAct trace — one tool invocation per iteration.
 * Phase 55 will define the canonical shape; this matches the minimum
 * fields needed by the feedback recorder.
 */
export interface ReactTraceEntry {
  tool:      string;
  iteration: number;
}

/**
 * Record self-learning signals when an investigation session concludes.
 *
 * Called after the orchestrator marks a session as `status = 'done'`.
 * Writes two kinds of feedback:
 *   1. **Hypothesis accuracy** — predicted root cause type and fix owner
 *   2. **Tool effectiveness** — per-tool invocation count and whether the
 *      tool appeared in the final 2 iterations (proxy for "led to conclusion")
 */
export function recordConcludeSignals(
  db:            Database,
  sessionId:     number,
  issueKey:      string,
  rootCauseType: string,
  fixOwner:      string | undefined,
  reactTrace:    ReactTraceEntry[],
): void {
  // 1. Record hypothesis prediction
  createHypothesisAccuracy(db, sessionId, issueKey, {
    rootCause: rootCauseType,
    fixOwner,
  });

  // 2. Record per-tool effectiveness
  const totalIterations = reactTrace.length;
  for (const entry of reactTrace) {
    // A tool "led to conclusion" if it appeared in the last 2 iterations
    const ledToConclusion = entry.iteration >= totalIterations - 2;
    upsertToolEffectiveness(db, entry.tool, rootCauseType, ledToConclusion);
  }
}
