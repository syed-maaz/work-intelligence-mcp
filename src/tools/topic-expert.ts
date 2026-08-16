/**
 * ask_topic_expert MCP Tool
 *
 * Given a natural language question (and optional project key), searches across:
 *   1. SQLite DB (messages_fts FTS5 index) — Jira, Teams, Email already stored
 *   2. GitHub REST API (live) — issues and PRs from the configured GitHub instance
 *
 * Uses Claude Sonnet to synthesize a rich structured answer:
 *   - Narrative prose summary
 *   - Key decisions
 *   - Open items / blockers
 *   - Open PRs
 *   - Participants
 *
 * Unlike search_all (which does live browser fetches), topic-expert queries
 * already-stored data + GitHub API only. Run search_all or teams-sync first
 * to populate the DB.
 */

import type Database from 'better-sqlite3';
import fs from 'node:fs';
import nodePath from 'node:path';
import { AIAnalyzer, type ContextItem } from '../services/analyzer.js';
import { createGitHubConnector } from '../fetcher/sources/github.js';
import type { UnifiedMessage } from '../fetcher/sources/types.js';
import type { PalaceClient } from '../intelligence/palace-client.js';
import { recallMemory } from '../services/brain/recall.js';
import { getNotebook } from '../db/queries/notebooks.js';
import { SEPARATOR } from './obsidian-export.js';
import { syncSingleFile } from '../services/obsidian/vault-indexer.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AskTopicExpertArgs {
  /** Natural language question, e.g. "What's happening with authentication?" */
  question: string;
  /** Optional Jira project key to anchor the search (e.g. "DEMO") */
  projectKey?: string;
  /** Optional DB topic name label (used in report header only) */
  topicName?: string;
  /** Which sources to include (default: all four) */
  sources?: Array<'jira' | 'teams' | 'email' | 'github'>;
  /** Only include content from this date onwards (ISO format, default: 30 days ago) */
  since?: string;
  /** Max results per DB source before synthesizing (default: 50) */
  maxResults?: number;
  /** Optional MemPalace client for cross-session recall. */
  palace?: PalaceClient | null;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface MessageRow {
  id: number;
  source: string;
  source_id: string | null;
  subject: string | null;
  content: string;
  author: string;
  timestamp: string;
  metadata: string | null;
}

interface MeetingRow {
  id: number;
  title: string;
  date: string;
  chat_name: string | null;
  summary: string | null;
  topics: string | null;
  decisions: string | null;
}

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'what', 'is', 'are', 'the', 'a', 'an', 'in', 'on', 'with', 'about',
  'how', 'happening', 'tell', 'me', 'show', 'find', 'get', 'latest',
  'update', 'updates', 'status', 'there', 'any', 'all', 'for', 'of',
  'to', 'and', 'or', 'by', 'it', 'this', 'was', 'were', 'has', 'have',
  'had', 'been', 'be', 'do', 'does', 'did', 'that', 'from', 'at', 'as',
  'can', 'will', 'would', 'should', 'could', 'my', 'our', 'their',
]);

function extractKeywords(question: string, projectKey?: string): string[] {
  const tokens = question
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));

  const result: string[] = [];
  if (projectKey) {
    result.push(projectKey);
  }
  for (const t of tokens) {
    if (!result.some((r) => r.toLowerCase() === t)) {
      result.push(t);
    }
  }
  return result;
}

function buildFtsQuery(keywords: string[]): string {
  if (keywords.length === 0) return '';
  // Sanitize FTS5 metacharacters
  const safe = keywords
    .map((k) => k.replace(/["()*:]/g, ' ').trim())
    .filter(Boolean);
  return safe.join(' OR ');
}

// ---------------------------------------------------------------------------
// DB search — FTS5 with LIKE fallback + projectKey secondary pass
// ---------------------------------------------------------------------------

function searchDb(
  db: Database.Database,
  ftsQuery: string,
  sinceIso: string,
  maxResults: number,
  projectKey?: string
): { messages: MessageRow[]; meetings: MeetingRow[] } {
  const msgMap = new Map<number, MessageRow>();

  // Pass 1: FTS5 search across all sources
  if (ftsQuery) {
    try {
      const ftsRows = db.prepare(`
        SELECT m.id, m.source, m.source_id, m.subject, m.content,
               m.author, m.timestamp, m.metadata,
               bm25(messages_fts) AS rank
        FROM messages_fts
        JOIN messages m ON messages_fts.rowid = m.id
        WHERE messages_fts MATCH ? AND m.timestamp >= ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, sinceIso, maxResults) as MessageRow[];
      for (const row of ftsRows) msgMap.set(row.id, row);
    } catch {
      // FTS may fail if FTS table doesn't exist yet — fall through to LIKE
    }
  }

  // Pass 2: projectKey direct Jira match (even if FTS found results — adds more Jira context)
  if (projectKey) {
    const jiraRows = db.prepare(`
      SELECT id, source, source_id, subject, content, author, timestamp, metadata, 0 as rank
      FROM messages
      WHERE source = 'jira' AND source_id LIKE ? AND timestamp >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(`${projectKey}-%`, sinceIso, maxResults) as MessageRow[];
    for (const row of jiraRows) {
      if (!msgMap.has(row.id)) msgMap.set(row.id, row);
    }
  }

  // Pass 3: LIKE fallback if still no results
  if (msgMap.size === 0 && ftsQuery) {
    const keywords = ftsQuery.split(' OR ').map((k) => k.trim()).filter(Boolean);
    const firstKeyword = keywords[0] ?? '';
    const pattern = `%${firstKeyword}%`;
    const likeRows = db.prepare(`
      SELECT id, source, source_id, subject, content, author, timestamp, metadata, 0 as rank
      FROM messages
      WHERE (content LIKE ? OR subject LIKE ?) AND timestamp >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(pattern, pattern, sinceIso, maxResults) as MessageRow[];
    for (const row of likeRows) msgMap.set(row.id, row);
  }

  // Meetings search via FTS5
  const meetingMap = new Map<number, MeetingRow>();
  if (ftsQuery) {
    try {
      const meetFtsRows = db.prepare(`
        SELECT mt.id, mt.title, mt.date, mt.chat_name, mt.summary, mt.topics, mt.decisions,
               bm25(meetings_fts) AS rank
        FROM meetings_fts
        JOIN meetings mt ON meetings_fts.rowid = mt.id
        WHERE meetings_fts MATCH ? AND mt.date >= ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, sinceIso, Math.floor(maxResults / 2)) as MeetingRow[];
      for (const row of meetFtsRows) meetingMap.set(row.id, row);
    } catch {
      // meetings_fts may not exist — skip silently
    }
  }

  return {
    messages: Array.from(msgMap.values()).slice(0, maxResults),
    meetings: Array.from(meetingMap.values()),
  };
}

// ---------------------------------------------------------------------------
// Convert DB rows + GitHub results to ContextItem[]
// ---------------------------------------------------------------------------

function messageRowsToContextItems(rows: MessageRow[]): ContextItem[] {
  return rows.map((row) => {
    let parsedMeta: Record<string, unknown> | undefined;
    let url: string | undefined;

    if (row.metadata) {
      try {
        parsedMeta = JSON.parse(row.metadata) as Record<string, unknown>;
        // Extract Jira URL from metadata if available
        const jira = parsedMeta['jira'] as { issueKey?: string } | undefined;
        if (jira?.issueKey) {
          const baseUrl = process.env.JIRA_BASE_URL ?? 'https://jira.example.com';
          url = `${baseUrl}/browse/${jira.issueKey}`;
          // Simplify metadata for context
          parsedMeta = { status: (parsedMeta['jira'] as Record<string, unknown>)['status'] };
        }
      } catch {
        parsedMeta = undefined;
      }
    }

    return {
      source: row.source,
      title: row.subject ?? row.source_id ?? '(no subject)',
      content: row.content,
      url,
      author: row.author,
      timestamp: row.timestamp,
      metadata: parsedMeta,
    };
  });
}

function meetingRowsToContextItems(rows: MeetingRow[]): ContextItem[] {
  return rows.map((row) => {
    const parts: string[] = [];
    if (row.summary) parts.push(row.summary);
    if (row.topics) {
      try {
        const t = JSON.parse(row.topics) as string[];
        if (t.length) parts.push(`Topics: ${t.join(', ')}`);
      } catch { /* skip */ }
    }
    if (row.decisions) {
      try {
        const d = JSON.parse(row.decisions) as string[];
        if (d.length) parts.push(`Decisions: ${d.join('; ')}`);
      } catch { /* skip */ }
    }

    return {
      source: 'teams',
      title: `Meeting: ${row.title}`,
      content: parts.join('\n') || row.title,
      author: row.chat_name ?? 'Teams',
      timestamp: row.date,
    };
  });
}

function githubToContextItems(messages: UnifiedMessage[]): ContextItem[] {
  return messages.map((msg) => {
    const gh = msg.metadata.github;
    return {
      source: 'github',
      title: msg.subject,
      content: msg.content,
      url: gh?.url,
      author: msg.sender.name,
      timestamp: msg.createdAt.toISOString(),
      metadata: gh
        ? { state: gh.state, isPR: gh.isPR, labels: gh.labels }
        : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

interface RenderMeta {
  dbMessages: number;
  dbMeetings: number;
  githubCount: number;
  sinceDate: Date;
  generatedAt: Date;
  sources: string[];
  fetchNotes: string[];
}

function renderMarkdown(
  question: string,
  topicName: string | undefined,
  answer: {
    narrative: string;
    keyDecisions: string[];
    openItems: string[];
    openPRs: string[];
    participants: string[];
  },
  contextItems: ContextItem[],
  meta: RenderMeta
): string {
  const lines: string[] = [];

  const header = topicName
    ? `## Topic Expert: ${topicName} — ${question}`
    : `## Topic Expert: ${question}`;
  lines.push(header);

  const sourcesList = meta.sources.join(', ');
  const totalFound = meta.dbMessages + meta.dbMeetings + meta.githubCount;
  lines.push(
    `_Searched: ${sourcesList} | Found: ${totalFound} items | Since: ${meta.sinceDate.toISOString().slice(0, 10)} | Generated: ${meta.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC_`,
    ''
  );

  lines.push('### Summary', '', answer.narrative || '_No summary available._', '');

  lines.push('### Key Decisions');
  if (answer.keyDecisions.length > 0) {
    for (const d of answer.keyDecisions) lines.push(`- ${d}`);
  } else {
    lines.push('_None identified._');
  }
  lines.push('');

  lines.push('### Open Items');
  if (answer.openItems.length > 0) {
    for (const item of answer.openItems) lines.push(`- ${item}`);
  } else {
    lines.push('_None identified._');
  }
  lines.push('');

  lines.push('### Open PRs');
  if (answer.openPRs.length > 0) {
    for (const pr of answer.openPRs) lines.push(`- ${pr}`);
  } else {
    lines.push('_None identified._');
  }
  lines.push('');

  lines.push('### Participants');
  if (answer.participants.length > 0) {
    lines.push(answer.participants.join(', '));
  } else {
    lines.push('_None identified._');
  }
  lines.push('');

  // Sources used summary
  const bySource = new Map<string, number>();
  for (const item of contextItems) {
    bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
  }
  const sourceSummary = Array.from(bySource.entries())
    .map(([src, count]) => `${src.charAt(0).toUpperCase() + src.slice(1)}: ${count}`)
    .join(' | ');

  lines.push('### Sources Used', sourceSummary || '_No sources found._', '');

  // Top 10 source items as bullets
  const top10 = contextItems.slice(0, 10);
  for (const item of top10) {
    const dateStr = item.timestamp ? ` (${item.timestamp.slice(0, 10)})` : '';
    const urlPart = item.url ? ` — ${item.url}` : '';
    lines.push(`- **[${item.source.toUpperCase()}]** ${item.title}${dateStr}${urlPart}`);
  }
  if (contextItems.length > 10) {
    lines.push(`_…and ${contextItems.length - 10} more items used for analysis._`);
  }
  lines.push('');

  lines.push('---');
  if (meta.fetchNotes.length > 0) {
    lines.push(`_Notes: ${meta.fetchNotes.join(' | ')}_`);
  } else {
    lines.push('_All sources searched successfully._');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export async function askTopicExpert(
  db: Database.Database,
  args: AskTopicExpertArgs,
  anthropicApiKey?: string
): Promise<string> {
  const {
    question,
    projectKey,
    topicName,
    sources = ['jira', 'teams', 'email', 'github'],
    since,
    maxResults = 50,
  } = args;

  if (!question?.trim()) {
    return 'Error: question is required.';
  }

  // EP-14-4: look up topic's lookback_days if topicName is given and no explicit since
  let defaultLookbackDays = 30;
  if (!since && topicName) {
    try {
      const topicRow = db
        .prepare('SELECT lookback_days FROM topics WHERE name = ?')
        .get(topicName) as { lookback_days: number } | undefined;
      if (topicRow?.lookback_days) {
        defaultLookbackDays = topicRow.lookback_days;
      }
    } catch {
      // non-fatal — use default
    }
  }

  const sinceDate = since
    ? new Date(since)
    : new Date(Date.now() - defaultLookbackDays * 24 * 60 * 60 * 1000);
  const sinceIso = sinceDate.toISOString();

  const fetchNotes: string[] = [];
  const dbSources = sources.filter((s) => s !== 'github');
  const includeGitHub = sources.includes('github');

  // ── Phase 79-04: read prior memory BEFORE FTS/GitHub search ──
  const priorMemoryItems: ContextItem[] = [];

  // 1. topic_notebooks (exact + LIKE)
  try {
    if (topicName) {
      const nb = getNotebook(db, topicName);
      if (nb?.content) {
        priorMemoryItems.push({
          source: 'notebook',
          title: `Prior notebook — ${topicName}`,
          content: nb.content,
          timestamp: nb.last_updated,
        });
      }
    }
    const kw = question
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 4)
      .slice(0, 3);
    if (kw.length > 0) {
      const clauses = kw.map(() => `(lower(topic_name) LIKE ? OR lower(content) LIKE ?)`).join(' OR ');
      const params = kw.flatMap((k) => [`%${k}%`, `%${k}%`]);
      const rows = db
        .prepare(`SELECT topic_name, content, last_updated FROM topic_notebooks WHERE ${clauses} ORDER BY last_updated DESC LIMIT 3`)
        .all(...params) as Array<{ topic_name: string; content: string; last_updated: string }>;
      for (const r of rows) {
        if (r.topic_name === topicName) continue; // already added
        priorMemoryItems.push({
          source: 'notebook',
          title: `Related notebook — ${r.topic_name}`,
          content: r.content.slice(0, 2000),
          timestamp: r.last_updated,
        });
      }
    }
  } catch (err) {
    process.stderr.write(`[topic_expert] notebook read failed: ${(err as Error).message.slice(0, 100)}\n`);
  }

  // 2. brain_decisions + palace via recallMemory
  try {
    const recalled = await recallMemory({
      db,
      pattern: question,
      palace: args.palace ?? null,
      limit: 6,
      wings: [],
      sqliteLanes: true,
    });
    for (const r of recalled) {
      priorMemoryItems.push({
        source: `recall-${r.source}`,
        title: `Recalled — ${r.source} ${r.id}`,
        content: r.snippet,
        timestamp: r.created_at,
      });
    }
  } catch (err) {
    process.stderr.write(`[topic_expert] recallMemory failed: ${(err as Error).message.slice(0, 100)}\n`);
  }

  // ---- 1. Extract keywords and build FTS query ----
  const keywords = extractKeywords(question, projectKey);
  const ftsQuery = buildFtsQuery(keywords);

  process.stderr.write(
    `[topic_expert] Question: "${question}", keywords: [${keywords.join(', ')}], since: ${sinceIso}\n`
  );

  // ---- 2. DB search ----
  let dbMessages: MessageRow[] = [];
  let dbMeetings: MeetingRow[] = [];

  try {
    const dbResults = searchDb(db, ftsQuery, sinceIso, maxResults, projectKey);
    // Filter to requested DB sources
    const dbSourcesSet = new Set(dbSources);
    dbMessages = dbResults.messages.filter((m) => dbSourcesSet.has(m.source as 'jira' | 'teams' | 'email'));
    dbMeetings = dbSources.includes('teams') ? dbResults.meetings : [];
    process.stderr.write(
      `[topic_expert] DB: ${dbMessages.length} messages, ${dbMeetings.length} meetings\n`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[topic_expert] DB search error: ${msg}\n`);
    fetchNotes.push(`DB search error: ${msg.slice(0, 100)}`);
  }

  // ---- 3. GitHub fetch ----
  let githubMessages: UnifiedMessage[] = [];

  if (includeGitHub) {
    const githubConnector = createGitHubConnector();
    if (!githubConnector) {
      fetchNotes.push('GitHub skipped: GITHUB_API_URL or GITHUB_TOKEN not set');
    } else {
      try {
        const ghQuery = keywords.join(' ');
        process.stderr.write(`[topic_expert] GitHub search: "${ghQuery}"\n`);
        githubMessages = await githubConnector.searchIssues(ghQuery, sinceDate, 30);
        process.stderr.write(`[topic_expert] GitHub: ${githubMessages.length} results\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
        process.stderr.write(`[topic_expert] GitHub error: ${msg}\n`);
        fetchNotes.push(`GitHub error: ${msg.slice(0, 100)}`);
      }
    }
  }

  // ---- 4. Build context items ----
  const contextItems: ContextItem[] = [
    ...priorMemoryItems,         // Phase 79-04: prior memory first
    ...messageRowsToContextItems(dbMessages),
    ...meetingRowsToContextItems(dbMeetings),
    ...githubToContextItems(githubMessages),
  ];

  // Deduplicate by title+source, cap at 80 total
  const seen = new Set<string>();
  const deduped: ContextItem[] = [];
  for (const item of contextItems) {
    const key = `${item.source}::${item.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
    if (deduped.length >= 80) break;
  }

  const totalFound = deduped.length;
  process.stderr.write(`[topic_expert] Total context items: ${totalFound}\n`);

  // ---- 5. AI synthesis ----
  const emptyAnswer: {
    narrative: string;
    keyDecisions: string[];
    openItems: string[];
    openPRs: string[];
    participants: string[];
  } = {
    narrative: '',
    keyDecisions: [],
    openItems: [],
    openPRs: [],
    participants: [],
  };

  let answer = { ...emptyAnswer };

  if (!anthropicApiKey) {
    fetchNotes.push('AI synthesis skipped: ANTHROPIC_API_KEY not set');
  } else if (totalFound === 0) {
    answer.narrative = `No content found for "${question}" in the searched sources. Try running \`search_all\` or \`teams-sync\` to populate the database, or check that GITHUB_TOKEN is set.`;
  } else {
    try {
      const analyzer = new AIAnalyzer({ apiKey: anthropicApiKey });
      answer = await analyzer.answerQuestion(question, deduped);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      process.stderr.write(`[topic_expert] AI error: ${msg}\n`);
      fetchNotes.push(`AI synthesis error: ${msg.slice(0, 100)}`);
      answer.narrative = `AI synthesis failed. Raw context: ${dbMessages.length} DB messages, ${githubMessages.length} GitHub results found.`;
    }
  }

  // ---- 6. Render ----
  const activeSources = [...dbSources, ...(includeGitHub ? ['github'] : [])];

  const finalMarkdown = renderMarkdown(question, topicName, answer, deduped, {
    dbMessages: dbMessages.length,
    dbMeetings: dbMeetings.length,
    githubCount: githubMessages.length,
    sinceDate,
    generatedAt: new Date(),
    sources: activeSources,
    fetchNotes,
  });

  // ── Phase 79-04 (Task 8.5 retraction) + 79-08: write condensed synthesis to vault ──
  // Write above-separator only — preserves user annotations below separator.
  // syncSingleFile re-indexes into obsidian_notes so recall sees the update
  // without waiting for the chokidar watcher debounce.
  if (topicName && process.env.OBSIDIAN_VAULT_PATH) {
    try {
      const safeFilename = topicName.replace(/[/\\:*?"<>|]/g, '_');
      const filePath = nodePath.join(process.env.OBSIDIAN_VAULT_PATH, `${safeFilename}.md`);
      const now = new Date().toISOString();
      const condensedSnippet = [
        `## WI-Generated — Q&A ${now}`,
        `**Q:** ${question}`,
        `**A (condensed):** ${finalMarkdown.slice(0, 1500).replace(/\n{2,}/g, '\n')}`,
        '',
      ].join('\n');

      let existingUserAnnotations = '';
      if (fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, 'utf-8');
        // F5 fix (audit): use lastIndexOf, not indexOf. On the second write,
        // the WI-generated body sits ABOVE the SEPARATOR the first write
        // installed, and any accidental mention of the sentinel string in
        // that body would otherwise be treated as the boundary and grow a
        // ghost-annotation section. The last occurrence is always the real
        // separator installed at write time.
        const sepIdx = existing.lastIndexOf(SEPARATOR);
        if (sepIdx !== -1) {
          existingUserAnnotations = existing.slice(sepIdx + SEPARATOR.length);
        }
      }

      const newAboveSep = condensedSnippet;
      const newContent = `${newAboveSep}\n\n${SEPARATOR}\n${existingUserAnnotations}`;
      fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
      fs.writeFileSync(filePath, newContent, 'utf-8');
      // Phase 79-08: re-index immediately so obsidian_notes sees the update
      // without waiting for the chokidar watcher debounce.
      try {
        syncSingleFile(db, filePath);
      } catch (syncErr) {
        process.stderr.write(`[topic_expert] syncSingleFile failed (non-fatal): ${(syncErr as Error).message?.slice(0, 100)}\n`);
      }
      process.stderr.write(`[topic_expert] vault write-back OK: ${filePath}\n`);
    } catch (err) {
      process.stderr.write(`[topic_expert] vault write-back failed: ${(err as Error).message.slice(0, 100)}\n`);
    }
  }

  return finalMarkdown;
}
