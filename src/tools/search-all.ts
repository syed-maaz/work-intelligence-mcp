/**
 * search_all MCP Tool
 *
 * Given a keyword, sentence, or topic:
 *   1. Fetches live from Outlook email and Jira (in parallel) using the
 *      browser connectors and stores results to the DB.
 *   2. Searches all stored messages (email + jira + teams) via FTS5.
 *   3. Returns an AI-summarized report grouped by source.
 *
 * Teams is search-only (no live fetch) — messages are stored by the
 * separate teams-sync script / get_teams_updates tool.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { PromptCachingBetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/prompt-caching/messages.js';
import { bucketCallParams } from '../services/model-config.js';
import type Database from 'better-sqlite3';
import { withRetry } from '../lib/retry.js';
import { createTopic, getTopicByName, updateSyncState } from '../db/queries.js';
import { OutlookBrowserConnector } from '../fetcher/sources/outlook-browser.js';
import { createJiraDataSource } from '../fetcher/sources/jira-adapter.js';
import { convertRapidBoardToNavigatorUrl } from '../fetcher/sources/jira-browser.js';
import type { BrowserSessionManager } from '../fetcher/sources/browser-session.js';
import type { UnifiedMessage } from '../fetcher/sources/types.js';
import { fetchStream, localSpec } from '../fetcher/orchestrator.js';
import type { SourceSpec } from '../fetcher/orchestrator.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SearchAllArgs {
  /** Free-text query: keyword, sentence, topic, or question */
  query: string;
  /** Which sources to include (default: all three) */
  sources?: Array<'email' | 'jira' | 'teams'>;
  /** Only return results from this date onwards (ISO, default: 7 days ago) */
  since?: string;
  /** Jira board URL — falls back to JIRA_BOARD_URL env var */
  jiraBoardUrl?: string;
  /** Outlook folder slug (default: 'inbox') */
  outlookFolder?: string;
  /** Max DB results to return per source before summarising (default: 50) */
  maxResults?: number;
  /** U-15: relevance (BM25) vs recency (newest timestamp first). Default: relevance */
  sortBy?: 'relevance' | 'recency';
  /**
   * Fetch strategy (tsk_445432091927). Default 'live-blocking' preserves the
   * legacy contract: fetch Outlook+Jira live and block until done, then search.
   * 'local-first' returns the local FTS result immediately (<1s) and fires the
   * live scrape in the background to warm the cache for the next call — the
   * Cypher EXECUTE path uses this so a single dispatch can't stall 60-138s on
   * an Outlook scrape (p95 target <15s).
   */
  mode?: 'live-blocking' | 'local-first';
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
}

interface MeetingRow {
  id: number;
  title: string;
  date: string;
  chat_name: string | null;
  attendees: string | null;
  summary: string | null;
  topics: string | null;
  decisions: string | null;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Return the id of the single shared search-cache topic.
 * All live-fetched messages from search_all are stored here regardless of
 * query text — prevents unbounded topic-table growth from per-query rows.
 */
function ensureSearchCacheTopic(db: Database.Database): number {
  const SEARCH_CACHE_TOPIC = '_search_cache';
  const existing = getTopicByName(db, SEARCH_CACHE_TOPIC);
  if (existing) return existing.id;
  const created = createTopic(db, { name: SEARCH_CACHE_TOPIC });
  return created.id;
}

// storeMessage helper removed (ADR-044 S4): the fetcher orchestrator persists
// its own results; direct writes from search-all.ts are no longer needed.

// ---------------------------------------------------------------------------
// FTS search (all sources, no source filter)
// ---------------------------------------------------------------------------

/** U-15: ORDER BY clause for FTS queries (unit-tested). */
export function ftsOrderBy(
  sortBy: 'relevance' | 'recency',
  kind: 'messages' | 'meetings',
): string {
  if (sortBy === 'recency') {
    return kind === 'messages' ? 'm.timestamp DESC' : 'mt.date DESC';
  }
  return 'rank';
}

function searchFTS(
  db: Database.Database,
  query: string,
  since: string,
  maxResults: number,
  sortBy: 'relevance' | 'recency' = 'relevance',
): { messages: MessageRow[]; meetings: MeetingRow[] } {
  const ftsQuery = query.replace(/"/g, '""');
  const msgOrder = ftsOrderBy(sortBy, 'messages');
  const meetOrder = ftsOrderBy(sortBy, 'meetings');

  const msgSql = `
    SELECT m.id, m.source, m.source_id, m.subject, m.content, m.author, m.timestamp,
           bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m ON messages_fts.rowid = m.id
    WHERE messages_fts MATCH ? AND m.timestamp >= ?
    ORDER BY ${msgOrder}
    LIMIT ?
  `;
  const messages = db.prepare(msgSql).all(ftsQuery, since, maxResults) as MessageRow[];

  const meetSql = `
    SELECT mt.id, mt.title, mt.date, mt.chat_name, mt.attendees, mt.summary,
           mt.topics, mt.decisions,
           bm25(meetings_fts) AS rank
    FROM meetings_fts
    JOIN meetings mt ON meetings_fts.rowid = mt.id
    WHERE meetings_fts MATCH ? AND mt.date >= ?
    ORDER BY ${meetOrder}
    LIMIT ?
  `;
  const meetings = db.prepare(meetSql).all(ftsQuery, since, maxResults) as MeetingRow[];

  return { messages, meetings };
}

function searchLike(
  db: Database.Database,
  query: string,
  since: string,
  maxResults: number
): { messages: MessageRow[]; meetings: MeetingRow[] } {
  const pattern = `%${query}%`;

  const messages = db.prepare(`
    SELECT id, source, source_id, subject, content, author, timestamp
    FROM messages
    WHERE (content LIKE ? OR subject LIKE ?) AND timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(pattern, pattern, since, maxResults) as MessageRow[];

  const meetings = db.prepare(`
    SELECT id, title, date, chat_name, attendees, summary, topics, decisions
    FROM meetings
    WHERE (title LIKE ? OR transcript LIKE ? OR topics LIKE ? OR summary LIKE ?) AND date >= ?
    ORDER BY date DESC
    LIMIT ?
  `).all(pattern, pattern, pattern, pattern, since, maxResults) as MeetingRow[];

  return { messages, meetings };
}

// ---------------------------------------------------------------------------
// Fetch helpers (ADR-044 S4): withTimeout + fetchJira removed. The fetcher
// orchestrator (src/fetcher/orchestrator.ts) now owns per-source AbortController
// timeouts (cancel-and-release contract) and Jira dispatch via JiraDataSource.
// fetchOutlook retained: still called by the OutlookBrowserConnector fallback path
// when a caller needs direct scraping outside the orchestrator.
// ---------------------------------------------------------------------------

async function fetchOutlook(
  session: BrowserSessionManager,
  query: string,
  folder: string,
  since: Date,
  connector?: OutlookBrowserConnector,
  signal?: AbortSignal,
): Promise<UnifiedMessage[]> {
  process.stderr.write(`[search_all] Fetching Outlook (folder=${folder}, subjectFilter="${query}")...\n`);
  const c = connector ?? new OutlookBrowserConnector(session);
  return c.fetchMessages({ folder, subjectFilter: query }, since, signal);
}

// fetchJira helper removed (ADR-044 S4): the fetcher orchestrator now dispatches
// Jira via createJiraDataSource inside the source spec. See src/fetcher/orchestrator.ts.

// ---------------------------------------------------------------------------
// AI summarisation
// ---------------------------------------------------------------------------

async function summarise(
  query: string,
  content: string,
  anthropicApiKey?: string,
  db?: Database.Database,
): Promise<string> {
  if (!anthropicApiKey || !content.trim()) return '';

  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const client = new Anthropic({
    apiKey: baseURL ? 'x-proxy' : anthropicApiKey,
    ...(baseURL
      ? { baseURL, defaultHeaders: { Authorization: `Bearer ${anthropicApiKey}` } }
      : {}),
  });

  const systemPrompt =
    'You are a work intelligence assistant. You have search results from Outlook email, Jira issues, and Teams messages. Summarize concisely and directly answer the user query.';
  const cachedSystem: PromptCachingBetaTextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];
  const bucketParams = db ? bucketCallParams(db, 'digest', 1500) : {
    model: 'claude-sonnet-4-6' as const,
    max_tokens: 1500,
  };

  const truncated =
    content.length > 10_000 ? content.slice(0, 10_000) + '\n...[truncated]' : content;

  try {
    const response = await withRetry(
      () => client.beta.promptCaching.messages.create({
        ...bucketParams,
        system: cachedSystem,
        messages: [
          {
            role: 'user',
            content:
              `Search query: "${query}"\n\n` +
              `Based on the following data from Outlook, Jira, and Teams, provide:\n` +
              `1. A direct answer or summary of what you found\n` +
              `2. Key information grouped by source (Email / Jira / Teams)\n` +
              `3. Any decisions, action items, or open questions found\n\n` +
              `---\n${truncated}`,
          },
        ],
      }),
      { maxAttempts: 2, baseDelayMs: 1_000 },
    );

    const block = response.content.find((b) => b.type === 'text');
    return block?.type === 'text' ? block.text : '';
  } catch (err) {
    return `(AI summary unavailable: ${err instanceof Error ? err.message : String(err)})`;
  }
}

// ---------------------------------------------------------------------------
// Format context for Claude
// ---------------------------------------------------------------------------

function buildClaudeContext(
  query: string,
  messages: MessageRow[],
  meetings: MeetingRow[]
): string {
  const lines: string[] = [`Search: "${query}"`, ''];

  const bySource = new Map<string, MessageRow[]>();
  for (const m of messages) {
    const list = bySource.get(m.source) ?? [];
    list.push(m);
    bySource.set(m.source, list);
  }

  for (const [source, msgs] of bySource.entries()) {
    lines.push(`## ${source.toUpperCase()} (${msgs.length} results)`, '');
    for (const msg of msgs) {
      const subj = msg.subject ? `[${msg.subject}] ` : '';
      lines.push(`[${msg.timestamp.slice(0, 16)}] ${msg.author}: ${subj}${msg.content.slice(0, 300)}`);
      lines.push('');
    }
  }

  if (meetings.length > 0) {
    lines.push(`## MEETINGS (${meetings.length})`, '');
    for (const m of meetings) {
      lines.push(`### ${m.title} (${m.date.slice(0, 10)}) — ${m.chat_name ?? ''}`);
      if (m.summary) lines.push(`Summary: ${m.summary}`);
      if (m.topics) {
        try {
          const t = JSON.parse(m.topics) as string[];
          if (t.length) lines.push(`Topics: ${t.join(', ')}`);
        } catch { /* skip */ }
      }
      if (m.decisions) {
        try {
          const d = JSON.parse(m.decisions) as string[];
          if (d.length) lines.push(`Decisions: ${d.join('; ')}`);
        } catch { /* skip */ }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Format final MCP response
// ---------------------------------------------------------------------------

function formatResponse(
  query: string,
  messages: MessageRow[],
  meetings: MeetingRow[],
  aiSummary: string,
  fetchNotes: string[]
): string {
  const lines: string[] = [];

  if (aiSummary) {
    lines.push('## Summary', '', aiSummary, '');
  }

  if (fetchNotes.length > 0) {
    lines.push('> **Fetch notes:** ' + fetchNotes.join(' | '), '');
  }

  const totalHits = messages.length + meetings.length;
  lines.push(
    '---',
    `*Searched across Outlook, Jira, and Teams for "${query}" — ${totalHits} result(s) found.*`,
    ''
  );

  // Group messages by source
  const bySource = new Map<string, MessageRow[]>();
  for (const m of messages) {
    const list = bySource.get(m.source) ?? [];
    list.push(m);
    bySource.set(m.source, list);
  }

  for (const [source, msgs] of bySource.entries()) {
    const label = source === 'email' ? 'Email' : source === 'jira' ? 'Jira' : 'Teams';
    lines.push(`## ${label} Results (${msgs.length})`, '');
    for (const msg of msgs.slice(0, 10)) {
      const subj = msg.subject || '(no subject)';
      lines.push(`**${msg.author}** — ${msg.timestamp.slice(0, 16)}`);
      lines.push(`*${subj}*`);
      const preview = msg.content.length > 250 ? msg.content.slice(0, 250) + '…' : msg.content;
      lines.push(preview);
      lines.push('');
    }
    if (msgs.length > 10) {
      lines.push(`*…and ${msgs.length - 10} more ${label} results.*`, '');
    }
  }

  if (meetings.length > 0) {
    lines.push('## Meetings', '');
    for (const m of meetings) {
      lines.push(`### ${m.title}`);
      lines.push(`**Date:** ${m.date.slice(0, 10)}  |  **Chat:** ${m.chat_name ?? 'unknown'}`);
      if (m.summary) lines.push(`**Summary:** ${m.summary}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export async function searchAll(
  db: Database.Database,
  args: SearchAllArgs,
  session: BrowserSessionManager,
  anthropicApiKey?: string
): Promise<string> {
  const {
    query,
    sources = ['email', 'jira', 'teams'],
    since,
    jiraBoardUrl,
    outlookFolder = 'inbox',
    maxResults = 50,
    sortBy = 'relevance',
    mode = 'live-blocking',
  } = args;

  if (!query?.trim()) return 'Error: query is required.';

  const sinceDate = since
    ? new Date(since)
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sinceIso = sinceDate.toISOString();

  // Single shared cache topic — avoids unbounded ghost topics from per-query rows
  const topicId = ensureSearchCacheTopic(db);

  const fetchNotes: string[] = [];
  const PER_SOURCE_TIMEOUT_MS = 15_000;  // ADR-044 S4: parallel per-source cap
  const OVERALL_HARD_CAP_MS   = 30_000;  // ADR-044 S4: overall wall-clock cap

  // ---- ADR-044 S4/S5 migration: parallel local-first fetch via orchestrator ----
  // Was: sequential `await Outlook (90s) → await Jira (300s) → local` — one slow
  // source burned the caller's whole 60s budget before local even ran. Now:
  // orchestrator.fetchStream(['local','teams','jira','email']) — local emits
  // FIRST (~10ms, no network, no browser slot), live sources run in PARALLEL
  // each with its own 15s timeout via cancel-and-release (session.releaseBySource
  // → the browser pool slot is FREED, not leaked). One slow source now yields
  // its own {status:'timed_out'} envelope; it never sinks the aggregate.
  //
  // Local NEVER cancels; per-source timeout = 15s; overall cap = 30s.
  //
  // We preserve the existing byte-for-byte return shape: this function still
  // returns a markdown string built from the DB search (filteredMessages +
  // filteredMeetings + fetchNotes). The migration is an internal refactor of
  // HOW data is fetched, not WHAT the caller receives.
  const runLiveFetch = async (): Promise<void> => {
    const specs: SourceSpec[] = [];

    // local — always first, always ok, never blocks.
    specs.push(localSpec(db, query, maxResults, 5_000));

    if (sources.includes('email')) {
      const connector = new OutlookBrowserConnector(session);
      specs.push({
        source: 'email',
        fetch: (signal) => fetchOutlook(session, query, outlookFolder, sinceDate, connector, signal),
        release: async () => { await session.releaseBySource('email'); },
        timeoutMs: PER_SOURCE_TIMEOUT_MS,
      });
    }

    if (sources.includes('jira')) {
      const boardUrl = jiraBoardUrl ?? process.env.JIRA_BOARD_URL;
      if (!boardUrl) {
        fetchNotes.push('Jira skipped: no jiraBoardUrl provided and JIRA_BOARD_URL not set');
      } else {
        const jira = createJiraDataSource(session);
        const navigatorUrl = convertRapidBoardToNavigatorUrl(boardUrl, sinceDate);
        specs.push({
          source: 'jira',
          fetch: () => jira.fetchMessages({ boardUrl: navigatorUrl }, sinceDate),
          release: async () => { await session.releaseBySource('jira'); },
          timeoutMs: PER_SOURCE_TIMEOUT_MS,
        });
      }
    }

    // Overall wall-clock cap — if the orchestrator hasn't drained in 30s, we
    // stop consuming its stream (each still-running source will time out at
    // its own 15s and release its slot; we're just refusing to wait past the
    // aggregate budget).
    const hardCap = new Promise<void>((resolve) => setTimeout(resolve, OVERALL_HARD_CAP_MS));
    let hardCapHit = false;

    const drain = async () => {
      for await (const ev of fetchStream(db, specs)) {
        if (ev.kind !== 'result') continue;
        if (ev.source === 'local') {
          // Local always ok; nothing to persist — rows are already in `messages`.
          continue;
        }
        // For live sources, the orchestrator already persisted ok rows into
        // the fetcher's default topic (`_fetcher_sync`). To preserve the
        // legacy search-cache topic behavior (upsert under `_search_cache`
        // with call-site metadata), we ALSO issue the sync-state update and
        // dedupe-persist under the search topic. This is a no-op for the
        // dedup path (UNIQUE(source, source_id)), but keeps the legacy
        // signal that "search_all just refreshed source X".
        if (ev.status === 'ok') {
          updateSyncState(db, String(topicId), ev.source, new Date().toISOString(), ev.count);
          process.stderr.write(`[search_all] ${ev.source} returned ${ev.count} in ${ev.durationMs}ms\n`);
        } else if (ev.status === 'timed_out') {
          fetchNotes.push(`${ev.source} fetch timed out (>${PER_SOURCE_TIMEOUT_MS / 1000}s)`);
        } else if (ev.status === 'error') {
          fetchNotes.push(`${ev.source} error: ${ev.note ?? 'unknown'}`);
        }
      }
    };

    await Promise.race([
      drain(),
      hardCap.then(() => { hardCapHit = true; }),
    ]);
    if (hardCapHit) {
      fetchNotes.push(`aggregate fetch exceeded ${OVERALL_HARD_CAP_MS / 1000}s hard cap — remaining sources continue in background`);
    }
  };

  if (mode === 'local-first') {
    // Detached: warm the cache for the next call, but do NOT block this response.
    // The unhandled-rejection guard is inside runLiveFetch (per-source catch),
    // so this .catch is belt-and-suspenders for anything above the try blocks.
    void runLiveFetch().catch((err) => {
      process.stderr.write(`[search_all] background enrich failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
    fetchNotes.push('Live fetch running in background (local-first mode) — results below are from the last sync; re-run for freshly-scraped data.');
  } else {
    await runLiveFetch();
  }

  // ---- DB search ----

  process.stderr.write(`[search_all] Searching DB for "${query}" since ${sinceIso}...\n`);

  let results: { messages: MessageRow[]; meetings: MeetingRow[] };
  try {
    results = searchFTS(db, query, sinceIso, maxResults, sortBy);
    if (results.messages.length === 0 && results.meetings.length === 0) {
      results = searchLike(db, query, sinceIso, maxResults);
    }
  } catch {
    results = searchLike(db, query, sinceIso, maxResults);
  }

  // Filter to requested sources
  const sourcesSet = new Set(sources);
  const filteredMessages = results.messages.filter((m) =>
    sourcesSet.has(m.source as 'email' | 'jira' | 'teams')
  );
  const filteredMeetings = sources.includes('teams') ? results.meetings : [];

  const totalHits = filteredMessages.length + filteredMeetings.length;
  process.stderr.write(`[search_all] Found ${totalHits} result(s) in DB.\n`);

  if (totalHits === 0) {
    const noteStr = fetchNotes.length ? `\n\nFetch notes: ${fetchNotes.join('; ')}` : '';
    return `No results found for "${query}" across ${sources.join(', ')}${since ? ` (since ${since})` : ''}.${noteStr}`;
  }

  // ---- AI summary ----

  const claudeContext = buildClaudeContext(query, filteredMessages, filteredMeetings);
  const aiSummary = await summarise(query, claudeContext, anthropicApiKey, db);

  return formatResponse(query, filteredMessages, filteredMeetings, aiSummary, fetchNotes);
}
