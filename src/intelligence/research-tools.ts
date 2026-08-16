import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { readdirSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { readFile, type ReadFileInput } from './tools/file-reader.js';
import { gitLogWindow, type GitLogWindowInput } from './tools/git-log-window.js';
import { traceCallGraph, type TraceInput } from './tools/call-graph-tracer.js';
import { grepCode } from './investigation-orchestrator.js';
import { getOwnership, type OwnershipEntry } from './ownership-map.js';
import { defaultRepoName, repoNameHint } from './repo-names.js';

export interface ToolContext {
  db: Database.Database;
  repoPaths: Record<string, string>;
  searchPaths: Record<string, string>;
  ownershipMap: OwnershipEntry[];
}

export type ResearchTier = 1 | 2 | 3;

export async function dispatchResearchTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<string> {
  switch (name) {
    case 'grep_code': {
      const { pattern, repo } = input as { pattern: string; repo?: string };
      return grepCode(pattern, ctx.searchPaths[repoNameHint(repo)] ?? '.');
    }

    case 'read_file':
      return readFile(input as ReadFileInput, ctx.searchPaths).content;

    case 'list_files': {
      const { repo, subPath } = input as { repo: string; subPath?: string };
      const base = ctx.searchPaths[repo] ?? '.';
      const target = subPath ? `${base}/${subPath}` : base;
      try {
        const entries = readdirSync(target);
        const lines = entries.slice(0, 60).map(e => {
          try { return statSync(`${target}/${e}`).isDirectory() ? `${e}/` : e; }
          catch { return e; }
        });
        return `Contents of ${subPath ?? '/'}:\n${lines.join('\n')}`;
      } catch (err) {
        return `Cannot list ${target}: ${(err as Error).message?.slice(0, 80)}`;
      }
    }

    case 'get_architecture': {
      const { area } = input as { area: string };
      const knowledge = ctx.db.prepare(
        `SELECT title, content FROM codebase_knowledge WHERE repo = ? AND area LIKE ? LIMIT 3`
      ).all(defaultRepoName(), `%${area}%`) as Array<{ title: string; content: string }>;
      return knowledge.length > 0
        ? knowledge.map(k => `## ${k.title}\n${k.content.slice(0, 500)}`).join('\n\n')
        : 'No architecture knowledge found for this area. Try a broader search term.';
    }

    case 'search_codebase_knowledge': {
      const { keywords } = input as { keywords: string[] };
      const conditions = keywords.map(() => `(title LIKE ? OR content LIKE ?)`).join(' OR ');
      const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);
      const rows = ctx.db.prepare(
        `SELECT title, content, area FROM codebase_knowledge WHERE ${conditions} LIMIT 5`
      ).all(...params) as Array<{ title: string; content: string; area: string }>;
      return rows.length > 0
        ? rows.map(r => `[${r.area}] ${r.title}\n${r.content.slice(0, 400)}`).join('\n---\n')
        : 'No matching codebase knowledge entries found.';
    }

    case 'search_docs': {
      const { query, repo } = input as { query: string; repo?: string };
      const resolvedRepo = repoNameHint(repo);
      const searchPath = ctx.searchPaths[resolvedRepo] ?? '.';
      try {
        const result = execFileSync('grep', [
          '-rl', '--include=*.md', '--include=*.mdx', '--include=*.txt',
          '-i', query, `${searchPath}/docs`, `${searchPath}/README.md`,
        ], { encoding: 'utf8', timeout: 10_000 }).trim();
        const files = result.split('\n').filter(Boolean).slice(0, 8);
        if (files.length === 0) return `No docs matching "${query}" in ${resolvedRepo}.`;
        const snippets = files.map(f => {
          try {
            const content = execFileSync('grep', ['-i', '-m', '3', '-A', '2', query, f],
              { encoding: 'utf8', timeout: 5000 }).trim();
            const relPath = f.replace(searchPath + '/', '');
            return `### ${relPath}\n${content.slice(0, 300)}`;
          } catch { return ''; }
        }).filter(Boolean);
        return snippets.join('\n\n') || `Found ${files.length} files but could not extract snippets.`;
      } catch {
        return `No docs matching "${query}" in ${resolvedRepo}.`;
      }
    }

    case 'git_log_window':
      return (await gitLogWindow(input as GitLogWindowInput, ctx.repoPaths)).summary;

    case 'trace_call_graph':
      return traceCallGraph(input as TraceInput, ctx.db, ctx.ownershipMap).summary;

    case 'get_ownership': {
      const { file, repo } = input as { file: string; repo?: string };
      const result = getOwnership(file, repoNameHint(repo), ctx.ownershipMap);
      return result
        ? `Owner: ${result.team}${result.owner ? ` (${result.owner})` : ''}${result.notes ? `. Note: ${result.notes}` : ''}`
        : 'No ownership entry found for this file path.';
    }

    case 'search_messages': {
      const { query, limit } = input as { query: string; limit?: number };
      const maxRows = Math.min(limit ?? 5, 10);
      const rows = ctx.db.prepare(
        `SELECT source, content, author, timestamp FROM messages
         WHERE messages MATCH ? ORDER BY rank LIMIT ?`
      ).all(query, maxRows) as Array<{ source: string; content: string; author: string; timestamp: string }>;
      if (rows.length === 0) return `No messages matching "${query}" in FTS index.`;
      return rows.map(r => `[${r.source}] ${r.author} (${r.timestamp?.slice(0, 10)}): ${r.content.slice(0, 200)}`).join('\n');
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// --- Tool Definitions (Anthropic.Tool[] format) ---

const TIER_1_TOOLS: Anthropic.Tool[] = [
  {
    name: 'grep_code',
    description: 'Search for a pattern across source files using ripgrep. Returns matching lines with file paths. Best for finding function definitions, imports, variable usage, or string literals.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for (ripgrep syntax)' },
        repo: { type: 'string', description: 'Repository to search (default: configured primary repo)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file with optional line range (viewport). Use offset+limit to read specific sections — do not read entire large files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository (as configured)' },
        file: { type: 'string', description: 'Relative file path within the repo' },
        offset: { type: 'number', description: 'Start line (0-indexed). Omit to start from beginning.' },
        limit: { type: 'number', description: 'Max lines to read (default: 100)' },
      },
      required: ['repo', 'file'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and directories at a path. Shows first 60 entries with directory markers (/).',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository (as configured)' },
        subPath: { type: 'string', description: 'Subdirectory path relative to repo root' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'get_architecture',
    description: 'Query indexed architecture knowledge for a specific area (e.g. "auth", "search", "routing"). Returns structured knowledge from codebase_knowledge table.',
    input_schema: {
      type: 'object' as const,
      properties: {
        area: { type: 'string', description: 'Architecture area to query (e.g. "recommended-links", "search", "auth")' },
      },
      required: ['area'],
    },
  },
  {
    name: 'search_codebase_knowledge',
    description: 'Search the codebase knowledge index using multiple keywords (OR match). More flexible than get_architecture — finds entries by title or content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords to search for (matched with OR logic)',
        },
      },
      required: ['keywords'],
    },
  },
];

const TIER_2_TOOLS: Anthropic.Tool[] = [
  ...TIER_1_TOOLS,
  {
    name: 'search_docs',
    description: 'Grep documentation files (*.md, *.mdx) for a keyword. Returns matching file paths and context snippets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Keyword or phrase to search for in docs' },
        repo: { type: 'string', description: 'Repository (default: configured primary repo)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'git_log_window',
    description: 'Get git commit history for a time window or path. Shows commits, authors, files changed, and dependency diffs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository (as configured)' },
        since: { type: 'string', description: 'Start date (ISO format)' },
        until: { type: 'string', description: 'End date (ISO format)' },
        path: { type: 'string', description: 'Optional file/directory path filter' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'trace_call_graph',
    description: 'Trace the call graph from a file — find callers, callees, or both. Shows ownership and cross-repo boundaries.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository containing the file' },
        startFile: { type: 'string', description: 'Relative path to trace from' },
        direction: { type: 'string', enum: ['callers', 'callees', 'both'], description: 'Trace direction' },
        maxDepth: { type: 'number', description: 'Max depth (1-5, default 3)' },
      },
      required: ['repo', 'startFile', 'direction'],
    },
  },
  {
    name: 'get_ownership',
    description: 'Look up team ownership for a file path. Returns team name, contact, and notes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string', description: 'Relative file path' },
        repo: { type: 'string', description: 'Repository (default: configured primary repo)' },
      },
      required: ['file'],
    },
  },
  {
    name: 'search_messages',
    description: 'Full-text search across stored messages (Teams, email, Jira). Returns matching messages with author and timestamp.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'FTS5 search query' },
        limit: { type: 'number', description: 'Max results (default 5, max 10)' },
      },
      required: ['query'],
    },
  },
];

const TIER_3_TOOLS: Anthropic.Tool[] = TIER_2_TOOLS;

export function getToolsForTier(tier: ResearchTier): Anthropic.Tool[] {
  switch (tier) {
    case 1: return TIER_1_TOOLS;
    case 2: return TIER_2_TOOLS;
    case 3: return TIER_3_TOOLS;
  }
}
